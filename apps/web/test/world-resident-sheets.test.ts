import { describe, expect, it } from 'vitest';
import {
  declaredArtFiles,
  residentBody,
  residentLayerPlacement,
  resolveResidentArt,
  sheetRowFor,
  validateArtIndex,
  RESIDENT_BODIES,
  type ArtIndex,
  type ArtIndexEntry,
  type SheetPassport,
} from '../src/world/art';
import { WorldArtFiles } from '../src/world/art-files';
import { WorldArtLibrary } from '../src/world/art-runtime';
import type { CityBuilding } from '../src/world/city-layout';
import { createConstructionSimulation, startBuildingConstruction, startBuildingDemolition, workSlotsForBuilding } from '../src/world/construction';
import type { ResidentEntity } from '../src/world/residents';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

const FACINGS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

function sheet(frames: number, directions?: readonly string[], extra: Partial<SheetPassport> = {}): ArtIndexEntry {
  const rows = directions?.length ?? 5;
  return {
    w: 192 * frames,
    h: 256 * rows,
    passport: { frameW: 192, frameH: 256, frames, fps: 4, anchor: { x: 96, y: 236 }, ...(directions ? { directions } : {}), ...extra } as SheetPassport,
  };
}

function resident(partial: Partial<ResidentEntity>): ResidentEntity {
  return {
    id: 'res-agent-3',
    agentId: 'agent-3',
    name: 'R',
    roleKey: null,
    roleClass: 'executor',
    archetype: 'architect',
    look: { id: 'egypt-architect', label: 'A', prop: 'scroll', headgear: 'hood' },
    level: 6,
    outfitTier: 3,
    cloakColor: '#C96A4B',
    facing: 'S',
    walkPhase: 0,
    pose: 'walking',
    col: 5,
    row: 5,
    ...partial,
  } as ResidentEntity;
}

const index = (files: Record<string, ArtIndexEntry>): ArtIndex => ({ contract: 2, pack: 'egypt', files });

describe('Resident sheets drawn only in the directions they need (#1975)', () => {
  it('shows the nearest drawn direction or its mirror for every way a resident faces', () => {
    const shown = (directions: readonly string[] | undefined, facingPose = false) =>
      FACINGS.map(f => {
        const { row, mirror } = sheetRowFor(directions as SheetPassport['directions'], f, facingPose);
        return `${(directions ?? ['N', 'NE', 'E', 'SE', 'S'])[row]}${mirror ? '~' : ''}`;
      });
    /* No field: the five rows N..S, the west faces mirrored from the east ones. */
    expect(shown(undefined)).toEqual(['N', 'NE', 'E', 'SE', 'S', 'SE~', 'E~', 'NE~']);
    /* Idle drawn SE: the south half sees SE or its mirror SW; the north half the nearest of the two. */
    expect(shown(['SE'])).toEqual(['SE', 'SE', 'SE', 'SE', 'SE', 'SE~', 'SE~', 'SE~']);
    /* Build drawn NE: NE, or its mirror NW for faces nearer the west. */
    expect(shown(['NE'])).toEqual(['NE', 'NE', 'NE', 'NE', 'NE', 'NE~', 'NE~', 'NE~']);
    expect(shown(['S'])).toEqual(['S', 'S', 'S', 'S', 'S', 'S', 'S', 'S']);
    expect(shown(['NE', 'SE'])).toEqual(['NE', 'NE', 'NE', 'SE', 'SE', 'SE~', 'NE~', 'NE~']);
  });

  it('never mirrors or turns a facing pose: pray and sad_sit show as drawn in every direction', () => {
    for (const f of FACINGS) expect(sheetRowFor(['S'], f, true)).toEqual({ row: 0, mirror: false });
    for (const f of FACINGS) expect(sheetRowFor(undefined, f, true)).toEqual({ row: 4, mirror: false });
    const files = index({ 'people/egypt-architect/tier_3/pray.png': sheet(4, ['S']), 'people/egypt-architect/tier_3/sad_sit.png': sheet(4, ['S']) });
    for (const f of FACINGS) {
      const art = resolveResidentArt(EGYPT_WORLD_PACK, files, resident({ pose: 'praying', facing: f }), 0)!;
      expect(art.mirror, f).toBe(false);
      expect(art.layers[0]!.frame.y, f).toBe(0);
    }
  });

  it('rejects a sheet whose height is not frameH times its directions, or that names a direction twice or one it does not know', () => {
    const at = 'people/egypt-architect/tier_1/';
    const report = validateArtIndex(
      EGYPT_WORLD_PACK,
      index({
        [`${at}walk.png`]: sheet(8),
        [`${at}idle.png`]: sheet(4, ['SE']),
        [`${at}build.png`]: { ...sheet(6, ['NE']), h: 256 * 5 },
        [`${at}sleep.png`]: sheet(4, ['SE', 'SE']),
        [`${at}pray.png`]: sheet(4, ['SSW' as 'SW']),
        /* The west directions may be drawn too (#1983, Ivan 23.11: a big carried item keeps its hand). */
        [`${at}sad_sit.png`]: sheet(4, ['SE', 'SW']),
      }),
    );
    expect(report.errors.filter(e => [`${at}walk.png`, `${at}idle.png`, `${at}sad_sit.png`].some(p => e.startsWith(p)))).toEqual([]);
    expect(report.errors.some(e => e.startsWith(`${at}build.png`) && /height/.test(e))).toBe(true);
    expect(report.errors.some(e => e.startsWith(`${at}sleep.png`) && /twice/.test(e))).toBe(true);
    expect(report.errors.some(e => e.startsWith(`${at}pray.png`) && /directions/.test(e))).toBe(true);
  });
});

