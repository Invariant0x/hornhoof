/* Draws the plant layer for the world engine: the soft shadows and then the plants, back to front, swaying in the wind.
   One instance per map. WebGL draws sprites from one shared atlas; the canvas fallback draws the same layout with
   drawImage. The engine keeps one call per frame: update (WebGL) or drawFallback2D. Knows no species and no world. */

import { Container, Matrix, MeshSimple, Rectangle, Sprite, Texture } from 'pixi.js';
import { masterTileW } from './art';
import type { WorldRect } from './coords';
import type { WorldPackManifest } from './manifest';
import { createDrawList, ITEM_STRIDE, PlantLayout, type PlantDrawList } from './plant-layer';
import { buildPlantAtlas, MESH_COLS, MESH_ROWS, type PlantAtlas } from './plant-sprites';
import { generatePlants, type PlantField } from './plants';
import type { LoadedTerrainArt } from './terrain-art';
import type { GeneratedWorldMap } from './terrain-engine';

const MESH_VERTS = MESH_COLS * MESH_ROWS;
/* Painted plants at least this tall (picture pixels) bend as a mesh; smaller ones, and plants without a wind map,
   sway as one sprite, which costs far less per frame. */
const MESH_MIN_PICTURE_H = 180;
/* Weight at the top of a palm trunk where the fronds attach: flutter starts above it, so leaves never tear off. */
const FLUTTER_HUB_WEIGHT = 0.25;

/* Two triangles per cell of the bending grid. */
const MESH_INDICES = (() => {
  const idx: number[] = [];
  for (let r = 0; r < MESH_ROWS - 1; r++) {
    for (let c = 0; c < MESH_COLS - 1; c++) {
      const i = r * MESH_COLS + c;
      idx.push(i, i + 1, i + MESH_COLS, i + 1, i + MESH_COLS + 1, i + MESH_COLS);
    }
  }
  return new Uint32Array(idx);
})();

export type BendFrame = Readonly<{
  /* Size of the picture and where its root and crown hub are, in picture pixels. */
  w: number;
  h: number;
  rootX: number;
  hubX: number;
  hubY: number;
  crownWidth: number;
  /* Wind weight per grid vertex, MESH_COLS x MESH_ROWS row by row from the top; null bends nothing. */
  weights: Float32Array | null;
}>;

/* Positions of the bending grid of one painted plant in world pixels, by the rules that come with the painted set:
   each vertex moves sideways by push * weight, sags a little as it swings (0.24 * push * (x - root) / crown width *
   weight + 0.09 * |push| * weight^1.6), and its leaves flutter above the crown hub with a phase that changes around
   the hub, so fronds shiver out of step. The matrix (a, b, c, d, tx, ty) takes picture pixels to world pixels. */
export function bendPlantMesh(
  out: Float32Array,
  f: BendFrame,
  a: number,
  b: number,
  c: number,
  d: number,
  tx: number,
  ty: number,
  push: number,
  flutterPx: number,
  flutterPhase: number,
): void {
  const ws = f.weights;
  for (let r = 0; r < MESH_ROWS; r++) {
    const y0 = (r / (MESH_ROWS - 1)) * f.h;
    for (let col = 0; col < MESH_COLS; col++) {
      const i = r * MESH_COLS + col;
      const x0 = (col / (MESH_COLS - 1)) * f.w;
      let x = x0;
      let y = y0;
      const w = ws ? ws[i]! : 0;
      if (w > 0) {
        x += push * w;
        y += 0.24 * push * ((x0 - f.rootX) / f.crownWidth) * w + 0.09 * Math.abs(push) * Math.pow(w, 1.6);
        if (flutterPx > 0 && w > FLUTTER_HUB_WEIGHT) {
          const wf = Math.pow((w - FLUTTER_HUB_WEIGHT) / (1 - FLUTTER_HUB_WEIGHT), 1.35);
          const th = Math.atan2(y0 - f.hubY, x0 - f.hubX);
          x += flutterPx * wf * Math.sin(flutterPhase + th * 3);
          y += flutterPx * 0.5 * wf * Math.cos(flutterPhase * 1.3 + th * 2);
        }
      }
      out[i * 2] = a * x + c * y + tx;
      out[i * 2 + 1] = b * x + d * y + ty;
    }
  }
}

export type PlantStats = Readonly<{
  total: number;
  inView: number;
  drawn: number;
  byKind: Readonly<Record<string, number>>;
  /* Spread of the wind lean (per unit of sway amplitude) over the plants drawn last frame: 0 would be everything in unison. */
  leanSpan: number;
}>;

