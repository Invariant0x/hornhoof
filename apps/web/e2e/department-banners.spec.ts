import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import type { BackupsView, Org, UpdatesView } from '../src/types';
import { ME, serveApi } from './api';

/* A department opened from the map while a bar of the shell hangs over the map, as everyone saw it on 0.39.1: after each
   update until its OK is pressed, in a new company until its recovery file is saved, while a newer build waits, and when
   the company's reload fails. The map flew into the department's card and stayed in the upper half at that zoom, and the
   department took the lower half. The department takes the whole window, as with no bar, with the header and the bars
   floating over it and what it shows starting under them (#1639), and no map shows beside it; back on the map, the map is
   where and as large as the person left it. Each look is a width and a skin: the default one, and one more. */
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
    /* An update that waits for the agents of the nodes to finish their turns, with the way to call it off (#1594). */
    name: 'an update waiting for the agents', before: true,
    serve: async page => {
      const waiting = { version: '0.39.4', commit: 'd'.repeat(40), since: '2026-11-20T02:00:00.000Z', until: '2026-11-20T02:30:00.000Z', turns: [{ agent: 'Ada', task: 12 }], lost: [] };
      await page.route('**/api/updates', route => route.fulfill({ json: { ...quiet(), updater: { present: true, status: null, waiting, calledOff: null } } satisfies UpdatesView }));
    },
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
/* What a click inside the room under the header and the bars reaches, across the whole width. */
const roomBox = (b: Box, under: { top: number; bottom: number }): Box => ({ x: b.x, y: under.top, width: b.width, height: under.bottom - under.top });
/* Every part of what the selector finds that shows in the window, clipped as the boxes around it clip it, and lies under the
   header's blocks or a bar of the shell: a word there could not be read. */
