import { Graphics, Texture } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import {
  ART_CONTRACT_VERSION,
  BOAT_BLOCK,
  declaredArtFiles,
  validateArtIndex,
  type ArtIndex,
  type ArtIndexEntry,
} from '../src/world/art';
import type { FootprintKey } from '../src/world/manifest';
import { harbourAt, jettyAxis, planHarbour, quayAxis, type RiverHarbourPlan } from '../src/world/harbour';
import { drawHarbourArtPixi, harbourArtNeeds, harbourArtReady } from '../src/world/harbour-renderer';
import { createHornhoofLiveFixture, syncLiveSnapshotToCity } from '../src/world/live-sync';
import { createResidentSimulation } from '../src/world/residents';
import { renderResidentsToPixi, type ResidentArtContext } from '../src/world/residents-renderer';
import { generateWorldTerrain } from '../src/world/terrain-engine';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';
import { normalizePassport } from '../world-art-index.config';

/* #2006: the harbour comes only from its art (#105, #107): with the files of H1 to H6 it is drawn, without any one of
   them nothing of it is, and the stones keep coming from home. A fixture index stands in for the art folder. */

const pack = EGYPT_WORLD_PACK;
const T0 = Date.parse('2026-11-21T19:00:00Z');

function picture(fp: FootprintKey, extra: Record<string, unknown> = {}): ArtIndexEntry {
  const m = pack.projection.buildingFootprintsMaster4x[fp];
  const h = Math.min(m.maxCanvasH, m.diamondH + 300);
  const cy = h - m.diamondH / 2 - 1;
  const cx = m.diamondW / 2;
  return {
    w: m.diamondW,
    h,
    passport: {
      groundAnchor: { x: cx, y: cy },
      corners: { top: { x: cx, y: cy - m.diamondH / 2 }, right: { x: m.diamondW, y: cy }, bottom: { x: cx, y: cy + m.diamondH / 2 }, left: { x: 0, y: cy } },
      ...extra,
    },
  } as ArtIndexEntry;
}

function boatPicture(points = 2): ArtIndexEntry {
  const cargoPoints = [
    { x: 173, y: 468 },
    { x: 307, y: 536 },
    { x: 240, y: 500 },
    { x: 200, y: 480 },
  ].slice(0, points);
  return { w: 480, h: 680, passport: { anchor: { x: 240, y: 559 }, bow: { x: 396, y: 567 }, heading: 'SE', lengthTiles: 2.6, cargoPoints } } as ArtIndexEntry;
}

/* Every harbour file of the egypt catalog, as an artist would deliver it (Ivan AI's packs of 24.11). */
function fullHarbourIndex(): ArtIndex {
  const files: Record<string, ArtIndexEntry> = {};
  for (const d of declaredArtFiles(pack)) {
    if (d.role !== 'harbour') continue;
    if (d.path === BOAT_BLOCK) files[d.path] = { w: 120, h: 120, passport: { anchor: { x: 60, y: 100 }, stackTop: { x: 60, y: 40 } } } as ArtIndexEntry;
    else if (d.path.startsWith('boats/')) files[d.path] = boatPicture();
    else files[d.path] = picture(d.footprint!, /jetty_[uv]_end/.test(d.path) ? { mooring: { x: 60, y: 380 } } : {});
  }
  return { contract: ART_CONTRACT_VERSION, pack: pack.id, files };
}

function riverCity() {
  const live = createHornhoofLiveFixture();
  const map = generateWorldTerrain(pack, { seed: live.company.seed, mapSize: 150 });
  const { city } = syncLiveSnapshotToCity(pack, map, live);
  const plan = planHarbour(pack, map, city) as RiverHarbourPlan;
  expect(plan.kind).toBe('river');
  return { live, city, plan };
}

