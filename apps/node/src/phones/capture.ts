import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { SaxesParser } from 'saxes';
import type { PhoneCapture, PhoneElement } from '@hornhoof/protocol';
export type { PhoneCapture, PhoneElement } from '@hornhoof/protocol';

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const MAX_PIXELS = 12_000_000;
const MAX_TREE_BYTES = 2 * 1024 * 1024;
type Rect = PhoneElement['bounds'];

/* UIAutomator owns this XML. DTDs, entities, malformed trees and uncertain bounds hide the whole capture. */
export function parsePhoneTree(raw: string): PhoneElement[] {
  if (Buffer.byteLength(raw) > MAX_TREE_BYTES || /<!/.test(raw)) throw new Error('phone_tree_invalid');
  const start = raw.indexOf('<hierarchy');
  const end = raw.lastIndexOf('</hierarchy>');
  if (start < 0 || end < start) throw new Error('phone_tree_invalid');
  const xml = raw.slice(start, end + '</hierarchy>'.length);
  const tag = createHash('sha256').update(xml).digest('hex').slice(0, 16);
  const elements: PhoneElement[] = [];
  let depth = 0;
  const parser = new SaxesParser({ xmlns: false });
  parser.on('error', () => { throw new Error('phone_tree_invalid'); });
  parser.on('text', text => { if (text.trim()) throw new Error('phone_tree_invalid'); });
  parser.on('opentag', node => {
    if ((depth === 0 && node.name !== 'hierarchy') || (depth > 0 && node.name !== 'node')) throw new Error('phone_tree_invalid');
    depth++;
    if (depth === 1) return;
    if (elements.length >= 5000) throw new Error('phone_tree_invalid');
    const a = node.attributes;
    const bounds = /^\[(\d{1,5}),(\d{1,5})\]\[(\d{1,5}),(\d{1,5})\]$/.exec(a.bounds ?? '');
    if (!bounds || !['true', 'false'].includes(a.password ?? '')) throw new Error('phone_tree_invalid');
    const rect: Rect = [Number(bounds[1]), Number(bounds[2]), Number(bounds[3]), Number(bounds[4])];
    if (rect[2] < rect[0] || rect[3] < rect[1]) throw new Error('phone_tree_invalid');
    elements.push({
      ref: `${tag}:${elements.length}`, text: (a.text ?? '').slice(0, 4096), description: (a['content-desc'] ?? '').slice(0, 4096),
      resource: (a['resource-id'] ?? '').slice(0, 256), package: (a.package ?? '').slice(0, 256), class: (a.class ?? '').slice(0, 256),
      password: a.password === 'true', focused: a.focused === 'true', editable: /(?:EditText|AutoCompleteTextView)$/.test(a.class ?? ''), bounds: rect,
    });
  });
  parser.on('closetag', () => { depth--; });
  parser.write(xml).close();
  if (!elements.length || depth !== 0) throw new Error('phone_tree_invalid');
  return elements;
}

/* Inspect the allocation size before any decompressor sees untrusted image bytes. */
function imageSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 33 || png.length > 8 * 1024 * 1024 || !png.subarray(0, 8).equals(SIGNATURE) || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  return width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= MAX_PIXELS ? { width, height } : null;
}

function readPixels(png: Buffer, width: number, height: number): Buffer {
  if (png[24] !== 8 || ![2, 6].includes(png[25]!) || png[28] !== 0) throw new Error('phone_png_unsupported');
  const compressed: Buffer[] = [];
  let at = 8;
  let ended = false;
  while (at + 12 <= png.length) {
    const length = png.readUInt32BE(at);
    const kind = png.toString('ascii', at + 4, at + 8);
    if (at + length + 12 > png.length || (kind === 'IHDR' && at !== 8)) throw new Error('phone_png_invalid');
    if (kind === 'IDAT') compressed.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
    if (kind === 'IEND') { ended = true; break; }
  }
  if (!ended || at !== png.length) throw new Error('phone_png_invalid');
  const expected = height * (width * (png[25] === 6 ? 4 : 3) + 1);
  if (inflateSync(Buffer.concat(compressed), { maxOutputLength: expected }).length !== expected) throw new Error('phone_png_invalid');
  return PNG.sync.read(png, { checkCRC: true }).data;
}

function paint(data: Buffer, width: number, rect: Rect): void {
  for (let y = rect[1]; y < rect[3]; y++) {
    for (let x = rect[0]; x < rect[2]; x++) {
      const at = (y * width + x) * 4;
      data.fill(0, at, at + 3);
      data[at + 3] = 255;
    }
  }
}

function cleaned(element: PhoneElement, hide: (text: string) => string): { element: PhoneElement; secret: boolean } {
  const out = { ...element, text: hide(element.text), description: hide(element.description), resource: hide(element.resource), package: hide(element.package), class: hide(element.class) };
  const secret = element.password || out.text !== element.text || out.description !== element.description || out.resource !== element.resource || out.class !== element.class || out.package !== element.package;
  if (element.password) { out.text = '[hidden]'; out.description = '[hidden]'; }
  return { element: out, secret };
}

export function safeCapture(xml: string, png: Buffer, blocked = false, hide: (text: string) => string = text => text): PhoneCapture {
  const size = imageSize(png);
  if (!size) return { png: null, width: 0, height: 0, elements: [], masked: true };
  const { width, height } = size;
  let elements: PhoneElement[] = [];
  const masks: Rect[] = [];
  let pixels: Buffer;
  try {
    if (blocked) throw new Error('phone_capture_uncertain');
    const raw = parsePhoneTree(xml);
    for (const item of raw) {
      if (item.bounds[2] > width || item.bounds[3] > height) throw new Error('phone_bounds_unknown');
      const safe = cleaned(item, hide);
      elements.push(safe.element);
      if (safe.secret) masks.push(item.bounds);
    }
    pixels = readPixels(png, width, height);
  } catch {
    blocked = true;
    elements = [];
    pixels = Buffer.alloc(width * height * 4);
    masks.push([0, 0, width, height]);
  }
  for (const rect of masks) paint(pixels, width, rect);
  // Only newly encoded pixels leave this function. PNG text, source chunks and original bytes are never retained.
  const image = new PNG();
  Object.assign(image, { width, height, data: pixels });
  const output = PNG.sync.write(image, { colorType: 6, bitDepth: 8, filterType: 0, deflateLevel: 6 });
  return { png: output.toString('base64'), width, height, elements, masked: blocked || masks.length > 0 };
}
