import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { zipOf } from './zip-fixture.js';

/* A synthetic theme archive, made of nothing but test data (#62, #105): a look from a built-in skin, a font and a kit
   picture that are only their headers' truth, and for a theme with a world the data of a pack Hornhoof ships. */

export type ThemeFiles = Record<string, Buffer | string>;

const web = <T>(path: string) => import(pathToFileURL(fileURLToPath(new URL(`../../web/src/${path}`, import.meta.url))).href) as Promise<T>;

/* A whole PNG of one colour: IHDR, the scanlines deflated, IEND. */
export function png(width: number, height: number, after: Buffer = Buffer.alloc(0)): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Math.min(height, 64);
  const lines = Buffer.alloc(rows * (1 + Math.min(width, 64) * 4), 0x80);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(lines)), chunk('IEND', Buffer.alloc(0)), after]);
}

/* A lossless WebP: its RIFF size, and the canvas its VP8L chunk gives. */
export function webp(width: number, height: number): Buffer {
  const chunk = Buffer.alloc(14);
  chunk.write('VP8L', 0, 'latin1');
  chunk.writeUInt32LE(6, 4);
  chunk[8] = 0x2f;
  chunk.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 9);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + chunk.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, chunk, Buffer.alloc(4)]);
}

/* A WOFF2 header, its signature and its length: what the server checks of a font. */
export function woff2(size = 64): Buffer {
  const bytes = Buffer.alloc(size);
  bytes.write('wOF2', 0, 'latin1');
  bytes.writeUInt32BE(size, 8);
  return bytes;
}

/* A built-in skin's look as ui/look.json holds it. */
export async function lookOf(skin: string): Promise<Record<string, unknown>> {
  const { builtinSkin } = await web<{ builtinSkin: (id: string) => object | undefined }>('skins/registry.ts');
  const look = JSON.parse(JSON.stringify(builtinSkin(skin))) as Record<string, unknown>;
  delete look.id;
  delete look.world;
  return look;
}

/* A shipped pack's world as world/world.json holds it. */
export async function worldOf(pack: string): Promise<Record<string, unknown>> {
  const registry = await web<{ resolveWorldPack: (id: string) => object | null }>('world-packs/registry.ts');
  const data = await web<{ dataOfWorldPack: (pack: object) => Record<string, unknown> }>('world-packs/data-pack.ts');
  return data.dataOfWorldPack(registry.resolveWorldPack(pack)!);
}

export const SKILLS = {
  label: { en: 'Night shift', ru: 'Ночная смена' },
  address: { en: 'Good evening, chief', ru: 'Добрый вечер, шеф' },
  salutations: ['Good evening'],
  names: { ruler: { en: 'Chief', ru: 'Шеф' }, employees: { en: ['Ada', 'Bo'], ru: ['Ада', 'Бо'] } },
};

/* The files of a theme with no world, and of one with a world: whole and correct, for a test to change one thing. */
export async function plainTheme(): Promise<ThemeFiles> {
  return {
    'theme.json': JSON.stringify({
      format: 1, id: 'night-shift', name: { en: 'Night shift', ru: 'Ночная смена' }, description: { en: 'A synthetic test theme.', ru: 'Тестовая тема.' },
      version: '1.0.0', author: 'Hornhoof tests', license: 'CC0-1.0', contract: { ui: 1 }, engine: 'none', languages: ['en', 'ru'],
    }),
    LICENSE: 'Synthetic test data, CC0-1.0.\n',
    'ui/look.json': JSON.stringify({ ...(await lookOf('pixel')), fonts: { ...((await lookOf('pixel')).fonts as object), body: ['Night Sans', 'sans-serif'] } }),
    'ui/fonts.json': JSON.stringify({ faces: [{ family: 'Night Sans', file: 'night-sans.woff2', weight: 400, style: 'normal' }] }),
    'ui/fonts/night-sans.woff2': woff2(),
    'ui/fonts/OFL.txt': 'Synthetic font licence.\n',
    'ui/kit.json': JSON.stringify({ slots: { card: { file: 'panel.png', slice: '8 8 8 8 fill', width: '8px' } } }),
    'ui/kit/panel.png': png(32, 32),
    'ui/NOTES.md': 'Notes for the next author.\n',
    'preview/cover.png': png(640, 360),
    'preview/shot-1.png': png(1280, 720),
  };
}

export async function worldTheme(pack = 'dungeon'): Promise<ThemeFiles> {
  const plain = await plainTheme();
  const manifest = JSON.parse(String(plain['theme.json'])) as Record<string, unknown>;
  return {
    ...plain,
    'theme.json': JSON.stringify({ ...manifest, engine: 'iso2d', contract: { ui: 1, world: 2 } }),
    'world/world.json': JSON.stringify(await worldOf(pack)),
    'world/art/loose/one.png': png(16, 16),
    'skills/world.json': JSON.stringify(SKILLS),
  };
}

export const archiveOf = (files: ThemeFiles, folder = '') => zipOf(Object.entries(files).map(([name, data]) => ({ name: folder + name, data })));
