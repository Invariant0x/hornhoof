import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import type { BackupsView, UpdatesView } from '../src/types';
import { serveApi } from './api';

/* A department opened from the map while a bar of the shell hangs over the map, as everyone saw it on 0.39.1: after each
   update until its OK is pressed, in a new company until its recovery file is saved, while a newer build waits, and when
   the company's reload fails. The map flew into the department's card and stayed in the upper half at that zoom, and the
   department took the lower half. The department takes the whole room under the bars, as with no bar, and no map shows
   beside it; back on the map, the map is where and as large as the person left it. Each look is a width and a skin: the
   default one, and one more. */
test.describe.configure({ timeout: 120_000 });

const WIDTHS = [1440, 375];
const SKINS = ['cyberpunk', 'matrix'];
const HEIGHT = 850;
/* Where the screenshots go: the folder a run collects, else beside this test's results. */
const SHOTS = process.env.HH_OUT ? join(process.env.HH_OUT, 'department-banners') : fileURLToPath(new URL('results/department-banners-shots', import.meta.url));

const CURRENT = { version: '0.39.1', commit: 'a276aa6c' + 'c'.repeat(32), migrations: 156 };
const NEWER = { tag: 'v0.39.2', version: '0.39.2', commit: 'b'.repeat(40), created: '2026-11-19T20:00:00.000Z', title: 'A department fills the screen', migrations: 156 };
const quiet = (): UpdatesView => ({ current: CURRENT, available: false, checkedAt: '2026-11-19T20:00:00.000Z', latest: null, versions: [], error: null, updater: { present: true, status: null, waiting: null, calledOff: null } });
const BROKEN = { status: 500, json: { error: { code: 'internal', message: 'Something went wrong.' } } };

/* Each bar, as the server makes it show, and whether it already shows on the map before the department opens. */
/* arm: what starts as the department opens. */
const BARS: { name: string; before: boolean; serve: (page: Page) => Promise<(() => void) | void> }[] = [
  {
    name: 'the update that ended', before: true,
    serve: async page => { await page.route('**/api/updates', route => route.fulfill({ json: { ...quiet(), updater: { present: true, status: { id: 'u39', version: '0.39.1', commit: CURRENT.commit, state: 'done', step: 'finished', log: '', at: '2026-11-19T19:00:00.000Z' }, waiting: null, calledOff: null } } satisfies UpdatesView })); },
  },
  {
    name: 'a newer build', before: true,
    serve: async page => { await page.route('**/api/updates', route => route.fulfill({ json: { ...quiet(), available: true, latest: NEWER, versions: [NEWER] } satisfies UpdatesView })); },
  },
  {
    name: 'the recovery file', before: true,
    serve: async page => { await page.route('**/api/backups/recovery', route => route.fulfill({ json: { recoveryNeeded: true, linkChanged: false } satisfies Pick<BackupsView, 'recoveryNeeded' | 'linkChanged'> })); },
  },
  {
    /* The map has the company; the reload as the department opens fails, and its bar shows over the department. */
    name: "the company's failed reload", before: false,
    serve: async page => {
      let failing = false;
      await page.route('**/api/org', route => (failing ? route.fulfill(BROKEN) : route.fallback()));
      return () => { failing = true; };
    },
  },
];

type Box = { x: number; y: number; width: number; height: number };

