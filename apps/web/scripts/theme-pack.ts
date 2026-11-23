/* Writes the archive of a theme Hornhoof ships (docs/theme-archive.md, 11), from the skin registry, its world pack and
   the server's world voice, in the format any theme author writes:
     npx tsx apps/web/scripts/theme-pack.ts cyberpunk --out cyberpunk.zip
     npx tsx apps/web/scripts/theme-pack.ts egypt --art <the Egypt art folder> --licence <its licence> --out egypt.zip
     npx tsx apps/web/scripts/theme-pack.ts egypt --kit <a kit's pack folder> --fonts <a fonts folder> \
       --display-font "El Messiri" --body-font "Fira Sans" [--id egypt-gold --name-en ... --name-ru ...] --out egypt.zip
   A world whose art is licensed apart from the repository (#105) takes its art and its licence from outside it; without
   --art the world has no pictures, and the theme installs as its interface alone (docs/theme-archive.md, 4.2). A painted
   kit (#1970) comes from outside the repository too: --kit names its pack folder (kit.json beside its pictures, and its
   LICENSE.md, the theme's licence unless --licence gives one), and --fonts a folder of fonts.json in the archive's form,
   the font files it names and their *-OFL.txt licences; the fonts head the look's display and body stacks. --id and the
   names pack a second theme of the same look, such as a second kit of it. */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { BUILTIN_SKINS, type BuiltinSkin, type BuiltinSkinId } from '../src/skins/registry';
import { dataOfWorldPack } from '../src/world-packs/data-pack';
import { resolveWorldPack } from '../src/world-packs/registry';
import type { WorldPackManifest } from '../src/world/manifest';

type Lang = Readonly<{ en: string; ru: string }>;
/* The words of a world's voice and its era names, as skills/world.json holds them. */
export type ThemeVoice = Readonly<{ label: Lang; address: Lang; salutations: readonly string[]; names: Readonly<{ ruler: Lang; employees: Readonly<{ en: readonly string[]; ru: readonly string[] }> }> }>;
export type PackOptions = Readonly<{
  version?: string; art?: string | null; licence?: string | null; voice?: ThemeVoice | null;
  kit?: string | null; fonts?: string | null; displayFont?: string; bodyFont?: string; id?: string; names?: Lang;
}>;

/* From this file's own path: Vite reads new URL(..., import.meta.url) as a web asset when the screens' tests load it. */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/* The server's world voice of a pack it ships, read from its source: the web's type check covers web files only. */
type ServerPacks = { defaultWorldPacks: () => ReadonlyMap<string, { label: Lang; skills: readonly { voice?: { samples: Lang; salutations: readonly string[] } }[]; names: ThemeVoice['names'] }> };
export async function shippedVoice(id: string): Promise<ThemeVoice | null> {
  const server = (await import(pathToFileURL(join(REPO, 'apps/server/src/modules/world/packs/index.ts')).href)) as ServerPacks;
  const pack = server.defaultWorldPacks().get(id);
  const voice = pack?.skills.find(skill => skill.voice)?.voice;
  return pack && voice ? { label: pack.label, address: voice.samples, salutations: voice.salutations, names: pack.names } : null;
}

/* Every picture and passport of an art folder, under world/art/, as the art check reads a folder; Hornhoof writes the
   art index itself when the theme is installed. */
function artFiles(folder: string): [string, Buffer][] {
  const found: [string, Buffer][] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if ((name.endsWith('.png') || name.endsWith('.json')) && name !== 'art-index.json') found.push([`world/art/${relative(folder, path).split(sep).join('/')}`, readFileSync(path)]);
    }
  };
  walk(folder);
  return found;
}

/* A kit's pack folder: its kit.json as ui/kit.json, each picture a slot names under ui/kit/, and its licence. */
function kitFiles(folder: string): { files: [string, Buffer][]; licence: Buffer | null } {
  const manifest = readFileSync(join(folder, 'kit.json'));
  const kit = JSON.parse(manifest.toString('utf8')) as { slots?: Record<string, { file?: string }> };
  const pictures = [...new Set(Object.values(kit.slots ?? {}).map(slot => slot.file).filter((file): file is string => typeof file === 'string'))];
  const missing = pictures.filter(file => !existsSync(join(folder, file)));
  if (missing.length) throw new Error(`The kit's kit.json names pictures its folder does not have: ${missing.join(', ')}`);
  const licence = ['LICENSE.md', 'LICENSE', 'LICENSE.txt'].map(name => join(folder, name)).find(path => existsSync(path));
  return { files: [['ui/kit.json', manifest], ...pictures.sort().map((file): [string, Buffer] => [`ui/kit/${file}`, readFileSync(join(folder, file))])], licence: licence ? readFileSync(licence) : null };
}

/* A fonts folder: fonts.json as ui/fonts.json, each file a face names, and the fonts' OFL texts beside them. */
function fontFiles(folder: string): { files: [string, Buffer][]; families: Set<string> } {
  const manifest = readFileSync(join(folder, 'fonts.json'));
  const { faces } = JSON.parse(manifest.toString('utf8')) as { faces: { family: string; file: string }[] };
  const named = [...new Set(faces.map(face => face.file))].sort();
  const missing = named.filter(file => !existsSync(join(folder, file)));
  if (missing.length) throw new Error(`fonts.json names fonts its folder does not have: ${missing.join(', ')}`);
  const licences = readdirSync(folder).filter(name => name.endsWith('-OFL.txt')).sort();
  return {
    files: [['ui/fonts.json', manifest], ...[...named, ...licences].map((file): [string, Buffer] => [`ui/fonts/${file}`, readFileSync(join(folder, file))])],
    families: new Set(faces.map(face => face.family)),
  };
}

