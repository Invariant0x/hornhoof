import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { SubView } from '../src/types';
import { serveApi } from './api';

/* The one department serveApi answers with, whose tasks the tracker lists. */
const DEPARTMENT_ID = 'd2';

/* 19.11: on screens whose data comes in parts, one part showed first and the rest came in with a jump, and nobody could
   tell whether everything had come. While a screen's data is coming, the shared indicator stands where it will be and says
   more is coming; once it came, the indicator goes and nothing already shown moves. A load that fails says why, one past
   the screen's one limit says it takes longer than usual, each with Try again, which loads again. The server's answers
   are held back by the test, and the page runs on the test's clock. */
test.describe.configure({ timeout: 180_000 });
const SHOTS = 'e2e/results/loading-shots';
mkdirSync(SHOTS, { recursive: true });

const pathOf = (url: URL | string) => new URL(url.toString()).pathname;
/* Well past the one limit of any load. */
const PAST_ANY_LIMIT = 5 * 60_000;

const PLAN = {
  id: 's-codex', provider: 'codex', kind: 'personal', label: 'Codex', last4: null, tier: 'pro', status: 'ready', online: true,
  owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company', id: null, name: 'Whole company' }, limits: null, limitsUpdatedAt: null,
  budget: null, fallbacks: [], isOrchestrator: false, accounts: [], accountsDiffer: false, signedInOnce: true, leaseMachine: null, agents: [],
  machines: [{ id: 'm1', hostname: 'dev-laptop', status: 'ready', online: true }], api: null, models: [], target: null, connecting: null,
} as unknown as SubView;

type Lang = 'en' | 'ru';
const words = (lang: Lang) => (lang === 'en' ? en : ru);

/* A screen whose data the test holds back: where it opens, which answer is held, the blocks it shows before that answer,
   where the indicator stands, and what the answer brings. */
type Screen = {
  name: string;
  held: string;
  open(page: Page, lang: Lang): Promise<void>;
  answer(route: Route): Promise<void>;
  shown(page: Page, lang: Lang): Locator[];
  place(page: Page): Locator;
  arrived(page: Page, lang: Lang): Locator;
};

const SCREENS: Screen[] = [
  {
    name: 'tracker',
    held: '/api/tasks',
    /* A department's list, whose rows are the work the held answer brings. */
    open: async page => { await page.goto(`/tasks?department=${DEPARTMENT_ID}`, { waitUntil: 'domcontentloaded' }); },
    answer: route => route.fallback(),
    shown: (page, lang) => [page.getByRole('navigation').first(), page.locator('h1.tr-where'), page.getByRole('radio', { name: words(lang).tracker.views.list, exact: true })],
    place: page => page.locator('.tr-main'),
    arrived: page => page.locator('.tr-row').first(),
  },
  {
    name: 'subscriptions',
    held: '/api/subscriptions',
    open: async (page, lang) => {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.getByRole('navigation').getByRole('button', { name: words(lang).shell.tabs.subscriptions, exact: true }).click();
    },
    answer: route => route.fulfill({ json: { subscriptions: [PLAN], apiPlaces: null } }),
    shown: (page, lang) => [page.getByRole('navigation').first(), page.getByRole('heading', { level: 1, name: words(lang).subs.heading, exact: true })],
    place: page => page.locator('section.subs'),
    arrived: (page, lang) => page.getByRole('button', { name: words(lang).tables.openCard('Codex'), exact: true }),
  },
];

/* The screen's held answer: each request waits until the test lets it go, and then answers, or fails while the test says. */
type Hold = { asked: () => number; release(): void; failing(on: boolean): void };

async function openHeld(page: Page, screen: Screen, look: { lang: Lang; theme: string; width: number }): Promise<Hold> {
  await page.clock.install({ time: Date.parse('2026-11-19T23:00:00Z') });
  await page.setViewportSize({ width: look.width, height: 900 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, look);
  await serveApi(page);
  let asked = 0;
  let fail = false;
  let open: () => void = () => {};
  let gate = new Promise<void>(go => { open = go; });
  await page.route(url => pathOf(url) === screen.held, async route => {
    asked++;
    await gate;
    if (fail) return route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'The server could not answer.' } } });
    return screen.answer(route);
  });
  await screen.open(page, look.lang);
  return {
    asked: () => asked,
    release: () => open(),
    failing: on => {
      fail = on;
      if (on) return;
      gate = new Promise<void>(go => { open = go; });
    },
  };
}

const boxesOf = (blocks: Locator[]) => Promise.all(blocks.map(async b => (await b.boundingBox())!));

const EN = { lang: 'en' as const, theme: 'cyberpunk', width: 1440 };

