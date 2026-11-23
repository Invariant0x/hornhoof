import { describe, expect, it } from 'vitest';
import {
  ART_CONTRACT_VERSION,
  declaredArtFiles,
  resolveBuildingArt,
  resolveResidentArt,
  validateArtIndex,
  type ArtIndex,
  type ArtIndexEntry,
  type DeclaredArtFile,
} from '../src/world/art';
import { targetSpanForProgress, type BuildingKind, type CityBuilding } from '../src/world/city-layout';
import { validateWorldPack, type FootprintKey, type WorldPackManifest } from '../src/world/manifest';
import type { ResidentEntity } from '../src/world/residents';
import { registeredWorldPackIds, resolveWorldPack } from '../src/world-packs/registry';

const PACKS_WITH_ART: readonly WorldPackManifest[] = registeredWorldPackIds()
  .map(id => resolveWorldPack(id))
  .filter((p): p is WorldPackManifest => Boolean(p?.art));

/* Sizes the city engine grows each kind to (city-layout.ts), which the art steps must cover exactly. */
const ENGINE_SPANS: Readonly<Record<BuildingKind, readonly number[]>> = {
  house: [1, 2, 3, 4],
  department: [3, 4, 5],
  residence: [2, 3, 4, 5, 6],
  district_hub: [3, 4],
  supply: [3],
  flophouse: [2, 3],
  statue: [1, 2, 3],
  monument: [4, 5, 6],
};

function stepFootprintOf(pack: WorldPackManifest, path: string): FootprintKey | null {
  const [, kind, stepId] = path.split('/');
  return pack.art?.buildings[kind as BuildingKind]?.find(s => s.id === stepId)?.footprint ?? null;
}

/* An index with every declared file present and geometrically correct, as a finished pack would have. */
function completeIndex(pack: WorldPackManifest): ArtIndex {
  const files: Record<string, ArtIndexEntry> = {};
  const declared = declaredArtFiles(pack);
  const entryFor = (d: DeclaredArtFile): ArtIndexEntry | null => {
    if (d.passport === 'picture') {
      const fpKey = d.role === 'module' ? (d.path.split('/')[1] as FootprintKey) : (stepFootprintOf(pack, d.path) ?? '1x1');
      const fp = pack.projection.buildingFootprintsMaster4x[fpKey];
      const w = fp.diamondW + 8;
      const h = Math.min(fp.maxCanvasH, fp.diamondH + 300);
      const cx = w / 2;
      const cy = h - fp.diamondH / 2 - 4;
      return {
        w,
        h,
        passport: {
          groundAnchor: { x: cx, y: cy },
          corners: {
            top: { x: cx, y: cy - fp.diamondH / 2 },
            right: { x: cx + fp.diamondW / 2, y: cy },
            bottom: { x: cx, y: cy + fp.diamondH / 2 },
            left: { x: cx - fp.diamondW / 2, y: cy },
          },
          flagAnchor: { x: cx + 10, y: 20 },
          topAnchor: { x: cx, y: 10 },
        },
      };
    }
    if (d.passport === 'anchor') return { w: 40, h: 100, passport: { anchor: { x: 20, y: 98 } } };
    if (d.passport === 'sheet') {
      const rows = d.role === 'person' ? 5 : 1;
      return { w: 8 * 136, h: rows * 200, passport: { frameW: 136, frameH: 200, frames: 8, fps: 10, anchor: { x: 68, y: 190 } } };
    }
    return d.role === 'cloak' ? { w: 8 * 136, h: 5 * 200 } : null;
  };
  for (const d of declared) {
    const entry = entryFor(d);
    if (entry) files[d.path] = entry;
  }
  return { contract: ART_CONTRACT_VERSION, pack: pack.id, files };
}

function cityBuilding(kind: BuildingKind, span: number, stage: number, level: number, maxStage: number): CityBuilding {
  return {
    id: `${kind}-${span}-${stage}-${level}`,
    kind,
    label: kind,
    col: 40,
    row: 40,
    spanCol: span,
    spanRow: span,
    lot: { col: 40, row: 40, spanCol: 6, spanRow: 6 },
    door: { col: 41, row: 39 },
    stage,
    maxStage,
    floors: 1,
    level,
    residentIds: [],
    mergedFromIds: [],
    goalCount: 0,
    placedAtStep: 0,
    fullness: 0.6,
    progress: 0.5,
  };
}

