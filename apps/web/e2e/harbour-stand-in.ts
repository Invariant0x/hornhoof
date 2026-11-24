/* Stand-in harbour art for the browser checks of #2006: every harbour slot of the egypt catalog drawn plainly at its
   passport's size and served through the page's routes, as an artist's delivery would be. Nothing of it is in the
   repository's art, and the product never draws it: the real look comes with checklist H1 to H6. */

import { crc32, deflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import { ART_CONTRACT_VERSION, declaredArtFiles, type ArtIndexEntry } from '../src/world/art';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

const pack = EGYPT_WORLD_PACK;

/* A plain RGBA canvas and the few shapes the stand-ins need. */
class Raster {
  readonly data: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Uint8Array(w * h * 4);
  }
  poly(pts: readonly (readonly [number, number])[], rgb: number, alpha = 255): void {
    const ys = pts.map(p => p[1]);
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(this.h - 1, Math.ceil(Math.max(...ys))); y++) {
      const xs: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i]!;
        const [x2, y2] = pts[(i + 1) % pts.length]!;
        if ((y1 <= y + 0.5 && y2 > y + 0.5) || (y2 <= y + 0.5 && y1 > y + 0.5)) xs.push(x1 + ((y + 0.5 - y1) * (x2 - x1)) / (y2 - y1));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.max(0, Math.round(xs[k]!)); x < Math.min(this.w, Math.round(xs[k + 1]!)); x++) {
          const o = (y * this.w + x) * 4;
          this.data[o] = (rgb >> 16) & 255;
          this.data[o + 1] = (rgb >> 8) & 255;
          this.data[o + 2] = rgb & 255;
          this.data[o + 3] = alpha;
        }
      }
    }
  }
  png(): Buffer {
    const raw = Buffer.alloc((this.w * 4 + 1) * this.h);
    for (let y = 0; y < this.h; y++) Buffer.from(this.data.buffer, y * this.w * 4, this.w * 4).copy(raw, y * (this.w * 4 + 1) + 1);
    const chunk = (type: string, body: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length);
      const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(tb));
      return Buffer.concat([len, tb, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr.set([8, 6, 0, 0, 0], 8);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  }
}

type Pt = readonly [number, number];
const diamond = (cx: number, cy: number, hw: number, hh: number, lift = 0): Pt[] => [
  [cx, cy - hh - lift],
  [cx + hw, cy - lift],
  [cx, cy + hh - lift],
  [cx - hw, cy - lift],
];
/* A block standing on the ground at (cx, cy): its top, then its two front faces. */
function block(r: Raster, cx: number, cy: number, hw: number, height: number, rgb: number): void {
  const hh = hw / 2;
  r.poly([[cx - hw, cy - height], [cx, cy + hh - height], [cx, cy + hh], [cx - hw, cy]], rgb - 0x202020);
  r.poly([[cx, cy + hh - height], [cx + hw, cy - height], [cx + hw, cy], [cx, cy + hh]], rgb - 0x303030);
  r.poly(diamond(cx, cy, hw, hh, height), rgb);
}

const HEADINGS: Readonly<Record<string, Pt>> = { NE: [2, -1], SE: [2, 1], SW: [-2, 1], NW: [-2, -1] };
const unit = ([x, y]: Pt): Pt => [x / Math.hypot(x, y), y / Math.hypot(x, y)];

/* One row of a boat sheet: a hull along its heading, with a sail while it sails, bobbing a pixel every other frame. */
function boatRow(r: Raster, row: number, heading: string, frames: number, sail: boolean): void {
  const d = unit(HEADINGS[heading]!);
  const p = unit([-HEADINGS[heading]![0], HEADINGS[heading]![1]]);
  for (let f = 0; f < frames; f++) {
    const ax = f * 480 + 240;
    const ay = row * 400 + 300 + (f % 2);
    const hull = (lift: number): Pt[] => [
      [ax + d[0] * 170 + p[0] * 30, ay + d[1] * 170 + p[1] * 30 - lift],
      [ax + d[0] * 170 - p[0] * 30, ay + d[1] * 170 - p[1] * 30 - lift],
      [ax - d[0] * 150 - p[0] * 42, ay - d[1] * 150 - p[1] * 42 - lift],
      [ax - d[0] * 150 + p[0] * 42, ay - d[1] * 150 + p[1] * 42 - lift],
    ];
    r.poly(hull(0), 0x5a3a1c);
    r.poly(hull(18), 0x8b5a2b);
    r.poly([[ax - 3, ay - 18], [ax + 3, ay - 18], [ax + 3, ay - 200], [ax - 3, ay - 200]], 0x3b2a1a);
    if (sail) r.poly([[ax + 4, ay - 196], [ax + 4, ay - 40], [ax + 4 + d[0] * 110, ay - 60 + d[1] * 40]], 0xf2e6c8);
  }
}