for (const screen of SCREENS) {
  test.describe(`${screen.name} loading`, () => {
    test('shows the indicator while its data is coming, and once it came nothing already shown moves', async ({ page }) => {
      const t = words('en');
      const hold = await openHeld(page, screen, EN);
      const waiting = screen.place(page).getByRole('status').filter({ hasText: t.common.loading });
      await expect(waiting).toBeVisible();
      await expect(waiting.locator('.waiting-mark')).toBeVisible();
      await expect(screen.arrived(page, 'en')).toHaveCount(0);
      for (const block of screen.shown(page, 'en')) await expect(block).toBeVisible();
      const before = await boxesOf(screen.shown(page, 'en'));
      hold.release();
      await expect(screen.arrived(page, 'en')).toBeVisible();
      await expect(waiting).toHaveCount(0);
      expect(await boxesOf(screen.shown(page, 'en'))).toEqual(before);
    });

    test('says why a load failed, with Try again, which loads again', async ({ page }) => {
      const t = words('en');
      const hold = await openHeld(page, screen, EN);
      hold.failing(true);
      hold.release();
      const stalled = screen.place(page).getByRole('alert');
      await expect(stalled).toBeVisible();
      await expect(screen.place(page).locator('.waiting-mark')).toHaveCount(0);
      const asked = hold.asked();
      hold.failing(false);
      await screen.place(page).getByRole('button', { name: t.app.tryAgain, exact: true }).click();
      await expect.poll(hold.asked).toBeGreaterThan(asked);
      await expect(screen.place(page).getByRole('status').filter({ hasText: t.common.loading })).toBeVisible();
      hold.release();
      await expect(screen.arrived(page, 'en')).toBeVisible();
      await expect(stalled).toHaveCount(0);
    });

    test('says a load past its one limit takes longer than usual, with Try again in a visible focus ring, which loads again', async ({ page }) => {
      const t = words('en');
      const hold = await openHeld(page, screen, EN);
      await expect(screen.place(page).getByRole('status').filter({ hasText: t.common.loading })).toBeVisible();
      await page.clock.fastForward(PAST_ANY_LIMIT);
      await expect(screen.place(page).getByRole('alert')).toHaveText(t.common.tooLong);
      await expect(screen.place(page).locator('.waiting-mark')).toHaveCount(0);
      const retry = screen.place(page).getByRole('button', { name: t.app.tryAgain, exact: true });
      await retry.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(retry).toBeFocused();
      expect(await retry.evaluate(el => { const s = getComputedStyle(el); return [el.matches(':focus-visible'), s.outlineStyle, s.outlineWidth]; })).toEqual([true, 'solid', '2px']);
      const asked = hold.asked();
      await retry.press('Enter');
      await expect.poll(hold.asked).toBeGreaterThan(asked);
      hold.release();
      await expect(screen.arrived(page, 'en')).toBeVisible();
      await expect(screen.place(page).getByRole('alert')).toHaveCount(0);
    });
  });
}

/* The pictures for the check against the style book: each state of each screen, on a phone and a desktop, in both
   languages and two skins. */
const LOOKS = (['en', 'ru'] as const).flatMap(lang => (['cyberpunk', 'light'] as const).flatMap(theme => [375, 1440].map(width => ({ lang, theme, width }))));

for (const screen of SCREENS) for (const look of LOOKS) {
  const name = `${screen.name}-${look.lang}-${look.theme}-${look.width}`;
  test(`each state of a load stays inside the screen ${name}`, async ({ page, browserName }) => {
    const t = words(look.lang);
    const shot = (state: string) => page.screenshot({ path: `${SHOTS}/${browserName}-${name}-${state}.png`, animations: 'disabled' });
    const hold = await openHeld(page, screen, look);
    await expect(screen.place(page).getByRole('status').filter({ hasText: t.common.loading })).toBeVisible();
    await shot('loading');
    await page.clock.fastForward(PAST_ANY_LIMIT);
    await expect(screen.place(page).getByRole('alert')).toHaveText(t.common.tooLong);
    await screen.place(page).getByRole('button', { name: t.app.tryAgain, exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await shot('too_long');
    hold.failing(true);
    hold.release();
    await screen.place(page).getByRole('button', { name: t.app.tryAgain, exact: true }).click();
    await expect(screen.place(page).getByRole('alert')).not.toHaveText(t.common.tooLong);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot('failed');
    hold.failing(false);
    await screen.place(page).getByRole('button', { name: t.app.tryAgain, exact: true }).click();
    hold.release();
    await expect(screen.arrived(page, look.lang)).toBeVisible();
    await shot('loaded');
  });
}
