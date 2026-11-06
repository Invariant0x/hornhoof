import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pngOutputDimensions } from '../src/test-output-png.js';

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
function chunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length); bytes.write(type, 4, 4, 'ascii'); data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4);
  return bytes;
}
function header(width = 1, height = 1, depth = 8, color = 6, interlace = 0): Buffer {
  const bytes = Buffer.alloc(13);
  bytes.writeUInt32BE(width); bytes.writeUInt32BE(height, 4);
  bytes[8] = depth; bytes[9] = color; bytes[12] = interlace;
  return bytes;
}
const rgba = Buffer.from([0, 12, 34, 56, 255]);
const png = (ihdr: Buffer = header(), raw: Buffer = rgba, before: Buffer[] = [], after: Buffer[] = []): Buffer =>
  Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), ...before, chunk('IDAT', deflateSync(raw)), ...after, chunk('IEND')]);

describe('static PNG diagnostic content', () => {
  it.each([
    { name: 'one RGBA pixel', ihdr: header(), raw: rgba },
    { name: 'RGB pixel', ihdr: header(1, 1, 8, 2), raw: Buffer.from([0, 12, 34, 56]) },
    { name: 'one-bit grayscale', ihdr: header(1, 1, 1, 0), raw: Buffer.from([0, 0x80]) },
    { name: 'grayscale alpha', ihdr: header(1, 1, 8, 4), raw: Buffer.from([0, 50, 255]) },
    { name: 'sixteen-bit RGBA', ihdr: header(1, 1, 16, 6), raw: Buffer.alloc(9) },
    { name: 'small Adam7 image', ihdr: header(1, 1, 8, 6, 1), raw: rgba },
  ])('accepts decoded $name', ({ ihdr, raw }) => {
    expect(pngOutputDimensions(png(ihdr, raw))).toEqual({ width: 1, height: 1 });
  });
  it('checks every Adam7 pass and reports the full image dimensions', () => {
    // The seven reduced images of an 8x8 RGBA image have these literal row sizes/counts.
    const raw = Buffer.concat([Buffer.alloc(5), Buffer.alloc(5), Buffer.alloc(9), Buffer.alloc(18), Buffer.alloc(34), Buffer.alloc(68), Buffer.alloc(132)]);
    expect(pngOutputDimensions(png(header(8, 8, 8, 6, 1), raw))).toEqual({ width: 8, height: 8 });
    expect(pngOutputDimensions(png(header(8, 8, 8, 6, 1), Buffer.alloc(264)))).toBeNull();
  });
  it.each([0, 1, 2, 3, 4])('decodes indexed scanline filter %s before checking palette indices', filter => {
    const palette = chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255]));
    const encoded = [0x40, 0x40, 0, 0x20, 0][filter]!;
    expect(pngOutputDimensions(png(header(2, 2, 1, 3), Buffer.from([0, 0x40, filter, encoded]), [palette]))).toEqual({ width: 2, height: 2 });
  });
  it.each([
    { name: 'wraps a restored Sub sample into the actual palette', raw: [1, 1, 255], want: { width: 2, height: 1 } },
    { name: 'refuses a restored Sub sample outside the actual palette', raw: [1, 1, 1], want: null },
  ])('$name', ({ raw, want }) => {
    const palette = chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255]));
    expect(pngOutputDimensions(png(header(2, 1, 8, 3), Buffer.from(raw), [palette]))).toEqual(want);
  });
  it.each([
    { name: 'left', raw: [0, 1, 1, 4, 255, 4] },
    { name: 'up', raw: [0, 1, 0, 4, 0, 4] },
    { name: 'corner', raw: [0, 1, 2, 4, 255, 3] },
    { name: 'left wins its tie with corner', raw: [0, 3, 4, 4, 254, 3] },
    { name: 'up wins its tie with corner', raw: [0, 3, 1, 4, 1, 3] },
  ])('accepts independently filtered palette rows when Paeth selects $name', ({ raw }) => {
    expect(pngOutputDimensions(png(header(2, 2, 8, 3), Buffer.from(raw), [chunk('PLTE', Buffer.alloc(15))]))).toEqual({ width: 2, height: 2 });
  });
  it.each([
    { name: 'left', raw: [0, 0, 2, 4, 2, 3] },
    { name: 'up', raw: [0, 0, 2, 4, 0, 3] },
    { name: 'corner', raw: [0, 2, 1, 4, 1, 3] },
  ])('refuses a palette overflow exposed only after Paeth selects $name', ({ raw }) => {
    expect(pngOutputDimensions(png(header(2, 2, 8, 3), Buffer.from(raw), [chunk('PLTE', Buffer.alloc(15))]))).toBeNull();
  });
  it('resets indexed previous-row state for each nonempty Adam7 pass', () => {
    // 2x2 uses passes 1, 6 and 7; Up on each first row must see a zero previous row.
    const raw = Buffer.from([0, 1, 2, 1, 2, 1, 1]);
    expect(pngOutputDimensions(png(header(2, 2, 8, 3, 1), raw, [chunk('PLTE', Buffer.alloc(6))]))).toEqual({ width: 2, height: 2 });
  });
  it.each([
    { extra: 0, want: { width: 1, height: 1 } }, { extra: 1, want: null },
  ])('enforces the encoded byte ceiling on a fully formed PNG with $extra extra bytes', ({ extra, want }) => {
    const limit = 50 * 1024 * 1024;
    const padding = chunk('raNd', Buffer.alloc(limit + extra - png().length - 12));
    expect(pngOutputDimensions(png(header(), rgba, [padding]))).toEqual(want);
  });
  it.each([
    { height: 2097152, want: { width: 24, height: 2097152 } }, { height: 2097153, want: null },
  ])('enforces decoded storage at the exact byte boundary for $height populated rows', ({ height, want }) => {
    // 24 grayscale bytes plus one filter byte per row: 25 * 2097152 = 50MiB exactly.
    expect(pngOutputDimensions(png(header(24, height, 8, 0), Buffer.alloc(25 * height)))).toEqual(want);
  });
  it.each([
    { width: 52428800, want: { width: 52428800, height: 1 } }, { width: 52428801, want: null },
  ])('enforces pixel work independently of decoded storage for $width one-bit samples', ({ width, want }) => {
    expect(pngOutputDimensions(png(header(width, 1, 1, 0), Buffer.alloc(Math.ceil(width / 8) + 1)))).toEqual(want);
  });
  it('joins consecutive IDAT pieces including empty chunks without changing the bytes', () => {
    const data = deflateSync(rgba);
    const bytes = Buffer.concat([SIGNATURE, chunk('IHDR', header()), chunk('IDAT'), chunk('IDAT', data.subarray(0, 3)), chunk('IDAT', data.subarray(3)), chunk('IEND')]);
    const saved = Buffer.from(bytes);
    expect(pngOutputDimensions(bytes)).toEqual({ width: 1, height: 1 });
    expect(bytes).toEqual(saved);
  });
  it('accepts checked ancillary bytes without interpreting metadata as execution authority', () => {
    expect(pngOutputDimensions(png(header(), rgba, [chunk('tEXt', Buffer.from('fixture\0diagnostic'))]))).toEqual({ width: 1, height: 1 });
  });
  it.each([
    { name: 'empty', bytes: Buffer.alloc(0) }, { name: 'signature only', bytes: SIGNATURE },
    { name: 'HTML', bytes: Buffer.from('<html>not a PNG</html>') },
    { name: 'missing header', bytes: Buffer.concat([SIGNATURE, chunk('IDAT', deflateSync(rgba)), chunk('IEND')]) },
    { name: 'missing image data', bytes: Buffer.concat([SIGNATURE, chunk('IHDR', header()), chunk('IEND')]) },
    { name: 'missing end', bytes: png().subarray(0, -12) },
    { name: 'trailing foreign bytes', bytes: Buffer.concat([png(), Buffer.from('foreign')]) },
    { name: 'repeated header', bytes: png(header(), rgba, [chunk('IHDR', header())]) },
    { name: 'nonempty end', bytes: Buffer.concat([png().subarray(0, -12), chunk('IEND', Buffer.from([0]))]) },
    { name: 'unknown critical chunk', bytes: png(header(), rgba, [chunk('ABCD')]) },
    { name: 'invalid chunk letters', bytes: png(header(), rgba, [chunk('a1CD')]) },
    { name: 'reserved chunk bit', bytes: png(header(), rgba, [chunk('abca')]) },
    { name: 'zero width', bytes: png(header(0)) }, { name: 'zero height', bytes: png(header(1, 0)) },
    { name: 'unsupported depth', bytes: png(header(1, 1, 4, 6)) },
    { name: 'unsupported color', bytes: png(header(1, 1, 8, 1)) },
    { name: 'unknown interlace', bytes: png(header(1, 1, 8, 6, 2)) },
    { name: 'oversized decoded image', bytes: png(header(100000, 100000)) },
    { name: 'truncated zlib stream', bytes: Buffer.concat([SIGNATURE, chunk('IHDR', header()), chunk('IDAT', deflateSync(rgba).subarray(0, -2)), chunk('IEND')]) },
    { name: 'non-zlib bytes', bytes: Buffer.concat([SIGNATURE, chunk('IHDR', header()), chunk('IDAT', Buffer.from('not compressed')), chunk('IEND')]) },
    { name: 'too few pixels', bytes: png(header(), Buffer.from([0, 12])) },
    { name: 'too many pixels', bytes: png(header(), Buffer.concat([rgba, Buffer.from([1])])) },
    { name: 'invalid scanline filter', bytes: png(header(), Buffer.from([5, 12, 34, 56, 255])) },
    { name: 'indexed without palette', bytes: png(header(1, 1, 1, 3), Buffer.from([0, 0])) },
    { name: 'index beyond palette', bytes: png(header(1, 1, 1, 3), Buffer.from([0, 0x80]), [chunk('PLTE', Buffer.from([0, 0, 0]))]) },
    { name: 'empty palette', bytes: png(header(), rgba, [chunk('PLTE')]) },
    { name: 'partial palette entry', bytes: png(header(), rgba, [chunk('PLTE', Buffer.from([0, 0]))]) },
    { name: 'palette forbidden for grayscale', bytes: png(header(1, 1, 8, 0), Buffer.from([0, 0]), [chunk('PLTE', Buffer.from([0, 0, 0]))]) },
    { name: 'late palette', bytes: png(header(), rgba, [], [chunk('PLTE', Buffer.from([0, 0, 0]))]) },
    { name: 'repeated palette', bytes: png(header(), rgba, [chunk('PLTE', Buffer.from([0, 0, 0])), chunk('PLTE', Buffer.from([0, 0, 0]))]) },
    { name: 'animation control', bytes: png(header(), rgba, [chunk('acTL', Buffer.alloc(8))]) },
    { name: 'animation frame', bytes: png(header(), rgba, [], [chunk('fdAT', Buffer.alloc(4))]) },
  ])('refuses $name', ({ bytes }) => {
    expect(pngOutputDimensions(bytes)).toBeNull();
  });
  it('rejects bad CRCs and incomplete chunk lengths even when the image signature is valid', () => {
    const badCrc = png(); badCrc[29] = badCrc[29]! ^ 1;
    expect(pngOutputDimensions(badCrc)).toBeNull();
    const badLength = png(); badLength.writeUInt32BE(0x7fffffff, 33);
    expect(pngOutputDimensions(badLength)).toBeNull();
    expect(pngOutputDimensions(png().subarray(0, -1))).toBeNull();
  });
  it('rejects an IDAT sequence interrupted by another chunk', () => {
    const data = deflateSync(rgba);
    const bytes = Buffer.concat([SIGNATURE, chunk('IHDR', header()), chunk('IDAT', data.subarray(0, 3)), chunk('tEXt', Buffer.from('fixture\0text')), chunk('IDAT', data.subarray(3)), chunk('IEND')]);
    expect(pngOutputDimensions(bytes)).toBeNull();
  });
});