const underBars = (page: Page, selector: string) => page.evaluate(sel => {
  const over = [...document.querySelectorAll('main.body > :is(.update-banner, .alert, .guard-stop), .topbar > *')]
    .map(el => ({ el, r: el.getBoundingClientRect() })).filter(({ r }) => r.width && r.height);
  const seen: string[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(sel)) {
    const r = el.getBoundingClientRect();
    let [left, top, right, bottom] = [Math.max(r.left, 0), Math.max(r.top, 0), Math.min(r.right, innerWidth), Math.min(r.bottom, innerHeight)];
    for (let up = el.parentElement; up; up = up.parentElement) {
      const style = getComputedStyle(up);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const c = up.getBoundingClientRect();
      [left, top, right, bottom] = [Math.max(left, c.left), Math.max(top, c.top), Math.min(right, c.right), Math.min(bottom, c.bottom)];
    }
    if (right - left < 1 || bottom - top < 1) continue;
    for (const { el: bar, r: b } of over) {
      if (left < b.right - 0.5 && right > b.left + 0.5 && top < b.bottom - 0.5 && bottom > b.top + 0.5)
        seen.push(`${el.className.toString().split(' ')[0]} "${(el.textContent ?? '').trim().slice(0, 24)}" at ${Math.round(top)}–${Math.round(bottom)} under ${bar.className.toString().split(' ')[0]} at ${Math.round(b.top)}–${Math.round(b.bottom)}`);
    }
  }
  return seen;
}, selector);
/* What the map and an open department show that a bar could hide. */
const MAP_CONTENT = '.map:not([inert]) .world :is(.dept, .hub, .chip)';
const DEPARTMENT_CONTENT = '.dview :is(.crumbs, .shead, .pchip, .llab)';
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
  /* A skin's own font comes late, and the map fits again to the cards it makes taller: still is after that. */
  await page.evaluate(async () => { await document.fonts.ready; });
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

    /* The person zooms the map in on the department's card and leaves it there: the view is theirs. A phone's map opens on
       its hub (#1597), where the card may show only in part at an edge, and the map runs under the header and the bars
       (#1639), so they zoom and then click where the card shows in the room under them. */
    const shownPart = async () => {
      const map = await boxOf(page, '.map'), under = await room(page), shown = await boxOf(page, '.dept:has-text("Development")');
      const [x0, x1] = [Math.max(shown.x, map.x), Math.min(shown.x + shown.width, map.x + map.width)];
      const [y0, y1] = [Math.max(shown.y, map.y, under.top), Math.min(shown.y + shown.height, map.y + map.height, under.bottom)];
      expect(x1 - x0 > 8 && y1 - y0 > 8, "the department's card shows in the room under the bars").toBe(true);
      return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, card: shown };
    };
    const zoomAt = await shownPart();
    await page.mouse.move(zoomAt.x, zoomAt.y);
    await page.mouse.wheel(0, -240);
    const left = await still(page);
    const mapBefore = await boxOf(page, '.map');
    expect(mapBefore.y, 'the map starts at the top of the window, under the header and any bar').toBeLessThanOrEqual(0.5);

    arm?.();
    const clickAt = await shownPart();
    await card.click({ position: { x: clickAt.x - clickAt.card.x, y: clickAt.y - clickAt.card.y } });
    const back = page.getByRole('button', { name: en.dept.back, exact: true });
    await expect(back).toBeVisible();
    await expect(page.locator('main.body > :is(.update-banner, .alert, .guard-stop)').first()).toBeVisible();
    await settled(page);
    const name = `${info.project.name}-${width}-${skin}-${bar.name.replace(/[^a-z]+/gi, '-').replace(/^-|-$/g, '')}`;
    shot(await page.screenshot(), name);

    const under = await room(page);
    const department = await boxOf(page, '.dview');
    expect(under.bars, 'a bar shows over the department').toBeGreaterThan(0);
    expect(department.y, 'the department starts at the top of the window, under the header and the bars').toBeLessThanOrEqual(0.5);
    expect(Math.abs(department.y + department.height - under.bottom), `the department reaches the bottom of the page at ${under.bottom}`).toBeLessThanOrEqual(1);
    expect(department.width).toBeGreaterThanOrEqual(width - 1);
    expect(await reached(page, roomBox(department, under)), 'only the department shows in the room under the bars, no map beside it').toEqual(Array(25).fill('department'));
    const plate = await boxOf(page, '.dview .crumbs');
    expect(plate.y, `the department's name starts under the bars at ${under.top}, not at ${plate.y}`).toBeGreaterThanOrEqual(under.top - 0.5);
    expect(await underBars(page, DEPARTMENT_CONTENT), 'nothing the department shows lies under the bars').toEqual([]);
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

/* On a phone a bar over the map moved the department down under it, and the department's name plate came down over its
   head card: "No head yet." stood hidden under "← Development CTO". The head card opens 8 px under the name plate, with any
   bar and with none, at both widths, and the name stands at the start of the line in both directions. */
const NO_BAR: (typeof BARS)[number] = { name: 'no bar', before: false, serve: async () => {} };
const DIRS = ['ltr', 'rtl'] as const;
/* Where a box stands until it stops moving: the schema glides to its place as the department opens. */
async function stillBox(page: Page, selector: string) {
  let last = '';
  await expect.poll(async () => {
    await settled(page);
    const now = JSON.stringify(await page.locator(selector).boundingBox());
    const same = now === last;
    last = now;
    return same;
  }).toBe(true);
  return JSON.parse(last) as Box;
}

