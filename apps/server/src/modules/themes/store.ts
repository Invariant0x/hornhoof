import type { InstalledThemeView, ThemeEngine } from '@hornhoof/protocol/themes';
import type { WorldPackBehaviorSpec } from '@hornhoof/protocol/world';
import { and, asc, eq, inArray, like, or } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { themeFiles, themes } from '../../db/schema.js';
import type { Files } from '../files/files.js';
import type { Tx } from '../tasks/state.js';
import { defaultWorldPacks, type WorldPackRegistry } from '../world/packs/index.js';
import type { CheckedTheme } from './archive.js';

/* The themes a company installed from archives (docs/theme-archive.md, 10): stored only as their check built them, each
   version's files under its own address, so a file once served never changes. The bytes of the files are in the
   company's file store (modules/files), and their rows name them by their sha256. */

type Reader = Db | Tx;
/* Files are written a few at a time, so one statement never carries a whole theme. */
const FILES_PER_INSERT = 16;

/* Where an installed theme's files are served, ending in a slash. */
export const themeBase = (themeId: string, version: string): string => `/api/themes/files/${themeId}/${version}/`;

type ThemeRow = typeof themes.$inferSelect;

function viewOf(row: ThemeRow, files: readonly string[]): InstalledThemeView {
  const manifest = row.manifest as { name: Record<string, string>; description?: Record<string, string>; author: string; license: string; engine: ThemeEngine; languages: string[] };
  const base = themeBase(row.themeId, row.version);
  const picture = (name: string) => files.find(path => path === `preview/${name}.png` || path === `preview/${name}.webp`);
  const cover = picture('cover');
  /* Every archive has exactly one licence file: the check refuses one without it or with two. */
  const licence = files.find(path => /^LICENSE(?:\.md|\.txt)?$/.test(path)) ?? 'LICENSE';
  return {
    id: row.themeId,
    version: row.version,
    name: manifest.name,
    description: manifest.description ?? null,
    author: manifest.author,
    license: manifest.license,
    engine: manifest.engine,
    languages: manifest.languages,
    base,
    cover: cover ? base + cover : null,
    shots: [1, 2, 3, 4, 5, 6].map(n => picture(`shot-${n}`)).filter((path): path is string => path !== undefined).map(path => base + path),
    licenseFile: base + licence,
    hasWorld: row.world !== null,
    /* A theme stored without the world it declares had its world left out at the check: only for a lack of its art. */
    worldLeftOut: manifest.engine !== 'none' && row.world === null ? 'art_missing' : null,
    hasKit: row.kit !== null,
    size: row.size,
    installedAt: row.installedAt.toISOString(),
  };
}

export async function installedThemes(db: Reader, companyId: string): Promise<InstalledThemeView[]> {
  const rows = await db.select().from(themes).where(eq(themes.companyId, companyId)).orderBy(asc(themes.installedAt), asc(themes.themeId));
  /* The files a card names: its pictures and its licence. */
  const shown = await db
    .select({ themeId: themeFiles.themeId, path: themeFiles.path })
    .from(themeFiles)
    .where(and(eq(themeFiles.companyId, companyId), or(like(themeFiles.path, 'preview/%'), inArray(themeFiles.path, ['LICENSE', 'LICENSE.md', 'LICENSE.txt']))));
  return rows.map(row => viewOf(row, shown.filter(file => file.themeId === row.themeId).map(file => file.path)));
}

/* What the screens need to put an installed theme on: its look, its fonts, its kit and its world, with where its files
   are: a kit picture is at base + ui/kit/ + its slot's file. */
export type InstalledThemeLook = Readonly<{ id: string; version: string; base: string; look: unknown; fonts: unknown; kit: unknown; world: unknown }>;

export async function installedThemeLook(db: Reader, companyId: string, themeId: string): Promise<InstalledThemeLook | null> {
  const [row] = await db
    .select({ version: themes.version, look: themes.look, fonts: themes.fonts, kit: themes.kit, world: themes.world })
    .from(themes)
    .where(and(eq(themes.companyId, companyId), eq(themes.themeId, themeId)));
  return row ? { id: themeId, version: row.version, base: themeBase(themeId, row.version), look: row.look, fonts: row.fonts, kit: row.kit, world: row.world } : null;
}

export async function isInstalledTheme(db: Reader, companyId: string, themeId: string): Promise<boolean> {
  const [row] = await db.select({ themeId: themes.themeId }).from(themes).where(and(eq(themes.companyId, companyId), eq(themes.themeId, themeId)));
  return Boolean(row);
}

