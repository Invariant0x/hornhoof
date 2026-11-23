/* Generated test pictures for the art contract checks: flat shapes in an RGBA buffer, encoded as PNG.
   They stand in for artist files only inside browser tests and are never shipped. */

import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export class RgbaCanvas {
  readonly w: number;
  readonly h: number;
  readonly px: Buffer;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.px = Buffer.alloc(w * h * 4);
  }

  /* Fills a convex or concave polygon by scanline with an even-odd rule. */
  polygon(points: ReadonlyArray<readonly [number, number]>, rgba: readonly [number, number, number, number]): void {
    const minY = Math.max(0, Math.floor(Math.min(...points.map(p => p[1]))));
    const maxY = Math.min(this.h - 1, Math.ceil(Math.max(...points.map(p => p[1]))));
    for (let y = minY; y <= maxY; y++) {
      const yc = y + 0.5;
      const xs: number[] = [];
      for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i]!;
        const [x2, y2] = points[(i + 1) % points.length]!;
        if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.round(xs[k]!));
        const to = Math.min(this.w - 1, Math.round(xs[k + 1]!) - 1);
        for (let x = from; x <= to; x++) {
          const o = (y * this.w + x) * 4;
          this.px[o] = rgba[0];
          this.px[o + 1] = rgba[1];
          this.px[o + 2] = rgba[2];
          this.px[o + 3] = rgba[3];
        }
      }
    }
  }

  png(): Buffer {
    const raw = Buffer.alloc((this.w * 4 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 4 + 1)] = 0;
      this.px.copy(raw, y * (this.w * 4 + 1) + 1, y * this.w * 4, (y + 1) * this.w * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 3 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}
