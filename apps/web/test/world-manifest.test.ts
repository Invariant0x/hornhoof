import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAMERA_BOUNDS,
  DEFAULT_ISOMETRIC_PROJECTION,
  packMaxSourceTileW,
  validateWorldPack,
  type WorldPackManifest,
} from '../src/world/manifest';
import { STUB_DIAMOND_PACK } from '../src/world/packs/stub-pack';

const WORLD_DIR = join(import.meta.dirname, '..', 'src', 'world');
const FORBIDDEN_THEME_TERMS = /\b(egypts?|egyptians?|pharaohs?|pyramids?|nile|papyrus|hieroglyphs?|sandstones?|obelisks?|sphinxes?|scarabs?|ankhs?|oasis|oases|lapis|karnak|giza|luxor)\b/i;

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkFiles(full));
    else if (/\.(ts|tsx|css|md|json)$/.test(name)) out.push(full);
  }
  return out;
}

describe('world pack manifest contract and stub pack', () => {
  it('validates the stub diamond pack with 150x150 map size, hard zoom bounds and 1x..8x LOD tiers', () => {
    expect(validateWorldPack(STUB_DIAMOND_PACK)).toEqual({ ok: true });
    expect(STUB_DIAMOND_PACK.engine).toBe('isometric-2d');
    expect(STUB_DIAMOND_PACK.mapSize).toBe(150);
    expect(STUB_DIAMOND_PACK.params.chunkSize).toBe(4);
    expect(STUB_DIAMOND_PACK.projection).toEqual(DEFAULT_ISOMETRIC_PROJECTION);
    expect(STUB_DIAMOND_PACK.camera).toEqual(DEFAULT_CAMERA_BOUNDS);
    expect(STUB_DIAMOND_PACK.projection.defaultTileW).toBe(120);
    expect(STUB_DIAMOND_PACK.projection.defaultTileH).toBe(60);

    expect(STUB_DIAMOND_PACK.projection.lods).toEqual([
      { id: '1x', tileW: 60, tileH: 30, humanHeightPx: 34, animationDetail: 'reduced' },
      { id: '2x', tileW: 120, tileH: 60, humanHeightPx: 68, animationDetail: 'standard' },
      { id: '4x', tileW: 240, tileH: 120, humanHeightPx: 136, animationDetail: 'full' },
      { id: '8x', tileW: 480, tileH: 240, humanHeightPx: 272, rigSourceHumanHeightPx: 544, animationDetail: 'full' },
    ]);
    expect(Object.keys(STUB_DIAMOND_PACK.projection.buildingFootprintsMaster4x)).toEqual([
      '1x1', '2x2', '3x3', '4x4', '5x5', '6x6',
    ]);
    expect(STUB_DIAMOND_PACK.projection.directions.uniqueRenderAngles).toEqual(['N', 'NE', 'E', 'SE', 'S']);
    expect(STUB_DIAMOND_PACK.projection.directions.order).toHaveLength(8);
  });

  it('controls map size via a single mapSize field and respects sprite source resolution caps', () => {
    const resized: WorldPackManifest = { ...STUB_DIAMOND_PACK, mapSize: 200 };
    expect(validateWorldPack(resized)).toEqual({ ok: true });
    expect(resized.resolveEmptyTileId?.(199, 100, resized.params.chunkSize, resized.mapSize)).toBe('border');
    expect(resized.resolveEmptyTileId?.(100, 100, resized.params.chunkSize, resized.mapSize)).toBe('origin');

    expect(packMaxSourceTileW(STUB_DIAMOND_PACK)).toBe(480);
    const spriteCapped: WorldPackManifest = {
      ...STUB_DIAMOND_PACK,
      sprites: [{ id: 'atlas-main', url: '/sprites/main.png', maxSourceTileW: 240 }],
    };
    expect(packMaxSourceTileW(spriteCapped)).toBe(240);
  });

  it('rejects manifests with invalid mapSize, bad tile ratio, unsorted LODs, bad camera bounds or bad colours', () => {
    expect(validateWorldPack({ ...STUB_DIAMOND_PACK, mapSize: 0 }).ok).toBe(false);

    const badDefaultRatio: WorldPackManifest = {
      ...STUB_DIAMOND_PACK,
      projection: { ...STUB_DIAMOND_PACK.projection, defaultTileW: 120, defaultTileH: 80 },
    };
    expect(validateWorldPack(badDefaultRatio).ok).toBe(false);

    const unsortedLods: WorldPackManifest = {
      ...STUB_DIAMOND_PACK,
      projection: {
        ...STUB_DIAMOND_PACK.projection,
        lods: [...STUB_DIAMOND_PACK.projection.lods].reverse(),
      },
    };
    expect(validateWorldPack(unsortedLods).ok).toBe(false);

    const badCamera: WorldPackManifest = {
      ...STUB_DIAMOND_PACK,
      camera: { minZoom: 1.5, defaultZoom: 1.0, maxZoom: 2.0 },
    };
    expect(validateWorldPack(badCamera).ok).toBe(false);

    const badChunk: WorldPackManifest = {
      ...STUB_DIAMOND_PACK,
      params: { ...STUB_DIAMOND_PACK.params, chunkSize: 0 },
    };
    expect(validateWorldPack(badChunk).ok).toBe(false);

    const badColor: WorldPackManifest = {
      ...STUB_DIAMOND_PACK,
      palette: { ...STUB_DIAMOND_PACK.palette, backdrop: 'not-a-hex' },
    };
    expect(validateWorldPack(badColor).ok).toBe(false);
  });

  it('keeps the entire world engine and stub pack free of theme-specific words, Russian yo and em dashes', () => {
    const files = walkFiles(WORLD_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const rel = relative(WORLD_DIR, file);
      expect(FORBIDDEN_THEME_TERMS.test(rel), `theme word in filename ${rel}`).toBe(false);
      const body = readFileSync(file, 'utf8');
      expect(FORBIDDEN_THEME_TERMS.test(body), `theme word in ${rel}`).toBe(false);
      expect(body.includes('\u2014'), `em dash in ${rel}`).toBe(false);
      expect(/[\u0451\u0401]/.test(body), `Russian yo in ${rel}`).toBe(false);
    }
  });
});