for (const width of WIDTHS) for (const dir of DIRS) for (const bar of [NO_BAR, ...BARS]) {
  test(`the head card opens 8 px under the department's name with ${bar.name}, ${width}px ${dir}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width, height: HEIGHT });
    await page.addInitScript(() => {
      localStorage.setItem('hh-lang', 'en');
      localStorage.setItem('hh-theme', 'cyberpunk');
    });
    await serveApi(page);
    const arm = await bar.serve(page);
    await page.goto('/');
    const card = page.locator('.dept', { hasText: 'Development' });
    await expect(card).toBeVisible();
    if (bar.before) await expect(page.locator('main.body > .update-banner')).toBeVisible();
    if (dir === 'rtl') await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    await still(page);

    arm?.();
    await card.click();
    await expect(page.getByRole('button', { name: en.dept.back, exact: true })).toBeVisible();
    if (bar !== NO_BAR) await expect(page.locator('main.body > :is(.update-banner, .alert, .guard-stop)').first()).toBeVisible();
    else await expect(page.locator('main.body > :is(.update-banner, .alert, .guard-stop)')).toHaveCount(0);
    const nameText = page.locator('.dview .shead .hn');
    await expect(nameText).toHaveText(en.dept.noHead);
    const head = await stillBox(page, '.dview .shead');
    const plate = await boxOf(page, '.dview .crumbs');
    expect(await page.locator('.dview .crumbs').evaluate(e => getComputedStyle(e).direction), 'the department reads in this direction').toBe(dir);
    /* Still, so a look that did not change is the same picture byte for byte: the blinking dot of the line stands still. */
    shot(await page.screenshot({ animations: 'disabled' }), `head-${info.project.name}-${width}-${dir}-${bar.name.replace(/[^a-z]+/gi, '-').replace(/^-|-$/g, '')}`);

    expect(head.y, `the head card starts at ${head.y}, 8 px under the name plate's bottom at ${plate.y + plate.height}`).toBeGreaterThanOrEqual(plate.y + plate.height + 8 - 0.5);
    /* Every word of the head card shows: what a click at the middle of "No head yet." reaches is the head card. */
    const words = await boxOf(page, '.dview .shead .hn');
    expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.shead'), { x: words.x + words.width / 2, y: words.y + words.height / 2 }), '"No head yet." is not under anything').toBe(true);
    expect(await underBars(page, DEPARTMENT_CONTENT), 'nothing the department shows lies under the header or the bars').toEqual([]);
    /* The name stands at the start of the line: the left in ltr, the right in rtl, as far from that edge in both. */
    const start = await page.locator('.dview .crumbs').evaluate(e => parseFloat(getComputedStyle(e).insetInlineStart));
    const fromStart = dir === 'rtl' ? width - (plate.x + plate.width) : plate.x;
    expect(Math.abs(fromStart - start), `the name plate stands ${start} px from the ${dir === 'rtl' ? 'right' : 'left'} edge, not ${fromStart}`).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });
}

/* Design on #1639: a card opens 8 px under the last element at the top, and the department's name plate is one. A name
   that wraps to two lines makes the plate taller, so a card opened over the department starts under its measured bottom:
   on a phone always, on a wide screen where that is lower than under the header or the bars. */
const LONG_NAME = 'Development of the web app, the map of the company and the task tracker';
const LONG_NAMED: Org = {
  company: ME.company,
  orchestrator: { id: 'a1', name: 'Orchestrator', model: 'claude-opus-5-5', effort: null, subscription: null, context: null, program: null, alarm: null, retry: null, failure: null },
  agents: { total: 1, working: 1 },
  people: [],
  departments: [{ id: 'd2', name: LONG_NAME, templateKey: null, roleCode: 'CTO', about: '', agents: { total: 1, working: 1 }, products: [], teams: [], people: [], employees: [], roles: [] }],
};
for (const width of WIDTHS) for (const dir of DIRS) for (const bar of [NO_BAR, ...BARS.filter(bar => bar.name === 'the update that ended')]) {
  test(`a task card opens 8 px under a department's name of two lines with ${bar.name}, ${width}px ${dir}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width, height: HEIGHT });
    await page.addInitScript(() => {
      localStorage.setItem('hh-lang', 'en');
      localStorage.setItem('hh-theme', 'cyberpunk');
    });
    await serveApi(page);
    await page.route('**/api/org', route => route.fulfill({ json: LONG_NAMED }));
    await bar.serve(page);
    await page.goto('/');
    const card = page.locator('.dept', { hasText: LONG_NAME });
    await expect(card).toBeVisible();
    if (bar.before) await expect(page.locator('main.body > .update-banner')).toBeVisible();
    if (dir === 'rtl') await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    await still(page);
    await card.click();
    await expect(page.getByRole('button', { name: en.dept.back, exact: true })).toBeVisible();
    /* A task opens over the department as its tree opens one: the task's address, with the department's under it. */
    await page.evaluate(() => {
      history.pushState({ hhBackground: location.pathname, hhUnderlays: [] }, '', '/tasks/t1');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    const opened = page.locator('aside.acard');
    await expect(opened.getByText('Checkout step 1', { exact: true }).first()).toBeVisible();
    await expect(page.locator('.dview .crumbs')).toBeVisible();
    const lines = await page.locator('.dview .crumbs h2').evaluate(e => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)));
    expect(lines, "the department's name takes two lines").toBeGreaterThanOrEqual(2);
    const plate = await stillBox(page, '.dview .crumbs'), at = await stillBox(page, 'aside.acard');
    shot(await page.screenshot({ animations: 'disabled' }), `task-card-${info.project.name}-${width}-${dir}-${bar.name.replace(/[^a-z]+/gi, '-').replace(/^-|-$/g, '')}`);

    const under = await room(page), header = await boxOf(page, '.topbar');
    const plateEnd = plate.y + plate.height + 8;
    const top = width <= 760 ? plateEnd : Math.max(bar === NO_BAR ? 68 : under.top, plateEnd);
    expect(Math.abs(at.y - top), `the task card opens at ${top}, 8 px under the name plate's bottom at ${plate.y + plate.height}, not at ${at.y}`).toBeLessThanOrEqual(1);
    expect(at.y, 'the task card opens under the header').toBeGreaterThanOrEqual(header.y + header.height);
    expect(errors).toEqual([]);
  });
}