/* The stand-in delivery: every harbour slot of the catalog, drawn plainly at its passport's size. */
function standInHarbour(): Map<string, { entry: ArtIndexEntry; png: Buffer }> {
  const out = new Map<string, { entry: ArtIndexEntry; png: Buffer }>();
  for (const slot of declaredArtFiles(pack)) {
    if (slot.role !== 'harbour') continue;
    const name = slot.path.slice(slot.path.lastIndexOf('/') + 1);
    if (slot.passport === 'picture') {
      const m = pack.projection.buildingFootprintsMaster4x[slot.footprint!];
      const h = Math.min(m.maxCanvasH, m.diamondH + 300);
      const cx = m.diamondW / 2;
      const cy = h - m.diamondH / 2 - 1;
      const r = new Raster(m.diamondW, h);
      if (slot.path.includes('/yard/')) {
        r.poly(diamond(cx, cy, cx, m.diamondH / 2), 0xc9b48a);
        const stage = Number(/fill_(\d)/.exec(name)![1]);
        for (let i = 0; i < stage * 3; i++) block(r, cx - m.diamondW / 3 + (i % 6) * (m.diamondW / 9), cy - 30 + Math.floor(i / 6) * 40, 26, 34, 0xe8dcc0);
      } else if (name.startsWith('quay')) {
        block(r, cx, cy, cx, 40, 0xa89f91);
      } else {
        r.poly(diamond(cx, cy, cx * 0.8, m.diamondH * 0.4, 10), 0x7a5230);
        if (name.startsWith('pier_head')) r.poly([[cx - 8, cy - 20], [cx + 8, cy - 20], [cx + 8, cy - 90], [cx - 8, cy - 90]], 0x3b2a1a);
      }
      const passport = {
        groundAnchor: { x: cx, y: cy },
        corners: { top: { x: cx, y: cy - m.diamondH / 2 }, right: { x: m.diamondW, y: cy }, bottom: { x: cx, y: cy + m.diamondH / 2 }, left: { x: 0, y: cy } },
        ...(name.startsWith('pier_head') ? { mooring: { x: 40, y: cy } } : {}),
      };
      out.set(slot.path, { entry: { w: r.w, h: r.h, passport } as ArtIndexEntry, png: r.png() });
      continue;
    }
    const cargo = /boat_cargo_(\d)/.exec(name);
    const frames = cargo ? 1 : 8;
    const directions = ['NE', 'SE', 'SW', 'NW'];
    const r = new Raster(480 * frames, 400 * directions.length);
    directions.forEach((heading, row) => {
      if (!cargo) return boatRow(r, row, heading, frames, name === 'boat_sail.png' || name === 'caravan_walk.png');
      const d = unit(HEADINGS[heading]!);
      const n = Number(cargo[1]);
      for (let i = 0; i < n; i++) block(r, 240 + d[0] * (i - (n - 1) / 2) * 56, row * 400 + 284 + d[1] * (i - (n - 1) / 2) * 56, 24, 30, 0xe8dcc0);
    });
    const passport = { frameW: 480, frameH: 400, frames, fps: 8, anchor: { x: 240, y: 300 }, directions };
    out.set(slot.path, { entry: { w: r.w, h: r.h, passport } as ArtIndexEntry, png: r.png() });
  }
  return out;
}

/* The page's art folder with the stand-in harbour added to whatever art it already has, less the files named. */
export async function deliverHarbourArt(page: Page, without: readonly string[] = []): Promise<void> {
  const art = standInHarbour();
  for (const path of without) art.delete(path);
  await page.route('**/world-art/egypt/art-index.json', async route => {
    const res = await route.fetch().catch(() => null);
    const base = res?.ok() ? ((await res.json()) as { files: Record<string, ArtIndexEntry> }) : { files: {} };
    const files = { ...base.files, ...Object.fromEntries([...art].map(([path, a]) => [path, a.entry])) };
    await route.fulfill({ json: { contract: ART_CONTRACT_VERSION, pack: pack.id, files } });
  });
  await page.route('**/world-art/egypt/harbour/**', route => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/world-art\/egypt\//, '');
    const a = art.get(path);
    return a ? route.fulfill({ body: a.png, contentType: 'image/png' }) : route.fulfill({ status: 404 });
  });
}
