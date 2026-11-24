import { Graphics, Texture } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import {
  ART_CONTRACT_VERSION,
  declaredArtFiles,
  validateArtIndex,
  type ArtIndex,
  type ArtIndexEntry,
} from '../src/world/art';
import type { FootprintKey } from '../src/world/manifest';
import { planHarbour, type RiverHarbourPlan } from '../src/world/harbour';
import { drawHarbourArtPixi, harbourArtNeeds, harbourArtReady } from '../src/world/harbour-renderer';
import { createHornhoofLiveFixture, syncLiveSnapshotToCity } from '../src/world/live-sync';
import { createResidentSimulation } from '../src/world/residents';
import { renderResidentsToPixi, type ResidentArtContext } from '../src/world/residents-renderer';
import { generateWorldTerrain } from '../src/world/terrain-engine';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

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

function sheet(frames: number, directions: readonly string[] = ['NE', 'SE', 'SW', 'NW']): ArtIndexEntry {
  return { w: 480 * frames, h: 400 * directions.length, passport: { frameW: 480, frameH: 400, frames, fps: 8, anchor: { x: 240, y: 300 }, directions } } as ArtIndexEntry;
}

/* Every harbour file of the egypt catalog, as an artist would deliver it. */
function fullHarbourIndex(): ArtIndex {
  const files: Record<string, ArtIndexEntry> = {};
  for (const d of declaredArtFiles(pack)) {
    if (d.role !== 'harbour') continue;
    if (d.passport === 'picture') files[d.path] = picture(d.footprint!, d.path.includes('pier_head') ? { mooring: { x: 60, y: 380 } } : {});
    else files[d.path] = sheet(d.path.includes('cargo') ? 1 : 8);
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
  it('declares the harbour slots of H1 to H6 and requires none of them', () => {
    const harbour = declaredArtFiles(pack).filter(d => d.role === 'harbour');
    const paths = harbour.map(d => d.path);
    for (const side of ['a', 'b']) {
      for (const piece of ['quay', 'pier_root', 'pier', 'pier_head', 'quay_end_' + side + '1', 'quay_end_' + side + '2']) {
        expect(paths).toContain(piece.startsWith('quay_end') ? `harbour/${piece}.png` : `harbour/${piece}_${side}.png`);
      }
    }
    for (const p of ['boat_sail', 'boat_moored', 'boat_unload', 'boat_cargo_1', 'boat_cargo_4']) expect(paths).toContain(`harbour/${p}.png`);
    for (const fp of ['2x2', '3x3', '4x4']) for (let n = 0; n <= 5; n++) expect(paths).toContain(`harbour/yard/${fp}/fill_${n}.png`);
    expect(harbour.every(d => !d.required)).toBe(true);
    expect(validateArtIndex(pack, fullHarbourIndex()).errors).toEqual([]);
  });

  it('shows no harbour until every file it needs is in the art folder', () => {
    const { plan } = riverCity();
    const full = fullHarbourIndex();
    expect(harbourArtReady(pack, full, plan, 4)).toBe(true);
    expect(harbourArtReady(pack, null, plan, 4)).toBe(false);
    expect(harbourArtReady({ ...pack, art: { ...pack.art!, harbour: undefined } }, full, plan, 4)).toBe(false);
    for (const need of harbourArtNeeds(plan, 4)) {
      const files = { ...full.files };
      delete files[need];
      expect(harbourArtReady(pack, { ...full, files }, plan, 4), need).toBe(false);
    }
  });

  it('rejects a boat sheet without the four diagonals and a mooring point off its picture', () => {
    const index = fullHarbourIndex();
    const files = {
      ...index.files,
      'harbour/boat_sail.png': sheet(8, ['N', 'NE', 'E', 'SE', 'S']),
      'harbour/pier_head_a.png': picture('1x1', { mooring: { x: 900, y: 10 } }),
    };
    const errors = validateArtIndex(pack, { ...index, files }).errors;
    expect(errors.some(e => e.startsWith('harbour/boat_sail.png:') && e.includes('NE, SE, SW and NW'))).toBe(true);
    expect(errors.some(e => e.startsWith('harbour/pier_head_a.png:') && e.includes('mooring'))).toBe(true);
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
    expect(paths.filter(p => /quay(_end)?_/.test(p))).toHaveLength(plan.quay.length);
    expect(paths.filter(p => p.includes('pier_root_'))).toHaveLength(plan.piers.length);
    expect(paths.filter(p => p.includes('pier_head_'))).toHaveLength(plan.piers.length);
    /* 7 open, 3 of them still aboard: 4 in the yard, fill stage 2. */
    expect(paths).toContain('harbour/yard/3x3/fill_2.png');
    expect(paths).toContain('harbour/boat_sail.png');
    expect(paths).toContain('harbour/boat_cargo_3.png');
    expect(paths.every(p => p.startsWith('harbour/'))).toBe(true);
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
    expect(shown.drawn.some(d => d.path === 'harbour/quay_' + plan.side + '.png' || d.path.startsWith('harbour/quay_end_'))).toBe(true);
    expect(shown.drawn.some(d => d.path.startsWith('harbour/yard/'))).toBe(true);
  });
});
