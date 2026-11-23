import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importBuildingDelivery } from '../scripts/world-art-import';
import { buildArtIndexFromFolder } from '../scripts/world-art-index';
import { resolveBuildingArt, validateArtIndex, type BuildingPicturePassport } from '../src/world/art';
import type { CityBuilding } from '../src/world/city-layout';
import type { BuildingConstructionState } from '../src/world/construction';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

const dirs: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function put(root: string, rel: string, data: Buffer | string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, data);
}

const DOOR = [556.8, 800.6];
const PIVOT = [[210, 542], [426, 650]];

/* The layout the art pipeline delivered the first building in (a 3x3 workshop growing to 5x5). */
function delivery(): string {
  const d = temp('delivery-');
  for (let n = 1; n <= 10; n++) put(d, `cut/stage_${String(n).padStart(2, '0')}.png`, pngHeader(720, 960));
  put(d, 'cut/demol_01.png', pngHeader(720, 960));
  put(d, 'cut/demol_02.png', pngHeader(720, 960));
  for (const f of ['stage_09_base', 'stage_10_base', 'shadow', 'shadow_notable', 'props', 'awning']) put(d, `layers/${f}.png`, pngHeader(720, 960));
  put(d, 'layers/layers.json', JSON.stringify({ sway_pivot_master: PIVOT, order_stage_09: ['stage_09_base', 'shadow', 'props', 'awning'] }));
  for (const [n, w, h] of [[4, 960, 1200], [5, 1200, 1440]] as const) {
    for (const state of ['1_build', '2_walls', '3_done']) put(d, `growth/g${n}_${state}_cut.png`, pngHeader(w, h));
  }
  const stages: Record<string, unknown> = {};
  for (let n = 1; n <= 10; n++) {
    stages[String(n).padStart(2, '0')] = { points_master: { door: { ground_centre: DOOR, open_height: n >= 5 ? 148 : null } } };
  }
  put(d, 'checks.json', JSON.stringify({ stages }));
  return d;
}

const hub = (span: number, stage: number): CityBuilding =>
  ({
    id: 'hub-1',
    kind: 'district_hub',
    label: 'm1',
    col: 40,
    row: 40,
    spanCol: span,
    spanRow: span,
    lot: { col: 38, row: 38, spanCol: 5, spanRow: 5 },
    door: { col: 43, row: 40 },
    stage,
    maxStage: 3,
    floors: 1,
    level: 1,
    residentIds: [],
    mergedFromIds: [],
    goalCount: 0,
    placedAtStep: 1,
  }) as CityBuilding;

const job = (stage: number, phase: BuildingConstructionState['phase']): BuildingConstructionState =>
  ({ id: 'j', buildingId: 'hub-1', kind: 'district_hub', col: 40, row: 40, spanCol: 3, spanRow: 3, phase, currentStage: stage, targetStage: 10, maxStage: 10, stageProgress: 0, stagesPerSec: 0, stageHistory: [] }) as unknown as BuildingConstructionState;

describe('Importing a delivered building into the art folder (contract 2)', () => {
  it('lays the workshop, its larger steps, layers and demolition out as the contract asks, and the art check passes them', () => {
    const art = temp('art-');
    const result = importBuildingDelivery({ delivery: delivery(), to: art, pack: EGYPT_WORLD_PACK, kind: 'district_hub', steps: ['workshop', 'great_workshop', 'workshop_hall'] });
    expect(result.written).toContain('buildings/district_hub/workshop/stage_04.png');
    expect(result.written).toContain('buildings/district_hub/workshop_hall/annex.png');

    const index = buildArtIndexFromFolder(art, 'egypt');
    const report = validateArtIndex(EGYPT_WORLD_PACK, index);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    /* The workshop's own stage pictures stand in for the contract 1 construction pictures. */
    expect(report.missingRequired.filter(p => p.startsWith('buildings/district_hub/workshop/'))).toEqual([]);

    const complete = index.files['buildings/district_hub/workshop/complete.png']!.passport as BuildingPicturePassport;
    expect(complete.corners).toEqual({ top: { x: 360, y: 599 }, right: { x: 720, y: 779 }, bottom: { x: 360, y: 959 }, left: { x: 0, y: 779 } });
    expect(complete.door).toEqual({ x: 556.8, y: 800.6 });
    expect(complete.layers).toEqual([
      { file: 'shadow.png', blend: 'multiply' },
      { file: 'props.png' },
      { file: 'awning.png', sway: { pivot: [{ x: 210, y: 542 }, { x: 426, y: 650 }] } },
    ]);
    const upgraded = index.files['buildings/district_hub/workshop/upgraded.png']!.passport as BuildingPicturePassport;
    expect(upgraded.layers?.map(l => l.file)).toEqual(['shadow_notable.png', 'awning.png']);
    /* A larger step keeps the plot's bottom corner, so the old building's door moves with the canvas. */
    const hall = index.files['buildings/district_hub/workshop_hall/complete.png']!.passport as BuildingPicturePassport;
    expect(hall.corners.bottom).toEqual({ x: 600, y: 1439 });
    expect(hall.door).toEqual({ x: 556.8 + 240, y: 800.6 + 480 });
    expect(JSON.parse(readFileSync(join(art, 'buildings/district_hub/great_workshop/complete.json'), 'utf8')).door).toEqual([676.8, 1040.6]);

    const pack = EGYPT_WORLD_PACK;
    const paths = (b: CityBuilding, j: BuildingConstructionState | null) =>
      resolveBuildingArt(pack, index, b, j)?.layers.map(l => `${l.path.split('/').slice(-2).join('/')}${l.blend ? ':' + l.blend : ''}${l.sway ? ':sway' : ''}`);
    expect(paths(hub(3, 1), null)).toEqual(['workshop/complete.png', 'workshop/shadow.png:multiply', 'workshop/props.png', 'workshop/awning.png:sway']);
    expect(paths(hub(3, 3), null)?.[0]).toBe('workshop/upgraded.png');
    expect(paths(hub(4, 2), null)).toEqual(['great_workshop/complete.png']);
    expect(paths(hub(5, 3), null)).toEqual(['workshop_hall/complete.png']);
    expect(paths(hub(3, 1), job(4, 'building'))).toEqual(['workshop/stage_04.png']);
    expect(paths(hub(3, 1), job(1, 'building'))).toEqual(['workshop/stage_01.png']);
    expect(paths(hub(3, 1), job(9, 'complete'))?.[0]).toBe('workshop/complete.png');
    expect(paths(hub(3, 1), job(8, 'demolishing'))).toEqual(['workshop/demol_01.png']);
    expect(paths(hub(3, 1), job(3, 'demolishing'))).toEqual(['workshop/demol_02.png']);
  });
});
