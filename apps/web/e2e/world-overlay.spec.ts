import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DICTIONARIES, LANGUAGES, type Language, type Messages } from '../src/i18n';
import { en } from '../src/i18n/en';
import type { Org, UpdatesView } from '../src/types';
import { ME, serveApi } from './api';

/* #1874 / #1882: The world (map today, game world tomorrow) always occupies the entire viewport beneath the UI and never
   shifts or resizes when shell bars (.update-banner, .alert, .guard-stop) or the narrow-screen agent strip appear or
   disappear. The bottom version bar is removed from every screen except the map, where the version stays as a HUD overlay. */
test.describe.configure({ timeout: 0 });

const HEIGHT = 812;
const WIDTHS = [1440, 375] as const;
const SKINS = ['cyberpunk', 'light'] as const;

/* Dynamically select the shortest and longest actually shipped locales by summing the real strings rendered on this view. */
const touchedWords = (t: Messages) => [
  t.shell.tabs.map, t.shell.tabs.tasks, t.shell.tabs.people, t.shell.tabs.subscriptions, t.shell.tabs.machines,
  t.updates.updatedTo('0.40.2 (5012dc3)'), t.updates.ok, t.errors.codes.internal, t.guard.stopped, t.guard.restart,
  t.map.openOrchestrator, t.window.minimize,
].join('');
const rankedLocales = LANGUAGES.map(l => ({ id: l.id, length: touchedWords(DICTIONARIES[l.id]).length })).sort((a, b) => a.length - b.length);
const SHORTEST_LANG = rankedLocales[0]!.id;
const LONGEST_LANG = rankedLocales.at(-1)!.id;
const LOCALES: { name: string; lang: Language; dir: 'ltr' | 'rtl' }[] = [
  { name: SHORTEST_LANG, lang: SHORTEST_LANG, dir: 'ltr' },
  ...(LONGEST_LANG === SHORTEST_LANG ? [] : [{ name: LONGEST_LANG, lang: LONGEST_LANG, dir: 'ltr' as const }]),
  { name: `${SHORTEST_LANG}-rtl`, lang: SHORTEST_LANG, dir: 'rtl' },
];
const MESSAGES = DICTIONARIES;

const CURRENT = { version: '0.40.2', commit: '5012dc32' + '0'.repeat(32), migrations: 156 };
const VERSION_TEXT = '0.40.2 (5012dc3)';
const QUIET_UPDATES: UpdatesView = {
  current: CURRENT, available: false, checkedAt: '2026-11-21T10:00:00.000Z', latest: null, versions: [], error: null,
  updater: { present: true, status: null, waiting: null, calledOff: null },
};
const DONE_UPDATES: UpdatesView = {
  ...QUIET_UPDATES,
  updater: {
    present: true,
    status: { id: 'u402', version: '0.40.2', commit: CURRENT.commit, state: 'done', step: 'finished', log: '', at: '2026-11-21T09:50:00.000Z' },
    waiting: null,
    calledOff: null,
  },
};
const BROKEN = { status: 500, json: { error: { code: 'internal', message: 'Temporary server error while loading company data.' } } };
const SHOTS = process.env.HH_OUT ?? '';
const PREFIX = process.env.HH_SHOT_PREFIX ?? 'after';

type Box = { x: number; y: number; width: number; height: number };
type Snapshot = { map: Box | null; hub: Box | null; dept: Box | null };

function saveShot(png: Buffer, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const file = `${PREFIX}-${name}.png`;
  writeFileSync(join(SHOTS, file), png);
  console.log(`SHOT ${file} sha256=${createHash('sha256').update(png).digest('hex')}`);
}

const settled = (page: Page) => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

const snapshot = (page: Page): Promise<Snapshot> => page.evaluate(() => {
  const box = (sel: string): Box | null => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  return {
    map: box('.map'),
    hub: box('.map .hub-art:not(.hub-spin)'),
    dept: box('.map .dept'),
  };
});

