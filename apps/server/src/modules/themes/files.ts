import { THEME_FILE_LIMITS, type ThemeProblemCode } from '@hornhoof/protocol/themes';
import { crc32 } from 'node:zlib';
import { ArchiveRefused } from './zip.js';

/* What each file of a theme archive is, from its place in the archive, and the proof from its own bytes that it is what
   its name says (docs/theme-archive.md, sections 1 and 9). A file with no place is refused; a script or a page is
   refused by name, wherever it stands. */

export type FileKind = 'json' | 'text' | 'png' | 'webp' | 'woff2' | 'index';
export type MediaType = 'application/json' | 'text/plain; charset=utf-8' | 'image/png' | 'image/webp' | 'font/woff2';

export const MEDIA: Readonly<Record<Exclude<FileKind, 'index'>, MediaType>> = {
  json: 'application/json',
  text: 'text/plain; charset=utf-8',
  png: 'image/png',
  webp: 'image/webp',
  woff2: 'font/woff2',
};

/* Throws, so a check that fails narrows the code after it. */
function refuse(code: ThemeProblemCode, path: string, detail?: string): never {
  throw new ArchiveRefused(detail === undefined ? { code, path } : { code, path, detail });
}

/* Files that run or render as a page in a browser, refused with their own reason so an author knows why. */
const SCRIPT = /\.(?:m?js|cjs|jsx|tsx?|wasm|html?|xhtml|xml|svgz?|css|php|sh|bat|cmd|exe|dll|so|dylib|jar|py|rb|pl)$/i;

const PLACES: readonly [RegExp, FileKind][] = [
  [/^theme\.json$/, 'json'],
  [/^LICENSE(?:\.md|\.txt)?$/, 'text'],
  [/^ui\/(?:look|fonts|kit)\.json$/, 'json'],
  [/^ui\/NOTES\.md$/, 'text'],
  [/^ui\/fonts\/[^/]+\.woff2$/, 'woff2'],
  [/^ui\/fonts\/[^/]+\.txt$/, 'text'],
  [/^ui\/kit\/[^/]+\.png$/, 'png'],
  [/^ui\/kit\/[^/]+\.webp$/, 'webp'],
  [/^world\/world\.json$/, 'json'],
  [/^world\/art\/art-index\.json$/, 'index'],
  [/^world\/art\/.+\.png$/, 'png'],
  [/^world\/art\/.+\.json$/, 'json'],
  [/^skills\/world\.json$/, 'json'],
  [/^preview\/(?:cover|shot-[1-6])\.png$/, 'png'],
  [/^preview\/(?:cover|shot-[1-6])\.webp$/, 'webp'],
];

export function kindOf(path: string): FileKind {
  if (SCRIPT.test(path)) refuse('file_script', path);
  const place = PLACES.find(([pattern]) => pattern.test(path));
  return place ? place[1] : refuse('file_place', path);
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type Picture = { width: number; height: number };

/* A PNG whose every chunk is whole with its checksum, from IHDR first to IEND last with nothing after it, in no more
   chunks than a picture has: a picture that carries another file behind it, or a walk of a million empty chunks, is not
   one. */
function pngSize(bytes: Buffer): Picture | null {
  if (!pngHead(bytes)) return null;
  let at = 8;
  let type = '';
  for (let chunks = 0; at + 12 <= bytes.length && type !== 'IEND'; chunks += 1) {
    const end = chunks < THEME_FILE_LIMITS.pngChunks ? chunkEnd(bytes, at) : null;
    if (end === null) return null;
    type = bytes.toString('latin1', at + 4, at + 8);
    at = end;
  }
  return type === 'IEND' && at === bytes.length ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
}

/* The signature of a PNG, then its IHDR chunk of 13 bytes. */
const pngHead = (bytes: Buffer) => bytes.length >= 45 && bytes.subarray(0, 8).equals(PNG) && bytes.toString('latin1', 12, 16) === 'IHDR' && bytes.readUInt32BE(8) === 13;

/* Where the chunk at `at` ends, when it is whole: a name of four letters, inside the file, and its checksum right. */
function chunkEnd(bytes: Buffer, at: number): number | null {
  const end = at + 12 + bytes.readUInt32BE(at);
  const named = /^[A-Za-z]{4}$/.test(bytes.toString('latin1', at + 4, at + 8));
  return named && end <= bytes.length && crc32(bytes.subarray(at + 4, end - 4)) >>> 0 === bytes.readUInt32BE(end - 4) ? end : null;
}

/* A WebP's canvas from its first chunk: lossy VP8, lossless VP8L or the extended VP8X. */
function webpSize(bytes: Buffer): Picture | null {
  if (bytes.length < 30 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') return null;
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) return null;
  return WEBP_CANVAS.get(bytes.toString('latin1', 12, 16))?.(bytes) ?? null;
}

/* The canvas each kind of first chunk gives, when its own signature is there. */
const WEBP_CANVAS = new Map<string, (bytes: Buffer) => Picture | null>([
  ['VP8 ', bytes => (bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a ? { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff } : null)],
  ['VP8L', bytes => (bytes[20] === 0x2f ? { width: (bytes.readUInt32LE(21) & 0x3fff) + 1, height: ((bytes.readUInt32LE(21) >>> 14) & 0x3fff) + 1 } : null)],
  ['VP8X', bytes => ({ width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 })],
]);

/* A picture whose bytes say it is one, no larger than the limits: a picture's size is what a browser unpacks it to. */
export function pictureOf(path: string, kind: 'png' | 'webp', bytes: Buffer, side: number = THEME_FILE_LIMITS.imageSide): Picture {
  const size = kind === 'png' ? pngSize(bytes) : webpSize(bytes);
  if (!size || size.width === 0 || size.height === 0) return refuse('file_bytes', path);
  if (size.width > side || size.height > side || size.width * size.height > THEME_FILE_LIMITS.imagePixels) refuse('image_too_large', path, `${size.width} x ${size.height}`);
  return size;
}

/* A WOFF2 font: its signature, and the length its header gives is its own. */
export function checkFont(path: string, bytes: Buffer): void {
  if (bytes.length < 48 || bytes.toString('latin1', 0, 4) !== 'wOF2' || bytes.readUInt32BE(8) !== bytes.length) refuse('file_bytes', path);
  if (bytes.length > THEME_FILE_LIMITS.fontBytes) refuse('file_too_large', path);
}

/* What text never holds, as no person sees it: control and format characters, private and unassigned code points,
   line and paragraph separators, characters a renderer ignores, variation selectors and the blank braille cell. A text
   file keeps its tabs and line breaks; a string of JSON is one line (NOT_ONE_LINE), so a voice line or a name never
   becomes a paragraph of its own where it is quoted. */
const UNSEEN = String.raw`\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Variation_Selector}\u2800`;
const NOT_PLAIN = new RegExp(String.raw`[^\P{Cc}\t\n\r]|[${UNSEEN}]`, 'u');
export const NOT_ONE_LINE = new RegExp(String.raw`[\p{Cc}${UNSEEN}]`, 'u');

export function plainText(path: string, bytes: Buffer, limit: number = THEME_FILE_LIMITS.textBytes): string {
  if (bytes.length > limit) refuse('file_too_large', path);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return refuse('text_not_plain', path);
  }
  if (NOT_PLAIN.test(text)) refuse('text_not_plain', path);
  return text;
}

