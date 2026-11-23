/* Puts one building delivered by the art pipeline into a pack's art folder, laid out by the art contract (2):
     npx tsx apps/web/scripts/world-art-import.ts <delivery folder> --to <art folder> --pack <id> --kind <kind> --steps <a,b,c>
   then build the index with world-art-index.ts. The delivery holds the building on its first step's plot canvas (the
   plot's bottom corner at the bottom centre of the canvas, in master pixels):
     cut/stage_01.png .. stage_10.png      the construction line, scaffolding drawn in where there is any
     cut/demol_01.png, demol_02.png        half torn down, then rubble
     layers/stage_09_base.png, stage_10_base.png and the layers over them (shadow, shadow_notable, props, awning),
       layers/layers.json with sway_pivot_master (the line the awning hangs from)
     growth/gN_2_walls_cut.png, gN_3_done_cut.png   the building grown to N x N inside its lot (the old one in front)
     checks.json                           stages.NN.points_master.door.ground_centre: where walkers reach the door
   The first step gets the whole line, each further step its grown picture and the annex under work. Art never goes
   into the repository: the art folder lives outside it (ARTIST_CONTRACT.md, section 1). */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BuildingKind } from '../src/world/city-layout';
import type { FootprintKey, WorldPackManifest } from '../src/world/manifest';
import { resolveWorldPack } from '../src/world-packs/registry';
import { readPngSize } from './world-art-index';

type Pair = readonly [number, number];

export type BuildingImportOptions = Readonly<{
  delivery: string;
  to: string;
  pack: WorldPackManifest;
  kind: BuildingKind;
  /* The kind's catalog steps this building fills, smallest first. */
  steps: readonly string[];
}>;

const pad2 = (n: number): string => String(n).padStart(2, '0');
const round1 = (v: number): number => Math.round(v * 10) / 10;

