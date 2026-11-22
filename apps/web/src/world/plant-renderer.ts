/* Draws the plant layer for the world engine: the soft shadows and then the plants, back to front, swaying in the wind.
   One instance per map. WebGL draws sprites from one shared atlas; the canvas fallback draws the same layout with
   drawImage. The engine keeps one call per frame: update (WebGL) or drawFallback2D. Knows no species and no world. */

import { Container, Matrix, Rectangle, Sprite, Texture } from 'pixi.js';
import type { WorldRect } from './coords';
import type { WorldPackManifest } from './manifest';
import { createDrawList, ITEM_STRIDE, PlantLayout, type PlantDrawList } from './plant-layer';
import { buildPlantAtlas, type PlantAtlas } from './plant-sprites';
import { generatePlants, type PlantField } from './plants';
import type { GeneratedWorldMap } from './terrain-engine';

export type PlantStats = Readonly<{
  total: number;
  inView: number;
  drawn: number;
  byKind: Readonly<Record<string, number>>;
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
  private readonly shadowPool: Sprite[] = [];
  private readonly bodyPool: Sprite[] = [];
  private readonly matrix = new Matrix();
  private tintedAtlas: HTMLCanvasElement | null = null;
  private inView = 0;

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
    return { total: this.field.plants.length, inView: this.inView, drawn: this.list.count - this.list.shadowCount, byKind };
  }

  private ensureAtlas(): PlantAtlas {
    if (!this.atlas) {
      this.atlas = buildPlantAtlas(this.pack);
      this.layout = new PlantLayout({ pack: this.pack, field: this.field, sprites: this.atlas.sprites, lighting: this.pack.lighting });
    }
    return this.atlas;
  }

  /* WebGL: puts the shadow and plant layers into `parent`, between the ground and whatever stands on it. */
  attachPixi(parent: Container): void {
    const atlas = this.ensureAtlas();
    const source = Texture.from(atlas.canvas);
    source.source.autoGenerateMipmaps = true;
    source.source.style.scaleMode = 'linear';
    source.source.style.mipmapFilter = 'linear';
    this.atlasTexture = source;
    this.textures = atlas.frames.map(f => new Texture({ source: source.source, frame: new Rectangle(f.x, f.y, f.w, f.h) }));
    this.shadowLayer = new Container();
    this.bodyLayer = new Container();
    parent.addChild(this.shadowLayer);
    parent.addChild(this.bodyLayer);
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

  /* WebGL: lay out and apply this frame's sprites. */
  update(view: WorldRect, timeSec: number): void {
    if (!this.layout || !this.shadowLayer || !this.bodyLayer) return;
    this.inView = this.layout.build(view, timeSec, this.list);
    const { data, shadowCount, count } = this.list;
    const m = this.matrix;
    for (let i = 0; i < shadowCount; i++) {
      const o = i * ITEM_STRIDE;
      const s = this.sprite(this.shadowPool, this.shadowLayer, i, true);
      s.texture = this.textures[data[o]!]!;
      m.set(data[o + 1]!, data[o + 2]!, data[o + 3]!, data[o + 4]!, data[o + 5]!, data[o + 6]!);
      s.setFromMatrix(m);
      s.visible = true;
    }
    for (let i = shadowCount; i < count; i++) {
      const o = i * ITEM_STRIDE;
      const s = this.sprite(this.bodyPool, this.bodyLayer, i - shadowCount, false);
      s.texture = this.textures[data[o]!]!;
      m.set(data[o + 1]!, data[o + 2]!, data[o + 3]!, data[o + 4]!, data[o + 5]!, data[o + 6]!);
      s.setFromMatrix(m);
      s.visible = true;
    }
    for (let i = shadowCount; i < this.shadowPool.length; i++) this.shadowPool[i]!.visible = false;
    for (let i = count - shadowCount; i < this.bodyPool.length; i++) this.bodyPool[i]!.visible = false;
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
    const { data, shadowCount, count } = this.list;
    for (let i = 0; i < count; i++) {
      const o = i * ITEM_STRIDE;
      const f = atlas.frames[data[o]!]!;
      const shadow = i < shadowCount;
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
    this.shadowLayer = null;
    this.bodyLayer = null;
    this.atlas = null;
    this.layout = null;
    this.tintedAtlas = null;
  }
}