function parseColor(color: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  return m ? Number.parseInt(m[1]!, 16) : 0x000000;
}

export class PlantRenderer {
  readonly field: PlantField;
  private readonly pack: WorldPackManifest;
  private atlas: PlantAtlas | null = null;
  private layout: PlantLayout | null = null;
  private readonly list: PlantDrawList = createDrawList();
  private textures: Texture[] = [];
  private atlasTexture: Texture | null = null;
  private shadowLayer: Container | null = null;
  private bodyLayer: Container | null = null;
  private flatLayer: Container | null = null;
  private reflectionLayer: Container | null = null;
  private readonly shadowPool: Sprite[] = [];
  private readonly bodyPool: MeshSimple[] = [];
  private readonly bodySpritePool: Sprite[] = [];
  private readonly bodyFrame: number[] = [];
  private readonly flatPool: Sprite[] = [];
  private readonly reflectionPool: Sprite[] = [];
  private readonly reflections: PlantDrawList = createDrawList();
  private bendFrames: BendFrame[] = [];
  private readonly matrix = new Matrix();
  private tintedAtlas: HTMLCanvasElement | null = null;
  private inView = 0;
  /* The painted plants to draw with, as the engine fixed them when it mounted; none draws procedural plants. */
  private art: LoadedTerrainArt | null = null;

  private constructor(pack: WorldPackManifest, field: PlantField) {
    this.pack = pack;
    this.field = field;
  }

  /* Null when the pack has no plants or the map grows none, so the engine pays nothing for a bare world. */
  static create(pack: WorldPackManifest, map: GeneratedWorldMap | undefined): PlantRenderer | null {
    if (!map || !pack.plants || pack.plants.length === 0) return null;
    const field = generatePlants(pack, map);
    return field.plants.length > 0 ? new PlantRenderer(pack, field) : null;
  }

  get stats(): PlantStats {
    const byKind: Record<string, number> = {};
    (this.pack.plants ?? []).forEach((k, i) => {
      byKind[k.id] = this.field.countsByKind[i] ?? 0;
    });
    return { total: this.field.plants.length, inView: this.inView, drawn: this.list.count - this.list.shadowCount, byKind, leanSpan: this.layout ? this.layout.leanMax - this.layout.leanMin : 0 };
  }

  /* The art to build the plant pictures from; once they are built they stay for the session. */
  useArt(art: LoadedTerrainArt | null): void {
    if (!this.atlas) this.art = art;
  }

  private ensureAtlas(): PlantAtlas {
    if (!this.atlas) {
      const pxToWorld = this.pack.projection.defaultTileW / masterTileW(this.pack);
      this.atlas = buildPlantAtlas(this.pack, this.art, pxToWorld);
      this.layout = new PlantLayout({ pack: this.pack, field: this.field, sprites: this.atlas.sprites, lighting: this.pack.lighting });
    }
    return this.atlas;
  }

  /* WebGL: puts the flat details, shadow and plant layers into `parent`, between the ground and whatever stands on
     it, and the reflections into `waterParent`, which lies under the ground so only open water shows them. */
  attachPixi(parent: Container, waterParent?: Container): void {
    const atlas = this.ensureAtlas();
    const source = Texture.from(atlas.canvas);
    source.source.autoGenerateMipmaps = true;
    source.source.style.scaleMode = 'linear';
    source.source.style.mipmapFilter = 'linear';
    this.atlasTexture = source;
    this.textures = atlas.frames.map(f => new Texture({ source: source.source, frame: new Rectangle(f.x, f.y, f.w, f.h) }));
    /* Per atlas frame: how its painted plant bends (null weights for everything that does not). */
    this.bendFrames = atlas.frames.map(f => ({ w: f.w, h: f.h, rootX: f.w / 2, hubX: f.w / 2, hubY: f.h / 2, crownWidth: Math.max(1, f.w), weights: null }));
    for (const variants of atlas.sprites) {
      for (const info of variants) {
        if (!info.meshWeights) continue;
        const f = atlas.frames[info.base.frame]!;
        const pp = info.passport;
        this.bendFrames[info.base.frame] = { w: f.w, h: f.h, rootX: pp.rootPoint[0], hubX: pp.crownHub[0], hubY: pp.crownHub[1], crownWidth: Math.max(1, pp.crownWidthPx), weights: info.meshWeights };
      }
    }
    this.flatLayer = new Container();
    this.shadowLayer = new Container();
    this.bodyLayer = new Container();
    parent.addChild(this.flatLayer);
    parent.addChild(this.shadowLayer);
    parent.addChild(this.bodyLayer);
    if (waterParent) {
      this.reflectionLayer = new Container();
      this.reflectionLayer.alpha = 0.42;
      waterParent.addChild(this.reflectionLayer);
    }
  }