/* The same rule for the windows on a wide screen: an employee's window stands at the right in both directions, and in rtl
   the department's name stands there too. While a department is open its windows open 8 px under the name as the cards
   do, where that is lower than under the header or the bars; with none open they open under the bars (the map's check). */
for (const dir of DIRS) for (const bar of [NO_BAR, ...BARS.filter(bar => bar.name === 'the update that ended')]) {
  test(`an employee's window opens 8 px under a department's name of two lines with ${bar.name}, 1440px ${dir}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: HEIGHT });
    await page.addInitScript(() => {
      localStorage.setItem('hh-lang', 'en');
      localStorage.setItem('hh-theme', 'cyberpunk');
    });
    await serveApi(page);
    await page.route('**/api/org', route => route.fulfill({ json: LONG_NAMED }));
    await bar.serve(page);
    await page.goto('/');
    const card = page.locator('.dept', { hasText: LONG_NAME });
    await expect(card).toBeVisible();
    if (bar.before) await expect(page.locator('main.body > .update-banner')).toBeVisible();
    if (dir === 'rtl') await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    await still(page);
    await card.click();
    /* The CEO hires from the department, and the orchestrator's window opens for it. */
    await page.locator('.dview').getByRole('button', { name: en.dept.hire, exact: true }).click();
    await expect(page.locator('.orch')).toBeVisible();
    const plate = await stillBox(page, '.dview .crumbs'), at = await stillBox(page, '.orch');
    shot(await page.screenshot({ animations: 'disabled' }), `window-${info.project.name}-1440-${dir}-${bar.name.replace(/[^a-z]+/gi, '-').replace(/^-|-$/g, '')}`);

    const under = await room(page);
    const top = Math.max(bar === NO_BAR ? 68 : under.top, plate.y + plate.height + 8);
    expect(Math.abs(at.y - top), `the window opens at ${top}, 8 px under the name plate's bottom at ${plate.y + plate.height}, not at ${at.y}`).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });
}

/* Ivan's word on 0.39.2 and 0.39.3, for #1639: a bar of the shell took a row of its own and moved the map down under it, so
   the header stood apart from the map. The map's dots and lines reach the top of the window, the header and the bars float
   over them, nothing the map shows lies under them, and the map opens with its hub in the middle across of the room under
   them (#1597). Each look is a width, a direction, a skin and a bar: an update that ended, one that waits for the agents,
   and none. */
const FLOATING = [NO_BAR, ...BARS.filter(bar => bar.name === 'the update that ended' || bar.name === 'an update waiting for the agents')];
for (const width of WIDTHS) for (const dir of DIRS) for (const skin of SKINS) for (const bar of FLOATING) {
  test(`the map runs under the header and ${bar.name} to the top of the window, its hub in the middle of the room under them, ${width}px ${dir} ${skin}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width, height: HEIGHT });
    await page.addInitScript(({ skin, dir }) => {
      localStorage.setItem('hh-lang', 'en');
      localStorage.setItem('hh-theme', skin);
      document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = dir; });
    }, { skin, dir });
    await serveApi(page);
    await bar.serve(page);
    await page.goto('/');
    await expect(page.locator('.dept', { hasText: 'Development' })).toBeVisible();
    if (bar === NO_BAR) await expect(page.locator('main.body > :is(.update-banner, .alert, .guard-stop)')).toHaveCount(0);
    else await expect(page.locator('main.body > .update-banner')).toBeVisible();
    await page.evaluate(d => { document.documentElement.dir = d; }, dir);
    await still(page);
    shot(await page.screenshot({ animations: 'disabled' }), `map-${info.project.name}-${width}-${dir}-${skin}-${bar.name.replace(/[^a-z]+/gi, '-').replace(/^-|-$/g, '')}`);

    const map = await boxOf(page, '.map'), under = await room(page);
    expect(map.y, 'the map starts at the top of the window, under the header and any bar').toBeLessThanOrEqual(0.5);
    expect(Math.abs(map.y + map.height - under.bottom), `the map reaches the bottom of the page at ${under.bottom}`).toBeLessThanOrEqual(1);
    expect(await underBars(page, MAP_CONTENT), 'nothing the map shows lies under the header or the bars').toEqual([]);
    /* The room the map opens in starts under the header, or under the bars and the gap after them while one stands. */
    const header = await boxOf(page, '.topbar');
    const top = bar === NO_BAR ? header.y + header.height + 8 : under.top;
    const hub = await boxOf(page, '.map .hub-art:not(.hub-spin)'), glow = await boxOf(page, '.map .world > .halo');
    expect(Math.abs(glow.x + glow.width / 2 - (hub.x + hub.width / 2)), "the hub's glow stands around the hub, in either direction").toBeLessThanOrEqual(1);
    expect(hub.y, `the hub starts in the room under the header and the bars, at ${top} or lower`).toBeGreaterThanOrEqual(top - 0.5);
    /* By Design's rule on #1597 a phone's map, which never fits whole at a readable size, opens with its hub in the middle
       across; a wide screen's fits, and opens whole in the room with the middle of all of it there: the hub's glow, its
       cards and its people. */
    const layout = await page.evaluate(() => {
      const boxes = (selector: string) => [...document.querySelectorAll(selector)].map(el => el.getBoundingClientRect());
      const glow = boxes('.map .world > .halo'), blocks = boxes('.map .world :is(.dept, .hub, .chips, .dept-chips)'), across = [...glow, ...blocks];
      return { x0: Math.min(...across.map(r => r.left)), x1: Math.max(...across.map(r => r.right)), y0: Math.min(...blocks.map(r => r.top)), y1: Math.max(...blocks.map(r => r.bottom)) };
    });
    const across = width <= 760 ? hub.x + hub.width / 2 : (layout.x0 + layout.x1) / 2;
    expect(Math.abs(across - width / 2), `the map stands in the middle across of the room, ${(across - width / 2).toFixed(1)} px off`).toBeLessThanOrEqual(1);
    if (width > 760) {
      expect(layout.y0, `the whole map starts in the room under the bars, at ${top} or lower`).toBeGreaterThanOrEqual(top - 0.5);
      expect(layout.y1, `the whole map ends in the room, above ${under.bottom}`).toBeLessThanOrEqual(under.bottom);
    }
    /* Design on #1639: the orchestrator's window opens 8 px under a bar while one stands, under the header without one. */
    await page.getByRole('button', { name: en.map.openOrchestrator, exact: true }).click();
    const opened = await boxOf(page, '.orch');
    const windowTop = bar === NO_BAR ? (width <= 760 ? 56 : 68) : under.top;
    expect(Math.abs(opened.y - windowTop), `the orchestrator's window opens at ${windowTop}, not at ${opened.y}`).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });
}