describe('Body types of residents (#1975)', () => {
  it('gives the same agent the same body on two loads, and every body to some agents', () => {
    expect(RESIDENT_BODIES).toEqual(['male_slim', 'female_slim', 'male_heavy', 'female_full']);
    const agents = Array.from({ length: 200 }, (_, i) => `agent-${i}`);
    expect(agents.map(residentBody)).toEqual(agents.map(residentBody));
    expect(new Set(agents.map(residentBody))).toEqual(new Set(RESIDENT_BODIES));
  });

  it('draws the body’s own sheet, and male_slim, laid directly in the tier folder, where that body is missing', () => {
    const agent = Array.from({ length: 50 }, (_, i) => `agent-${i}`).find(a => residentBody(a) === 'female_full')!;
    const r = resident({ agentId: agent, id: `res-${agent}` });
    const own = index({ 'people/egypt-architect/tier_3/walk.png': sheet(8), 'people/egypt-architect/tier_3/female_full/walk.png': sheet(8) });
    expect(resolveResidentArt(EGYPT_WORLD_PACK, own, r, 0)!.layers[0]!.path).toBe('people/egypt-architect/tier_3/female_full/walk.png');
    const slim = index({ 'people/egypt-architect/tier_3/walk.png': sheet(8) });
    expect(resolveResidentArt(EGYPT_WORLD_PACK, slim, r, 0)!.layers[0]!.path).toBe('people/egypt-architect/tier_3/walk.png');
    const paths = new Set(declaredArtFiles(EGYPT_WORLD_PACK).map(f => f.path));
    expect(paths.has('people/egypt-architect/tier_1/female_full/walk.png')).toBe(true);
    expect(paths.has('people/egypt-architect/tier_1/sad_sit.png')).toBe(true);
    expect(paths.has('loops/sleep_z.png')).toBe(true);
  });
});