/* Where the room under the shell's bars starts, the bottom of the page, and where the bars stand. */
const room = (page: Page) => page.evaluate(() => {
  const body = document.querySelector('main.body')!.getBoundingClientRect();
  const bars = [...document.querySelectorAll('main.body > :is(.update-banner, .alert, .guard-stop)')];
  const top = Math.max(body.top, ...bars.map(bar => bar.getBoundingClientRect().bottom + parseFloat(getComputedStyle(bar).marginBlockEnd || '0')));
  return { top, bottom: body.bottom, bars: bars.length };
});
const boxOf = async (page: Page, selector: string): Promise<Box> => {
  const found = await page.locator(selector).boundingBox();
  expect(found, `${selector} takes room on the page`).not.toBeNull();
  return found!;
};
/* Points across a box, and what a click at each reaches. */
const reached = (page: Page, b: Box) => page.evaluate(({ x, y, width, height }) => {
  const seen: string[] = [];
  for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) for (const fy of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    const hit = document.elementFromPoint(x + width * fx, y + height * fy);
    seen.push(!hit ? 'nothing' : hit.closest('.dview') ? 'department' : hit.closest('.map') ? 'map' : 'other');
  }
  return seen;
}, b);
/* Whether the map the department was opened from draws anywhere the department does not cover. */
const mapOutside = (page: Page) => page.evaluate(() => {
  const map = document.querySelector('.map');
  if (!map) return false;
  const style = getComputedStyle(map);
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  const m = map.getBoundingClientRect(), d = document.querySelector('.dview')!.getBoundingClientRect();
  return m.top < d.top - 0.5 || m.bottom > d.bottom + 0.5 || m.left < d.left - 0.5 || m.right > d.right + 0.5;
});
const view = (page: Page) => page.locator('.map .world').evaluate((e: HTMLElement) => e.style.transform);
const settled = (page: Page) => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));

/* The map's view once it stopped moving. */
async function still(page: Page) {
  let last = '';
  await expect.poll(async () => {
    await settled(page);
    const now = await view(page);
    const same = now === last;
    last = now;
    return same;
  }).toBe(true);
  return last;
}

function shot(png: Buffer, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, `${name}.png`), png);
  console.log(`SHOT ${name}.png sha256=${createHash('sha256').update(png).digest('hex')}`);
}

for (const width of WIDTHS) for (const skin of SKINS) for (const bar of BARS) {
  test(`a department opened under ${bar.name} fills the room under the bars, and the map comes back as it was, ${width}px ${skin}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width, height: HEIGHT });
    await page.addInitScript(skin => {
      localStorage.setItem('hh-lang', 'en');
      localStorage.setItem('hh-theme', skin);
    }, skin);
    await serveApi(page);
    const arm = await bar.serve(page);
    await page.goto('/');
    const card = page.locator('.dept', { hasText: 'Development' });
    await expect(card).toBeVisible();
    if (bar.before) await expect(page.locator('main.body > .update-banner')).toBeVisible();
    await still(page);

    /* The person zooms the map in and leaves it there: the view is theirs. */
    const map = await boxOf(page, '.map');
    await page.mouse.move(map.x + map.width / 2, map.y + map.height / 2);
    await page.mouse.wheel(0, -240);
    const left = await still(page);
    const mapBefore = await boxOf(page, '.map');
    if (bar.before) expect(mapBefore.y, 'the map starts under the bar').toBeGreaterThanOrEqual((await room(page)).top - 0.5);

    arm?.();
    await card.click();
    const back = page.getByRole('button', { name: en.dept.back, exact: true });
    await expect(back).toBeVisible();
    await expect(page.locator('main.body > :is(.update-banner, .alert, .guard-stop)').first()).toBeVisible();
    await settled(page);
    const name = `${info.project.name}-${width}-${skin}-${bar.name.replace(/[^a-z]+/gi, '-').replace(/^-|-$/g, '')}`;
    shot(await page.screenshot(), name);

    const under = await room(page);
    const department = await boxOf(page, '.dview');
    expect(under.bars, 'a bar shows over the department').toBeGreaterThan(0);
    expect(Math.abs(department.y - under.top), `the department starts right under the bars at ${under.top}, not at ${department.y}`).toBeLessThanOrEqual(1);
    expect(Math.abs(department.y + department.height - under.bottom), `the department reaches the bottom of the page at ${under.bottom}`).toBeLessThanOrEqual(1);
    expect(department.width).toBeGreaterThanOrEqual(width - 1);
    expect(await reached(page, department), 'only the department shows in its room, no map beside it').toEqual(Array(25).fill('department'));
    expect(await mapOutside(page), 'no part of the map shows outside the department, behind the header or the bars either').toBe(false);

    await back.click();
    await expect(page.locator('.dview')).toHaveCount(0);
    await expect(card).toBeVisible();
    await expect.poll(() => view(page), 'the map is back where and as large as the person left it').toBe(left);
    const mapAfter = await boxOf(page, '.map');
    if (bar.before) expect(mapAfter, 'the map takes the same room as before').toEqual(mapBefore);
    expect(errors).toEqual([]);
  });
}
