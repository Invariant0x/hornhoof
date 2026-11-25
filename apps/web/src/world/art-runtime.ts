/* Runtime side of the art contract: reads a pack's art-index.json, decodes its pictures and sheets on first use from
   the pack's art files (art-files.ts: kept in the browser by content hash), and keeps sprites and placeholder graphics
   in one depth order. A pack without art, a folder without an index or a file that fails to load all leave the flat
   placeholders in place. */

import { Container, Graphics, ImageSource, MeshSimple, Rectangle, RenderLayer, Sprite, Texture } from 'pixi.js';
import { ART_CONTRACT_VERSION, validateArtIndex, type ArtIndex, type ArtIndexEntry, type ArtRect } from './art';
import { worldArtFiles, type WorldArtFiles } from './art-files';
import { CLOTH_COLS, CLOTH_ROWS, clothIndices, clothUvs, clothVertexWeights, greyOf } from './cloth';
import type { WorldPackManifest } from './manifest';

export type WorldArtStats = {
  indexedFiles: number;
  loadedTextures: number;
  buildingsDrawn: number;
  residentsDrawn: number;
};

/* Drops files the contract check rejects, so one broken passport never breaks the whole city. */
function usableIndex(pack: WorldPackManifest, raw: ArtIndex): ArtIndex | null {
  if (raw.contract !== ART_CONTRACT_VERSION || raw.pack !== pack.id) return null;
  const report = validateArtIndex(pack, raw);
  if (report.errors.length === 0) return raw;
  const rejected = new Set(report.errors.map(e => e.slice(0, e.indexOf(':'))));
  const files: Record<string, ArtIndexEntry> = {};
  for (const [path, entry] of Object.entries(raw.files)) {
    if (!rejected.has(path)) files[path] = entry;
  }
  return { ...raw, files };
}

export type GreyPicture = Readonly<{ data: Uint8ClampedArray; w: number; h: number }>;
/* Reads a grey picture (a cloth mask) one byte per pixel; rejects when it cannot. */
export type GreyReader = (url: string) => Promise<GreyPicture>;

async function greyOfBlob(blob: Blob | null): Promise<GreyPicture> {
  if (!blob) throw new Error('no mask');
  const bitmap = await createImageBitmap(blob);
  /* A closed bitmap reads 0 by 0, so its size is taken first. */
  const { width: w, height: h } = bitmap;
  const ctx = new OffscreenCanvas(w, h).getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { data: greyOf(ctx.getImageData(0, 0, w, h).data), w, h };
}

/* A picture as a texture the way the PixiJS loader makes one: alpha premultiplied on upload, mipmaps for far zooms. */
async function textureOfBlob(blob: Blob | null): Promise<Texture> {
  if (!blob) throw new Error('no picture');
  const bitmap = await createImageBitmap(blob);
  return new Texture({ source: new ImageSource({ resource: bitmap, alphaMode: 'premultiply-alpha-on-upload', autoGenerateMipmaps: true }) });
}

export class WorldArtLibrary {
  readonly index: ArtIndex | null;
  readonly stats: WorldArtStats;
  private readonly baseUrl: string;
  private readonly textures = new Map<string, Texture | 'loading' | 'failed'>();
  private readonly frames = new Map<string, Texture>();
  private readonly cloths = new Map<string, Float32Array | 'loading' | 'failed'>();
  private readonly listeners = new Set<() => void>();
  private destroyed = false;

  private readonly grey: GreyReader;
  private readonly files: WorldArtFiles | null;

  private constructor(baseUrl: string, index: ArtIndex | null, files: WorldArtFiles | null, grey?: GreyReader) {
    this.baseUrl = baseUrl;
    this.index = index;
    this.files = files;
    this.grey = grey ?? (url => (files ? files.blob(url.slice(baseUrl.length)) : Promise.resolve(null)).then(greyOfBlob));
    this.stats = {
      indexedFiles: index ? Object.keys(index.files).length : 0,
      loadedTextures: 0,
      buildingsDrawn: 0,
      residentsDrawn: 0,
    };
  }

  static none(): WorldArtLibrary {
    return new WorldArtLibrary('', null, null);
  }