/* An art context that records what is drawn instead of drawing it. */
function recordingContext(index: ArtIndex) {
  const drawn: { path: string; x: number; y: number; depth: number }[] = [];
  let lastPath = '';
  const pool = {
    depth: 0,
    begin() {},
    graphics: () => new Graphics(),
    sprite: () => {
      const at = { path: lastPath, x: 0, y: 0, depth: pool.depth };
      drawn.push(at);
      return {
        anchor: { set() {} },
        scale: { set() {} },
        position: {
          set(x: number, y: number) {
            at.x = x;
            at.y = y;
          },
        },
        tint: 0xffffff,
      };
    },
  };
  const library = {
    index,
    stats: { indexedFiles: 0, loadedTextures: 0, buildingsDrawn: 0, residentsDrawn: 0 },
    frame: (path: string) => {
      lastPath = path;
      return index.files[path] ? Texture.WHITE : null;
    },
  };
  return { ctx: { library, pool } as unknown as ResidentArtContext, drawn };
}

describe('The harbour is drawn from its art only (#2006)', () => {
  it('declares the harbour slots by Ivan AI’s names of 24.11 and requires none of them', () => {
    const harbour = declaredArtFiles(pack).filter(d => d.role === 'harbour');
    const paths = harbour.map(d => d.path);
    for (const kind of ['quay', 'jetty']) {
      for (const axis of ['u', 'v']) for (const piece of ['start', 'span', 'end']) expect(paths).toContain(`harbour/${kind}_${axis}_${piece}.png`);
    }
    for (const p of ['sail_ne', 'sail_se', 'sail_sw', 'sail_nw', 'moored_u', 'moored_v', 'empty_u', 'empty_v', 'block']) expect(paths).toContain(`boats/cargo/${p}.png`);
    for (let n = 0; n <= 4; n++) expect(paths).toContain(`harbour/stone_yard/fill_${n}.png`);
    expect(paths.filter(p => p.startsWith('harbour/stone_yard/'))).toHaveLength(5);
    expect(paths.some(p => /harbour\/(pier|boat_|yard\/)/.test(p)), 'no slot keeps the old names').toBe(false);
    expect(harbour.find(d => d.path === 'harbour/stone_yard/fill_0.png')?.footprint).toBe('2x2');
    expect(harbour.every(d => !d.required)).toBe(true);
    expect(validateArtIndex(pack, fullHarbourIndex()).errors).toEqual([]);
  });

  it('reads the delivered passports: points as pairs, the yard’s shadow layer, stack tops and cargo points', () => {
    const delivered = normalizePassport({
      anchor: [240, 559],
      bow: [396, 567],
      heading: 'SE',
      lengthTiles: 2.6,
      cargoPoints: [
        [173, 468],
        [307, 536],
      ],
    });
    const files = { ...fullHarbourIndex().files, 'boats/cargo/moored_u.png': { w: 480, h: 680, passport: delivered } as ArtIndexEntry };
    const yard = picture('2x2', { layers: [{ file: 'fill_2_shadow.png', blend: 'multiply' }], stackTops: [{ x: 240, y: 492 }] });
    files['harbour/stone_yard/fill_2.png'] = yard;
    files['harbour/stone_yard/fill_2_shadow.png'] = { w: yard.w, h: yard.h } as ArtIndexEntry;
    expect(validateArtIndex(pack, { ...fullHarbourIndex(), files }).errors).toEqual([]);
  });

  it('shows no harbour until every file it needs is in the art folder', () => {
    const { plan } = riverCity();
    const full = fullHarbourIndex();
    expect(harbourArtReady(pack, full, plan)).toBe(true);
    expect(harbourArtReady(pack, null, plan)).toBe(false);
    expect(harbourArtReady({ ...pack, art: { ...pack.art!, harbour: undefined } }, full, plan)).toBe(false);
    for (const need of harbourArtNeeds(plan)) {
      const files = { ...full.files };
      delete files[need];
      expect(harbourArtReady(pack, { ...full, files }, plan), need).toBe(false);
    }
  });

  it('rejects a boat without a cargo point and a mooring point off its picture', () => {
    const index = fullHarbourIndex();
    const files = {
      ...index.files,
      'boats/cargo/sail_ne.png': boatPicture(0),
      'boats/cargo/moored_v.png': { w: 480, h: 680, passport: { anchor: { x: 240, y: 559 } } } as ArtIndexEntry,
      'harbour/jetty_u_end.png': picture('1x1', { mooring: { x: 900, y: 10 } }),
    };
    const errors = validateArtIndex(pack, { ...index, files }).errors;
    expect(errors.some(e => e.startsWith('boats/cargo/sail_ne.png:') && e.includes('cargo point'))).toBe(true);
    expect(errors.some(e => e.startsWith('boats/cargo/moored_v.png:') && e.includes('cargo point'))).toBe(true);
    expect(errors.some(e => e.startsWith('harbour/jetty_u_end.png:') && e.includes('mooring'))).toBe(true);
  });

  it('draws the quay, the piers, the yard at the queue’s fill and a boat with the blocks it brings', () => {
    const { live, city, plan } = riverCity();
    const flowLive = { ...live, generatedAt: new Date(T0).toISOString(), taskFlow: { open: 7, arrivals: [0, 2, 5].map(s => new Date(T0 + s * 1000).toISOString()) } };
    const sim = createResidentSimulation(pack, city, flowLive, { harbour: plan, harbourShown: true });
    const harbour = sim.harbour!;
    const trip = harbour.trips[0]!;
    expect(trip.stones).toBe(3);
    harbour.nowMs = Math.round((trip.leaveMs + trip.mooredMs) / 2);
    const { ctx, drawn } = recordingContext(fullHarbourIndex());
    const everything = { minX: -1e9, maxX: 1e9, minY: -1e9, maxY: 1e9 };
    drawHarbourArtPixi(ctx, pack, ctx.library.index!, harbour, 1, everything, 120, 60);
    const paths = drawn.map(d => d.path);
    const quay = quayAxis(plan.side);
    const jetty = jettyAxis(plan.side);
    expect(paths.filter(p => p.startsWith(`harbour/quay_${quay}_`))).toHaveLength(plan.quay.length);
    expect(paths.filter(p => p === `harbour/quay_${quay}_start.png`)).toHaveLength(1);
    expect(paths.filter(p => p === `harbour/quay_${quay}_end.png`)).toHaveLength(1);
    expect(paths.filter(p => p === `harbour/jetty_${jetty}_start.png`)).toHaveLength(plan.piers.length);
    expect(paths.filter(p => p === `harbour/jetty_${jetty}_end.png`)).toHaveLength(plan.piers.length);
    /* 7 open, 3 of them still aboard: 4 in the yard, fill stage 2. */
    expect(paths).toContain('harbour/stone_yard/fill_2.png');
    const boat = harbourAt(plan, harbour.trips, harbour.flow, harbour.nowMs).carriers[0]!;
    expect(boat.state).toBe('sail');
    expect(paths).toContain(`boats/cargo/sail_${boat.facing.toLowerCase()}.png`);
    expect(paths.filter(p => p === BOAT_BLOCK)).toHaveLength(3);
    expect(paths.every(p => p.startsWith('harbour/') || p.startsWith('boats/cargo/'))).toBe(true);
  });

  it('moors a loaded boat along its jetty, then shows it empty, and stacks the blocks on its cargo points', () => {
    const { live, city, plan } = riverCity();
    const flowLive = { ...live, generatedAt: new Date(T0).toISOString(), taskFlow: { open: 4, arrivals: [0, 1, 2, 3].map(s => new Date(T0 + s * 1000).toISOString()) } };
    const sim = createResidentSimulation(pack, city, flowLive, { harbour: plan, harbourShown: true });
    const harbour = sim.harbour!;
    const trip = harbour.trips[0]!;
    expect(trip.stones).toBe(4);
    const everything = { minX: -1e9, maxX: 1e9, minY: -1e9, maxY: 1e9 };
    const draw = (atMs: number) => {
      harbour.nowMs = atMs;
      const { ctx, drawn } = recordingContext(fullHarbourIndex());
      drawHarbourArtPixi(ctx, pack, ctx.library.index!, harbour, 1, everything, 120, 60);
      return { drawn, boat: harbourAt(plan, harbour.trips, harbour.flow, atMs).carriers[0]! };
    };
    const moored = draw(trip.mooredMs + 1);
    expect(moored.boat.state).not.toBe('sail');
    expect(moored.boat.cargo).toBe(4);
    expect(moored.drawn.map(d => d.path)).toContain(`boats/cargo/moored_${jettyAxis(plan.side)}.png`);
    /* Four blocks on two cargo points: two stacks of two, the upper one at the lower one's stack top. */
    const blocks = moored.drawn.filter(d => d.path === BOAT_BLOCK);
    expect(blocks).toHaveLength(4);
    expect(new Set(blocks.map(b => b.x)).size).toBe(2);
    const [first, , third] = blocks;
    expect(third!.x).toBeCloseTo(first!.x, 6);
    expect(third!.y).toBeLessThan(first!.y);
    for (const b of blocks) expect(b.depth).toBeGreaterThan(moored.drawn.find(d => d.path.startsWith('boats/cargo/moored_'))!.depth);

    const empty = draw(trip.unloadedMs + 1);
    expect(empty.boat.cargo).toBe(0);
    expect(empty.drawn.map(d => d.path)).toContain(`boats/cargo/empty_${jettyAxis(plan.side)}.png`);
    expect(empty.drawn.some(d => d.path === BOAT_BLOCK)).toBe(false);
  });

  it('draws no more blocks than its cargo points when the block has no stack top', () => {
    const { live, city, plan } = riverCity();
    const flowLive = { ...live, generatedAt: new Date(T0).toISOString(), taskFlow: { open: 4, arrivals: [0, 1, 2, 3].map(s => new Date(T0 + s * 1000).toISOString()) } };
    const sim = createResidentSimulation(pack, city, flowLive, { harbour: plan, harbourShown: true });
    const harbour = sim.harbour!;
    harbour.nowMs = harbour.trips[0]!.leaveMs + 1;
    const index = fullHarbourIndex();
    const files = { ...index.files, [BOAT_BLOCK]: { w: 120, h: 120, passport: { anchor: { x: 60, y: 100 } } } as ArtIndexEntry };
    const { ctx, drawn } = recordingContext({ ...index, files });
    drawHarbourArtPixi(ctx, pack, ctx.library.index!, harbour, 1, { minX: -1e9, maxX: 1e9, minY: -1e9, maxY: 1e9 }, 120, 60);
    expect(drawn.filter(d => d.path === BOAT_BLOCK)).toHaveLength(2);
  });

  it('the residents layer leaves the harbour out while its art is missing and draws it once it is in', () => {
    const { live, city, plan } = riverCity();
    const sim = createResidentSimulation(pack, city, live, { harbour: plan });
    const everything = { minX: -1e9, maxX: 1e9, minY: -1e9, maxY: 1e9 };
    const hidden = recordingContext(fullHarbourIndex());
    renderResidentsToPixi(new Graphics(), sim, city, pack, everything, 120, 60, null, undefined, hidden.ctx);
    expect(hidden.drawn.filter(d => d.path.startsWith('harbour/'))).toEqual([]);
    sim.harbour!.shown = true;
    const shown = recordingContext(fullHarbourIndex());
    renderResidentsToPixi(new Graphics(), sim, city, pack, everything, 120, 60, null, undefined, shown.ctx);
    expect(shown.drawn.some(d => d.path.startsWith(`harbour/quay_${quayAxis(plan.side)}_`))).toBe(true);
    expect(shown.drawn.some(d => d.path.startsWith('harbour/stone_yard/'))).toBe(true);
  });
});
