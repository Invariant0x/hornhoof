/* Painted streets of the city: each street runs as a strip of the pack's painted road art from the centre of a street
   tile to the centre of its neighbour, along one tile axis, laid flat on the ground. Columns of the strip continue
   from tile to tile along a straight run, so a street shows no seams; ends are pushed out by half the street's width
   where the street turns or stops, so corners close. Bridges keep their own look. Knows no world: tiers and pictures
   come from the pack. */

import { Assets, Container, Matrix, Texture, TilingSprite } from 'pixi.js';
import type { RoadTile, RoadTier } from './city-layout';
import { tileTopVertexToWorld } from './coords';
import type { TileWindow } from './city-renderer';

/* Strip pixels across one tile (the painted strips are 1024 px long for 4 tiles). */
export const STRIP_TEXELS_PER_TILE = 256;

const TIER_ORDER: Readonly<Record<RoadTier, number>> = { trail: 0, dirt: 1, brick: 2, stone: 3 };
/* Column offset of strips along the second axis, so crossing streets do not show the same pebble twice. */
const V_AXIS_TEXEL_OFFSET = 311;

export type RoadStripSegment = Readonly<{
  tier: RoadTier;
  /* 'u' runs along the column axis (down right on screen), 'v' along the row axis (down left). */
  axis: 'u' | 'v';
  /* The middle line: v (for axis u) or u (for axis v) in fractional tiles. */
  across: number;
  /* Start and end along the axis, fractional tiles. */
  from: number;
  to: number;
  /* Strip column at `from`; the strip repeats along its length. */
  texelX: number;
}>;

const keyOf = (col: number, row: number): string => `${col},${row}`;

/* Segments for every pair of neighbouring street tiles (lower tier of the two), and a short stub for a lone tile. */
export function roadStripSegments(
  roads: ReadonlyMap<string, RoadTile>,
  widths: Readonly<Record<RoadTier, number>>,
  texelsPerTile = STRIP_TEXELS_PER_TILE,
): RoadStripSegment[] {
  const out: RoadStripSegment[] = [];
  const street = (col: number, row: number): RoadTile | null => {
    const t = roads.get(keyOf(col, row));
    return t && !t.bridge ? t : null;
  };
  const bridge = (col: number, row: number): boolean => Boolean(roads.get(keyOf(col, row))?.bridge);
  const lower = (a: RoadTier, b: RoadTier): RoadTier => (TIER_ORDER[a] <= TIER_ORDER[b] ? a : b);

  for (const t of roads.values()) {
    if (t.bridge) continue;
    const { col, row } = t;
    let linked = false;
    for (const axis of ['u', 'v'] as const) {
      const dc = axis === 'u' ? 1 : 0;
      const dr = axis === 'v' ? 1 : 0;
      if (street(col - dc, row - dr) || street(col + dc, row + dr)) linked = true;
      const next = street(col + dc, row + dr);
      if (!next) continue;
      const tier = lower(t.tier, next.tier);
      const hw = widths[tier] / 2;
      const at = axis === 'u' ? col : row;
      const across = (axis === 'u' ? row : col) + 0.5;
      /* An end stops at a straight continuation, reaches a bridge's edge, and otherwise passes the centre by half a width. */
      const startEnd = street(col - dc, row - dr) ? at + 0.5 : bridge(col - dc, row - dr) ? at : at + 0.5 - hw;
      const endEnd = street(col + 2 * dc, row + 2 * dr) ? at + 1.5 : bridge(col + 2 * dc, row + 2 * dr) ? at + 2 : at + 1.5 + hw;
      out.push({
        tier,
        axis,
        across,
        from: startEnd,
        to: endEnd,
        texelX: startEnd * texelsPerTile + (axis === 'v' ? V_AXIS_TEXEL_OFFSET : 0),
      });
    }
    if (!linked) {
      const hw = widths[t.tier] / 2;
      out.push({ tier: t.tier, axis: 'u', across: row + 0.5, from: col + 0.5 - hw, to: col + 0.5 + hw, texelX: (col + 0.5 - hw) * texelsPerTile });
    }
  }
  return out;
}