/* A stack headed by a font the archive brings, the rest of it as the skin has it. */
function headed(stack: unknown, family: string | undefined, families: ReadonlySet<string>): unknown {
  if (!family) return stack;
  if (!families.has(family)) throw new Error(`"${family}" is not a family of the fonts' fonts.json`);
  return [family, ...(stack as string[]).filter(font => font !== family)];
}

/* The files of the archive of a built-in theme, by path. */
export function themeArchiveFiles(id: BuiltinSkinId, options: PackOptions = {}): Map<string, Buffer> {
  const skin: BuiltinSkin | undefined = BUILTIN_SKINS.find(one => one.id === id);
  if (!skin) throw new Error(`Hornhoof ships no theme "${id}".`);
  const pack = skin.world && skin.world !== 'standard' ? resolveWorldPack(skin.world) : null;
  const look: Record<string, unknown> = JSON.parse(JSON.stringify(skin)) as Record<string, unknown>;
  delete look.id;
  delete look.world;
  const kit = options.kit ? kitFiles(options.kit) : null;
  const fonts = options.fonts ? fontFiles(options.fonts) : null;
  if ((options.displayFont || options.bodyFont) && !fonts) throw new Error('--display-font and --body-font name fonts that --fonts brings');
  if (fonts) {
    const stacks = look.fonts as Record<string, unknown>;
    look.fonts = { ...stacks, display: headed(stacks.display, options.displayFont, fonts.families), body: headed(stacks.body, options.bodyFont, fonts.families) };
  }
  const licence = options.licence ? readFileSync(options.licence) : kit?.licence ?? null;
  const files = new Map<string, Buffer>();
  files.set('theme.json', json(manifestOf(id, Boolean(pack), Boolean(licence), options)));
  files.set('LICENSE', licence ?? readFileSync(join(REPO, 'LICENSE')));
  files.set('ui/look.json', json(look));
  for (const [path, bytes] of [...(fonts?.files ?? []), ...(kit?.files ?? [])]) files.set(path, bytes);
  if (pack) for (const [path, bytes] of worldFiles(pack, options)) files.set(path, bytes);
  return files;
}

function manifestOf(id: BuiltinSkinId, world: boolean, ownLicence: boolean, options: PackOptions): Record<string, unknown> {
  return {
    format: 1,
    id: options.id ?? id,
    name: options.names ?? { en: en.skins.names[id], ru: ru.skins.names[id] },
    description: { en: en.skins.descs[id], ru: ru.skins.descs[id] },
    version: options.version ?? '1.0.0',
    author: 'Hornhoof',
    license: ownLicence ? 'see LICENSE' : 'MIT',
    contract: world ? { ui: 1, world: 2 } : { ui: 1 },
    engine: world ? 'iso2d' : 'none',
    languages: ['en', 'ru'],
  };
}

/* A world's data, its art when it is given from outside the repository, and its voice. */
function worldFiles(pack: WorldPackManifest, options: PackOptions): [string, Buffer][] {
  return [
    ['world/world.json', json(dataOfWorldPack(pack))],
    ...(options.art ? artFiles(options.art) : []),
    ...(options.voice ? [['skills/world.json', json(options.voice)] as [string, Buffer]] : []),
  ];
}

/* A plain zip of the files, deflated, with no dates, so the same theme always packs to the same bytes. */
export function zipOf(files: ReadonlyMap<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, data] of files) {
    const name = Buffer.from(path, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const sum = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, name, packed);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/* The archive of a built-in theme, with its world's voice from the server when it has one. */
export async function packTheme(id: BuiltinSkinId, options: PackOptions = {}): Promise<Buffer> {
  const voice = options.voice === undefined ? await shippedVoice(id) : options.voice;
  return zipOf(themeArchiveFiles(id, { ...options, voice }));
}

const flag = (argv: readonly string[], name: string) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};

export async function main(argv: readonly string[]): Promise<number> {
  const [id] = argv;
  const out = flag(argv, '--out');
  if (!id || !out || !BUILTIN_SKINS.some(skin => skin.id === id)) {
    console.log(`Usage: theme-pack.ts <${BUILTIN_SKINS.map(skin => skin.id).join(' | ')}> --out <file.zip> [--art <folder>] [--licence <file>] [--version <x.y.z>]`
      + ' [--kit <pack folder>] [--fonts <folder> --display-font <family> --body-font <family>] [--id <id> --name-en <name> --name-ru <name>]');
    return 2;
  }
  const [nameEn, nameRu] = [flag(argv, '--name-en'), flag(argv, '--name-ru')];
  if (flag(argv, '--id') && (!nameEn || !nameRu)) {
    console.log('A theme of its own id needs its names: --name-en and --name-ru.');
    return 2;
  }
  const zip = await packTheme(id as BuiltinSkinId, {
    art: flag(argv, '--art') ?? null, licence: flag(argv, '--licence') ?? null, kit: flag(argv, '--kit') ?? null, fonts: flag(argv, '--fonts') ?? null,
    ...(flag(argv, '--version') ? { version: flag(argv, '--version')! } : {}),
    ...(flag(argv, '--display-font') ? { displayFont: flag(argv, '--display-font')! } : {}),
    ...(flag(argv, '--body-font') ? { bodyFont: flag(argv, '--body-font')! } : {}),
    ...(flag(argv, '--id') ? { id: flag(argv, '--id')!, names: { en: nameEn!, ru: nameRu! } } : {}),
  });
  writeFileSync(out, zip);
  console.log(`${out}: ${zip.length} bytes`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
