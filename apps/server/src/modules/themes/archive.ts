import {
  THEME_ARCHIVE_FORMAT, THEME_ENGINES, THEME_FILE_LIMITS, THEME_KIT_COLORS, THEME_KIT_SLOTS, THEME_KIT_VALUE_LENGTH, THEME_KIT_VALUES, THEME_LIMITS, type ThemeArtFile, type ThemeLimits, type ThemeProblemCode, type ThemeWebCheck, type ThemeWorldLeftOut,
} from '@hornhoof/protocol/themes';
import type { WorldPackBehaviorSpec } from '@hornhoof/protocol/world';
import { z } from 'zod';
import { checkFont, jsonOf, kindOf, MEDIA, pictureOf, plainText, type FileKind, type MediaType } from './files.js';
import { archiveWorldSkills } from './skills.js';
import { ArchiveRefused, openZip, type ZipFile, type ZipSource } from './zip.js';

/* The whole check of a theme archive (docs/theme-archive.md): the zip, then each file by its place and its bytes, then
   each part by its own check. The first problem refuses the archive. What passed is built anew from the values that
   passed, and only the files the theme serves are kept. */

/* Throws, so a check that fails narrows the code after it. */
function refuse(code: ThemeProblemCode, path?: string, detail?: string): never {
  throw new ArchiveRefused({ code, ...(path === undefined ? {} : { path }), ...(detail === undefined ? {} : { detail: detail.slice(0, THEME_FILE_LIMITS.shown * 3) }) });
}

const LANGUAGE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const plain = (max: number) => z.string().trim().min(1).max(max);
const texts = (max: number) => z.record(z.string().regex(LANGUAGE), plain(max)).refine(value => 'en' in value && 'ru' in value, 'needs en and ru');

export const ThemeManifest = z.strictObject({
  format: z.literal(THEME_ARCHIVE_FORMAT),
  id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, 'lower case Latin letters, digits and -, from 2 to 40, starting with a letter'),
  name: texts(60),
  description: texts(280).optional(),
  version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/, 'MAJOR.MINOR.PATCH'),
  author: plain(80),
  license: plain(60).regex(/^[A-Za-z0-9.+() -]+$/, 'an SPDX id or "see LICENSE"'),
  contract: z.strictObject({ ui: z.literal(1), world: z.literal(2).optional() }),
  engine: z.enum(THEME_ENGINES),
  languages: z.array(z.string().regex(LANGUAGE)).min(2).max(40).refine(list => list.includes('en') && list.includes('ru') && new Set(list).size === list.length, 'en and ru, each once'),
});
export type ThemeManifest = z.infer<typeof ThemeManifest>;

const FontFace = z.strictObject({
  family: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 -]{0,39}$/, 'letters, digits, spaces and -, up to 40'),
  file: z.string().regex(/^[A-Za-z0-9._@-]+\.woff2$/, 'a .woff2 file of ui/fonts'),
  weight: z.number().int().min(100).max(900).multipleOf(100),
  style: z.enum(['normal', 'italic']),
  unicodeRange: z.string().regex(/^U\+[0-9A-F?]{1,6}(?:-[0-9A-F]{1,6})?(?:,\s*U\+[0-9A-F?]{1,6}(?:-[0-9A-F]{1,6})?)*$/i).max(2000).optional(),
});
export type ThemeFontFace = z.infer<typeof FontFace>;
const Fonts = z.strictObject({ faces: z.array(FontFace).min(1).max(THEME_FILE_LIMITS.fonts) });

/* A slot of ui/kit.json in the forms of the theme UI kit 1.0, section 6.2 (THEME_KIT_VALUES): what the screens would
   skip is refused here, with the form it should have. */