async function settledSnapshot(page: Page): Promise<Snapshot> {
  await page.evaluate(async () => { await document.fonts.ready; });
  let last = '';
  await expect.poll(async () => {
    await settled(page);
    const now = JSON.stringify(await snapshot(page));
    const same = now === last;
    last = now;
    return same;
  }).toBe(true);
  return JSON.parse(last) as Snapshot;
}

function expectSameGeometry(after: Snapshot, before: Snapshot, label: string) {
  for (const [part, a, b] of [['.map', after.map, before.map], ['.map .hub', after.hub, before.hub], ['.map .dept', after.dept, before.dept]] as const) {
    expect.soft(a, `${label}: ${part} stays mounted`).not.toBeNull();
    expect.soft(b, `${label}: ${part} baseline mounted`).not.toBeNull();
    if (!a || !b) continue;
    expect.soft(Math.abs(a.x - b.x), `${label}: ${part} deltaX (${a.x} vs ${b.x})`).toBeLessThanOrEqual(0.5);
    expect.soft(Math.abs(a.y - b.y), `${label}: ${part} deltaY (${a.y} vs ${b.y})`).toBeLessThanOrEqual(0.5);
    expect.soft(Math.abs(a.width - b.width), `${label}: ${part} deltaWidth (${a.width} vs ${b.width})`).toBeLessThanOrEqual(0.5);
    expect.soft(Math.abs(a.height - b.height), `${label}: ${part} deltaHeight (${a.height} vs ${b.height})`).toBeLessThanOrEqual(0.5);
  }
}

async function expectBarVisibleUnclipped(locator: Locator, width: number, height: number, label: string, edge = 16) {
  await expect(locator, `${label}: visible`).toBeVisible();
  const metrics = await locator.evaluate(el => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height, sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight };
  });
  expect.soft(metrics.width, `${label}: non-zero width`).toBeGreaterThan(0);
  expect.soft(metrics.height, `${label}: non-zero height`).toBeGreaterThan(0);
  expect.soft(metrics.x, `${label}: left edge inside viewport`).toBeGreaterThanOrEqual(edge - 1);
  expect.soft(metrics.right, `${label}: right edge inside viewport`).toBeLessThanOrEqual(width - edge + 1);
  expect.soft(metrics.y, `${label}: top inside viewport`).toBeGreaterThanOrEqual(0);
  expect.soft(metrics.bottom, `${label}: bottom inside viewport`).toBeLessThanOrEqual(height + 1);
  expect.soft(metrics.sw, `${label}: no horizontal clipping`).toBeLessThanOrEqual(metrics.cw + 1);
  expect.soft(metrics.sh, `${label}: no vertical clipping`).toBeLessThanOrEqual(metrics.ch + 1);
  return metrics;
}

const ORG: Org = {
  company: ME.company,
  orchestrator: { id: 'a1', name: 'Orchestrator', model: 'claude-opus-5-5', effort: null, subscription: null, context: null, program: null, alarm: null, retry: null, failure: null },
  agents: { total: 1, working: 1 },
  people: [],
  departments: [
    { id: 'd2', name: 'Development', templateKey: null, roleCode: 'CTO', about: '', agents: { total: 1, working: 1 }, products: [], teams: [], people: [], employees: [], roles: [] },
  ],
};

/* Item 5: World rect and node screen point stay identical to the pixel as update banner (done), .alert, .guard-stop, and
   agent-strip appear in sequence, across 1440 & 375, Cyberpunk & Light, and en, ru, en-rtl. */
