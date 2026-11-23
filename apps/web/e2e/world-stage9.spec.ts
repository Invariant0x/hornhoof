import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ART_CONTRACT_VERSION,
  personSheetPath,
  type ArtIndexEntry,
  type BuildingPicturePassport,
} from '../src/world/art';
import type { WorldArtStats } from '../src/world/art-runtime';
import type { CityBuilding } from '../src/world/city-layout';
import type { FootprintKey, WorldPackManifest } from '../src/world/manifest';
import type { WorldEngineStats } from '../src/world/renderer';
import { resolveWorldPack } from '../src/world-packs/registry';
import { RgbaCanvas } from './fixture-png';

/* Stage 9: the Egypt pack runs whole on placeholders, draws artist files through the contract as soon as they
   appear in its art folder (here generated test pictures, never real art), drops a broken file instead of
   breaking, and a second pack runs on the same engine. */

test.describe.configure({ mode: 'serial' });

const OUT_DIR = process.env.HH_OUT || join(process.cwd(), 'e2e', 'results', 'stage9-out');

type LiveHandle = {
  getStats: () => WorldEngineStats | null;
  getArtStats: () => WorldArtStats | null;
  getBuildings: () => readonly CityBuilding[];
  centerOnBuilding: (id: string, zoom?: number) => boolean;
  flushVisibleBakes: () => void;
  holdBuildingStage: (id: string, stage: number, phase?: 'building' | 'demolishing') => boolean;
};

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `stage9-${name}.png`);
  await page.screenshot({ path });
  await info.attach(`stage9-${name}.png`, { path, contentType: 'image/png' });
}