const kitValue = (key: Exclude<keyof typeof THEME_KIT_VALUES, 'file' | 'color'>, form: string) => z.string().max(THEME_KIT_VALUE_LENGTH).regex(THEME_KIT_VALUES[key], form).optional();
const KitSlot = z.strictObject({
  file: z.string().max(THEME_LIMITS.pathLength).regex(THEME_KIT_VALUES.file, 'a .webp or .png file of ui/kit: lowercase letters, digits, ".", "@" and "-"'),
  slice: kitValue('slice', '1 to 4 numbers, each with an optional %, then an optional " fill"'),
  width: kitValue('width', '1 to 4 of: a number with px or %, a plain number, auto'),
  outset: kitValue('outset', '1 to 4 numbers, each with an optional px'),
  size: kitValue('size', '1 or 2 of: a number with px or %, auto, calc(100% - Npx)'),
  repeat: kitValue('repeat', '1 or 2 of: stretch, repeat, round, space'),
});
/* Only the parts and colours the screens know (THEME_KIT_SLOTS, THEME_KIT_COLORS), each at most once. The pack's name
   and the name of its licence are for people, as the kit writes them. */
const Kit = z.strictObject({
  pack: plain(80).optional(),
  licence: plain(80).optional(),
  slots: z.partialRecord(z.enum(THEME_KIT_SLOTS), KitSlot).refine(slots => Object.keys(slots).length > 0, 'at least one slot'),
  colors: z.partialRecord(z.enum(THEME_KIT_COLORS), z.string().regex(THEME_KIT_VALUES.color, '#RRGGBB')).optional(),
});
export type ThemeKit = z.infer<typeof Kit>;

/* A file the theme serves to the screens, with the type it is served as. It is read again from the archive when it is
   stored, so a theme is never held in memory whole. */
export type ServedFile = Readonly<{ path: string; mediaType: MediaType; size: number; read: () => Promise<Buffer> }>;

export type CheckedTheme = Readonly<{
  manifest: ThemeManifest;
  look: unknown;
  fonts: readonly ThemeFontFace[];
  kit: ThemeKit | null;
  world: unknown;
  skills: WorldPackBehaviorSpec | null;
  /* A world the theme declares but which is not kept, and why: the theme is then its interface alone. */
  worldLeftOut: ThemeWorldLeftOut | null;
  files: readonly ServedFile[];
  size: number;
}>;

/* The archive's files under the paths the format gives, wherever one folder holds them all. */
function rooted(files: readonly ZipFile[]): Map<string, ZipFile> {
  const byPath = new Map(files.map(file => [file.path, file]));
  if (byPath.has('theme.json')) return byPath;
  const tops = new Set(files.map(file => file.path.split('/')[0]!));
  const [top] = [...tops];
  if (tops.size !== 1 || !byPath.has(`${top}/theme.json`)) {
    const folder = [...byPath.keys()].find(path => path.endsWith('/theme.json'))?.slice(0, -'theme.json'.length);
    const stray = folder === undefined ? undefined : [...byPath.keys()].find(path => !path.startsWith(folder));
    return stray === undefined ? refuse('theme_missing', 'theme.json') : refuse('path_outside', stray);
  }
  return new Map(files.map(file => [file.path.slice(top!.length + 1), file]));
}

const shapeProblem = (path: string, error: z.ZodError): never => {
  const issue = error.issues[0]!;
  return refuse('json_shape', path, `${issue.path.join('.') || 'the file'}: ${issue.message}`);
};

function parsed<T>(path: string, schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  return result.success ? result.data : shapeProblem(path, result.error);
}

class Reader {
  constructor(readonly files: Map<string, ZipFile>, readonly kinds: Map<string, FileKind>) {}
  has(path: string): boolean {
    return this.files.has(path);
  }
  async read(path: string): Promise<Buffer> {
    return (this.files.get(path) ?? refuse('file_missing', path)).read();
  }
  /* The file as the theme serves it, once its bytes passed. */
  served(path: string, mediaType: MediaType): ServedFile {
    const file = this.files.get(path) ?? refuse('file_missing', path);
    return { path, mediaType, size: file.size, read: file.read };
  }
  async json(path: string, limit?: number): Promise<unknown> {
    return jsonOf(path, await this.read(path), limit);
  }
  under(folder: string): string[] {
    return [...this.files.keys()].filter(path => path.startsWith(folder)).sort();
  }
}

function engineRules(manifest: ThemeManifest, files: Reader): void {
  if (manifest.engine === '3d') refuse('engine_3d', 'theme.json');
  const worldly = files.under('world/').concat(files.under('skills/'));
  if (manifest.engine === 'none' && worldly.length) refuse('engine_none_world', worldly[0]);
  if (manifest.engine === 'iso2d' && !files.has('world/world.json')) refuse('world_missing', 'world/world.json');
  if (manifest.engine === 'iso2d' && manifest.contract.world === undefined) refuse('json_shape', 'theme.json', 'contract.world: needs the world art contract version, 2');
}

