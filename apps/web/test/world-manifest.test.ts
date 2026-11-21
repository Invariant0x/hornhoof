import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ISOMETRIC_PROJECTION, validateWorldPack, type WorldPackManifest } from '../src/world/manifest';
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
  it('validates the stub diamond pack with 150x150 map size and standard colleague proportions', () => {
    expect(validateWorldPack(STUB_DIAMOND_PACK)).toEqual({ ok: true });
    expect(STUB_DIAMOND_PACK.engine).toBe('isometric-2d');
    expect(STUB_DIAMOND_PACK.mapSize).toBe(150);
    expect(STUB_DIAMOND_PACK.projection).toEqual(DEFAULT_ISOMETRIC_PROJECTION);
    expect(STUB_DIAMOND_PACK.projection.tiers.master4x).toEqual({
      tileW: 240,
      tileH: 120,
      humanHeightPx: 136,
      rigSourceHumanHeightPx: 544,
    });
    expect(STUB_DIAMOND_PACK.projection.tiers.hd2x).toEqual({
      tileW: 120,
      tileH: 60,
      humanHeightPx: 68,
    });
    expect(STUB_DIAMOND_PACK.projection.tiers.classic1x).toEqual({
      tileW: 60,
      tileH: 30,
      humanHeightPx: 34,
    });
    expect(Object.keys(STUB_DIAMOND_PACK.projection.buildingFootprintsMaster4x)).toEqual([
      '1x1', '2x2', '3x3', '4x4', '5x5', '6x6',
    ]);
    expect(STUB_DIAMOND_PACK.projection.directions.uniqueRenderAngles).toEqual(['N', 'NE', 'E', 'SE', 'S']);
    expect(STUB_DIAMOND_PACK.projection.directions.order).toHaveLength(8);
  });

  it('rejects manifests with invalid mapSize, broken 2:1 tile ratio, bad chunkSize or bad colours', () => {
    const badSize: WorldPackManifest = { ...STUB_DIAMOND_PACK, mapSize: 0 };
    expect(validateWorldPack(badSize).ok).toBe(false);

    const badRatio: WorldPackManifest = {
      ...STUB_DIAMOND_PACK,
      projection: {
        ...STUB_DIAMOND_PACK.projection,
        tiers: {
          ...STUB_DIAMOND_PACK.projection.tiers,
          classic1x: { tileW: 60, tileH: 40, humanHeightPx: 34 },
        },
      },
    };
    expect(validateWorldPack(badRatio).ok).toBe(false);

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

  it('keeps the entire world engine and stub pack free of theme-specific words and em dashes', () => {
    const files = walkFiles(WORLD_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const rel = relative(WORLD_DIR, file);
      expect(FORBIDDEN_THEME_TERMS.test(rel), `theme word in filename ${rel}`).toBe(false);
      const body = readFileSync(file, 'utf8');
      expect(FORBIDDEN_THEME_TERMS.test(body), `theme word in ${rel}`).toBe(false);
      expect(body.includes('\u2014'), `em dash in ${rel}`).toBe(false);
    }
  });
});