/* Draws the segments with one tiling sprite each, under the plants and the city. */
export class RoadStripPainter {
  readonly container = new Container();
  private readonly textures = new Map<RoadTier, Texture>();
  private readonly pool: TilingSprite[] = [];
  private readonly matrix = new Matrix();
  private loaded = false;

  /* Loads the strips the pack names; resolves to whether every street tier has a picture. */
  async load(baseUrl: string, paths: Readonly<Partial<Record<RoadTier, string>>>): Promise<boolean> {
    const tiers = Object.keys(TIER_ORDER) as RoadTier[];
    const results = await Promise.all(
      tiers.map(async tier => {
        const path = paths[tier];
        if (!path) return null;
        try {
          const tex = await Assets.load<Texture>(`${baseUrl}${path}`);
          tex.source.style.addressModeU = 'repeat';
          tex.source.style.scaleMode = 'linear';
          return [tier, tex] as const;
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) if (r) this.textures.set(r[0], r[1]);
    this.loaded = tiers.every(t => this.textures.has(t));
    return this.loaded;
  }

  get ready(): boolean {
    return this.loaded;
  }

  /* Widths in tiles, from each strip's height. */
  widths(texelsPerTile = STRIP_TEXELS_PER_TILE): Record<RoadTier, number> {
    const w = { trail: 0.4, dirt: 0.8, brick: 1, stone: 1 } as Record<RoadTier, number>;
    for (const [tier, tex] of this.textures) w[tier] = tex.height / texelsPerTile;
    return w;
  }

  draw(roads: ReadonlyMap<string, RoadTile>, window: TileWindow | null, tileW: number, tileH: number, texelsPerTile = STRIP_TEXELS_PER_TILE): void {
    let used = 0;
    if (this.loaded) {
      const inWindow = new Map<string, RoadTile>();
      for (const [k, t] of roads) {
        if (!window || (t.col >= window.minCol - 1 && t.col <= window.maxCol + 1 && t.row >= window.minRow - 1 && t.row <= window.maxRow + 1)) {
          inWindow.set(k, t);
        }
      }
      const k = 1 / (2 * texelsPerTile);
      for (const s of roadStripSegments(inWindow, this.widths(texelsPerTile), texelsPerTile)) {
        const tex = this.textures.get(s.tier)!;
        const sprite = this.pool[used] ?? this.make();
        used++;
        sprite.texture = tex;
        sprite.width = (s.to - s.from) * texelsPerTile;
        sprite.height = tex.height;
        sprite.tilePosition.set(-s.texelX, 0);
        const half = tex.height / 2 / texelsPerTile;
        const origin =
          s.axis === 'u'
            ? tileTopVertexToWorld(s.from, s.across - half, tileW, tileH)
            : tileTopVertexToWorld(s.across - half, s.from, tileW, tileH);
        if (s.axis === 'u') this.matrix.set(tileW * k, tileH * k, -tileW * k, tileH * k, origin.x, origin.y);
        else this.matrix.set(-tileW * k, tileH * k, tileW * k, tileH * k, origin.x, origin.y);
        /* Width and height are in strip pixels; the matrix takes those pixels onto the ground. */
        sprite.setFromMatrix(this.matrix);
        sprite.visible = true;
      }
    }
    for (let i = used; i < this.pool.length; i++) this.pool[i]!.visible = false;
  }

  private make(): TilingSprite {
    const s = new TilingSprite({ texture: Texture.EMPTY, width: 1, height: 1 });
    this.container.addChild(s);
    this.pool.push(s);
    return s;
  }

  destroy(): void {
    if (!this.container.destroyed) this.container.destroy({ children: true });
    this.pool.length = 0;
    this.textures.clear();
    this.loaded = false;
  }
}