describe('The Z-z-z over a sleeper (#1975)', () => {
  const z: ArtIndexEntry = { w: 64 * 6, h: 96, passport: { frameW: 64, frameH: 96, frames: 6, fps: 3, anchor: { x: 32, y: 90 }, attach: 'head' } };

  it('puts the loop at the sleep sheet’s headAnchor, or 146 px above the feet without one, upright on a mirrored sleeper', () => {
    const at = 'people/egypt-architect/tier_3/';
    const lying = index({ [`${at}sleep.png`]: sheet(4, ['SE'], { headAnchor: { x: 60, y: 200 } }), 'loops/sleep_z.png': z });
    const art = resolveResidentArt(EGYPT_WORLD_PACK, lying, resident({ pose: 'sleeping', facing: 'SE' }), 0)!;
    expect(art.layers.map(l => l.path)).toEqual([`${at}sleep.png`, 'loops/sleep_z.png']);
    const zLayer = art.layers[1]!;
    expect(zLayer.at).toEqual({ x: 60 - 96, y: 200 - 236 });
    expect(zLayer.upright).toBe(true);
    /* Mirrored: the point moves to the other side of the feet, the letters stay readable. */
    expect(residentLayerPlacement(zLayer, true, 0.5, 100, 200)).toEqual({ x: 100 + 18, y: 200 - 18, scaleX: 0.5 });
    expect(residentLayerPlacement(art.layers[0]!, true, 0.5, 100, 200)).toEqual({ x: 100, y: 200, scaleX: -0.5 });
    const standing = index({ [`${at}sleep.png`]: sheet(4, ['SE']), 'loops/sleep_z.png': z });
    expect(resolveResidentArt(EGYPT_WORLD_PACK, standing, resident({ pose: 'sleeping' }), 0)!.layers[1]!.at).toEqual({ x: 0, y: -146 });
    expect(resolveResidentArt(EGYPT_WORLD_PACK, index({ [`${at}sleep.png`]: sheet(4, ['SE']) }), resident({ pose: 'sleeping' }), 0)!.layers).toHaveLength(1);
  });
});

describe('Builders face a front wall (#1975)', () => {
  function site(kind: CityBuilding['kind'], span: number, maxStage: number): CityBuilding {
    return {
      id: `${kind}-1`, kind, label: kind, col: 40, row: 40, spanCol: span, spanRow: span, lot: { col: 40, row: 40, spanCol: span, spanRow: span },
      door: { col: 40 + span, row: 40 + span - 1 }, stage: 1, maxStage, floors: 1, level: 1, residentIds: [], mergedFromIds: [], goalCount: 0, placedAtStep: 0, progress: 0.4,
    };
  }

  it('keeps every work place of a 3x3 building out of the strip its shared front scaffold and ramp stand in', () => {
    /* modules/README.md (r3), front_clear_strip: from the front right wall's outer face (u 1.95 on the shared 3x3
       modules) out to 0.40 tile on v 0.04..2.35, and out to 0.66 tile on v 1.78..1.96 for the ladder's foot. */
    const inStrip = (u: number, v: number) =>
      (u > 1.95 && u < 2.35 && v > 0.04 && v < 2.35) || (u > 1.95 && u < 2.61 && v > 1.78 && v < 1.96);
    for (const kind of ['house', 'department', 'flophouse', 'district_hub', 'supply', 'residence'] as const) {
      const sim = createConstructionSimulation(EGYPT_WORLD_PACK);
      for (let stage = 1; stage <= 10; stage++) {
        const b = { ...site(kind, 3, 10), stage };
        for (const job of [startBuildingConstruction(sim, b, 10, stage, 0.05), startBuildingDemolition(sim, b, 0.05), null]) {
          for (const slot of workSlotsForBuilding(b, job, EGYPT_WORLD_PACK)) {
            const u = slot.col - b.col;
            const v = slot.row - b.row;
            expect(inStrip(u, v), `${kind} stage ${stage} ${job?.phase ?? 'none'} ${slot.id} at u ${u.toFixed(2)} v ${v.toFixed(2)}`).toBe(false);
          }
        }
      }
    }
  });

  it('sets no work place behind a building or facing a back wall, at any stage, building or tearing down', () => {
    /* Everything in front of and beside the site taken, so a place behind it would be the only one left. */
    const busy = new Map<string, string>();
    for (let c = 30; c <= 60; c++) for (let r = 30; r <= 60; r++) if (c >= 45 || r >= 45) busy.set(`${c},${r}`, 'other');
    for (const [kind, span, max] of [['house', 2, 10], ['department', 4, 10], ['residence', 5, 5], ['statue', 3, 20], ['monument', 5, 10]] as const) {
      const sim = createConstructionSimulation(EGYPT_WORLD_PACK);
      for (let stage = 1; stage <= max; stage++) {
        for (const occupant of [undefined, busy]) {
          const b = site(kind, span, max);
          const jobs = [startBuildingConstruction(sim, b, max, stage, 0.05), startBuildingDemolition(sim, { ...b, stage }, 0.05), null];
          for (const job of jobs) {
            for (const slot of workSlotsForBuilding({ ...b, stage }, job, EGYPT_WORLD_PACK, occupant)) {
              const where = `${kind} stage ${stage} ${job?.phase ?? 'none'} ${slot.id}`;
              expect(slot.col >= b.col && slot.row >= b.row, where).toBe(true);
              if (slot.action !== 'pull_sled') expect(['N', 'W'], where).toContain(slot.facing);
            }
          }
        }
      }
    }
  });
});

