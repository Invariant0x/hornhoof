import { expect, test, type Locator, type Page } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { LANGUAGES, type Language } from '../src/i18n/index';
import { ru } from '../src/i18n/ru';
import { BUILTIN_SKINS } from '../src/skins/registry';
import type { UpdatesView } from '../src/types';
import { serveApi } from './api';

/* The bars of the shell during an update, as Ivan saw them on 0.34.0: the map's bar of a refused load ran under the logo
   and the tabs and said again what the update panel says. While the panel shows the update, a maintenance refusal draws no
   bar, and the map comes back by itself when the update ends; any bar that does show stands in its own row under the
   header, and what the page shows moves down. Each look is a width, a skin, and the shipped language with the longest or
   the shortest words of this view, or the longest turned right to left: no shipped language is written that way yet. */
test.describe.configure({ timeout: 0 });

const DICTS: Record<Language, Messages> = { en, ru };
const TABS = ['map', 'tasks', 'people', 'subscriptions', 'machines'] as const;
const TARGET = { version: '0.34.0', commit: '00e5ff3e' + 'f'.repeat(32) };
/* How often the updates screen asks while an update runs; the page's clock moves only as the test moves it. */
const BUSY_POLL_MS = 2_000;

/* What this view says, the same way in every language: the tabs, the update panel and the bars it may show. */
const viewWords = (t: Messages) => [...TABS.map(tab => t.shell.tabs[tab]), t.updates.label, t.updates.running('0.34.0 (00e5ff3)'),
  t.updates.maintenance, t.updates.details, t.errors.maintenance, t.errors.codes.internal, t.people.heading, t.machines.heading, t.subs.heading];
const ranked = LANGUAGES.map(l => ({ id: l.id, length: viewWords(DICTS[l.id]).join('').length })).sort((a, b) => a.length - b.length);
const SHORTEST = ranked[0]!.id;
const LONGEST = ranked.at(-1)!.id;
const LANGS = [
  { look: `longest-${LONGEST}`, lang: LONGEST, rtl: false },
  ...(SHORTEST === LONGEST ? [] : [{ look: `shortest-${SHORTEST}`, lang: SHORTEST, rtl: false }]),
  { look: `rtl-${LONGEST}`, lang: LONGEST, rtl: true },
];
const WIDTHS = [1440, 390];
const SKINS = BUILTIN_SKINS.map(skin => skin.id);

const REFUSED = { status: 503, json: { error: { code: 'unavailable', message: 'Hornhoof is installing an update and takes no changes until it ends.', reason: 'maintenance' } } };
const BROKEN = { status: 500, json: { error: { code: 'internal', message: 'Something went wrong.' } } };

function updates(step: 'install' | 'health'): UpdatesView {
  return {
    current: { version: '0.33.2', commit: 'c'.repeat(40), migrations: 60 }, available: false, checkedAt: '2026-11-18T13:00:00.000Z',
    latest: null, versions: [], error: null,
    updater: { present: true, status: { id: 'u1', ...TARGET, state: 'running', step, log: '', at: '2026-11-18T13:30:00.000Z' }, waiting: null, calledOff: null },
  };
}

/* The server an update holds: the updates poll answers first with the update running, then with the maintenance refusal,
   as does every load of the company, until the update ends. */
async function heldServer(page: Page) {
  const held = { on: true, polls: 0 };
  await serveApi(page);
  await page.route('**/api/updates', route => {
    held.polls++;
    if (held.on && held.polls > 1) return route.fulfill(REFUSED);
    return route.fulfill({ json: updates(held.on ? 'install' : 'health') });
  });
  await page.route('**/api/org', route => (held.on ? route.fulfill(REFUSED) : route.fallback()));
  return { end: () => { held.on = false; } };
}

async function look(page: Page, lang: Language, skin: string, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ lang, skin }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', skin);
  }, { lang, skin });
}

/* A page that turned right to left keeps its words; Hornhoof sets only the language of the page. */
async function turned(page: Page, rtl: boolean) {
  if (!rtl) return;
  await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
  expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
}

type Box = { x: number; y: number; width: number; height: number };
type Bar = Box & { what: string; onTop: boolean };

/* Where one part of the page stands, read once the state it belongs to has come: a part that is not on the page then, or
   is on it more than once, fails the test at once and names itself. A wait for it would wait as long as the run lets it,
   as a box of the map did once the map's workspace was gone. */
async function boxOf(locator: Locator, what: string): Promise<Box> {
  expect(await locator.count(), `${what} is on the page once`).toBe(1);
  const box = await locator.boundingBox();
  expect(box, `${what} takes room on the page`).not.toBeNull();
  return box!;
}
const meet = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

/* What stands where: the parts of the header on screen (the mark gives its place to the tabs on a phone), every bar of
   the shell and every alert, and the page's own heading. */