  /* Draw slot i of the plant bodies: a sprite and a bending mesh, added next to each other so the slots keep their
     back-to-front order whichever of the two a plant uses. */
  private body(i: number): MeshSimple {
    let mesh = this.bodyPool[i];
    if (!mesh) {
      this.sprite(this.bodySpritePool, this.bodyLayer!, i, false);
      mesh = new MeshSimple({
        texture: this.atlasTexture!,
        vertices: new Float32Array(MESH_VERTS * 2),
        uvs: new Float32Array(MESH_VERTS * 2),
        indices: MESH_INDICES,
      });
      if (this.pack.lighting) mesh.tint = parseColor(this.pack.lighting.sunTint);
      this.bodyLayer!.addChild(mesh);
      this.bodyPool.push(mesh);
      this.bodyFrame.push(-1);
    }
    return mesh;
  }

  private setUvs(mesh: MeshSimple, frame: number): void {
    const atlas = this.atlas!;
    const f = atlas.frames[frame]!;
    const W = atlas.canvas.width;
    const H = atlas.canvas.height;
    const uvs = mesh.geometry.uvs;
    for (let r = 0; r < MESH_ROWS; r++) {
      for (let c = 0; c < MESH_COLS; c++) {
        const i = (r * MESH_COLS + c) * 2;
        uvs[i] = (f.x + (c / (MESH_COLS - 1)) * f.w) / W;
        uvs[i + 1] = (f.y + (r / (MESH_ROWS - 1)) * f.h) / H;
      }
    }
    mesh.geometry.getBuffer('aUV').update();
  }

  private flatOrReflection(pool: Sprite[], layer: Container, i: number): Sprite {
    let s = pool[i];
    if (!s) {
      s = new Sprite();
      layer.addChild(s);
      pool.push(s);
    }
    return s;
  }

  private sprite(pool: Sprite[], layer: Container, i: number, shadow: boolean): Sprite {
    let s = pool[i];
    if (!s) {
      s = new Sprite();
      if (shadow) {
        const light = this.pack.lighting;
        s.tint = parseColor(light?.shadowColor ?? '#000000');
        s.alpha = light?.shadowAlpha ?? 0.3;
      } else if (this.pack.lighting) {
        /* Sunlit plants take the warm tint of the light, like the ground does. */
        s.tint = parseColor(this.pack.lighting.sunTint);
      }
      layer.addChild(s);
      pool.push(s);
    }
    return s;
  }