export async function installedVersion(db: Reader, companyId: string, themeId: string): Promise<string | null> {
  const [row] = await db.select({ version: themes.version }).from(themes).where(and(eq(themes.companyId, companyId), eq(themes.themeId, themeId)));
  return row?.version ?? null;
}

/* Installs a checked theme for the company, in place of any other version of it: the row and every file it serves,
   read once more from the archive, which checks each file's sum again as it unpacks it, into the store. A file the store
   keeps and no row names, of an install that failed, goes with the store's sweep. */
export async function installTheme(db: Db, files: Pick<Files, 'putBytes'>, companyId: string, personId: string, theme: CheckedTheme): Promise<void> {
  const { manifest } = theme;
  await db.transaction(async tx => {
    await tx.delete(themes).where(and(eq(themes.companyId, companyId), eq(themes.themeId, manifest.id)));
    await tx.insert(themes).values({
      companyId,
      themeId: manifest.id,
      version: manifest.version,
      manifest,
      look: theme.look as Record<string, unknown>,
      fonts: theme.fonts as unknown as Record<string, unknown>[],
      kit: theme.kit as Record<string, unknown> | null,
      world: theme.world as Record<string, unknown> | null,
      skills: theme.skills,
      size: theme.size,
      installedBy: personId,
    });
    for (let at = 0; at < theme.files.length; at += FILES_PER_INSERT) {
      const batch = theme.files.slice(at, at + FILES_PER_INSERT);
      const rows: (typeof themeFiles.$inferInsert)[] = [];
      for (const file of batch) {
        const kept = await files.putBytes(tx, await file.read());
        rows.push({ companyId, themeId: manifest.id, version: manifest.version, path: file.path, mediaType: file.mediaType, sha256: kept.sha256, size: kept.size });
      }
      await tx.insert(themeFiles).values(rows);
    }
  });
}

/* Removes an installed theme and all its files. True when there was one. */
export async function deleteTheme(db: Db, companyId: string, themeId: string): Promise<boolean> {
  const gone = await db.delete(themes).where(and(eq(themes.companyId, companyId), eq(themes.themeId, themeId))).returning({ themeId: themes.themeId });
  return gone.length > 0;
}

/* One file of an installed theme, only of the company that installed it: its type and the content that holds it. */
export async function themeFile(db: Reader, companyId: string, themeId: string, version: string, path: string): Promise<{ mediaType: string; sha256: string } | null> {
  const [file] = await db
    .select({ mediaType: themeFiles.mediaType, sha256: themeFiles.sha256 })
    .from(themeFiles)
    .where(and(eq(themeFiles.companyId, companyId), eq(themeFiles.themeId, themeId), eq(themeFiles.version, version), eq(themeFiles.path, path)));
  return file ?? null;
}

/* The theme files opened last, by their sha256, about 64 MB of them: every viewer of a world loads the same art, and a
   content is the same bytes for good. A file over 8 MB is opened each time. */
const OPENED_BYTES = 64 * 1024 ** 2;
const OPENED_FILE_BYTES = 8 * 1024 ** 2;
const opened = new Map<string, Buffer>();
let openedBytes = 0;

/* The bytes of a theme's file, by its content: from what the app keeps opened, else from the store. */
export async function themeFileBytes(files: Pick<Files, 'bytes'>, db: Reader, sha256: string): Promise<Buffer> {
  const kept = opened.get(sha256);
  if (kept) {
    opened.delete(sha256);
    opened.set(sha256, kept);
    return kept;
  }
  const bytes = await files.bytes(db, sha256);
  if (bytes.length > OPENED_FILE_BYTES) return bytes;
  opened.set(sha256, bytes);
  openedBytes += bytes.length;
  for (const [name, old] of opened) {
    if (openedBytes <= OPENED_BYTES) break;
    opened.delete(name);
    openedBytes -= old.length;
  }
  return bytes;
}

/* The world packs of one company: the ones Hornhoof ships, and in place of any of them, or beside them, the voice and
   names of each theme the company installed. An installed theme with no voice takes away a shipped one of its id. */
export async function companyWorldPacks(ctx: { db: Reader; worldPacks?: WorldPackRegistry | undefined }, companyId: string): Promise<WorldPackRegistry> {
  const shipped = ctx.worldPacks ?? defaultWorldPacks();
  const installed = await ctx.db.select({ themeId: themes.themeId, skills: themes.skills }).from(themes).where(eq(themes.companyId, companyId));
  if (!installed.length) return shipped;
  const packs = new Map<string, WorldPackBehaviorSpec>(shipped);
  for (const row of installed) {
    packs.delete(row.themeId);
    if (row.skills) packs.set(row.themeId, row.skills);
  }
  return packs;
}
