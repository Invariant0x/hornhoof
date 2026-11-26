import { expect, test, type Page } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { LANGUAGES, type ShippedLanguage } from '../src/i18n/index';
import { ru } from '../src/i18n/ru';
import { BUILTIN_SKINS, builtinSkin } from '../src/skins/registry';
import type { UpdatesView } from '../src/types';
import { serveApi } from './api';

/* A maintenance refusal uses the full loading screen. Genuine errors still have
   a row of their own once the app is usable. Cover the shipped languages and skins. */
test.describe.configure({ timeout: 0 });

const DICTS: Record<ShippedLanguage, Messages> = { en, ru };
const TABS = ['map', 'tasks', 'people', 'subscriptions', 'machines'] as const;
const TARGET = { version: '0.34.0', commit: '00e5ff3e' + 'f'.repeat(32) };
/* How often the updates screen asks while an update runs; the page's clock moves only as the test moves it. */
const BUSY_POLL_MS = 2_000;
/* The one line of the update, English in every language, and where the road stands. */
const UPDATING = 'Updating…';
const loaderOf = (page: Page) => page.locator('.boot-screen');

/* What this view says, the same way in every language: the tabs and the bars it may show. The road's own lines are English. */
const viewWords = (t: Messages) => [...TABS.map(tab => t.shell.tabs[tab]), t.errors.maintenance, t.errors.codes.internal, t.people.heading, t.machines.heading, t.subs.heading];
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
    updater: { present: true, status: { id: 'u1', ...TARGET, state: step === 'health' ? 'rolled_back' : 'running', step, log: '', at: '2026-11-18T13:30:00.000Z' }, waiting: null, calledOff: null },
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

async function look(page: Page, lang: ShippedLanguage, skin: string, width: number) {
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
  const world = builtinSkin(skin)?.world;

  test(`during an update the map draws no bar of a maintenance refusal, the road says it, and the map comes back after it, ${name}`, async ({ page }, info) => {
    const t = DICTS[lang];
    const problems = watchProblems(page);
    await page.clock.install({ time: new Date('2026-11-18T13:00:00.000Z') });
    await page.clock.pauseAt(new Date('2026-11-18T13:35:00.000Z'));
    await look(page, lang, skin, width);
    const server = await heldServer(page);
    const orgRefused = page.waitForResponse(response => new URL(response.url()).pathname === '/api/org' && response.status() === 503);
    await page.goto('/');
    const loader = loaderOf(page);
    await expect(loader).toHaveText(UPDATING);
    await orgRefused;
    await page.clock.runFor(BUSY_POLL_MS);
    await expect(loader).toHaveText(UPDATING);
    await turned(page, rtl);
    await expect(page.getByText(t.errors.maintenance)).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('progressbar')).toHaveCount(0);
    await expect(page.locator('.svc-strip')).toHaveCount(0);
    await expect(page.getByRole('navigation')).toBeHidden();
    if (pictured) await shot(page, info.outputPath(`maintenance-map-${name.replaceAll(' ', '-')}.png`));

    const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/org' && response.status() === 200);
    server.end();
    await page.clock.runFor(BUSY_POLL_MS);
    await loaded;
    await expect(world ? page.locator(`.map[data-world-canvas="${world}"] > .ticker[role="button"]`) : page.getByRole('button', { name: /^Development/ })).toBeVisible();
    await expect(loader).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test(`a genuine failure keeps its row after the update ends, ${name}`, async ({ page }, info) => {
    const t = DICTS[lang];
    const problems = watchProblems(page);
    await look(page, lang, skin, width);
    await serveApi(page);
    await page.clock.install();
    const running = { on: true };
    await page.route('**/api/updates', route => route.fulfill({ json: updates(running.on ? 'install' : 'health') }));
    await page.route('**/api/org', route => route.fulfill(BROKEN));
    await page.route('**/api/people', route => route.fulfill(BROKEN));
    await page.route('**/api/machines', route => route.fulfill(BROKEN));
    await page.route('**/api/subscriptions', route => route.fulfill(BROKEN));

    const screens = [['/', null], ['/departments/d2', null], ['/people', t.people.heading], ['/machines', t.machines.heading], ['/subscriptions', t.subs.heading]] as const;
    for (const [path, title] of screens) {
      running.on = true;
      await page.goto(path);
      const loader = loaderOf(page);
      await expect(loader).toHaveText(UPDATING);
      await expect(page.getByRole('alert')).toHaveCount(0);
      await turned(page, rtl);

      running.on = false;
      await page.clock.runFor(BUSY_POLL_MS * 2);
      await expect(loader).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(1);
      if (title) await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      expect(rowsHold(await places(page, t), width)).toEqual([]);
      if (pictured && path === '/') await shot(page, info.outputPath(`failure-map-${name.replaceAll(' ', '-')}.png`));
      if (pictured && path === '/people') await shot(page, info.outputPath(`failure-people-${name.replaceAll(' ', '-')}.png`));
    }
    expect(problems).toEqual([]);
  });
}
