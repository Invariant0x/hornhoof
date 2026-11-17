import { createHash } from 'node:crypto';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { SaxesParser } from 'saxes';
import type { PhoneCapture, PhoneElement } from '@hornhoof/protocol';
export type { PhoneCapture, PhoneElement } from '@hornhoof/protocol';

/* A model sees a picture best at this size on its long side; a larger one costs more and shows it nothing more. */
const LONG_SIDE = 1568;
const MAX_TREE_BYTES = 2 * 1024 * 1024;
type Rect = PhoneElement['bounds'];

/* UIAutomator owns this XML. DTDs, entities, malformed trees and uncertain bounds give no tree. */
function parsePhoneTree(raw: string): PhoneElement[] {
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

/* The screen as a person holding the phone sees it: a JPEG of at most 1568 px on its long side, with the elements in its
   pixels; scale turns them back into the phone's. A screen with no readable tree still shows, and one with no readable
   picture still gives its elements in the phone's pixels. */
export function phoneCapture(xml: string, png: Buffer): { capture: PhoneCapture; scale: number } {
  let elements: PhoneElement[] = [];
  try { elements = parsePhoneTree(xml); } catch { /* No tree, the picture alone. */ }
  let screen: PNG;
  try { screen = PNG.sync.read(png); } catch { return { capture: { jpeg: null, width: 0, height: 0, elements }, scale: 1 }; }
  const scale = Math.max(1, screen.width / LONG_SIDE, screen.height / LONG_SIDE);
  const width = Math.round(screen.width / scale), height = Math.round(screen.height / scale);
  const picture = jpeg.encode({ data: shrink(screen, width, height), width, height }, 80).data;
  const at = (n: number) => Math.round(n / scale);
  return { capture: { jpeg: picture.toString('base64'), width, height, elements: elements.map(e => ({ ...e, bounds: [at(e.bounds[0]), at(e.bounds[1]), at(e.bounds[2]), at(e.bounds[3])] })) }, scale };
}

/* Each pixel of the smaller picture is the average of the screen's pixels under it, so small text stays readable. */
function shrink(screen: PNG, width: number, height: number): Buffer {
  if (width === screen.width && height === screen.height) return screen.data;
  const from = screen.data, to = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const top = Math.floor(y * screen.height / height), bottom = Math.max(top + 1, Math.floor((y + 1) * screen.height / height));
    for (let x = 0; x < width; x++) {
      const left = Math.floor(x * screen.width / width), right = Math.max(left + 1, Math.floor((x + 1) * screen.width / width));
      let r = 0, g = 0, b = 0;
      for (let sy = top; sy < bottom; sy++) for (let sx = left; sx < right; sx++) {
        const i = (sy * screen.width + sx) * 4;
        r += from[i]!; g += from[i + 1]!; b += from[i + 2]!;
      }
      const n = (bottom - top) * (right - left), o = (y * width + x) * 4;
      to[o] = Math.round(r / n); to[o + 1] = Math.round(g / n); to[o + 2] = Math.round(b / n); to[o + 3] = 255;
    }
  }
  return to;
}