for (const width of WIDTHS) for (const skin of SKINS) for (const locale of LOCALES) {
  test(`map rect and node point stay identical across update banner, alert, guard-stop, and agent strip: ${width}px ${skin} ${locale.name}`, async ({ page }) => {
    const errors: string[] = [];
    let allowBoundaryError = false;
    page.on('pageerror', e => { if (!allowBoundaryError) errors.push(e.message); });

    let updatesMode: 'quiet' | 'done' = 'quiet';
    let orgMode: 'ok' | 'fail' | 'crash-dept' = 'ok';

    await page.setViewportSize({ width, height: HEIGHT });
    await page.addInitScript(({ lang, skin, dir }) => {
      localStorage.setItem('hh-lang', lang);
      localStorage.setItem('hh-theme', skin);
      if (dir === 'rtl') document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = 'rtl'; });
    }, { lang: locale.lang, skin, dir: locale.dir });

    await serveApi(page);
    await page.route('**/api/version', route => route.fulfill({ json: CURRENT }));
    await page.route('**/api/updates', route => route.fulfill({ json: updatesMode === 'done' ? DONE_UPDATES : QUIET_UPDATES }));
    await page.route('**/api/org', route => {
      if (orgMode === 'fail') return route.fulfill(BROKEN);
      if (orgMode === 'crash-dept') {
        const broken = { ...ORG, departments: [{ ...ORG.departments[0]!, roles: null }] };
        return route.fulfill({ json: broken });
      }
      return route.fulfill({ json: ORG });
    });

    await page.goto('/');
    await expect(page.locator('.map .dept', { hasText: 'Development' })).toBeVisible();
    await expect(page.locator('.map-version')).toHaveText(VERSION_TEXT);
    expect.soft(await page.locator('.version-mark, [role="contentinfo"]').count(), 'no footer bar on map').toBe(0);
    await page.evaluate(d => { document.documentElement.dir = d; }, locale.dir);

    const base = await settledSnapshot(page);
    expect.soft(Math.round(base.map!.x), 'map left is 0').toBe(0);
    expect.soft(Math.round(base.map!.y), 'map top is 0').toBe(0);
    expect.soft(Math.round(base.map!.width), 'map fills viewport width').toBe(width);
    expect.soft(Math.round(base.map!.height), 'map fills viewport height').toBe(HEIGHT);

    const isCanonical = skin === 'cyberpunk' && locale.name === SHORTEST_LANG;
    if (isCanonical) saveShot(await page.screenshot({ animations: 'disabled' }), `map-version-hud-${width}`);

    const t = MESSAGES[locale.lang];
    const barEdge = width <= 420 ? 12 : 16;

    const refetch = async (path: string) => {
      await Promise.all([
        page.waitForResponse(r => new URL(r.url()).pathname === path),
        page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))),
      ]);
    };

    /* 1) Update banner (done state with OK button) */
    updatesMode = 'done';
    await refetch('/api/updates');
    const banner = page.locator('main.body .update-banner');
    const bannerBox = await expectBarVisibleUnclipped(banner, width, HEIGHT, 'update banner', barEdge);
    expect.soft(await page.locator('main.body > .shell-bars > .update-banner').count(), 'update banner inside .shell-bars HUD stack').toBe(1);
    await expect(banner.getByRole('button', { name: t.updates.ok, exact: true })).toBeVisible();
    const afterBanner = await settledSnapshot(page);
    expectSameGeometry(afterBanner, base, 'update banner shown');

    /* Map clicks outside the centered update banner still reach .map. */
    const hitBelow = await page.evaluate(y => !!document.elementFromPoint(24, y)?.closest('.map'), Math.min(HEIGHT - 80, bannerBox.bottom + 12));
    expect.soft(hitBelow, 'clicks under update banner reach the map').toBe(true);
    if (width === 1440 && bannerBox.x > 48) {
      const hitBeside = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.map'), { x: 24, y: bannerBox.y + bannerBox.height / 2 });
      expect.soft(hitBeside, 'clicks beside update banner reach the map').toBe(true);
    }

    if (isCanonical) saveShot(await page.screenshot({ animations: 'disabled' }), `map-update-banner-${width}`);
    if (width === 1440 && skin === 'light' && locale.name === LONGEST_LANG) saveShot(await page.screenshot({ animations: 'disabled' }), 'map-update-banner-light-ru-1440');
    if (width === 375 && skin === 'light' && locale.dir === 'rtl') saveShot(await page.screenshot({ animations: 'disabled' }), 'map-update-banner-light-rtl-375');

    /* Department opened with banner visible fills the viewport with no map peeking beside it, and returns map intact. */
    if (isCanonical) {
      await page.evaluate(() => {
        history.pushState(null, '', '/departments/d2');
        dispatchEvent(new PopStateEvent('popstate'));
      });
      await expect(page.locator('.dview .shead')).toBeVisible();
      await settled(page);
      const dviewBox = await page.locator('.dview').boundingBox();
      expect.soft(Math.round(dviewBox!.y), 'department starts at viewport top').toBe(0);
      expect.soft(Math.round(dviewBox!.height), 'department fills viewport height').toBe(HEIGHT);
      saveShot(await page.screenshot({ animations: 'disabled' }), `department-banner-${width}`);
      await page.getByRole('button', { name: t.dept.back, exact: true }).click();
      await expect(page.locator('.dview')).toHaveCount(0);
      await expect(page.locator('.map .dept', { hasText: 'Development' })).toBeVisible();
      expectSameGeometry(await settledSnapshot(page), base, 'returned from department with update banner');
    }

    await banner.getByRole('button', { name: t.updates.ok, exact: true }).click();
    await expect(banner).toHaveCount(0);
    expectSameGeometry(await settledSnapshot(page), base, 'update banner dismissed');

    /* 2) .alert overlay on the map */
    orgMode = 'fail';
    await refetch('/api/org');
    const alert = page.locator('main.body .alert');
    await expectBarVisibleUnclipped(alert, width, HEIGHT, 'alert bar', barEdge);
    expect.soft(await page.locator('main.body > .shell-bars > .alert').count(), 'alert inside .shell-bars HUD stack').toBe(1);
    expectSameGeometry(await settledSnapshot(page), base, 'alert shown');
    if (isCanonical) saveShot(await page.screenshot({ animations: 'disabled' }), `map-alert-${width}`);

    orgMode = 'ok';
    await refetch('/api/org');
    await expect(alert).toHaveCount(0);
    await expect(page.locator('.map .dept', { hasText: 'Development' })).toBeVisible();
    expectSameGeometry(await settledSnapshot(page), base, 'alert cleared');

    /* 3) .guard-stop overlay on the map */
    orgMode = 'crash-dept';
    await refetch('/api/org');
    await settled(page);
    allowBoundaryError = true;
    await page.evaluate(() => {
      history.pushState(null, '', '/departments/d2');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    const guardStop = page.locator('main.body .guard-stop');
    await expectBarVisibleUnclipped(guardStop, width, HEIGHT, 'guard-stop bar', barEdge);
    expect.soft(await page.locator('main.body > .shell-bars > .guard-stop').count(), 'guard-stop inside .shell-bars HUD stack').toBe(1);
    await expect(guardStop.getByRole('button', { name: t.guard.restart, exact: true })).toBeVisible();
    expectSameGeometry(await settledSnapshot(page), base, 'guard-stop shown');
    if (isCanonical && width === 375) saveShot(await page.screenshot({ animations: 'disabled' }), 'map-guard-stop-375');

    orgMode = 'ok';
    await page.evaluate(() => {
      history.pushState(null, '', '/');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await refetch('/api/org');
    await expect(guardStop).toHaveCount(0);
    allowBoundaryError = false;
    expectSameGeometry(await settledSnapshot(page), base, 'guard-stop cleared');

    /* 4) .agent-strip (especially narrow viewport 375px, where .shell:has(.agent-strip) .body previously shrank map by 44px) */
    await page.getByRole('button', { name: t.map.openOrchestrator, exact: true }).click();
    const win = page.locator('.orch');
    await expect(win).toBeVisible();
    await win.getByRole('button', { name: t.window.minimize, exact: true }).click();
    await expect(win).toBeHidden();
    const strip = page.locator('.agent-strip');
    await expectBarVisibleUnclipped(strip, width, HEIGHT, 'agent-strip', 0);
    expectSameGeometry(await settledSnapshot(page), base, 'agent-strip shown');
    if (isCanonical && width === 375) saveShot(await page.screenshot({ animations: 'disabled' }), 'map-agent-strip-375');

    await strip.locator('.agent-strip-close').click();
    await expect(strip).toHaveCount(0);
    expectSameGeometry(await settledSnapshot(page), base, 'agent-strip closed');

    expect(errors).toEqual([]);
  });
}

/* Item 6: Remove the full-width bottom version bar on ALL screens except the map, giving full viewport height to page
   content; keep the version label only on the map as a HUD overlay. */
const NON_MAP_PAGES = [
  { name: 'tasks', path: '/tasks', ready: '.tracker' },
  { name: 'people', path: '/people', ready: 'h1' },
  { name: 'subscriptions', path: '/subscriptions', ready: 'h1' },
  { name: 'machines', path: '/machines', ready: 'h1' },
  { name: 'department', path: '/departments/d2', ready: '.dview .shead' },
] as const;

for (const width of WIDTHS) for (const skin of SKINS) {
  test(`bottom version bar is absent from DOM on all non-map pages and content reaches viewport bottom: ${width}px ${skin}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width, height: HEIGHT });
    await page.addInitScript(skin => {
      localStorage.setItem('hh-lang', 'en');
      localStorage.setItem('hh-theme', skin);
    }, skin);
    await serveApi(page);
    await page.route('**/api/version', route => route.fulfill({ json: CURRENT }));
    await page.route('**/api/updates', route => route.fulfill({ json: QUIET_UPDATES }));
    await page.route('**/api/people', route => route.fulfill({ json: { people: [] } }));
    await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [] } }));

    for (const screen of NON_MAP_PAGES) {
      await page.goto(screen.path);
      await expect(page.locator(screen.ready).first()).toBeVisible();
      await settled(page);

      expect.soft(await page.locator('.version-mark, [role="contentinfo"], .map-version').count(), `${screen.name}: no version bar or map-version in DOM`).toBe(0);
      const bottoms = await page.evaluate(() => ({
        screen: document.querySelector('.app-screen')!.getBoundingClientRect().bottom,
        body: document.querySelector('main.body')!.getBoundingClientRect().bottom,
        viewport: innerHeight,
      }));
      expect.soft(Math.abs(bottoms.screen - bottoms.viewport), `${screen.name}: .app-screen reaches viewport bottom`).toBeLessThanOrEqual(1);
      expect.soft(Math.abs(bottoms.body - bottoms.viewport), `${screen.name}: main.body reaches viewport bottom`).toBeLessThanOrEqual(1);

      if (screen.name === 'tasks' && skin === 'cyberpunk') {
        saveShot(await page.screenshot({ animations: 'disabled' }), `tasks-no-version-bar-${width}`);
      }
    }

    /* Settings dialog opened over Tasks also has no bottom version bar. */
    await page.goto('/tasks');
    await expect(page.locator('.tracker')).toBeVisible();
    await page.getByRole('button', { name: en.shell.account, exact: true }).click();
    await page.locator('.account-menu').getByRole('button', { name: en.settings.menu, exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect.soft(await page.locator('.version-mark, [role="contentinfo"], .map-version').count(), 'settings dialog: no bottom version bar').toBe(0);

    /* Map keeps version only as a HUD overlay with zero world shift/shrink. */
    await page.goto('/');
    await expect(page.locator('.map .dept')).toBeVisible();
    await expect(page.locator('.map-version')).toHaveText(VERSION_TEXT);
    expect.soft(await page.locator('.version-mark, [role="contentinfo"]').count(), 'map: no footer version bar').toBe(0);
    const mapBox = await page.locator('.map').boundingBox();
    expect.soft(Math.round(mapBox!.y + mapBox!.height)).toBe(HEIGHT);

    expect(errors).toEqual([]);
  });
}

/* Egypt game-world container (.map.world-map, .world-canvas-host, canvas, and isometric city building screen coordinates)
   likewise fills the viewport and never shifts or shrinks when HUD banners, Department Mode, alerts, or narrow-screen
   agent strips appear, and non-map pages have no bottom version bar in the Egypt theme. */
type WorldDebug = {
  getStats: () => { camera: { x: number; y: number; zoom: number } } | null;
  getBuildings: () => readonly { col: number; row: number }[];
  flushVisibleBakes: () => void;
};
type WorldSnapshot = {
  worldMap: Box | null;
  canvasHost: Box | null;
  canvas: Box | null;
  buildingScreen: { x: number; y: number } | null;
  zoom: number | null;
};

const worldSnapshot = (page: Page): Promise<WorldSnapshot> => page.evaluate(() => {
  const box = (sel: string): Box | null => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const worldMap = box('.map.world-map');
  const canvasHost = box('.world-canvas-host');
  const canvas = box('.world-canvas-host canvas');
  const h = (window as unknown as { __WORLD_PRODUCT__?: WorldDebug }).__WORLD_PRODUCT__;
  h?.flushVisibleBakes();
  const stats = h?.getStats() ?? null;
  const bld = h?.getBuildings()[0] ?? null;
  let buildingScreen: { x: number; y: number } | null = null;
  if (canvas && stats && bld) {
    const wx = (bld.col - bld.row) * 60;
    const wy = (bld.col + bld.row + 1) * 30;
    buildingScreen = {
      x: canvas.x + canvas.width / 2 + (wx - stats.camera.x) * stats.camera.zoom,
      y: canvas.y + canvas.height / 2 + (wy - stats.camera.y) * stats.camera.zoom,
    };
  }
  return { worldMap, canvasHost, canvas, buildingScreen, zoom: stats?.camera.zoom ?? null };
});

async function settledWorldSnapshot(page: Page): Promise<WorldSnapshot> {
  await page.evaluate(async () => { await document.fonts.ready; });
  let last = '';
  await expect.poll(async () => {
    await settled(page);
    const now = JSON.stringify(await worldSnapshot(page));
    const same = now === last;
    last = now;
    return same;
  }).toBe(true);
  return JSON.parse(last) as WorldSnapshot;
}

function expectSameWorldGeometry(after: WorldSnapshot, before: WorldSnapshot, label: string) {
  for (const [part, a, b] of [
    ['.map.world-map', after.worldMap, before.worldMap],
    ['.world-canvas-host', after.canvasHost, before.canvasHost],
    ['.world-canvas-host canvas', after.canvas, before.canvas],
  ] as const) {
    expect.soft(a, `${label}: ${part} stays mounted`).not.toBeNull();
    expect.soft(b, `${label}: ${part} baseline mounted`).not.toBeNull();
    if (!a || !b) continue;
    expect.soft(Math.abs(a.x - b.x), `${label}: ${part} deltaX (${a.x} vs ${b.x})`).toBeLessThanOrEqual(0.5);
    expect.soft(Math.abs(a.y - b.y), `${label}: ${part} deltaY (${a.y} vs ${b.y})`).toBeLessThanOrEqual(0.5);
    expect.soft(Math.abs(a.width - b.width), `${label}: ${part} deltaWidth (${a.width} vs ${b.width})`).toBeLessThanOrEqual(0.5);
    expect.soft(Math.abs(a.height - b.height), `${label}: ${part} deltaHeight (${a.height} vs ${b.height})`).toBeLessThanOrEqual(0.5);
  }
  expect.soft(after.buildingScreen, `${label}: building screen point available`).not.toBeNull();
  expect.soft(before.buildingScreen, `${label}: baseline building screen point available`).not.toBeNull();
  if (after.buildingScreen && before.buildingScreen) {
    expect.soft(Math.abs(after.buildingScreen.x - before.buildingScreen.x), `${label}: building deltaX`).toBeLessThanOrEqual(0.5);
    expect.soft(Math.abs(after.buildingScreen.y - before.buildingScreen.y), `${label}: building deltaY`).toBeLessThanOrEqual(0.5);
  }
  if (after.zoom !== null && before.zoom !== null) {
    expect.soft(Math.abs(after.zoom - before.zoom), `${label}: zoom unchanged`).toBeLessThanOrEqual(0.001);
  }
}

for (const width of WIDTHS) {
  test(`game-world container and building screen point stay identical across update banner, department mode, alert, agent strip, and tasks: ${width}px egypt`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));

    let updatesMode: 'quiet' | 'done' = 'quiet';
    let orgMode: 'ok' | 'fail' = 'ok';
    const egyptCompany = { ...ME.company, theme: 'egypt' };

    await page.setViewportSize({ width, height: HEIGHT });
    await page.addInitScript(() => {
      localStorage.setItem('hh-lang', 'en');
      localStorage.setItem('hh-theme', 'egypt');
    });

    await serveApi(page);
    await page.route('**/api/me', route => route.fulfill({ json: { ...ME, company: egyptCompany } }));
    await page.route('**/api/version', route => route.fulfill({ json: CURRENT }));
    await page.route('**/api/updates', route => route.fulfill({ json: updatesMode === 'done' ? DONE_UPDATES : QUIET_UPDATES }));
    await page.route('**/api/org', route => {
      if (orgMode === 'fail') return route.fulfill(BROKEN);
      return route.fulfill({ json: { ...ORG, company: egyptCompany } });
    });

    await page.goto('/');
    await expect(page.locator('[data-world-canvas="egypt"]')).toBeVisible();
    await page.waitForFunction(() => {
      const h = (window as unknown as { __WORLD_PRODUCT__?: WorldDebug }).__WORLD_PRODUCT__;
      return Boolean(h && h.getStats() && h.getBuildings().length > 0);
    });
    await expect(page.locator('.map-version')).toHaveText(VERSION_TEXT);
    expect.soft(await page.locator('.version-mark, [role="contentinfo"]').count(), 'no footer bar on egypt map').toBe(0);

    const base = await settledWorldSnapshot(page);
    expect.soft(Math.round(base.worldMap!.x), 'egypt worldMap left is 0').toBe(0);
    expect.soft(Math.round(base.worldMap!.y), 'egypt worldMap top is 0').toBe(0);
    expect.soft(Math.round(base.worldMap!.width), 'egypt worldMap fills width').toBe(width);
    expect.soft(Math.round(base.worldMap!.height), 'egypt worldMap fills height').toBe(HEIGHT);

    const barEdge = width <= 420 ? 12 : 16;
    const refetch = async (path: string) => {
      await Promise.all([
        page.waitForResponse(r => new URL(r.url()).pathname === path),
        page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))),
      ]);
    };

    /* 1) Update banner over Egypt game world */
    updatesMode = 'done';
    await refetch('/api/updates');
    const banner = page.locator('main.body .update-banner');
    const bannerBox = await expectBarVisibleUnclipped(banner, width, HEIGHT, 'egypt update banner', barEdge);
    expect.soft(await page.locator('main.body > .shell-bars > .update-banner').count(), 'egypt update banner inside .shell-bars').toBe(1);
    const hitBelow = await page.evaluate(y => !!document.elementFromPoint(24, y)?.closest('.map.world-map'), Math.min(HEIGHT - 80, bannerBox.bottom + 12));
    expect.soft(hitBelow, 'clicks below egypt update banner reach .map.world-map').toBe(true);
    expectSameWorldGeometry(await settledWorldSnapshot(page), base, 'egypt update banner shown');
    if (width === 1440) saveShot(await page.screenshot({ animations: 'disabled' }), 'egypt-update-banner-1440');

    /* 2) On-map Department Mode opened while update banner is visible */
    await page.evaluate(() => {
      history.pushState(null, '', '/departments/d2');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    const card = page.getByTestId('world-side-card');
    await expect(card).toBeVisible();
    await settled(page);
    const cardBox = await card.boundingBox();
    expect.soft(cardBox!.y, 'egypt department card clears update banner').toBeGreaterThanOrEqual(bannerBox.bottom - 1);
    expectSameWorldGeometry(await settledWorldSnapshot(page), base, 'egypt department mode with update banner');
    if (width === 1440) saveShot(await page.screenshot({ animations: 'disabled' }), 'egypt-department-banner-1440');

    await card.getByRole('button', { name: en.skins.worldCard.close, exact: true }).click();
    await expect(card).toHaveCount(0);
    await banner.getByRole('button', { name: en.updates.ok, exact: true }).click();
    await expect(banner).toHaveCount(0);
    expectSameWorldGeometry(await settledWorldSnapshot(page), base, 'egypt update banner dismissed');

    /* 3) Reload .alert over Egypt game world */
    orgMode = 'fail';
    await refetch('/api/org');
    await settled(page);
    const alert = page.locator('main.body .alert');
    const alertCount = await alert.count();
    expect.soft(alertCount, 'egypt alert rendered').toBe(1);
    expect.soft(await page.locator('main.body > .shell-bars > .alert').count(), 'egypt alert inside .shell-bars').toBe(1);
    if (alertCount > 0) await expectBarVisibleUnclipped(alert, width, HEIGHT, 'egypt alert', barEdge);
    expectSameWorldGeometry(await settledWorldSnapshot(page), base, 'egypt alert shown');

    orgMode = 'ok';
    await refetch('/api/org');
    await expect(alert).toHaveCount(0);
    expectSameWorldGeometry(await settledWorldSnapshot(page), base, 'egypt alert cleared');

    /* 4) Narrow-screen .agent-strip over Egypt game world */
    await page.locator('.map.world-map > .ticker').click();
    const win = page.locator('.orch');
    await expect(win).toBeVisible();
    await win.getByRole('button', { name: en.window.minimize, exact: true }).click();
    await expect(win).toBeHidden();
    const strip = page.locator('.agent-strip');
    await expectBarVisibleUnclipped(strip, width, HEIGHT, 'egypt agent-strip', 0);
    expectSameWorldGeometry(await settledWorldSnapshot(page), base, 'egypt agent-strip shown');
    if (width === 375) saveShot(await page.screenshot({ animations: 'disabled' }), 'egypt-agent-strip-375');

    await strip.locator('.agent-strip-close').click();
    await expect(strip).toHaveCount(0);
    expectSameWorldGeometry(await settledWorldSnapshot(page), base, 'egypt agent-strip closed');

    /* 5) Non-map page (/tasks) in Egypt theme has no bottom version bar */
    await page.goto('/tasks');
    await expect(page.locator('.tracker')).toBeVisible();
    await settled(page);
    expect.soft(await page.locator('.version-mark, [role="contentinfo"], .map-version').count(), 'egypt tasks: no version bar').toBe(0);
    const bottoms = await page.evaluate(() => ({
      screen: document.querySelector('.app-screen')!.getBoundingClientRect().bottom,
      body: document.querySelector('main.body')!.getBoundingClientRect().bottom,
      viewport: innerHeight,
    }));
    expect.soft(Math.abs(bottoms.screen - bottoms.viewport), 'egypt tasks .app-screen reaches viewport bottom').toBeLessThanOrEqual(1);
    expect.soft(Math.abs(bottoms.body - bottoms.viewport), 'egypt tasks main.body reaches viewport bottom').toBeLessThanOrEqual(1);

    expect(errors).toEqual([]);
  });
}