describe('Stage 9 world packs follow the art contract', () => {
  it('has at least the Egypt pack and a second pack with an art catalog', () => {
    expect(PACKS_WITH_ART.map(p => p.id)).toContain('egypt');
    expect(PACKS_WITH_ART.length).toBeGreaterThanOrEqual(2);
  });

  for (const pack of PACKS_WITH_ART) {
    describe(`pack ${pack.id}`, () => {
      it('validates and declares a step for every size the engine grows each building kind to', () => {
        expect(validateWorldPack(pack)).toEqual({ ok: true });
        for (const [kind, engineSpans] of Object.entries(ENGINE_SPANS)) {
          const steps = pack.art?.buildings[kind as BuildingKind] ?? [];
          const covered = new Set(steps.map(s => Number(s.footprint.split('x')[0])));
          /* A pack's layout rule replaces the engine's sizes of a kind. */
          const spans = pack.buildingLayout?.[kind as BuildingKind]?.spans ?? engineSpans;
          for (const span of spans) expect(covered.has(span), `${pack.id} ${kind} ${span}x${span}`).toBe(true);
        }
        expect(pack.art?.altar).toBe(true);
        expect(pack.art?.flags).toEqual({ district: true, department: true });
        expect(pack.art?.loops).toEqual(['crane', 'hoist_block', 'dust', 'smoke', 'water', 'awning', 'celebration']);
        expect(pack.art?.people?.tiers).toBe(5);
        /* Every look the pack can give a resident has its own sheets. */
        const lookIds = new Set([
          ...Object.values(pack.roleLooks ?? {}).map(l => l.id),
          ...Object.values(pack.classFallbackLooks ?? {}).map(l => l.id),
        ]);
        expect(new Set(pack.art?.people?.looks)).toEqual(lookIds);
      });

      it('accepts a complete synthetic art folder without errors and finds every required file', () => {
        const report = validateArtIndex(pack, completeIndex(pack));
        expect(report.errors).toEqual([]);
        expect(report.warnings).toEqual([]);
        expect(report.missingRequired).toEqual([]);
        expect(report.present).toBeGreaterThan(0);
      });

      it('draws each kind with the step of its exact size at every stage and level the engine produces', () => {
        const index = completeIndex(pack);
        /* Reserved growth lots from city-layout.ts defaultFootprint, or the last size of the pack's layout rule. */
        const engineLots: Partial<Record<BuildingKind, number>> = { house: 4, department: 5, residence: 6, district_hub: 4, flophouse: 3, supply: 3 };
        const lotSpans: Partial<Record<BuildingKind, number>> = { ...engineLots };
        for (const [kind, rule] of Object.entries(pack.buildingLayout ?? {})) lotSpans[kind as BuildingKind] = rule.spans.at(-1);
        const standardKinds: BuildingKind[] = ['house', 'department', 'residence', 'district_hub', 'flophouse', 'supply'];
        const maxStages: Partial<Record<BuildingKind, number>> = { residence: 5, flophouse: 6, supply: 6 };
        for (const kind of standardKinds) {
          const maxStage = maxStages[kind] ?? 10;
          for (let stage = 1; stage <= maxStage; stage++) {
            for (const level of kind === 'house' ? [1, 3, 4, 7, 8, 14, 15, 30] : [1]) {
              const lotSpan = lotSpans[kind]!;
              const lot = { col: 40, row: 40, spanCol: lotSpan, spanRow: lotSpan };
              const span = targetSpanForProgress(kind, level, stage, lot, pack.buildingLayout).spanCol;
              const art = resolveBuildingArt(pack, index, cityBuilding(kind, span, stage, level, maxStage), null);
              expect(art, `${pack.id} ${kind} stage ${stage} level ${level}`).not.toBeNull();
              const mainPath = art!.layers.find(l => l.path.startsWith('buildings/') || l.path.startsWith('modules/'))!.path;
              const fp = mainPath.startsWith('modules/') ? mainPath.split('/')[1] : stepFootprintOf(pack, mainPath);
              expect(fp, `${pack.id} ${kind} stage ${stage} level ${level} -> ${mainPath}`).toBe(`${span}x${span}`);
            }
          }
        }
        for (const span of [1, 2, 3]) {
          const art = resolveBuildingArt(pack, index, cityBuilding('statue', span, 20, 1, 20), null);
          expect(stepFootprintOf(pack, art!.layers[0]!.path)).toBe(`${span}x${span}`);
        }
        for (const span of [4, 5, 6]) {
          const art = resolveBuildingArt(pack, index, { ...cityBuilding('monument', span, 10, 1, 10), reached: true, progress: 1 }, null);
          expect(art!.layers.map(l => l.path.split('/').pop())).toEqual([`tier_${String(pack.stageCounts.monument).padStart(2, '0')}.png`, 'capstone.png']);
        }
      });

      it('gives every look a sheet for every pose at every outfit tier', () => {
        const index = completeIndex(pack);
        for (const look of pack.art?.people?.looks ?? []) {
          const r = {
            id: 'r',
            look: { id: look },
            roleClass: 'executor',
            outfitTier: 5,
            facing: 'W',
            walkPhase: 0,
            pose: 'carrying_stone',
            cloakColor: '#123456',
          } as unknown as ResidentEntity;
          const art = resolveResidentArt(pack, index, r, 1.25);
          expect(art?.layers.map(l => l.path)).toEqual([`people/${look}/tier_5/carry.png`, `people/${look}/tier_5/carry.cloak.png`]);
          expect(art?.mirror).toBe(true);
        }
      });
    });
  }
});