async function places(page: Page, t: Messages) {
  const shown = async (locator: ReturnType<Page['locator']>) => {
    const boxes: Bar[] = [];
    for (const one of await locator.all()) {
      const b = await one.boundingBox();
      /* What a click at its middle reaches: the bar itself, not a canvas or a view drawn over it. */
      const onTop = await one.evaluate(element => {
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit !== null && element.contains(hit);
      });
      if (b && b.width > 0 && b.height > 0) boxes.push({ ...b, what: (await one.textContent())?.slice(0, 60) ?? '', onTop });
    }
    return boxes;
  };
  return {
    header: [
      ...(await shown(page.locator('.tb-brand'))),
      ...(await shown(page.getByRole('navigation', { name: t.shell.sections, exact: true }))),
      ...(await shown(page.getByRole('button', { name: t.shell.account, exact: true }))),
    ],
    bars: await shown(page.locator('.update-banner, [role="alert"]')),
    wide: await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  };
}

/* No bar under or over the header, each in its own row under it and inside the page's width, none over another. */
function rowsHold({ header, bars, wide }: Awaited<ReturnType<typeof places>>, width: number): string[] {
  const offences: string[] = [];
  const bottom = Math.max(...header.map(h => h.y + h.height));
  if (header.length < 2) offences.push(`the header shows ${header.length} parts`);
  if (wide > 0) offences.push(`the page scrolls sideways by ${wide}px`);
  bars.forEach((bar, i) => {
    /* A row of its own, apart from the header: not under it, and not glued to its bottom edge either. */
    if (bar.y < bottom + 0.5) offences.push(`"${bar.what}" starts at ${bar.y}, not under the header's bottom ${bottom}`);
    for (const part of header) if (meet(bar, part)) offences.push(`"${bar.what}" meets the header part "${part.what}"`);
    if (bar.x < -0.5 || bar.x + bar.width > width + 0.5) offences.push(`"${bar.what}" leaves the page's width`);
    if (!bar.onTop) offences.push(`"${bar.what}" is drawn under something else`);
    bars.slice(i + 1).forEach(other => { if (meet(bar, other)) offences.push(`"${bar.what}" meets "${other.what}"`); });
  });
  return offences;
}

function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(error.message));
  /* The refusals the test gives are answers the page expects; a browser notes each one in its console. */
  page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource|status of 50[03]/.test(message.text())) problems.push(message.text()); });
  return problems;
}

const shot = (page: Page, path: string) => page.screenshot({ path, animations: 'disabled' });

