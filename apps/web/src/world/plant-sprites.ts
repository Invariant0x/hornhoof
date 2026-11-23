/* Procedural plant pictures for the plant layer: every kind of a pack is drawn from its palette and silhouette into one
   shared atlas canvas, in a few variants, with the sun at the upper left. They stand in for artist sprites, which fill
   the same slots (see PlantArtSpec). Trees come in two parts, trunk and crown, so the wind can bend the trunk gently
   and flutter the crown on its own. Needs a browser canvas. */

import type { PlantKindSpec, PlantPassport, WorldPackManifest } from './manifest';
import { createRng, hashSeed } from './prng';
import type { LoadedTerrainArt, PlantArtImage } from './terrain-art';

/* Grid of the bendable mesh laid over a painted plant: columns x rows of vertices, under the 100 a mesh may have to
   be drawn in one batch with the others. */
export const MESH_COLS = 6;
export const MESH_ROWS = 9;

/* Atlas pixels per world pixel at 100% zoom: crisp up to 200% zoom. */
export const PLANT_TEXTURE_SCALE = 2;
const ATLAS_WIDTH = 2048;
const GUTTER = 3;
const PAD = 8;

export type AtlasFrame = Readonly<{ x: number; y: number; w: number; h: number }>;

/* One part of a plant: where it sits in the atlas and which of its pixels is the pivot (root for a trunk, hub for a crown). */
export type PlantPart = Readonly<{ frame: number; pivotX: number; pivotY: number }>;

export type PlantSpriteInfo = Readonly<{
  /* Whole plant when single-part, the trunk of a tree otherwise. */
  base: PlantPart;
  crown?: PlantPart;
  /* Soft white silhouette of the whole plant, pivot at its root, for the cast shadow. */
  shadow: PlantPart;
  /* Crown hub relative to the base pivot, in atlas pixels (x right, y down; negative y is up). */
  hubX: number;
  hubY: number;
  /* Height of the picture's plant in atlas pixels: scales it to the planted height. */
  heightPx: number;
  passport: PlantPassport;
  /* Painted plants: world pixels per picture pixel at scale 1 (the picture keeps its drawn size), and the wind weight
     at each vertex of the bending mesh, row by row from the top, MESH_COLS x MESH_ROWS. */
  pxToWorld?: number;
  meshWeights?: Float32Array;
}>;

export type PlantAtlas = Readonly<{
  canvas: HTMLCanvasElement;
  frames: readonly AtlasFrame[];
  /* sprites[kindIndex][variant]. */
  sprites: readonly (readonly PlantSpriteInfo[])[];
  scale: number;
}>;

type Rgb = readonly [number, number, number];

function rgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h.slice(0, 6);
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function css(c: Rgb, alpha = 1): string {
  return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${alpha})`;
}

function newCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(w));
  canvas.height = Math.max(1, Math.ceil(h));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  return { canvas, ctx };
}

type Part = Readonly<{ canvas: HTMLCanvasElement; pivotX: number; pivotY: number }>;

type Drawn = Readonly<{
  base: Part;
  crown?: Part;
  hubX: number;
  hubY: number;
  heightPx: number;
  crownWidthPx: number;
}>;

/* Light from the upper left: how lit a surface facing (dx, dy) is, in [0, 1]. */
function lit(dx: number, dy: number): number {
  const len = Math.hypot(dx, dy) || 1;
  return Math.max(0, Math.min(1, 0.5 + 0.5 * ((dx / len) * -0.6 + (dy / len) * -0.8)));
}

/* ---------- trees with a trunk and a crown of long fronds ---------- */

function drawTrunk(ctx: CanvasRenderingContext2D, ox: number, oy: number, hubX: number, hubY: number, w0: number, w1: number, color: Rgb, rng: () => number): void {
  const bend = (rng() - 0.5) * (hubY < 0 ? -hubY : 1) * 0.05;
  const pts: { x: number; y: number; w: number }[] = [];
  const n = 26;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = hubX * t * t + bend * Math.sin(Math.PI * t);
    const y = hubY * t;
    const flare = 1 + 0.55 * Math.max(0, 1 - t / 0.1);
    pts.push({ x: ox + x, y: oy + y, w: (w0 + (w1 - w0) * t) * flare });
  }
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x - p.w / 2, p.y) : ctx.lineTo(p.x - p.w / 2, p.y)));
  for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i]!.x + pts[i]!.w / 2, pts[i]!.y);
  ctx.closePath();
  const grad = ctx.createLinearGradient(ox - w0, 0, ox + w0, 0);
  grad.addColorStop(0, css(mix(color, [255, 236, 200], 0.38)));
  grad.addColorStop(0.45, css(color));
  grad.addColorStop(1, css(mix(color, [30, 20, 10], 0.5)));
  ctx.fillStyle = grad;
  ctx.fill();
  /* Leaf-scar rings, slightly slanted, lit on their upper side. */
  for (let i = 2; i < n; i++) {
    const p = pts[i]!;
    const q = pts[i - 1]!;
    ctx.strokeStyle = css(mix(color, [25, 15, 8], 0.55), 0.55);
    ctx.lineWidth = Math.max(1, p.w * 0.07);
    ctx.beginPath();
    ctx.moveTo(p.x - p.w * 0.5, p.y + 1);
    ctx.quadraticCurveTo((p.x + q.x) / 2, p.y + p.w * 0.14, p.x + p.w * 0.5, p.y - 1);
    ctx.stroke();
    ctx.strokeStyle = css(mix(color, [255, 240, 205], 0.55), 0.35);
    ctx.beginPath();
    ctx.moveTo(p.x - p.w * 0.45, p.y - 1.5);
    ctx.lineTo(p.x - p.w * 0.1, p.y - 1.5);
    ctx.stroke();
  }
}

function drawFronds(ctx: CanvasRenderingContext2D, hx: number, hy: number, reach: number, k: PlantKindSpec, rng: () => number): void {
  const primary = rgb(k.palette.primary);
  const secondary = rgb(k.palette.secondary);
  const accent = rgb(k.palette.accent);
  const count = 12 + Math.floor(rng() * 3);
  const fronds: { a: number; len: number; droop: number }[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i + 0.2 + rng() * 0.6) / count;
    const a = -Math.PI * (0.96 - t * 0.92);
    fronds.push({ a, len: reach * (0.78 + 0.28 * rng()) * (0.8 + 0.2 * Math.abs(Math.cos(a))), droop: 0.2 + 0.2 * rng() });
  }
  for (const a of [0.34, Math.PI - 0.34, 0.12, Math.PI - 0.12]) fronds.push({ a, len: reach * (0.55 + 0.2 * rng()), droop: 0.45 });
  fronds.sort((p, q) => Math.sin(p.a) - Math.sin(q.a));

  for (const f of fronds) {
    const ux = Math.cos(f.a);
    const uy = Math.sin(f.a);
    const L = f.len;
    const p1 = { x: hx + ux * L * 0.34, y: hy + uy * L * 0.34 - L * 0.2 };
    const p2 = { x: hx + ux * L * 0.72, y: hy + uy * L * 0.72 - L * 0.1 };
    const p3 = { x: hx + ux * L, y: hy + uy * L + L * f.droop };
    const at = (t: number) => {
      const m = 1 - t;
      return {
        x: m * m * m * hx + 3 * m * m * t * p1.x + 3 * m * t * t * p2.x + t * t * t * p3.x,
        y: m * m * m * hy + 3 * m * m * t * p1.y + 3 * m * t * t * p2.y + t * t * t * p3.y,
      };
    };
    const light = lit(ux, uy < 0 ? uy * 0.7 : uy * 0.3);
    const body = mix(secondary, primary, 0.25 + 0.75 * light);
    const steps = 26;
    /* Rib. */
    ctx.strokeStyle = css(mix(body, [35, 45, 20], 0.35));
    ctx.lineWidth = Math.max(1.6, L * 0.012);
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const p = at(i / steps);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    /* Leaflets: paired, swept toward the tip and hanging a little, shorter toward the tip. */
    for (let i = 3; i <= steps; i++) {
      const t = i / steps;
      const p = at(t);
      const q = at(Math.max(0, t - 0.03));
      let tx = p.x - q.x;
      let ty = p.y - q.y;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      const ll = L * 0.17 * (1 - 0.72 * t) * (0.85 + 0.3 * rng());
      for (const sgn of [-1, 1]) {
        const nx = -ty * sgn;
        const ny = tx * sgn;
        let dx = tx * 0.5 + nx * 0.86;
        let dy = ty * 0.5 + ny * 0.86 + 0.42;
        const dl = Math.hypot(dx, dy);
        dx /= dl;
        dy /= dl;
        const shade = lit(dx, dy) * 0.5 + light * 0.5;
        const c = mix(mix(secondary, primary, 0.2 + 0.8 * shade), accent, shade * 0.34 * t);
        ctx.strokeStyle = css(c);
        ctx.lineWidth = Math.max(1.5, L * 0.011 * (1 - 0.4 * t));
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + dx * ll, p.y + dy * ll);
        ctx.stroke();
      }
    }
  }
}

function drawFrondedTree(k: PlantKindSpec, variant: number, H: number): Drawn {
  const rng = createRng(hashSeed(`${k.id}:${variant}`));
  const trunkColor = rgb(k.palette.trunk ?? '#8C6A44');
  const trunkH = H * (0.56 + 0.1 * rng());
  const lean = (rng() - 0.5) * H * 0.1;
  const w0 = H * 0.058;
  const w1 = H * 0.036;

  const tw = Math.ceil(H * 0.22 + Math.abs(lean) * 2);
  const th = Math.ceil(trunkH + PAD * 2);
  const trunk = newCanvas(tw, th);
  const rootX = tw / 2;
  const rootY = th - PAD;
  drawTrunk(trunk.ctx, rootX, rootY, lean, -trunkH, w0, w1, trunkColor, rng);

  const reach = H * 0.4;
  const cw = Math.ceil(reach * 2.5);
  const ch = Math.ceil(reach * 1.5);
  const crown = newCanvas(cw, ch);
  const hx = cw / 2;
  const hy = reach * 0.78;
  drawFronds(crown.ctx, hx, hy, reach, k, rng);
  /* Fruit clusters hanging under the hub. */
  for (let i = 0; i < 4; i++) {
    const a = Math.PI * (0.25 + 0.5 * rng());
    for (let j = 0; j < 6; j++) {
      crown.ctx.fillStyle = css(mix([186, 104, 40], [120, 64, 24], rng()));
      crown.ctx.beginPath();
      crown.ctx.ellipse(hx + Math.cos(a) * H * 0.04 + (rng() - 0.5) * H * 0.03, hy + H * 0.03 + Math.sin(a) * H * 0.04 + j * H * 0.008, H * 0.011, H * 0.016, 0, 0, Math.PI * 2);
      crown.ctx.fill();
    }
  }

  return {
    base: { canvas: trunk.canvas, pivotX: rootX, pivotY: rootY },
    crown: { canvas: crown.canvas, pivotX: hx, pivotY: hy },
    hubX: lean,
    hubY: -trunkH,
    heightPx: trunkH + hy,
    crownWidthPx: reach * 2.2,
  };
}

/* ---------- broad crowned tree: short trunk, layered leafy lobes with dappled light ---------- */

function drawBroadTree(k: PlantKindSpec, variant: number, H: number): Drawn {
  const rng = createRng(hashSeed(`${k.id}:${variant}`));
  const trunkColor = rgb(k.palette.trunk ?? '#7B5B3A');
  const primary = rgb(k.palette.primary);
  const secondary = rgb(k.palette.secondary);
  const accent = rgb(k.palette.accent);
  const trunkH = H * (0.34 + 0.06 * rng());
  const lean = (rng() - 0.5) * H * 0.06;

  const tw = Math.ceil(H * 0.34);
  const th = Math.ceil(trunkH + PAD * 2);
  const trunk = newCanvas(tw, th);
  const rootX = tw / 2;
  const rootY = th - PAD;
  drawTrunk(trunk.ctx, rootX, rootY, lean, -trunkH, H * 0.1, H * 0.07, trunkColor, rng);
  /* Two forks reaching into the crown. */
  for (const s of [-1, 1]) {
    trunk.ctx.strokeStyle = css(mix(trunkColor, [30, 20, 10], 0.3));
    trunk.ctx.lineWidth = H * 0.035;
    trunk.ctx.beginPath();
    trunk.ctx.moveTo(rootX + lean, rootY - trunkH * 0.92);
    trunk.ctx.quadraticCurveTo(rootX + lean + s * H * 0.05, rootY - trunkH * 1.0, rootX + lean + s * H * 0.09, rootY - trunkH * 1.06);
    trunk.ctx.stroke();
  }

  const R = H * 0.34;
  const cw = Math.ceil(R * 2.9);
  const ch = Math.ceil(R * 2.1);
  const crown = newCanvas(cw, ch);
  const hx = cw / 2;
  const hy = ch - R * 0.55;
  const lobes: { x: number; y: number; r: number }[] = [];
  const n = 7 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    lobes.push({ x: hx + (t - 0.5) * R * 1.7 + (rng() - 0.5) * R * 0.3, y: hy - R * (0.55 + 0.4 * Math.sin(t * Math.PI)) - rng() * R * 0.2, r: R * (0.42 + 0.22 * rng()) });
  }
  lobes.push({ x: hx, y: hy - R * 0.95, r: R * 0.62 });
  lobes.sort((a, b) => a.y - b.y);
  for (const lobe of lobes) {
    const g = crown.ctx.createRadialGradient(lobe.x - lobe.r * 0.35, lobe.y - lobe.r * 0.4, lobe.r * 0.1, lobe.x, lobe.y, lobe.r * 1.02);
    g.addColorStop(0, css(mix(primary, accent, 0.55)));
    g.addColorStop(0.55, css(primary));
    g.addColorStop(1, css(mix(secondary, [18, 40, 18], 0.4)));
    crown.ctx.fillStyle = g;
    crown.ctx.beginPath();
    crown.ctx.ellipse(lobe.x, lobe.y, lobe.r, lobe.r * 0.82, 0, 0, Math.PI * 2);
    crown.ctx.fill();
  }
  /* Leaf flecks: lit on the upper left, dark in the folds. */
  for (let i = 0; i < 220; i++) {
    const lobe = lobes[Math.floor(rng() * lobes.length)]!;
    const a = rng() * Math.PI * 2;
    const d = Math.sqrt(rng()) * lobe.r * 0.9;
    const x = lobe.x + Math.cos(a) * d;
    const y = lobe.y + Math.sin(a) * d * 0.8;
    const l = lit(Math.cos(a), Math.sin(a));
    crown.ctx.fillStyle = css(mix(mix(secondary, [20, 40, 18], 0.3), mix(primary, accent, 0.7), l), 0.8);
    crown.ctx.beginPath();
    crown.ctx.ellipse(x, y, R * 0.05, R * 0.03, a, 0, Math.PI * 2);
    crown.ctx.fill();
  }

  return {
    base: { canvas: trunk.canvas, pivotX: rootX, pivotY: rootY },
    crown: { canvas: crown.canvas, pivotX: hx, pivotY: hy },
    hubX: lean,
    hubY: -trunkH * 0.95,
    heightPx: trunkH * 0.95 + hy + R * 0.9,
    crownWidthPx: R * 2.6,
  };
}

/* ---------- round shrub: overlapping leaf clumps, optional blossoms ---------- */

function drawShrub(k: PlantKindSpec, variant: number, H: number): Drawn {
  const rng = createRng(hashSeed(`${k.id}:${variant}`));
  const primary = rgb(k.palette.primary);
  const secondary = rgb(k.palette.secondary);
  const accent = rgb(k.palette.accent);
  const W = Math.ceil(H * 1.5);
  const { canvas, ctx } = newCanvas(W, H + PAD * 2);
  const cx = W / 2;
  const baseY = H + PAD;
  const clumps: { x: number; y: number; r: number }[] = [];
  const n = 13 + Math.floor(rng() * 8);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI;
    const d = Math.sqrt(rng());
    const r = H * (0.17 + 0.16 * rng());
    clumps.push({ x: cx - Math.cos(a) * d * W * 0.36, y: baseY - r * 0.55 - Math.sin(a) * d * H * 0.5, r });
  }
  clumps.sort((a, b) => a.y - b.y);
  for (const c of clumps) {
    const g = ctx.createRadialGradient(c.x - c.r * 0.35, c.y - c.r * 0.4, c.r * 0.1, c.x, c.y, c.r);
    const heightLight = 1 - (c.y - (baseY - H)) / H;
    g.addColorStop(0, css(mix(primary, accent, 0.3 + 0.3 * heightLight)));
    g.addColorStop(0.6, css(mix(secondary, primary, 0.5 + 0.4 * heightLight)));
    g.addColorStop(1, css(mix(secondary, [20, 36, 16], 0.45)));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, c.r, c.r * 0.86, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 90; i++) {
    const c = clumps[Math.floor(rng() * clumps.length)]!;
    const a = rng() * Math.PI * 2;
    const d = Math.sqrt(rng()) * c.r * 0.85;
    const l = lit(Math.cos(a), Math.sin(a));
    ctx.strokeStyle = css(mix(secondary, mix(primary, accent, 0.5), l), 0.85);
    ctx.lineWidth = Math.max(1.4, H * 0.025);
    ctx.beginPath();
    ctx.moveTo(c.x + Math.cos(a) * d, c.y + Math.sin(a) * d * 0.85);
    ctx.lineTo(c.x + Math.cos(a) * d + Math.cos(a + 1.2) * H * 0.07, c.y + Math.sin(a) * d * 0.85 + Math.sin(a + 1.2) * H * 0.05);
    ctx.stroke();
  }
  /* Blossoms only where the accent colour is a flower pink rather than a leaf tone. */
  const blossoms = accent[0] > accent[1] + 25 ? Math.round(10 + rng() * 10) : 0;
  const flower = mix(accent, [255, 255, 255], 0.25);
  for (let i = 0; i < blossoms; i++) {
    const c = clumps[Math.floor(rng() * clumps.length)]!;
    const a = rng() * Math.PI * 2;
    const d = Math.sqrt(rng()) * c.r * 0.8;
    ctx.fillStyle = css(flower, 0.95);
    ctx.beginPath();
    ctx.arc(c.x + Math.cos(a) * d, c.y + Math.sin(a) * d * 0.8, Math.max(1.6, H * 0.03), 0, Math.PI * 2);
    ctx.fill();
  }
  return { base: { canvas, pivotX: cx, pivotY: baseY }, hubX: 0, hubY: 0, heightPx: H, crownWidthPx: W * 0.8 };
}

/* ---------- blades and umbels ---------- */

/* Umbel reed: thin triangular stalks with a starburst of drooping filaments on top, and a few short leaves at the foot. */
function drawUmbels(k: PlantKindSpec, variant: number, H: number): Drawn {
  const rng = createRng(hashSeed(`${k.id}:${variant}`));
  const primary = rgb(k.palette.primary);
  const secondary = rgb(k.palette.secondary);
  const accent = rgb(k.palette.accent);
  const W = Math.ceil(H * 1.05);
  const { canvas, ctx } = newCanvas(W, H + PAD * 2);
  const cx = W / 2;
  const baseY = H + PAD;
  const stalks = Array.from({ length: 5 + Math.floor(rng() * 3) }, () => ({ spread: (rng() - 0.5) * 0.62, len: 0.58 + 0.4 * rng(), x0: (rng() - 0.5) * H * 0.16 }));
  stalks.sort((a, b) => a.len - b.len);
  for (const b of stalks) {
    const topX = cx + b.x0 + b.spread * H * 0.3;
    const topY = baseY - H * b.len * 0.9;
    const midX = cx + b.x0 + b.spread * H * 0.08;
    const midY = baseY - H * b.len * 0.45;
    const l = lit(-b.spread, -1);
    const stalk = mix(mix(secondary, primary, 0.35 + 0.65 * l), accent, 0.25 * l);
    const w = H * 0.017;
    ctx.fillStyle = css(stalk);
    ctx.beginPath();
    ctx.moveTo(cx + b.x0 - w, baseY);
    ctx.quadraticCurveTo(midX - w * 0.6, midY, topX, topY);
    ctx.quadraticCurveTo(midX + w * 0.6, midY, cx + b.x0 + w, baseY);
    ctx.closePath();
    ctx.fill();
    /* Starburst: filaments leave the top in all directions, fall at the ends, the upper-left ones catch the light. */
    const rays = 30;
    const R = H * (0.15 + 0.06 * b.len);
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2 + rng() * 0.18;
      const reach = R * (0.75 + 0.35 * rng());
      const ex = topX + Math.cos(a) * reach;
      const ey = topY + Math.sin(a) * reach * 0.5 + reach * 0.36;
      const shade = lit(Math.cos(a), Math.sin(a));
      ctx.strokeStyle = css(mix(mix(secondary, primary, 0.5), mix(primary, accent, 0.7), shade));
      ctx.lineWidth = Math.max(1.1, H * 0.0105);
      ctx.beginPath();
      ctx.moveTo(topX, topY);
      ctx.quadraticCurveTo(topX + Math.cos(a) * reach * 0.62, topY + Math.sin(a) * reach * 0.3 - reach * 0.22, ex, ey);
      ctx.stroke();
    }
    ctx.fillStyle = css(mix(secondary, [40, 50, 20], 0.35));
    ctx.beginPath();
    ctx.arc(topX, topY + H * 0.004, H * 0.014, 0, Math.PI * 2);
    ctx.fill();
  }
  /* Short sheathing leaves at the foot. */
  for (let i = 0; i < 6; i++) {
    const s = (rng() - 0.5) * 0.9;
    const len = H * (0.16 + 0.12 * rng());
    ctx.fillStyle = css(mix(secondary, primary, 0.3 + 0.4 * rng()));
    ctx.beginPath();
    ctx.moveTo(cx + s * H * 0.1 - H * 0.02, baseY);
    ctx.quadraticCurveTo(cx + s * H * 0.12, baseY - len * 0.6, cx + s * H * 0.3, baseY - len);
    ctx.quadraticCurveTo(cx + s * H * 0.14, baseY - len * 0.5, cx + s * H * 0.1 + H * 0.02, baseY);
    ctx.fill();
  }
  return { base: { canvas, pivotX: cx, pivotY: baseY }, hubX: 0, hubY: 0, heightPx: H * 0.95, crownWidthPx: W * 0.7 };
}

/* Reeds, rushes and grass tufts: many tapered blades leaning every way, lit on the upper left. */
function drawBlades(k: PlantKindSpec, variant: number, H: number): Drawn {
  const rng = createRng(hashSeed(`${k.id}:${variant}`));
  const primary = rgb(k.palette.primary);
  const secondary = rgb(k.palette.secondary);
  const accent = rgb(k.palette.accent);
  const W = Math.ceil(H * 1.1);
  const { canvas, ctx } = newCanvas(W, H + PAD * 2);
  const cx = W / 2;
  const baseY = H + PAD;
  const count = 16 + Math.floor(rng() * 8);
  const blades = Array.from({ length: count }, () => ({ spread: (rng() - 0.5) * 1.0, len: 0.55 + 0.45 * rng(), x0: (rng() - 0.5) * H * 0.18 }));
  blades.sort((a, b) => a.len - b.len);
  for (const b of blades) {
    const topX = cx + b.x0 + b.spread * H * 0.55;
    const topY = baseY - H * b.len;
    const midX = cx + b.x0 + b.spread * H * 0.14;
    const midY = baseY - H * b.len * 0.5;
    const l = lit(-b.spread, -1);
    const c = mix(mix(secondary, primary, 0.3 + 0.7 * l), accent, 0.2 * l);
    const w = H * 0.05;
    ctx.fillStyle = css(c);
    ctx.beginPath();
    ctx.moveTo(cx + b.x0 - w, baseY);
    ctx.quadraticCurveTo(midX - w * 0.7, midY, topX, topY);
    ctx.quadraticCurveTo(midX + w * 0.7, midY, cx + b.x0 + w, baseY);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = css(mix(c, accent, 0.45), 0.7);
    ctx.lineWidth = Math.max(1, w * 0.3);
    ctx.beginPath();
    ctx.moveTo(cx + b.x0 - w * 0.2, baseY);
    ctx.quadraticCurveTo(midX - w * 0.3, midY, topX, topY);
    ctx.stroke();
  }
  return { base: { canvas, pivotX: cx, pivotY: baseY }, hubX: 0, hubY: 0, heightPx: H, crownWidthPx: W * 0.7 };
}

/* A few rounded stones lying together, lit from the upper left. */
function drawStones(k: PlantKindSpec, variant: number, H: number): Drawn {
  const rng = createRng(hashSeed(`${k.id}:${variant}`));
  const primary = rgb(k.palette.primary);
  const secondary = rgb(k.palette.secondary);
  const accent = rgb(k.palette.accent);
  const W = Math.ceil(H * 2.2);
  const { canvas, ctx } = newCanvas(W, H * 1.3 + PAD * 2);
  const cx = W / 2;
  const baseY = H * 1.3 + PAD * 0.5;
  const stones = Array.from({ length: 3 + Math.floor(rng() * 4) }, () => ({ x: cx + (rng() - 0.5) * W * 0.6, y: baseY - H * (0.1 + 0.2 * rng()), r: H * (0.22 + 0.3 * rng()) }));
  stones.sort((a, b) => a.y - b.y);
  for (const s of stones) {
    ctx.fillStyle = css(secondary, 0.35);
    ctx.beginPath();
    ctx.ellipse(s.x + s.r * 0.25, s.y + s.r * 0.35, s.r * 1.05, s.r * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    const g = ctx.createRadialGradient(s.x - s.r * 0.35, s.y - s.r * 0.45, s.r * 0.1, s.x, s.y, s.r * 1.05);
    g.addColorStop(0, css(mix(primary, accent, 0.7)));
    g.addColorStop(0.55, css(primary));
    g.addColorStop(1, css(mix(secondary, [40, 32, 24], 0.3)));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, s.r, s.r * 0.72, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  return { base: { canvas, pivotX: cx, pivotY: baseY }, hubX: 0, hubY: 0, heightPx: H, crownWidthPx: W * 0.6 };
}

/* ---------- atlas ---------- */

function drawKind(k: PlantKindSpec, variant: number, H: number): Drawn {
  switch (k.shape) {
    case 'fronded_tree':
      return drawFrondedTree(k, variant, H);
    case 'broad_tree':
      return drawBroadTree(k, variant, H);
    case 'round_shrub':
      return drawShrub(k, variant, H);
    case 'blade_cluster':
      return drawBlades(k, variant, H);
    case 'umbel_reed':
      return drawUmbels(k, variant, H);
    case 'stone_cluster':
      return drawStones(k, variant, H);
  }
}

/* Draws the whole plant on one canvas to take its silhouette, then shrinks it so it comes out soft. */
function makeShadow(d: Drawn): Part {
  const hub = d.crown ? { x: d.hubX, y: d.hubY } : null;
  const w = Math.ceil(Math.max(d.base.canvas.width, d.crown ? d.crown.canvas.width : 0) + PAD * 2);
  const h = Math.ceil(d.heightPx + d.base.canvas.height * 0.3 + PAD * 2);
  const whole = newCanvas(w, h);
  const rootX = w / 2;
  const rootY = h - PAD;
  whole.ctx.drawImage(d.base.canvas, rootX - d.base.pivotX, rootY - d.base.pivotY);
  if (d.crown && hub) whole.ctx.drawImage(d.crown.canvas, rootX + hub.x - d.crown.pivotX, rootY + hub.y - d.crown.pivotY);
  /* A blob at the root so the foot of the plant is always shaded. */
  whole.ctx.fillStyle = '#000';
  whole.ctx.beginPath();
  whole.ctx.ellipse(rootX, rootY, d.crownWidthPx * 0.16, d.crownWidthPx * 0.07, 0, 0, Math.PI * 2);
  whole.ctx.fill();

  const k = 3;
  const sw = Math.ceil(w / k);
  const sh = Math.ceil(h / k);
  const small = newCanvas(sw, sh);
  small.ctx.imageSmoothingEnabled = true;
  for (const [ox, oy] of [[0, 0], [0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7]] as const) small.ctx.drawImage(whole.canvas, ox, oy, sw, sh);
  small.ctx.globalCompositeOperation = 'source-in';
  small.ctx.fillStyle = '#fff';
  small.ctx.fillRect(0, 0, sw, sh);
  /* The soft silhouette is stored at 1/3 size; the renderer scales it back up, which blurs it further. */
  return { canvas: small.canvas, pivotX: rootX / k, pivotY: rootY / k };
}

/* Wind weight at each mesh vertex: the strongest weight within half a cell, so a vertex just outside the painted
   silhouette moves with the leaf tip beside it. A picture without a weight map bends from the root up. */
function meshWeights(img: PlantArtImage): Float32Array {
  const { width: w, height: h } = img.pixels;
  const out = new Float32Array(MESH_COLS * MESH_ROWS);
  const rx = Math.ceil(w / (MESH_COLS - 1) / 2);
  const ry = Math.ceil(h / (MESH_ROWS - 1) / 2);
  const rootY = img.passport.rootPoint[1];
  const height = img.passport.heightPx;
  for (let r = 0; r < MESH_ROWS; r++) {
    for (let c = 0; c < MESH_COLS; c++) {
      const x = Math.round((c / (MESH_COLS - 1)) * (w - 1));
      const y = Math.round((r / (MESH_ROWS - 1)) * (h - 1));
      let best = 0;
      if (img.weights) {
        for (let yy = Math.max(0, y - ry); yy <= Math.min(h - 1, y + ry); yy += 2) {
          for (let xx = Math.max(0, x - rx); xx <= Math.min(w - 1, x + rx); xx += 2) best = Math.max(best, img.weights[yy * w + xx]!);
        }
        best /= 255;
      } else {
        best = Math.pow(Math.max(0, Math.min(1, (rootY - y) / height)), 1.75);
      }
      /* The root row never moves. */
      out[r * MESH_COLS + c] = y >= rootY - 1 ? 0 : best;
    }
  }
  return out;
}

/* Draws every kind and variant of the pack into one atlas: painted pictures where the art has loaded, procedural
   silhouettes for the rest. */
export function buildPlantAtlas(pack: WorldPackManifest, art: LoadedTerrainArt | null = null, pxToWorld = 0.5): PlantAtlas {
  const S = PLANT_TEXTURE_SCALE;
  const kinds = pack.plants ?? [];
  type Pending = { canvas: HTMLCanvasElement; kind: number; variant: number; role: 'base' | 'crown' | 'shadow' };
  const pending: Pending[] = [];
  const drawn: Drawn[][] = [];
  const shadows: Part[][] = [];
  const painted: (Float32Array | null)[][] = [];

  kinds.forEach((k, ki) => {
    const nominal = ((k.heightPx.min + k.heightPx.max) / 2) * S;
    drawn[ki] = [];
    shadows[ki] = [];
    painted[ki] = [];
    const pictures = art?.plants.get(k.id);
    if (pictures && pictures.length > 0) {
      /* Placement picks a variant out of k.variants; wrap onto the pictures that loaded. */
      for (let v = 0; v < k.variants; v++) {
        const img = pictures[v % pictures.length]!;
        const d: Drawn = {
          base: { canvas: img.canvas, pivotX: img.passport.rootPoint[0], pivotY: img.passport.rootPoint[1] },
          hubX: 0,
          hubY: 0,
          heightPx: img.passport.heightPx,
          crownWidthPx: img.passport.crownWidthPx,
        };
        const shadow = makeShadow(d);
        drawn[ki]!.push(d);
        shadows[ki]!.push(shadow);
        painted[ki]!.push(meshWeights(img));
        pending.push({ canvas: d.base.canvas, kind: ki, variant: v, role: 'base' });
        pending.push({ canvas: shadow.canvas, kind: ki, variant: v, role: 'shadow' });
      }
      return;
    }
    for (let v = 0; v < k.variants; v++) {
      painted[ki]!.push(null);
      const d = drawKind(k, v, nominal);
      const shadow = makeShadow(d);
      drawn[ki]!.push(d);
      shadows[ki]!.push(shadow);
      pending.push({ canvas: d.base.canvas, kind: ki, variant: v, role: 'base' });
      if (d.crown) pending.push({ canvas: d.crown.canvas, kind: ki, variant: v, role: 'crown' });
      pending.push({ canvas: shadow.canvas, kind: ki, variant: v, role: 'shadow' });
    }
  });

  /* Shelf packing, tallest first. */
  const order = pending.map((p, i) => i).sort((a, b) => pending[b]!.canvas.height - pending[a]!.canvas.height);
  const frames: AtlasFrame[] = new Array<AtlasFrame>(pending.length);
  let x = 0;
  let y = 0;
  let shelfH = 0;
  for (const i of order) {
    const c = pending[i]!.canvas;
    if (x + c.width + GUTTER > ATLAS_WIDTH) {
      x = 0;
      y += shelfH + GUTTER;
      shelfH = 0;
    }
    frames[i] = { x, y, w: c.width, h: c.height };
    x += c.width + GUTTER;
    shelfH = Math.max(shelfH, c.height);
  }
  const atlasH = y + shelfH + GUTTER;
  const { canvas, ctx } = newCanvas(ATLAS_WIDTH, atlasH);
  pending.forEach((p, i) => ctx.drawImage(p.canvas, frames[i]!.x, frames[i]!.y));

  const frameOf = new Map<string, number>();
  pending.forEach((p, i) => frameOf.set(`${p.kind}:${p.variant}:${p.role}`, i));

  const sprites = kinds.map((_, ki) =>
    drawn[ki]!.map((d, v): PlantSpriteInfo => {
      const baseFrame = frameOf.get(`${ki}:${v}:base`)!;
      const crownFrame = frameOf.get(`${ki}:${v}:crown`);
      const shadowFrame = frameOf.get(`${ki}:${v}:shadow`)!;
      const sh = shadows[ki]![v]!;
      const passport: PlantPassport = {
        rootPoint: [d.base.pivotX, d.base.pivotY],
        crownCenter: [d.base.pivotX + d.hubX, d.base.pivotY + d.hubY - d.crownWidthPx * 0.1],
        crownHub: [d.base.pivotX + d.hubX, d.base.pivotY + d.hubY],
        heightPx: d.heightPx,
        crownWidthPx: d.crownWidthPx,
      };
      const weights = painted[ki]![v] ?? null;
      return {
        ...(weights ? { pxToWorld, meshWeights: weights } : {}),
        base: { frame: baseFrame, pivotX: d.base.pivotX, pivotY: d.base.pivotY },
        crown: d.crown && crownFrame !== undefined ? { frame: crownFrame, pivotX: d.crown.pivotX, pivotY: d.crown.pivotY } : undefined,
        shadow: { frame: shadowFrame, pivotX: sh.pivotX, pivotY: sh.pivotY },
        hubX: d.hubX,
        hubY: d.hubY,
        heightPx: d.heightPx,
        passport,
      };
    }),
  );
  return { canvas, frames, sprites, scale: S };
}
