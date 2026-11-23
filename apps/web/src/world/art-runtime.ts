/* Runtime side of the art contract: reads a pack's art-index.json, loads its pictures and
   sheets on first use, and keeps sprites and placeholder graphics in one depth order.
   A pack without art, a folder without an index or a file that fails to load all leave
   the geometric placeholders in place. */

import { Assets, Container, Graphics, Rectangle, RenderLayer, Sprite, Texture } from 'pixi.js';
import {
  ART_CONTRACT_VERSION,
  ART_INDEX_FILE,
  validateArtIndex,
  type ArtIndex,
  type ArtIndexEntry,
  type ArtRect,
} from './art';
import type { WorldPackManifest } from './manifest';

export type ArtFetch = (url: string) => Promise<Pick<Response, 'ok' | 'json'>>;

export type WorldArtStats = {
  indexedFiles: number;
  loadedTextures: number;
  buildingsDrawn: number;
  residentsDrawn: number;
};

function isIndexShape(value: unknown): value is ArtIndex {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<ArtIndex>;
  return typeof v.contract === 'number' && typeof v.pack === 'string' && Boolean(v.files) && typeof v.files === 'object';
}

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

export class WorldArtLibrary {
  readonly index: ArtIndex | null;
  readonly stats: WorldArtStats;
  private readonly baseUrl: string;
  private readonly textures = new Map<string, Texture | 'loading' | 'failed'>();
  private readonly frames = new Map<string, Texture>();
  private readonly listeners = new Set<() => void>();
  private destroyed = false;

  private constructor(baseUrl: string, index: ArtIndex | null) {
    this.baseUrl = baseUrl;
    this.index = index;
    this.stats = {
      indexedFiles: index ? Object.keys(index.files).length : 0,
      loadedTextures: 0,
      buildingsDrawn: 0,
      residentsDrawn: 0,
    };
  }

  static none(): WorldArtLibrary {
    return new WorldArtLibrary('', null);
  }

  static async load(pack: WorldPackManifest, fetchImpl: ArtFetch = url => fetch(url, { cache: 'no-cache' })): Promise<WorldArtLibrary> {
    const baseUrl = pack.art?.baseUrl;
    if (!baseUrl) return WorldArtLibrary.none();
    try {
      const res = await fetchImpl(`${baseUrl}${ART_INDEX_FILE}`);
      if (!res.ok) return WorldArtLibrary.none();
      const raw: unknown = await res.json();
      if (!isIndexShape(raw)) return WorldArtLibrary.none();
      const index = usableIndex(pack, raw);
      return index ? new WorldArtLibrary(baseUrl, index) : WorldArtLibrary.none();
    } catch {
      return WorldArtLibrary.none();
    }
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
    Assets.load<Texture>({ src: `${this.baseUrl}${path}`, data: { autoGenerateMipmaps: true } }).then(
      tex => {
        if (this.destroyed) return;
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
    for (const [path, tex] of this.textures) {
      if (tex instanceof Texture) void Assets.unload(`${this.baseUrl}${path}`);
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
  private readonly depthLayer: RenderLayer | null;
  /* Depth of the objects handed out next. */
  depth = 0;

  constructor(container: Container, depthLayer: RenderLayer | null = null) {
    this.container = container;
    this.depthLayer = depthLayer;
  }

  private place(child: Graphics | Sprite): void {
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
    s.visible = true;
    this.place(s);
    return s;
  }

  clear(): void {
    this.begin();
  }

  destroy(): void {
    this.begin();
    for (const g of this.freeGraphics) g.destroy();
    for (const s of this.freeSprites) s.destroy();
    this.freeGraphics.length = 0;
    this.freeSprites.length = 0;
  }
}

export function parseArtTint(color: string | undefined): number {
  const m = color ? /^#([0-9a-f]{6})$/i.exec(color.trim()) : null;
  return m ? Number.parseInt(m[1]!, 16) : 0xffffff;
}
