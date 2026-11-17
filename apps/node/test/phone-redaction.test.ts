import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { safeCapture } from '../src/phones/capture.js';

// A recorded UIAutomator tree, including a device that exposed a password's text in the tree.
const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hierarchy rotation="0"><node text="Sign in" content-desc="Continue &amp; sign in" resource-id="title" class="android.widget.TextView" package="com.android.chrome" password="false" focused="false" bounds="[0,0][3,1]"/><node text="SECRET_UNIQUE_MARKER" content-desc="SECRET_UNIQUE_MARKER" resource-id="password" class="android.widget.EditText" package="com.android.chrome" password="true" focused="true" bounds="[1,1][3,3]"/></hierarchy>UI hierchary dumped to: /dev/tty';

function chunk(kind: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length);
  out.write(kind, 4);
  data.copy(out, 8);
  let crc = 0xffffffff;
  for (const byte of out.subarray(4, -4)) {
    crc ^= byte;
    for (let n = 0; n < 8; n++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
  return out;
}

function samplePng(): Buffer {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(3); head.writeUInt32BE(3, 4); head[8] = 8; head[9] = 6;
  const pixels = Buffer.alloc(39, 255);
  for (let row = 0; row < 3; row++) pixels[row * 13] = 0;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', head),
    chunk('tEXt', Buffer.from('annotation\0SECRET_UNIQUE_MARKER')), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function pixelsOf(base64: string): number[] {
  const png = Buffer.from(base64, 'base64');
  const parts: Buffer[] = [];
  for (let at = 8; at + 12 <= png.length;) {
    const n = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') parts.push(png.subarray(at + 8, at + 8 + n));
    at += n + 12;
  }
  return [...inflateSync(Buffer.concat(parts))];
}

describe('phone captures before they leave the node', () => {
  it('rasterizes password masks and removes source metadata and password text', () => {
    const out = safeCapture(xml, samplePng());
    expect([out.width, out.height]).toEqual([3, 3]);
    expect(out.elements[0]!.description).toBe('Continue & sign in');
    expect(out.elements[1]!).toMatchObject({ text: '[hidden]', description: '[hidden]', password: true });
    expect(JSON.stringify(out)).not.toContain('SECRET_UNIQUE_MARKER');
    expect(Buffer.from(out.png!, 'base64').toString()).not.toContain('SECRET_UNIQUE_MARKER');
    expect(pixelsOf(out.png!)).toEqual([
      0, 255,255,255,255, 255,255,255,255, 255,255,255,255,
      0, 255,255,255,255, 0,0,0,255, 0,0,0,255,
      0, 255,255,255,255, 0,0,0,255, 0,0,0,255,
    ]);
  });

  it('masks the entire screen and tree when the screen changed during the capture', () => {
    const out = safeCapture(xml, samplePng(), true);
    expect(out.elements).toEqual([]);
    expect(out.masked).toBe(true);
    const pixels = pixelsOf(out.png!);
    expect(pixels.filter((_, i) => i % 13 !== 0 && (i % 13) % 4 !== 0).every(n => n === 0)).toBe(true);
  });

  it('fails closed on an untrusted tree, invalid PNG or out-of-screen password bounds', () => {
    expect(safeCapture('<!DOCTYPE x SYSTEM "file:///etc/passwd">', samplePng()).masked).toBe(true);
    expect(safeCapture(xml.replace('[1,1][3,3]', '[1,1][999,999]'), samplePng()).elements).toEqual([]);
    expect(safeCapture(xml, Buffer.from('not a PNG'))).toMatchObject({ png: null, elements: [], masked: true });
  });

  it('masks fields whose plain text was redacted even if the app did not mark them as a password', () => {
    const hide = (value: string) => value.replaceAll('SECRET_UNIQUE_MARKER', '[hidden]');
    const out = safeCapture(xml.replace('password="true"', 'password="false"'), samplePng(), false, hide);
    expect(JSON.stringify(out)).not.toContain('SECRET_UNIQUE_MARKER');
    expect(pixelsOf(out.png!).slice(18, 26)).toEqual([0,0,0,255,0,0,0,255]);
  });
});