async function fontsOf(files: Reader, served: ServedFile[]): Promise<ThemeFontFace[]> {
  const fontFiles = files.under('ui/fonts/').filter(path => path.endsWith('.woff2'));
  if (!files.has('ui/fonts.json')) return fontFiles.length ? refuse('fonts_bad', fontFiles[0], 'no ui/fonts.json names it') : [];
  const { faces } = parsed('ui/fonts.json', Fonts, await files.json('ui/fonts.json'));
  const named = new Set(faces.map(face => `ui/fonts/${face.file}`));
  const unnamed = fontFiles.find(path => !named.has(path));
  if (unnamed) refuse('fonts_bad', unnamed, 'no face of ui/fonts.json names it');
  for (const path of named) {
    if (!files.has(path)) refuse('file_missing', path, 'ui/fonts.json names it');
    const bytes = await files.read(path);
    checkFont(path, bytes);
    served.push(files.served(path, MEDIA.woff2));
  }
  return faces;
}

async function kitOf(files: Reader, served: ServedFile[]): Promise<ThemeKit | null> {
  const pictures = files.under('ui/kit/');
  if (!files.has('ui/kit.json')) return pictures.length ? refuse('kit_bad', pictures[0], 'no ui/kit.json names it') : null;
  const kit = parsed('ui/kit.json', Kit, await files.json('ui/kit.json'));
  const named = new Set(Object.values(kit.slots).map(slot => `ui/kit/${slot.file}`));
  const unnamed = pictures.find(path => !named.has(path));
  if (unnamed) refuse('kit_bad', unnamed, 'no slot of ui/kit.json names it');
  for (const path of named) {
    if (!files.has(path)) refuse('file_missing', path, 'ui/kit.json names it');
    const kind = path.endsWith('.png') ? 'png' : 'webp';
    const bytes = await files.read(path);
    if (bytes.length > THEME_FILE_LIMITS.kitBytes) refuse('file_too_large', path);
    pictureOf(path, kind, bytes);
    served.push(files.served(path, MEDIA[kind]));
  }
  return kit;
}

async function previewOf(files: Reader, served: ServedFile[]): Promise<void> {
  for (const path of files.under('preview/')) {
    const kind = path.endsWith('.png') ? 'png' : 'webp';
    const bytes = await files.read(path);
    if (bytes.length > THEME_FILE_LIMITS.previewBytes) refuse('file_too_large', path);
    pictureOf(path, kind, bytes, THEME_FILE_LIMITS.previewSide);
    served.push(files.served(path, MEDIA[kind]));
  }
  const covers = files.under('preview/cover.');
  if (covers.length > 1) refuse('too_many_of_kind', covers[1], 'one cover');
  const shots = files.under('preview/shot-').map(path => path.replace(/\.(?:png|webp)$/, ''));
  const twice = shots.find((shot, n) => shots.indexOf(shot) !== n);
  if (twice) refuse('too_many_of_kind', `${twice}.webp`, 'one picture for each shot');
}

/* The world: the art's pictures with their passports, then the pack and the art checks of the engine's own code. */
/* The world of an iso2d theme, checked whole. A world is kept only with all its own art: one that does not bring every
   picture its catalog requires is left out, its art not stored, and the theme is its interface alone, so no person gets
   a world of the engine's placeholders (docs/theme-archive.md, 4.2). */