/* A string that would take a browser somewhere: an address with a scheme or www. anywhere in it, a value that is a
   scheme a browser runs or opens (javascript:, data: and the like), a path from the root of another host, or a way out of
   the folder it stands in. Words such as "Tip: ..." are no link. */
const LINK = /(?:^|[^A-Za-z0-9])(?:[a-z][a-z0-9+.-]{0,31}:\/\/|www\.)|^\s*(?:javascript|data|vbscript|blob|file|mailto|about|filesystem):|^\s*(?:\/\/|\\\\)/i;
const KEYS_NEVER = ['__proto__', 'constructor', 'prototype'];
const DEEPEST = 32;

/* Every string of a JSON value, and every key, held to one line of plain text with no link in it; no key reaches a
   prototype. A string longer than any label is refused before a pattern reads it, so no string costs the server time. */
function plainJson(path: string, root: unknown): void {
  const stack: [unknown, string, number][] = [[root, '', 0]];
  for (let next = stack.pop(); next; next = stack.pop()) {
    const [value, where, depth] = next;
    if (depth > DEEPEST) refuse('json_shape', path, `${placeIn(where)} goes deeper than ${DEEPEST} levels`);
    if (typeof value === 'string') plainString(path, value, where);
    if (typeof value !== 'object' || value === null) continue;
    for (const key of Object.keys(value)) {
      const at = where ? `${where}.${key}` : key;
      plainKey(path, key, at);
      stack.push([(value as Record<string, unknown>)[key], at, depth + 1]);
    }
  }
}

const placeIn = (where: string) => where || 'the file';

/* One string of a JSON file: no longer than a label, one line of plain text, with no link in it. */
function plainString(path: string, value: string, where: string): void {
  if (value.length > THEME_FILE_LIMITS.jsonText) refuse('json_shape', path, `${placeIn(where)}: longer than ${THEME_FILE_LIMITS.jsonText} characters`);
  if (NOT_ONE_LINE.test(value) || /[<>]/.test(value)) refuse('text_not_plain', path, where);
  if (LINK.test(value) || value.includes('../')) refuse('link_outside', path, where);
}

/* One key of a JSON object: a short line of plain text that reaches no prototype. */
function plainKey(path: string, key: string, at: string): void {
  if (KEYS_NEVER.includes(key) || key.length > THEME_FILE_LIMITS.jsonText || NOT_ONE_LINE.test(key)) refuse('json_shape', path, at.slice(0, THEME_FILE_LIMITS.shown));
}

export function jsonOf(path: string, bytes: Buffer, limit: number = THEME_FILE_LIMITS.jsonBytes): unknown {
  if (bytes.length > limit) refuse('file_too_large', path);
  const text = plainText(path, bytes, limit);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refuse('json_bad', path);
  }
  plainJson(path, value);
  return value;
}
