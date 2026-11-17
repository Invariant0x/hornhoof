import { createHash } from 'node:crypto';
import { SaxesParser } from 'saxes';
import { PHONE_FRAME_MAX, type PhoneCapture, type PhoneElement } from '@hornhoof/protocol';
export type { PhoneCapture, PhoneElement } from '@hornhoof/protocol';

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const MAX_TREE_BYTES = 2 * 1024 * 1024;
type Rect = PhoneElement['bounds'];

/* UIAutomator owns this XML. DTDs, entities, malformed trees and uncertain bounds give no tree. */
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

/* The screen as the phone shows it, as a person holding it would see it. A screen with no readable tree still shows, and
   one whose picture is too large to send, as a photo on the home screen, still gives its elements. */
export function phoneCapture(xml: string, png: Buffer): PhoneCapture {
  let elements: PhoneElement[] = [];
  try { elements = parsePhoneTree(xml); } catch { /* No tree, the picture alone. */ }
  const picture = png.length >= 24 && Math.ceil(png.length / 3) * 4 <= PHONE_FRAME_MAX && png.subarray(0, 8).equals(SIGNATURE) && png.toString('ascii', 12, 16) === 'IHDR';
  return picture ? { png: png.toString('base64'), width: png.readUInt32BE(16), height: png.readUInt32BE(20), elements } : { png: null, width: 0, height: 0, elements };
}
