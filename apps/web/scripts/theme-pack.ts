/* Writes the archive of a theme Hornhoof ships (docs/theme-archive.md, 11), from the skin registry, its world pack and
   the server's world voice, in the format any theme author writes:
     npx tsx apps/web/scripts/theme-pack.ts cyberpunk --out cyberpunk.zip
     npx tsx apps/web/scripts/theme-pack.ts egypt --art <the Egypt art folder> --licence <its licence> --out egypt.zip
   A world whose art is licensed apart from the repository (#105) takes its art and its licence from outside it; without
   --art the world has no pictures, and the theme installs as its interface alone (docs/theme-archive.md, 4.2). */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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
export type PackOptions = Readonly<{ version?: string; art?: string | null; licence?: string | null; voice?: ThemeVoice | null }>;

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
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

/* The files of the archive of a built-in theme, by path. */
export function themeArchiveFiles(id: BuiltinSkinId, options: PackOptions = {}): Map<string, Buffer> {
  const skin: BuiltinSkin | undefined = BUILTIN_SKINS.find(one => one.id === id);
  if (!skin) throw new Error(`Hornhoof ships no theme "${id}".`);
  const pack = skin.world && skin.world !== 'standard' ? resolveWorldPack(skin.world) : null;
  const look: Record<string, unknown> = JSON.parse(JSON.stringify(skin)) as Record<string, unknown>;
  delete look.id;
  delete look.world;
  const files = new Map<string, Buffer>();
  files.set('theme.json', json(manifestOf(id, Boolean(pack), options)));
  files.set('LICENSE', options.licence ? readFileSync(options.licence) : readFileSync(join(REPO, 'LICENSE')));
  files.set('ui/look.json', json(look));
  if (pack) for (const [path, bytes] of worldFiles(pack, options)) files.set(path, bytes);
  return files;
}

function manifestOf(id: BuiltinSkinId, world: boolean, options: PackOptions): Record<string, unknown> {
  return {
    format: 1,
    id,
    name: { en: en.skins.names[id], ru: ru.skins.names[id] },
    description: { en: en.skins.descs[id], ru: ru.skins.descs[id] },
    version: options.version ?? '1.0.0',
    author: 'Hornhoof',
    license: options.licence ? 'see LICENSE' : 'MIT',
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
    console.log(`Usage: theme-pack.ts <${BUILTIN_SKINS.map(skin => skin.id).join(' | ')}> --out <file.zip> [--art <folder>] [--licence <file>] [--version <x.y.z>]`);
    return 2;
  }
  const zip = await packTheme(id as BuiltinSkinId, { art: flag(argv, '--art') ?? null, licence: flag(argv, '--licence') ?? null, ...(flag(argv, '--version') ? { version: flag(argv, '--version')! } : {}) });
  writeFileSync(out, zip);
  console.log(`${out}: ${zip.length} bytes`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