/* Ivan, 23.11 (order v3 4.4): a mirrored row moves a held item to the other hand or shoulder, which shows at once. A
   resident walking the grid faces NE, SE, SW or NW on screen, so a carry and the walk of a look with a large item draw
   those four, and that look's idle SE and SW; the rest keep their drawn rows and a mirror. The tier 1 mason set accepted
   before the rule keeps its 5-row carry with a named warning. */
describe('Held items keep their hand: sheets drawn in the directions of 4.4 (#1983, Ivan 23.11)', () => {
  const EIGHT = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const WALKED = ['NE', 'SE', 'SW', 'NW'];
  const errorsOf = (files: Record<string, ArtIndexEntry>) => validateArtIndex(EGYPT_WORLD_PACK, index(files)).errors;
  const about = (errors: readonly string[], path: string) => errors.filter(e => e.startsWith(`${path}:`));

  it('rejects a carry without NE, SE, SW and NW, for every look, and shows its drawn SW and W rows as drawn', () => {
    const at = 'people/egypt-architect/tier_3/';
    const errors = errorsOf({
      [`${at}carry.png`]: sheet(8),
      [`${at}female_full/carry.png`]: sheet(8, ['N', 'NE', 'E', 'SE', 'S', 'SW']),
      [`${at}female_slim/carry.png`]: sheet(8, WALKED),
      [`${at}male_heavy/carry.png`]: sheet(8, EIGHT),
    });
    expect(about(errors, `${at}carry.png`)).toEqual([`${at}carry.png: carry must be drawn in NE, SE, SW and NW (order v3 4.4), it has N, NE, E, SE, S`]);
    expect(about(errors, `${at}female_full/carry.png`), 'no NW').toHaveLength(1);
    expect(about(errors, `${at}female_slim/carry.png`)).toEqual([]);
    expect(about(errors, `${at}male_heavy/carry.png`), 'rows already drawn in N, E and S stay').toEqual([]);
    const four = index({ [`${at}carry.png`]: sheet(8, WALKED) });
    const sw = resolveResidentArt(EGYPT_WORLD_PACK, four, resident({ pose: 'carrying_stone', facing: 'SW' }), 0)!;
    expect([sw.layers[0]!.path, sw.layers[0]!.frame.y, sw.mirror]).toEqual([`${at}carry.png`, 256 * WALKED.indexOf('SW'), false]);
    const eight = index({ [`${at}carry.png`]: sheet(8, EIGHT) });
    const w = resolveResidentArt(EGYPT_WORLD_PACK, eight, resident({ pose: 'carrying_stone', facing: 'W' }), 0)!;
    expect([w.layers[0]!.frame.y, w.mirror]).toEqual([256 * EIGHT.indexOf('W'), false]);
  });

  it('rejects the walk of a look with a large item without NE, SE, SW and NW and its idle without SE and SW; other looks keep a mirror', () => {
    const overseer = 'people/egypt-overseer/tier_1/';
    const hoe = 'people/egypt-canal-builder/tier_1/';
    const errors = errorsOf({
      [`${overseer}walk.png`]: sheet(8),
      [`${overseer}idle.png`]: sheet(4, ['SE']),
      [`${hoe}walk.png`]: sheet(8),
      [`${hoe}idle.png`]: sheet(4, ['SW', 'SE']),
    });
    expect(about(errors, `${overseer}walk.png`)).toEqual([`${overseer}walk.png: walk of a look with a large item must be drawn in NE, SE, SW and NW (order v3 4.4), it has N, NE, E, SE, S`]);
    expect(about(errors, `${overseer}idle.png`)).toEqual([`${overseer}idle.png: idle of a look with a large item must be drawn in SE and SW (order v3 4.4), it has SE`]);
    expect(about(errors, `${hoe}walk.png`), 'the hoe is a large item').toHaveLength(1);
    expect(about(errors, `${hoe}idle.png`)).toEqual([]);
    expect(about(errorsOf({ [`${overseer}walk.png`]: sheet(8, WALKED), [`${overseer}idle.png`]: sheet(4, ['SE', 'SW']) }), overseer.slice(0, -1))).toEqual([]);
    /* A scroll, a key or a workshop tool is small: NE and SE drawn and a mirror, or the 5 rows of sheets already made. */
    for (const look of ['egypt-architect', 'egypt-scribe', 'egypt-keykeeper', 'egypt-machine-keeper', 'egypt-mason']) {
      const at = `people/${look}/tier_2/`;
      const files = { [`${at}walk.png`]: sheet(8, ['NE', 'SE']), [`${at}female_full/walk.png`]: sheet(8), [`${at}idle.png`]: sheet(4, ['SE']) };
      expect(about(errorsOf(files), at.slice(0, -1)), look).toEqual([]);
    }
    const large = Object.values(EGYPT_WORLD_PACK.roleLooks!).filter(l => l.largeItem).map(l => l.prop);
    expect(new Set(large)).toEqual(new Set(['staff', 'banner', 'spear_shield', 'water_jar', 'gong', 'tool']));
  });

  it('keeps the accepted mason carry egypt-mason-t1-r1 in play with a named warning, not an error, until its new export', async () => {
    const carry = 'people/egypt-mason/tier_1/carry.png';
    const old = index({ [carry]: sheet(8) });
    const report = validateArtIndex(EGYPT_WORLD_PACK, old);
    expect(about(report.errors, carry)).toEqual([]);
    expect(report.warnings).toContain(
      `${carry}: carry lacks SW and NW: the accepted set egypt-mason-t1-r1 stays in play until its export in NE, SE, SW and NW replaces it (order v3 4.4)`,
    );
    /* The game, the film and the pilot still draw it: the runtime keeps the sheet. */
    const folder = new WorldArtFiles({ packId: 'egypt', baseUrl: '/art/', store: null, fetch: async () => new Response(JSON.stringify(old)) });
    const lib = await WorldArtLibrary.load(EGYPT_WORLD_PACK, folder);
    expect(lib.index?.files[carry]).toBeDefined();
    lib.destroy();
    /* The new export passes with no warning; the grace covers that one file only. */
    const fresh = validateArtIndex(EGYPT_WORLD_PACK, index({ [carry]: sheet(8, WALKED) }));
    expect(fresh.warnings.filter(w => w.startsWith(carry))).toEqual([]);
    expect(about(errorsOf({ 'people/egypt-mason/tier_2/carry.png': sheet(8) }), 'people/egypt-mason/tier_2/carry.png')).toHaveLength(1);
  });
});
