import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Messages } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { Org, UpdatesView } from '../src/types';
import { ME, serveApi } from './api';

/* #1874 / #1882: The world (map today, game world tomorrow) always occupies the entire viewport beneath the UI and never
   shifts or resizes when shell bars (.update-banner, .alert, .guard-stop) or the narrow-screen agent strip appear or
   disappear. The bottom version bar is removed from every screen except the map, where the version stays as a HUD overlay. */
test.describe.configure({ timeout: 0 });

const HEIGHT = 812;
const WIDTHS = [1440, 375] as const;
const SKINS = ['cyberpunk', 'light'] as const;
const LOCALES = [
  { name: 'en', lang: 'en', dir: 'ltr' },
  { name: 'ru', lang: 'ru', dir: 'ltr' },
  { name: 'en-rtl', lang: 'en', dir: 'rtl' },
] as const;
const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };

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
type Snapshot = { map: Box; hub: Box; dept: Box };

function saveShot(png: Buffer, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const file = `${PREFIX}-${name}.png`;
  writeFileSync(join(SHOTS, file), png);
  console.log(`SHOT ${file} sha256=${createHash('sha256').update(png).digest('hex')}`);
}

const settled = (page: Page) => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

const snapshot = (page: Page): Promise<Snapshot> => page.evaluate(() => {
  const box = (sel: string): Box => {
    const r = document.querySelector(sel)!.getBoundingClientRect();
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
    expect(Math.abs(a.x - b.x), `${label}: ${part} deltaX (${a.x} vs ${b.x})`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(a.y - b.y), `${label}: ${part} deltaY (${a.y} vs ${b.y})`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(a.width - b.width), `${label}: ${part} deltaWidth (${a.width} vs ${b.width})`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(a.height - b.height), `${label}: ${part} deltaHeight (${a.height} vs ${b.height})`).toBeLessThanOrEqual(0.5);
  }
}

async function expectBarVisibleUnclipped(locator: Locator, width: number, height: number, label: string, edge = 16) {
  await expect(locator, `${label}: visible`).toBeVisible();
  const metrics = await locator.evaluate(el => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height, sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight };
  });
  expect(metrics.width, `${label}: non-zero width`).toBeGreaterThan(0);
  expect(metrics.height, `${label}: non-zero height`).toBeGreaterThan(0);
  expect(metrics.x, `${label}: left edge inside viewport`).toBeGreaterThanOrEqual(edge - 1);
  expect(metrics.right, `${label}: right edge inside viewport`).toBeLessThanOrEqual(width - edge + 1);
  expect(metrics.y, `${label}: top inside viewport`).toBeGreaterThanOrEqual(0);
  expect(metrics.bottom, `${label}: bottom inside viewport`).toBeLessThanOrEqual(height + 1);
  expect(metrics.sw, `${label}: no horizontal clipping`).toBeLessThanOrEqual(metrics.cw + 1);
  expect(metrics.sh, `${label}: no vertical clipping`).toBeLessThanOrEqual(metrics.ch + 1);
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
    await expect(page.locator('.version-mark, [role="contentinfo"]')).toHaveCount(0);
    await page.evaluate(d => { document.documentElement.dir = d; }, locale.dir);

    const base = await settledSnapshot(page);
    expect(Math.round(base.map.x), 'map left is 0').toBe(0);
    expect(Math.round(base.map.y), 'map top is 0').toBe(0);
    expect(Math.round(base.map.width), 'map fills viewport width').toBe(width);
    expect(Math.round(base.map.height), 'map fills viewport height').toBe(HEIGHT);

    const isCanonical = skin === 'cyberpunk' && locale.name === 'en';
    if (isCanonical) saveShot(await page.screenshot({ animations: 'disabled' }), `map-version-hud-${width}`);

    const t = MESSAGES[locale.lang];

    const refetch = async (path: string) => {
      await Promise.all([
        page.waitForResponse(r => new URL(r.url()).pathname === path),
        page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))),
      ]);
    };

    /* 1) Update banner (done state with OK button) */
    updatesMode = 'done';
    await refetch('/api/updates');
    const banner = page.locator('main.body > .shell-bars > .update-banner');
    const bannerBox = await expectBarVisibleUnclipped(banner, width, HEIGHT, 'update banner');
    await expect(banner.getByRole('button', { name: t.updates.ok, exact: true })).toBeVisible();
    const afterBanner = await settledSnapshot(page);
    expectSameGeometry(afterBanner, base, 'update banner shown');

    /* Map clicks outside the centered update banner still reach .map. */
    const hitBelow = await page.evaluate(y => !!document.elementFromPoint(24, y)?.closest('.map'), Math.min(HEIGHT - 80, bannerBox.bottom + 12));
    expect(hitBelow, 'clicks under update banner reach the map').toBe(true);
    if (width === 1440 && bannerBox.x > 48) {
      const hitBeside = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.map'), { x: 24, y: bannerBox.y + bannerBox.height / 2 });
      expect(hitBeside, 'clicks beside update banner reach the map').toBe(true);
    }

    if (isCanonical) saveShot(await page.screenshot({ animations: 'disabled' }), `map-update-banner-${width}`);
    if (width === 1440 && skin === 'light' && locale.name === 'ru') saveShot(await page.screenshot({ animations: 'disabled' }), 'map-update-banner-light-ru-1440');
    if (width === 375 && skin === 'light' && locale.name === 'en-rtl') saveShot(await page.screenshot({ animations: 'disabled' }), 'map-update-banner-light-rtl-375');

    await banner.getByRole('button', { name: t.updates.ok, exact: true }).click();
    await expect(banner).toHaveCount(0);
    expectSameGeometry(await settledSnapshot(page), base, 'update banner dismissed');

    /* 2) .alert overlay on the map */
    orgMode = 'fail';
    await refetch('/api/org');
    const alert = page.locator('main.body > .shell-bars > .alert');
    await expectBarVisibleUnclipped(alert, width, HEIGHT, 'alert bar');
    expectSameGeometry(await settledSnapshot(page), base, 'alert shown');
    if (isCanonical) saveShot(await page.screenshot({ animations: 'disabled' }), `map-alert-${width}`);

    orgMode = 'ok';
    await refetch('/api/org');
    await expect(alert).toHaveCount(0);
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
    const guardStop = page.locator('main.body > .shell-bars > .guard-stop');
    await expectBarVisibleUnclipped(guardStop, width, HEIGHT, 'guard-stop bar');
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

      await expect(page.locator('.version-mark, [role="contentinfo"], .map-version'), `${screen.name}: no version bar or map-version in DOM`).toHaveCount(0);
      const bottoms = await page.evaluate(() => ({
        screen: document.querySelector('.app-screen')!.getBoundingClientRect().bottom,
        body: document.querySelector('main.body')!.getBoundingClientRect().bottom,
        viewport: innerHeight,
      }));
      expect(Math.abs(bottoms.screen - bottoms.viewport), `${screen.name}: .app-screen reaches viewport bottom`).toBeLessThanOrEqual(1);
      expect(Math.abs(bottoms.body - bottoms.viewport), `${screen.name}: main.body reaches viewport bottom`).toBeLessThanOrEqual(1);

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
    await expect(page.locator('.version-mark, [role="contentinfo"], .map-version')).toHaveCount(0);

    /* Map keeps version only as a HUD overlay with zero world shift/shrink. */
    await page.goto('/');
    await expect(page.locator('.map .dept')).toBeVisible();
    await expect(page.locator('.map-version')).toHaveText(VERSION_TEXT);
    await expect(page.locator('.version-mark, [role="contentinfo"]')).toHaveCount(0);
    const mapBox = await page.locator('.map').boundingBox();
    expect(Math.round(mapBox!.y + mapBox!.height)).toBe(HEIGHT);

    expect(errors).toEqual([]);
  });
}