  /* The pack's index from its art files (one read per page), with the files the contract rejects left out. */
  static async load(
    pack: WorldPackManifest,
    files: WorldArtFiles | null = worldArtFiles(pack),
    grey?: GreyReader,
  ): Promise<WorldArtLibrary> {
    const baseUrl = pack.art?.baseUrl;
    if (!baseUrl || !files) return WorldArtLibrary.none();
    const raw = await files.index();
    const index = raw ? usableIndex(pack, raw) : null;
    return index ? new WorldArtLibrary(baseUrl, index, files, grey) : WorldArtLibrary.none();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /* The whole file as a texture, or null while it loads or after it failed. */
  texture(path: string): Texture | null {
    if (!this.index?.files[path]) return null;
    const known = this.textures.get(path);
    if (known instanceof Texture) return known;
    if (known) return null;
    this.textures.set(path, 'loading');
    (this.files ? this.files.blob(path) : Promise.resolve(null)).then(textureOfBlob).then(
      tex => {
        if (this.destroyed) {
          tex.destroy(true);
          return;
        }
        this.textures.set(path, tex);
        this.stats.loadedTextures++;
        for (const l of this.listeners) l();
      },
      () => {
        if (!this.destroyed) this.textures.set(path, 'failed');
      },
    );
    return null;
  }

  /* The cloth mesh's vertex weights from a cloth mask (cloth.ts), or null while it loads or after it failed. */
  clothWeights(path: string): Float32Array | null {
    if (!this.index?.files[path]) return null;
    const known = this.cloths.get(path);
    if (known instanceof Float32Array) return known;
    if (known) return null;
    this.cloths.set(path, 'loading');
    this.grey(`${this.baseUrl}${path}`).then(
      grey => {
        if (this.destroyed) return;
        this.cloths.set(path, clothVertexWeights(grey.data, grey.w, grey.h, CLOTH_COLS, CLOTH_ROWS));
        this.listeners.forEach(l => l());
      },
      () => this.cloths.set(path, 'failed'),
    );
    return null;
  }

  /* One frame of a sheet or a cut of a picture, cached per rectangle. */
  frame(path: string, rect: ArtRect): Texture | null {
    const base = this.texture(path);
    if (!base) return null;
    const key = `${path}#${rect.x},${rect.y},${rect.w},${rect.h}`;
    let tex = this.frames.get(key);
    if (!tex) {
      const w = Math.min(rect.w, base.source.width - rect.x);
      const h = Math.min(rect.h, base.source.height - rect.y);
      if (w <= 0 || h <= 0) return null;
      tex = new Texture({ source: base.source, frame: new Rectangle(rect.x, rect.y, w, h) });
      this.frames.set(key, tex);
    }
    return tex;
  }

  destroy(): void {
    this.destroyed = true;
    this.listeners.clear();
    for (const tex of this.frames.values()) tex.destroy(false);
    this.frames.clear();
    for (const tex of this.textures.values()) {
      if (tex instanceof Texture) tex.destroy(true);
    }
    this.textures.clear();
  }
}

/* Keeps placeholder graphics and art sprites interleaved in painter's order inside one container:
   consecutive placeholders share one Graphics, each sprite sits between them where it belongs.
   With a depth layer, every object also renders through that layer at the current `depth` (world y of its ground
   point), so the plants and people of other pools sort in between; placeholders share a Graphics only at one depth. */
export class DisplayRunPool {
  readonly container: Container;
  private readonly freeGraphics: Graphics[] = [];
  private readonly freeSprites: Sprite[] = [];
  private readonly freeCloths: MeshSimple[] = [];
  private readonly depthLayer: RenderLayer | null;
  /* Depth of the objects handed out next. */
  depth = 0;

  constructor(container: Container, depthLayer: RenderLayer | null = null) {
    this.container = container;
    this.depthLayer = depthLayer;
  }

  private place(child: Graphics | Sprite | MeshSimple): void {
    this.container.addChild(child);
    if (this.depthLayer) {
      child.zIndex = this.depth;
      this.depthLayer.attach(child);
    }
  }

  begin(): void {
    for (const child of this.container.removeChildren()) {
      if (child instanceof Sprite) this.freeSprites.push(child);
      else if (child instanceof Graphics) this.freeGraphics.push(child);
      else if (child instanceof MeshSimple) this.freeCloths.push(child);
    }
  }

  graphics(): Graphics {
    const last = this.container.children[this.container.children.length - 1];
    if (last instanceof Graphics && (!this.depthLayer || last.zIndex === this.depth)) return last;
    const g = this.freeGraphics.pop() ?? new Graphics();
    g.clear();
    this.place(g);
    return g;
  }

  sprite(texture: Texture): Sprite {
    const s = this.freeSprites.pop() ?? new Sprite();
    s.texture = texture;
    s.tint = 0xffffff;
    s.alpha = 1;
    s.rotation = 0;
    s.skew.set(0, 0);
    s.blendMode = 'normal';
    s.visible = true;
    this.place(s);
    return s;
  }

  /* A cloth mesh over the whole of `texture` (cloth.ts); its vertices are set by the wind pass. */
  cloth(texture: Texture): MeshSimple {
    const mesh =
      this.freeCloths.pop() ??
      new MeshSimple({ texture, vertices: new Float32Array(CLOTH_COLS * CLOTH_ROWS * 2), uvs: clothUvs(), indices: clothIndices() });
    mesh.texture = texture;
    mesh.tint = 0xffffff;
    mesh.visible = true;
    this.place(mesh);
    return mesh;
  }

  clear(): void {
    this.begin();
  }

  destroy(): void {
    this.begin();
    for (const g of this.freeGraphics) g.destroy();
    for (const s of this.freeSprites) s.destroy();
    for (const m of this.freeCloths) m.destroy();
    this.freeGraphics.length = 0;
    this.freeSprites.length = 0;
    this.freeCloths.length = 0;
  }
}

export function parseArtTint(color: string | undefined): number {
  const m = color ? /^#([0-9a-f]{6})$/i.exec(color.trim()) : null;
  return m ? Number.parseInt(m[1]!, 16) : 0xffffff;
}