/* Passport of a picture on a plot canvas: the footprint diamond stands on the canvas's bottom centre. */
function plotPassport(w: number, h: number, diamondW: number, door: Pair | null, layers?: readonly object[]): object {
  const bottom: Pair = [w / 2, h - 1];
  const dh = diamondW / 2;
  return {
    groundAnchor: [w / 2, bottom[1] - dh / 2],
    corners: {
      top: [w / 2, bottom[1] - dh],
      right: [w / 2 + diamondW / 2, bottom[1] - dh / 2],
      bottom,
      left: [w / 2 - diamondW / 2, bottom[1] - dh / 2],
    },
    ...(door ? { door: [round1(door[0]), round1(door[1])] } : {}),
    ...(layers ? { layers } : {}),
  };
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function importBuildingDelivery(opts: BuildingImportOptions): { written: string[]; skipped: string[] } {
  const { delivery, to, pack, kind, steps } = opts;
  const catalog = pack.art?.buildings[kind] ?? [];
  const written: string[] = [];
  const skipped: string[] = [];
  const footprintOf = (stepId: string): FootprintKey => {
    const step = catalog.find(s => s.id === stepId);
    if (!step) throw new Error(`pack ${pack.id} has no step ${stepId} for ${kind}`);
    return step.footprint;
  };
  const first = footprintOf(steps[0]!);
  const firstFp = pack.projection.buildingFootprintsMaster4x[first];
  const checks = readJson(join(delivery, 'checks.json'));
  const stageDoor = (n: number): Pair | null => {
    const st = (checks?.stages as Record<string, { points_master?: { door?: { ground_centre?: Pair } } }> | undefined)?.[pad2(n)];
    return st?.points_master?.door?.ground_centre ?? null;
  };
  const doneDoor = stageDoor(9);

  const put = (src: string, stepId: string, name: string, passport: object | null): void => {
    const from = join(delivery, src);
    if (!existsSync(from)) {
      skipped.push(src);
      return;
    }
    const rel = `buildings/${kind}/${stepId}/${name}.png`;
    const out = join(to, rel);
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(from, out);
    if (passport) writeFileSync(out.replace(/\.png$/, '.json'), `${JSON.stringify(passport, null, 2)}\n`);
    written.push(rel);
  };
  const sizeOf = (src: string): { w: number; h: number } | null => {
    const p = join(delivery, src);
    return existsSync(p) ? readPngSize(readFileSync(p)) : null;
  };
  const plot = (src: string, diamondW: number, door: Pair | null, layers?: readonly object[]): object | null => {
    const size = sizeOf(src);
    return size ? plotPassport(size.w, size.h, diamondW, door, layers) : null;
  };

  /* First step: the construction line, the finished building with its layers, the upgraded one, demolition. */
  const s0 = steps[0]!;
  for (let n = 1; n <= pack.stageCounts.construction; n++) {
    const src = `cut/stage_${pad2(n)}.png`;
    put(src, s0, `stage_${pad2(n)}`, plot(src, firstFp.diamondW, stageDoor(n)));
  }
  for (const name of ['demol_01', 'demol_02']) put(`cut/${name}.png`, s0, name, plot(`cut/${name}.png`, firstFp.diamondW, null));
  const layersInfo = readJson(join(delivery, 'layers/layers.json'));
  const pivot = layersInfo?.sway_pivot_master as readonly Pair[] | undefined;
  const awning = pivot && pivot.length === 2 ? { file: 'awning.png', sway: { pivot: [pivot[0], pivot[1]] } } : { file: 'awning.png' };
  for (const f of ['shadow', 'shadow_notable', 'props', 'awning']) put(`layers/${f}.png`, s0, f, null);
  const present = (f: string): boolean => existsSync(join(delivery, `layers/${f}.png`));
  const doneLayers = [
    ...(present('shadow') ? [{ file: 'shadow.png', blend: 'multiply' }] : []),
    ...(present('props') ? [{ file: 'props.png' }] : []),
    ...(present('awning') ? [awning] : []),
  ];
  const upgradedLayers = [
    ...(present('shadow_notable') ? [{ file: 'shadow_notable.png', blend: 'multiply' }] : []),
    ...(present('awning') ? [awning] : []),
  ];
  const base9 = existsSync(join(delivery, 'layers/stage_09_base.png')) ? 'layers/stage_09_base.png' : 'cut/stage_09.png';
  const base10 = existsSync(join(delivery, 'layers/stage_10_base.png')) ? 'layers/stage_10_base.png' : 'cut/stage_10.png';
  put(base9, s0, 'complete', plot(base9, firstFp.diamondW, doneDoor, base9.startsWith('layers/') ? doneLayers : undefined));
  put(base10, s0, 'upgraded', plot(base10, firstFp.diamondW, doneDoor, base10.startsWith('layers/') ? upgradedLayers : undefined));

  /* Larger steps: the grown building and the annex under work, the old building in front at the same plot corner. */
  for (const stepId of steps.slice(1)) {
    const fp = footprintOf(stepId);
    const n = Number(fp.split('x')[0]);
    const geo = pack.projection.buildingFootprintsMaster4x[fp];
    const done = `growth/g${n}_3_done_cut.png`;
    const size = sizeOf(done);
    const door: Pair | null = doneDoor && size ? [doneDoor[0] + (size.w - firstFp.diamondW) / 2, doneDoor[1] + (size.h - firstFp.maxCanvasH)] : null;
    put(done, stepId, 'complete', plot(done, geo.diamondW, door));
    const walls = `growth/g${n}_2_walls_cut.png`;
    put(walls, stepId, 'annex', plot(walls, geo.diamondW, door));
  }
  return { written, skipped };
}

function main(argv: readonly string[]): number {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const delivery = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  const to = arg('--to');
  const pack = resolveWorldPack(arg('--pack') ?? '');
  const kind = arg('--kind') as BuildingKind | undefined;
  const steps = arg('--steps')?.split(',').filter(Boolean) ?? [];
  if (!delivery || !to || !pack || !kind || steps.length === 0) {
    console.error('Usage: world-art-import.ts <delivery folder> --to <art folder> --pack <id> --kind <kind> --steps <a,b,c>');
    return 2;
  }
  const { written, skipped } = importBuildingDelivery({ delivery, to, pack, kind, steps });
  for (const w of written) console.log(`wrote ${w}`);
  for (const s of skipped) console.log(`not in the delivery: ${s}`);
  console.log(`${written.length} pictures written; build the index with world-art-index.ts ${to} --pack ${pack.id} --write`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