for (const { look: lookName, lang, rtl } of LANGS) for (const width of WIDTHS) for (const skin of SKINS) {
  const name = `${lookName} ${skin} ${width}`;
  const pictured = skin === 'cyberpunk';

  test(`during an update the map draws no bar of a maintenance refusal and comes back after it, ${name}`, async ({ page }, info) => {
    const t = DICTS[lang];
    const problems = watchProblems(page);
    await page.clock.install({ time: new Date('2026-11-18T13:00:00.000Z') });
    await page.clock.pauseAt(new Date('2026-11-18T13:35:00.000Z'));
    await look(page, lang, skin, width);
    const server = await heldServer(page);
    const orgRefused = page.waitForResponse(response => new URL(response.url()).pathname === '/api/org' && response.status() === 503);
    await page.goto('/');
    const panel = page.getByRole('status', { name: t.updates.label, exact: true });
    await expect(panel).toContainText(t.updates.running('0.34.0 (00e5ff3)'));
    await orgRefused;
    /* The next poll gets the refusal too: the panel says maintenance. */
    await page.clock.runFor(BUSY_POLL_MS);
    await expect(panel).toContainText(t.updates.maintenance);
    await turned(page, rtl);
    expect(await page.getByText(t.errors.maintenance).count(), 'no bar says maintenance again').toBe(0);
    expect(await page.getByRole('alert').count(), 'no bar of a refused load').toBe(0);
    expect(await page.getByText(t.updates.maintenance, { exact: true }).count(), 'the panel says it once').toBe(1);
    expect(rowsHold(await places(page, t), width)).toEqual([]);
    if (pictured) await shot(page, info.outputPath(`maintenance-map-${name.replaceAll(' ', '-')}.png`));

    /* The update ends: the next poll answers, and the map loads the company again with no reload of the page. */
    const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/org' && response.status() === 200);
    server.end();
    await page.clock.runFor(BUSY_POLL_MS);
    await loaded;
    await expect(page.getByRole('button', { name: /^Development/ })).toBeVisible();
    await expect(panel).toContainText(t.updates.steps.health);
    expect(await page.getByRole('alert').count()).toBe(0);
    /* The open map runs under the header and the panel to the top of the window, and the panel floats over it (#1639): it
       covers no card, chip, hub or control of the map. */
    expect(rowsHold(await places(page, t), width)).toEqual([]);
    const mapBox = await boxOf(page.locator('.map'), 'the map');
    const panelBox = await boxOf(panel, 'the update panel');
    expect(mapBox.y, 'the map starts at the top of the window').toBeLessThanOrEqual(0.5);
    const covered: string[] = [];
    for (const part of await page.locator('.map .world :is(.dept, .hub, .chip), .map > :is(.zoom, .ticker, .map-arrange)').all()) {
      const b = await part.boundingBox();
      if (b && b.width > 0 && b.height > 0 && meet(b, panelBox)) covered.push((await part.textContent())?.slice(0, 40) ?? '');
    }
    expect(covered, 'the panel covers nothing the map shows').toEqual([]);
    expect(problems).toEqual([]);
  });

  test(`a bar of any other failure stands in its own row under the header, and the page moves down, ${name}`, async ({ page }, info) => {
    const t = DICTS[lang];
    const problems = watchProblems(page);
    await look(page, lang, skin, width);
    await serveApi(page);
    const running = { on: true };
    await page.route('**/api/updates', route => route.fulfill({ json: running.on ? updates('install') : { ...updates('install'), updater: { present: true, status: null, waiting: null, calledOff: null } } }));
    await page.route('**/api/org', route => route.fulfill(BROKEN));
    await page.route('**/api/people', route => route.fulfill(BROKEN));
    await page.route('**/api/machines', route => route.fulfill(BROKEN));
    await page.route('**/api/subscriptions', route => route.fulfill(BROKEN));
    const panel = page.getByRole('status', { name: t.updates.label, exact: true });

    /* The map: the panel, then the bar of the company's failed load under it. */
    await page.goto('/');
    await expect(panel).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(1);
    await turned(page, rtl);
    const map = await places(page, t);
    expect(map.bars).toHaveLength(2);
    expect(rowsHold(map, width)).toEqual([]);
    expect(map.bars[1]!.y, 'the bar stands under the panel').toBeGreaterThanOrEqual(map.bars[0]!.y + map.bars[0]!.height - 0.5);
    if (pictured) await shot(page, info.outputPath(`failure-map-${name.replaceAll(' ', '-')}.png`));

    /* A department, with no update: its bar right under the header. */
    running.on = false;
    await page.goto('/departments/d2');
    await expect(page.getByRole('alert')).toHaveCount(1);
    await expect(panel).toHaveCount(0);
    await turned(page, rtl);
    const department = await places(page, t);
    expect(department.bars).toHaveLength(1);
    expect(rowsHold(department, width)).toEqual([]);
    if (pictured) await shot(page, info.outputPath(`failure-department-${name.replaceAll(' ', '-')}.png`));

    /* A page: the panel in its own row, the page's heading and its own bar after it. */
    running.on = true;
    await page.goto('/people');
    const heading = page.getByRole('heading', { name: t.people.heading, exact: true });
    await expect(heading).toBeVisible();
    await expect(panel).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(1);
    await turned(page, rtl);
    const people = await places(page, t);
    expect(rowsHold(people, width)).toEqual([]);
    const top = await boxOf(heading, 'the heading of People');
    expect(top.y, 'the heading stands under the panel').toBeGreaterThanOrEqual(people.bars[0]!.y + people.bars[0]!.height - 0.5);
    if (pictured) await shot(page, info.outputPath(`failure-people-${name.replaceAll(' ', '-')}.png`));
    /* Scrolled, the page and its bars pass under the band at the top, never over it: nothing shows around the glass
       blocks of the header. */
    await page.setViewportSize({ width, height: 300 });
    const main = page.getByRole('main');
    await main.evaluate(element => { element.scrollTop = 30; });
    expect(await main.evaluate(element => element.scrollTop)).toBe(30);
    const below = Math.max(...people.header.map(h => h.y + h.height)) + 2;
    const covered = await panel.evaluate((element, y) => {
      const r = element.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, y);
      return { reaches: r.top < y && r.bottom > y, over: hit !== null && element.contains(hit) };
    }, below);
    expect(covered).toEqual({ reaches: true, over: false });
    await page.setViewportSize({ width, height: 900 });

    /* The tracker, which stands right under the header: the panel in its own row, the tracker after it. */
    const sections = page.getByRole('navigation', { name: t.shell.sections });
    await sections.getByRole('button', { name: t.shell.tabs.tasks, exact: true }).click();
    const tracker = page.locator('.tracker');
    await expect(tracker).toBeVisible();
    await expect(panel).toBeVisible();
    await turned(page, rtl);
    const tasks = await places(page, t);
    expect(rowsHold(tasks, width)).toEqual([]);
    expect((await boxOf(tracker, 'the tracker')).y, 'the tracker stands under the panel').toBeGreaterThanOrEqual(tasks.bars[0]!.y + tasks.bars[0]!.height - 0.5);

    for (const [tab, title] of [['machines', t.machines.heading], ['subscriptions', t.subs.heading]] as const) {
      await sections.getByRole('button', { name: t.shell.tabs[tab], exact: true }).click();
      const heading = page.getByRole('heading', { name: title, exact: true });
      await expect(heading).toBeVisible();
      await expect(panel).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(1);
      await turned(page, rtl);
      const screen = await places(page, t);
      expect(rowsHold(screen, width)).toEqual([]);
      expect((await boxOf(heading, `the heading of ${tab}`)).y).toBeGreaterThanOrEqual(screen.bars[0]!.y + screen.bars[0]!.height - 0.5);
    }
    expect(problems).toEqual([]);
  });
}