async function worldOf(manifest: ThemeManifest, files: Reader, web: ThemeWebCheck, baseUrl: string, served: ServedFile[]): Promise<{ world: unknown; leftOut: ThemeWorldLeftOut | null } | null> {
  if (manifest.engine !== 'iso2d') return null;
  const world = await files.json('world/world.json', THEME_FILE_LIMITS.worldBytes);
  const art: ThemeArtFile[] = [];
  const kept: ServedFile[] = [];
  const all = files.under('world/art/').filter(path => files.kinds.get(path) !== 'index');
  for (const path of all.filter(name => name.endsWith('.png'))) {
    const bytes = await files.read(path);
    pictureOf(path, 'png', bytes);
    const passportPath = path.replace(/\.png$/, '.json');
    const passport = files.has(passportPath) ? await files.json(passportPath, THEME_FILE_LIMITS.passportBytes) : undefined;
    art.push({ path: path.slice('world/art/'.length), head: Buffer.from(bytes.subarray(0, 33)), ...(passport === undefined ? {} : { passport }) });
    kept.push(files.served(path, MEDIA.png));
    /* Each picture's whole walk costs the request's time: the next one waits for other requests first. */
    await new Promise(resolve => setImmediate(resolve));
  }
  for (const path of all.filter(name => name.endsWith('.json'))) {
    if (!files.has(path.replace(/\.json$/, '.png'))) refuse('file_place', path, 'a passport with no picture beside it');
    kept.push(files.served(path, MEDIA.json));
  }
  const checked = web.checkWorld({ id: manifest.id, world, baseUrl: `${baseUrl}world/art/`, art, files: all.map(path => path.slice('world/art/'.length)) });
  if (!checked.ok) refuse(checked.code, checked.code === 'world_bad' ? 'world/world.json' : 'world/art/', checked.detail);
  if (!checked.complete) return { world: null, leftOut: 'art_missing' };
  const index = Buffer.from(`${JSON.stringify(checked.artIndex)}\n`);
  served.push(...kept, { path: 'world/art/art-index.json', mediaType: MEDIA.json, size: index.length, read: () => Promise.resolve(index) });
  return { world: checked.world, leftOut: null };
}

async function skillsOf(manifest: ThemeManifest, files: Reader): Promise<WorldPackBehaviorSpec | null> {
  if (!files.has('skills/world.json')) return null;
  const skills = archiveWorldSkills(manifest.id, await files.json('skills/world.json'));
  return skills.ok ? skills.pack : refuse('skills_bad', 'skills/world.json', skills.detail);
}

async function textsOf(files: Reader, served: ServedFile[]): Promise<void> {
  const licence = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].filter(path => files.has(path));
  if (!licence.length) refuse('license_missing', 'LICENSE');
  if (licence.length > 1) refuse('too_many_of_kind', licence[1], 'one LICENSE');
  for (const path of [...licence, ...['ui/NOTES.md'].filter(name => files.has(name)), ...files.under('ui/fonts/').filter(name => name.endsWith('.txt'))]) {
    const bytes = await files.read(path);
    plainText(path, bytes);
    served.push(files.served(path, MEDIA.text));
  }
}

/* Checks a theme archive whole. baseUrl is where the theme's files will be served, ending in a slash. */
export async function checkThemeArchive(source: ZipSource, web: ThemeWebCheck, baseUrl: (manifest: ThemeManifest) => string, limits: ThemeLimits = THEME_LIMITS): Promise<CheckedTheme> {
  const zip = await openZip(source, limits);
  const byPath = rooted(zip);
  const kinds = new Map([...byPath.keys()].map(path => [path, kindOf(path)] as const));
  const files = new Reader(byPath, kinds);
  if (!files.has('theme.json')) refuse('theme_missing', 'theme.json');
  const manifest = parsed('theme.json', ThemeManifest, await files.json('theme.json'));
  engineRules(manifest, files);
  const served: ServedFile[] = [];
  await textsOf(files, served);
  const fonts = await fontsOf(files, served);
  if (!files.has('ui/look.json')) refuse('look_missing', 'ui/look.json');
  const look = web.checkLook(await files.json('ui/look.json'), [...new Set(fonts.map(face => face.family))]);
  if (!look.ok) refuse('look_bad', 'ui/look.json', look.detail);
  const kit = await kitOf(files, served);
  await previewOf(files, served);
  const world = await worldOf(manifest, files, web, baseUrl(manifest), served);
  /* The voice is checked either way, but a world left out takes its voice and era names with it. */
  const skills = await skillsOf(manifest, files);
  const leftOut = world?.leftOut ?? null;
  return {
    manifest, look: look.value, fonts, kit, world: world?.world ?? null, skills: leftOut ? null : skills, worldLeftOut: leftOut, files: served,
    size: served.reduce((sum, file) => sum + file.size, 0),
  };
}