  /* WebGL: lay out and apply this frame's flat details, shadows, plants and reflections. */
  update(view: WorldRect, timeSec: number): void {
    if (!this.layout || !this.shadowLayer || !this.bodyLayer || !this.flatLayer) return;
    this.inView = this.layout.build(view, timeSec, this.list, this.reflectionLayer ? this.reflections : undefined);
    const { data, flatCount, shadowCount, count } = this.list;
    const m = this.matrix;
    for (let i = 0; i < flatCount; i++) {
      const o = i * ITEM_STRIDE;
      const s = this.flatOrReflection(this.flatPool, this.flatLayer, i);
      s.texture = this.textures[data[o]!]!;
      m.set(data[o + 1]!, data[o + 2]!, data[o + 3]!, data[o + 4]!, data[o + 5]!, data[o + 6]!);
      s.setFromMatrix(m);
      s.visible = true;
    }
    for (let i = flatCount; i < shadowCount; i++) {
      const o = i * ITEM_STRIDE;
      const s = this.sprite(this.shadowPool, this.shadowLayer, i - flatCount, true);
      s.texture = this.textures[data[o]!]!;
      m.set(data[o + 1]!, data[o + 2]!, data[o + 3]!, data[o + 4]!, data[o + 5]!, data[o + 6]!);
      s.setFromMatrix(m);
      s.visible = true;
    }
    for (let i = shadowCount; i < count; i++) {
      const o = i * ITEM_STRIDE;
      const k = i - shadowCount;
      const mesh = this.body(k);
      const sprite = this.bodySpritePool[k]!;
      const frame = data[o]!;
      const bf = this.bendFrames[frame]!;
      const a = data[o + 1]!;
      const b = data[o + 2]!;
      const c = data[o + 3]!;
      const d = data[o + 4]!;
      const push = data[o + 7]!;
      if (bf.weights && bf.h >= MESH_MIN_PICTURE_H) {
        if (this.bodyFrame[k] !== frame) {
          this.setUvs(mesh, frame);
          this.bodyFrame[k] = frame;
        }
        bendPlantMesh(mesh.geometry.positions, bf, a, b, c, d, data[o + 5]!, data[o + 6]!, push, data[o + 8]!, data[o + 9]!);
        mesh.geometry.getBuffer('aPosition').update();
        mesh.visible = true;
        sprite.visible = false;
      } else {
        /* Small plants sway as a whole: the top moves by the push, the root stays. */
        sprite.texture = this.textures[frame]!;
        const k2 = push / Math.max(1, bf.h);
        m.set(a, b, c - a * k2, d - b * k2, data[o + 5]! + a * push, data[o + 6]! + b * push);
        sprite.setFromMatrix(m);
        sprite.visible = true;
        mesh.visible = false;
      }
    }
    for (let i = flatCount; i < this.flatPool.length; i++) this.flatPool[i]!.visible = false;
    for (let i = shadowCount - flatCount; i < this.shadowPool.length; i++) this.shadowPool[i]!.visible = false;
    for (let i = count - shadowCount; i < this.bodyPool.length; i++) {
      this.bodyPool[i]!.visible = false;
      this.bodySpritePool[i]!.visible = false;
    }

    if (this.reflectionLayer) {
      const rd = this.reflections.data;
      const rn = this.reflections.count;
      for (let i = 0; i < rn; i++) {
        const o = i * ITEM_STRIDE;
        const s = this.flatOrReflection(this.reflectionPool, this.reflectionLayer, i);
        s.texture = this.textures[rd[o]!]!;
        m.set(rd[o + 1]!, rd[o + 2]!, rd[o + 3]!, rd[o + 4]!, rd[o + 5]!, rd[o + 6]!);
        s.setFromMatrix(m);
        s.tint = 0x9cc4d4;
        s.visible = true;
      }
      for (let i = rn; i < this.reflectionPool.length; i++) this.reflectionPool[i]!.visible = false;
    }
  }

  /* Canvas fallback: draw the same layout straight onto the world-transformed 2D context. */
  drawFallback2D(ctx: CanvasRenderingContext2D, view: WorldRect, timeSec: number): void {
    const atlas = this.ensureAtlas();
    if (!this.layout) return;
    this.inView = this.layout.build(view, timeSec, this.list);
    if (!this.tintedAtlas) {
      const t = document.createElement('canvas');
      t.width = atlas.canvas.width;
      t.height = atlas.canvas.height;
      const tc = t.getContext('2d');
      if (tc) {
        tc.drawImage(atlas.canvas, 0, 0);
        tc.globalCompositeOperation = 'source-in';
        tc.fillStyle = this.pack.lighting?.shadowColor ?? '#000';
        tc.fillRect(0, 0, t.width, t.height);
      }
      this.tintedAtlas = t;
    }
    const { data, flatCount, shadowCount, count } = this.list;
    for (let i = 0; i < count; i++) {
      const o = i * ITEM_STRIDE;
      const f = atlas.frames[data[o]!]!;
      const shadow = i >= flatCount && i < shadowCount;
      ctx.save();
      ctx.globalAlpha = shadow ? (this.pack.lighting?.shadowAlpha ?? 0.3) : 1;
      ctx.transform(data[o + 1]!, data[o + 2]!, data[o + 3]!, data[o + 4]!, data[o + 5]!, data[o + 6]!);
      ctx.drawImage(shadow ? this.tintedAtlas : atlas.canvas, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
      ctx.restore();
    }
  }

  destroy(): void {
    this.textures.forEach(t => {
      if (!t.destroyed) t.destroy(false);
    });
    this.textures = [];
    if (this.atlasTexture && !this.atlasTexture.destroyed) this.atlasTexture.destroy(true);
    this.atlasTexture = null;
    this.shadowPool.length = 0;
    this.bodyPool.length = 0;
    this.bodySpritePool.length = 0;
    this.bodyFrame.length = 0;
    this.flatPool.length = 0;
    this.reflectionPool.length = 0;
    this.shadowLayer = null;
    this.bodyLayer = null;
    this.flatLayer = null;
    this.reflectionLayer = null;
    this.atlas = null;
    this.layout = null;
    this.tintedAtlas = null;
  }
}