async function openLive(page: Page, pack: string): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/world-live.html?pack=${pack}&lang=ru`);
  await page.waitForFunction(() => {
    const h = (window as unknown as { __WORLD_LIVE__?: LiveHandle }).__WORLD_LIVE__;
    return Boolean(h?.getStats() && h.getBuildings().length > 0);
  });
  expect(errors).toEqual([]);
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.flushVisibleBakes());
  await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

async function centreOn(page: Page, kind: CityBuilding['kind'], zoom: number): Promise<void> {
  await page.evaluate(
    ([k, z]) => {
      const h = (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__;
      const b = h.getBuildings().find(item => item.kind === k);
      if (b) h.centerOnBuilding(b.id, z as number);
    },
    [kind, zoom] as const,
  );
  await settle(page);
}

type Rgb = readonly [number, number, number];
const shade = (c: Rgb, f: number, a = 255): [number, number, number, number] => [
  Math.min(255, Math.round(c[0] * f)),
  Math.min(255, Math.round(c[1] * f)),
  Math.min(255, Math.round(c[2] * f)),
  a,
];

/* A flat box standing on the footprint diamond, with the passport the contract asks for. */
function boxPicture(pack: WorldPackManifest, footprint: FootprintKey, wallH: number, color: Rgb): { png: Buffer; entry: ArtIndexEntry } {
  const fp = pack.projection.buildingFootprintsMaster4x[footprint];
  const w = fp.diamondW + 16;
  const h = Math.min(fp.maxCanvasH, fp.diamondH + wallH + 24);
  const cx = w / 2;
  const cy = h - fp.diamondH / 2 - 8;
  const dw = fp.diamondW / 2;
  const dh = fp.diamondH / 2;
  const k = 0.82;
  const top: [number, number] = [cx, cy - dh * k];
  const right: [number, number] = [cx + dw * k, cy];
  const bottom: [number, number] = [cx, cy + dh * k];
  const left: [number, number] = [cx - dw * k, cy];
  const up = (p: [number, number]): [number, number] => [p[0], p[1] - wallH];
  const canvas = new RgbaCanvas(w, h);
  canvas.polygon([[cx, cy - dh], [cx + dw, cy], [cx, cy + dh], [cx - dw, cy]], [40, 30, 20, 70]);
  canvas.polygon([left, bottom, up(bottom), up(left)], shade(color, 0.78));
  canvas.polygon([bottom, right, up(right), up(bottom)], shade(color, 0.6));
  canvas.polygon([up(top), up(right), up(bottom), up(left)], shade(color, 1.05));
  /* A dark band under the roof edge makes the generated test picture easy to tell from a placeholder. */
  canvas.polygon([up(left), up(bottom), [bottom[0], bottom[1] - wallH + 14], [left[0], left[1] - wallH + 14]], [30, 24, 40, 255]);
  const passport: BuildingPicturePassport = {
    groundAnchor: { x: cx, y: cy },
    corners: { top: { x: cx, y: cy - dh }, right: { x: cx + dw, y: cy }, bottom: { x: cx, y: cy + dh }, left: { x: cx - dw, y: cy } },
    flagAnchor: { x: cx, y: cy - wallH - dh * 0.5 },
    topAnchor: { x: cx, y: cy - wallH - dh * k },
  };
  return { png: canvas.png(), entry: { w, h, passport } };
}

/* A small person sheet: 8 frames across, 5 direction rows (N, NE, E, SE, S), feet at (60, 170). */
function personSheet(cloak: boolean): { png: Buffer; entry: ArtIndexEntry } {
  const frameW = 120;
  const frameH = 180;
  const canvas = new RgbaCanvas(frameW * 8, frameH * 5);
  const rowBand: Rgb[] = [
    [230, 80, 80],
    [230, 160, 60],
    [90, 200, 90],
    [70, 150, 230],
    [170, 90, 220],
  ];
  for (let row = 0; row < 5; row++) {
    for (let f = 0; f < 8; f++) {
      const ox = f * frameW;
      const oy = row * frameH;
      const stride = Math.sin((f / 8) * Math.PI * 2) * 8;
      if (cloak) {
        canvas.polygon([[ox + 42, oy + 66], [ox + 78, oy + 66], [ox + 84, oy + 138], [ox + 36, oy + 138]], [255, 255, 255, 255]);
        continue;
      }
      canvas.polygon([[ox + 50 + stride, oy + 120], [ox + 58 + stride, oy + 120], [ox + 58 + stride, oy + 170], [ox + 50 + stride, oy + 170]], [120, 80, 50, 255]);
      canvas.polygon([[ox + 62 - stride, oy + 120], [ox + 70 - stride, oy + 120], [ox + 70 - stride, oy + 170], [ox + 62 - stride, oy + 170]], [110, 72, 44, 255]);
      canvas.polygon([[ox + 46, oy + 64], [ox + 74, oy + 64], [ox + 76, oy + 126], [ox + 44, oy + 126]], [240, 232, 214, 255]);
      canvas.polygon([[ox + 48, oy + 34], [ox + 72, oy + 34], [ox + 72, oy + 60], [ox + 48, oy + 60]], [214, 164, 120, 255]);
      canvas.polygon([[ox + 46, oy + 30], [ox + 74, oy + 30], [ox + 74, oy + 38], [ox + 46, oy + 38]], shade(rowBand[row]!, 1));
    }
  }
  const entry: ArtIndexEntry = cloak
    ? { w: canvas.w, h: canvas.h }
    : { w: canvas.w, h: canvas.h, passport: { frameW, frameH, frames: 8, fps: 8, anchor: { x: 60, y: 170 } } };
  return { png: canvas.png(), entry };
}

type FixtureArt = { index: Record<string, unknown>; pngs: Map<string, Buffer> };

/* Generated pictures for every finished look of the standard building kinds, sheets for every look, and the altar.
   Statues, pyramids and construction stages stay on placeholders, so the shot shows both side by side. */
function fixtureArt(pack: WorldPackManifest, brokenPath: string): FixtureArt {
  const files: Record<string, ArtIndexEntry> = {};
  const pngs = new Map<string, Buffer>();
  const colors: Partial<Record<CityBuilding['kind'], Rgb>> = {
    house: [214, 120, 190],
    department: [90, 150, 220],
    residence: [240, 200, 90],
    district_hub: [120, 200, 170],
    flophouse: [190, 150, 110],
    supply: [110, 200, 230],
  };
  for (const [kind, color] of Object.entries(colors) as Array<[CityBuilding['kind'], Rgb]>) {
    for (const step of pack.art?.buildings[kind] ?? []) {
      const span = Number(step.footprint.split('x')[0]);
      const pic = boxPicture(pack, step.footprint, 90 + span * 34, color);
      const names = kind === 'supply' ? ['fill_0', 'fill_1', 'fill_2', 'fill_3', 'fill_4'] : ['complete'];
      for (const name of names) {
        const path = `buildings/${kind}/${step.id}/${name}.png`;
        files[path] = pic.entry;
        pngs.set(path, pic.png);
      }
    }
  }
  const altar = boxPicture(pack, '1x1', 70, [250, 240, 200]);
  files['buildings/altar/complete.png'] = altar.entry;
  pngs.set('buildings/altar/complete.png', altar.png);

  const base = personSheet(false);
  const cloak = personSheet(true);
  for (const look of pack.art?.people?.looks ?? []) {
    for (const anim of ['walk', 'idle'] as const) {
      const p = personSheetPath(look, 1, anim);
      const c = personSheetPath(look, 1, anim, true);
      files[p] = base.entry;
      files[c] = cloak.entry;
      pngs.set(p, base.png);
      pngs.set(c, cloak.png);
    }
  }
  /* One broken passport: the engine must drop that file and keep its placeholder. */
  const broken = files[brokenPath] as ArtIndexEntry & { passport: BuildingPicturePassport };
  files[brokenPath] = { ...broken, passport: { ...broken.passport, groundAnchor: { x: 1, y: 1 } } };
  return { index: { contract: ART_CONTRACT_VERSION, pack: pack.id, files }, pngs };
}

async function serveArt(page: Page, pack: WorldPackManifest, art: FixtureArt | null): Promise<string[]> {
  const requested: string[] = [];
  const prefix = pack.art!.baseUrl;
  await page.route(`**${prefix}**`, async (route: Route) => {
    const rel = new URL(route.request().url()).pathname.slice(prefix.length);
    requested.push(rel);
    if (!art) return route.fulfill({ status: 404, body: 'no art folder' });
    if (rel === 'art-index.json') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(art.index) });
    const png = art.pngs.get(rel);
    if (!png) return route.fulfill({ status: 404, body: 'missing' });
    return route.fulfill({ status: 200, contentType: 'image/png', body: png });
  });
  return requested;
}

const artStats = (page: Page) =>
  page.evaluate(() => (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.getArtStats());

test('Stage 9: Egypt runs whole on placeholders when its art folder is empty', async ({ page }, info) => {
  const egypt = resolveWorldPack('egypt')!;
  const requested = await serveArt(page, egypt, null);
  await openLive(page, 'egypt');
  await settle(page);
  /* Buildings, people, loops and flags ask only for the index; ground and plants (contract section 9) load
     straight from the manifest's paths and fall back to their procedural look. */
  const terrainArt = /^(ground|roads|decals|veg)\//;
  expect(requested.filter(rel => !terrainArt.test(rel))).toEqual(['art-index.json']);
  expect(requested.some(rel => terrainArt.test(rel))).toBe(true);
  const stats = await artStats(page);
  expect(stats).toMatchObject({ indexedFiles: 0, loadedTextures: 0, buildingsDrawn: 0, residentsDrawn: 0 });
  await centreOn(page, 'residence', 1);
  await shot(page, info, 'egypt-placeholders-1440');
});

test('Stage 9: Egypt draws artist files through the contract as they appear, and drops a broken one', async ({ page }, info) => {
  const egypt = resolveWorldPack('egypt')!;
  const brokenPath = `buildings/department/${egypt.art!.buildings.department![0]!.id}/complete.png`;
  const art = fixtureArt(egypt, brokenPath);
  const requested = await serveArt(page, egypt, art);
  await openLive(page, 'egypt');
  await page.waitForFunction(() => {
    const s = (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.getArtStats();
    return Boolean(s && s.buildingsDrawn > 0 && s.residentsDrawn > 0);
  });
  await centreOn(page, 'residence', 1);
  await page.waitForFunction(() => {
    const s = (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.getArtStats();
    return Boolean(s && s.buildingsDrawn > 3);
  });
  await settle(page);
  const stats = (await artStats(page))!;
  const declaredCount = Object.keys(art.index.files as object).length;
  /* The broken file never reaches the engine and is never downloaded. */
  expect(stats.indexedFiles).toBe(declaredCount - 1);
  expect(requested).not.toContain(brokenPath);
  expect(stats.buildingsDrawn).toBeGreaterThan(3);
  expect(stats.residentsDrawn).toBeGreaterThan(3);
  await shot(page, info, 'egypt-test-pictures-100');

  await centreOn(page, 'residence', 2);
  await page.waitForFunction(() => {
    const s = (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.getArtStats();
    return Boolean(s && s.buildingsDrawn > 0);
  });
  await shot(page, info, 'egypt-test-pictures-200');

  await centreOn(page, 'monument', 1);
  await shot(page, info, 'egypt-test-pictures-with-placeholders');
});

const pad2 = (n: number): string => String(n).padStart(2, '0');

/* Generated pictures of the 3x3 workshop's own line: a box that rises stage by stage, is finished, then torn down. */
function workshopLine(pack: WorldPackManifest): { art: FixtureArt; base: string } {
  const step = pack.art!.buildings.district_hub!.find(s => s.footprint === '3x3')!;
  const base = `buildings/district_hub/${step.id}/`;
  const files: Record<string, ArtIndexEntry> = {};
  const pngs = new Map<string, Buffer>();
  const add = (name: string, wallH: number, color: Rgb): void => {
    const pic = boxPicture(pack, '3x3', wallH, color);
    files[`${base}${name}.png`] = pic.entry;
    pngs.set(`${base}${name}.png`, pic.png);
  };
  for (let n = 1; n <= pack.stageCounts.construction; n++) add(`stage_${pad2(n)}`, 8 + n * 18, [230 - n * 12, 110 + n * 10, 70 + n * 6]);
  add('complete', 190, [120, 200, 170]);
  add('demol_01', 110, [170, 120, 90]);
  add('demol_02', 20, [130, 100, 80]);
  return { art: { index: { contract: ART_CONTRACT_VERSION, pack: pack.id, files }, pngs }, base };
}

test('Stage 9: the 3x3 workshop draws its own picture at each construction stage and both demolition steps', async ({ page }, info) => {
  const egypt = resolveWorldPack('egypt')!;
  const { art, base } = workshopLine(egypt);
  const requested = await serveArt(page, egypt, art);
  await openLive(page, 'egypt');
  const hub = await page.evaluate(() => {
    const b = (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__
      .getBuildings()
      .find(item => item.kind === 'district_hub' && item.spanCol === 3);
    return b ? { id: b.id } : null;
  });
  expect(hub, 'a district workshop on a 3x3 plot').not.toBeNull();
  await page.evaluate(id => (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.centerOnBuilding(id, 1.5), hub!.id);

  /* Each held stage asks for its own picture, and the shot waits until every picture asked for is on the GPU. */
  const show = async (stage: number, phase: 'building' | 'demolishing', picture: string): Promise<void> => {
    const held = await page.evaluate(
      ([id, st, ph]) => (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.holdBuildingStage(id as string, st as number, ph as 'building' | 'demolishing'),
      [hub!.id, stage, phase] as const,
    );
    expect(held).toBe(true);
    await expect.poll(() => requested.includes(`${base}${picture}.png`), { message: `${picture} asked for`, timeout: 10_000 }).toBe(true);
    const served = new Set(requested.filter(rel => art.pngs.has(rel))).size;
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.getArtStats()?.loadedTextures ?? 0), {
        message: `${picture}: every picture asked for is loaded`,
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(served);
    await settle(page);
    await shot(page, info, `workshop-${picture}`);
  };
  /* Stages 1 to 8 are the construction line; 9 and 10 are the finished and the upgraded workshop. */
  for (let n = 1; n <= 8; n++) await show(n, 'building', `stage_${pad2(n)}`);
  await show(egypt.stageCounts.construction, 'demolishing', 'demol_01');
  await show(1, 'demolishing', 'demol_02');
});

test('Stage 9: the second test pack runs on the same engine with its own world', async ({ page }, info) => {
  const space = resolveWorldPack('space');
  expect(space?.art).toBeTruthy();
  await serveArt(page, space!, null);
  await openLive(page, 'space');
  await settle(page);
  const buildings = await page.evaluate(() => (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.getBuildings().length);
  expect(buildings).toBeGreaterThan(5);
  await centreOn(page, 'residence', 1);
  await shot(page, info, 'space-pack-1440');

  await page.goto('/world-gallery.html?pack=space&lang=ru');
  await page.waitForSelector('canvas');
  await page.evaluate(() => new Promise<void>(r => setTimeout(r, 400)));
  await shot(page, info, 'space-gallery');
});
