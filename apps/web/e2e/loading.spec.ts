import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { SubView, WaitCard } from '../src/types';
import { serveApi, TASKS } from './api';

/* The one department serveApi answers with, whose tasks the tracker lists. */
const DEPARTMENT_ID = 'd2';

/* 19.11: on screens whose data comes in parts, one part showed first and the rest came in with a jump, and nobody could
   tell whether everything had come. The style book's loading (1.5, section 4, #1611): what is known is drawn at once and
   never moves; the room of what is coming is held at its final size, with one ring and its words, which show 400 ms after
   the ask and stay at least 500 ms; at 10 s the load says it takes longer than usual, with the ring still turning, and at
   30 s it gives the ask up and says why; an error answer says why at once; each with Retry, which shows the ring at once,
   keeps the focus in the room and asks again. The server's answers are held back by the test, and the page runs on the
   test's clock, paused, so it moves only as far as a test moves it. */
test.describe.configure({ timeout: 180_000 });
const SHOTS = 'e2e/results/loading-shots';
mkdirSync(SHOTS, { recursive: true });

const pathOf = (url: URL | string) => new URL(url.toString()).pathname;
/* The style book's times of a load: the ring after 400 ms, at least 500 ms; longer than usual at 10 s; given up at 30 s. */
const RING_DELAY_MS = 400;
const RING_MIN_MS = 500;
const SLOW_MS = 10_000;
const FAIL_MS = 30_000;
const T0 = Date.parse('2026-11-19T23:00:00Z');

const PLAN = {
  id: 's-codex', provider: 'codex', kind: 'personal', label: 'Codex', last4: null, tier: 'pro', status: 'ready', online: true,
  owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company', id: null, name: 'Whole company' }, limits: null, limitsUpdatedAt: null,
  budget: null, fallbacks: [], isOrchestrator: false, accounts: [], accountsDiffer: false, signedInOnce: true, leaseMachine: null, agents: [],
  machines: [{ id: 'm1', hostname: 'dev-laptop', status: 'ready', online: true }], api: null, models: [], target: null, connecting: null,
} as unknown as SubView;

/* A card Hornhoof kept for the person: a task that took longer than it should. */
const LATE: WaitCard = { id: 'c1', about: 'late', taskId: null, number: null, kind: null, level: null, at: '2026-11-19T22:00:00.000Z', turn: null, tag: null } as unknown as WaitCard;

type Lang = 'en' | 'ru';
const words = (lang: Lang) => (lang === 'en' ? en : ru);
type Words = ReturnType<typeof words>;

/* A screen whose data the test holds back: where it opens, which answer is held, the blocks it shows before that answer,
   the place of its held room, and what the answer brings. busy: the words beside its ring; form: where it stands; live:
   they are the screen's one status; cancels: the screen stops its ask when it gives it up. */
type Screen = {
  name: string;
  held: string;
  open(page: Page, lang: Lang): Promise<void>;
  answer(route: Route): Promise<void>;
  shown(page: Page, lang: Lang): Locator[];
  place(page: Page): Locator;
  arrived(page: Page, lang: Lang): Locator;
  busy?: (t: Words) => string;
  /* screen: its ring stands in the middle of a whole screen's body, under the static mark, with its words under it. */
  form?: 'screen';
  live?: boolean;
  cancels?: boolean;
  /* What else the screen reads, as the server answers it. */
  serves?: Record<string, unknown>;
};

const byTab = (tab: 'people' | 'machines' | 'subscriptions') => async (page: Page, lang: Lang) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('navigation').getByRole('button', { name: words(lang).shell.tabs[tab], exact: true }).click();
};

/* The department's list, and the card of its first task opened from it. */
const tracker = async (page: Page) => { await page.goto(`/tasks?department=${DEPARTMENT_ID}`, { waitUntil: 'domcontentloaded' }); };
const FIRST = TASKS[0]!;

const SCREENS: Screen[] = [
  {
    name: 'tracker',
    held: '/api/tasks',
    /* A department's list, whose rows are the work the held answer brings. */
    open: tracker,
    answer: route => route.fallback(),
    shown: (page, lang) => [page.getByRole('navigation').first(), page.locator('h1.tr-where'), page.getByRole('radio', { name: words(lang).tracker.views.list, exact: true })],
    place: page => page.locator('.tr-main'),
    arrived: page => page.locator('.tr-list:not(.tr-held) .tr-row').first(),
    busy: t => t.load.tasks,
    cancels: true,
  },
  {
    name: 'card',
    held: `/api/tasks/${FIRST.id}`,
    /* The card opens from its row: its title, status and facts come with the row, and only its details are held. */
    open: async (page, lang) => {
      await tracker(page);
      await page.getByRole('button', { name: FIRST.title, exact: true }).click();
      await expect(page.locator('.acard').getByRole('heading', { name: FIRST.title, exact: true })).toBeVisible();
      void lang;
    },
    answer: route => route.fallback(),
    shown: (page, lang) => [
      page.locator('.acard .tp-heading'),
      page.locator('.acard .tp-state'),
      page.locator('.acard').getByRole('group', { name: words(lang).tracker.card.facts, exact: true }),
    ],
    place: page => page.locator('.acard'),
    arrived: (page, lang) => page.locator('.acard').getByRole('button', { name: words(lang).tasks.taskActions, exact: true }),
    busy: t => t.load.task,
    live: false,
    cancels: true,
  },
  {
    name: 'subscriptions',
    held: '/api/subscriptions',
    open: byTab('subscriptions'),
    answer: route => route.fulfill({ json: { subscriptions: [PLAN], apiPlaces: null } }),
    shown: (page, lang) => [page.getByRole('navigation').first(), page.getByRole('heading', { level: 1, name: words(lang).subs.heading, exact: true })],
    place: page => page.locator('section.subs'),
    arrived: (page, lang) => page.getByRole('button', { name: words(lang).tables.openCard('Codex'), exact: true }),
  },
  {
    name: 'waits',
    held: '/api/wait-cards',
    /* What waits for the person says that nothing does only once its kept cards came too. */
    open: async page => { await page.goto('/tasks?show=waits', { waitUntil: 'domcontentloaded' }); },
    answer: route => route.fulfill({ json: { cards: [], next: null } }),
    shown: (page, lang) => [page.getByRole('navigation').first(), page.locator('h1.tr-where'), page.locator('section.waiting').getByRole('heading', { name: words(lang).tasks.waiting, exact: true })],
    place: page => page.locator('section.waiting'),
    arrived: (page, lang) => page.locator('section.waiting').getByText(words(lang).tasks.nothingWaiting, { exact: true }),
  },
  {
    name: 'waits-cards',
    held: '/api/wait-cards',
    open: async page => { await page.goto('/tasks?show=waits', { waitUntil: 'domcontentloaded' }); },
    answer: route => route.fulfill({ json: { cards: [LATE], next: null } }),
    shown: (page, lang) => [page.getByRole('navigation').first(), page.locator('h1.tr-where'), page.locator('section.waiting').getByRole('heading', { name: words(lang).tasks.waiting, exact: true })],
    place: page => page.locator('section.waiting'),
    arrived: page => page.locator('section.waiting .wait-card'),
  },
];

/* The screen's held answer: each request waits until the test lets it go, and then answers, or fails while the test says.
   aborted: the asks the page stopped. */
type Hold = { asked: () => number; aborted: () => number; release(): void; failing(on: boolean): void; answered(): Promise<unknown> };

type Look = { lang: Lang; theme: string; width: number; dir?: 'rtl' };

async function openHeld(page: Page, screen: Screen, look: Look): Promise<Hold> {
  await page.clock.install({ time: T0 });
  await page.clock.pauseAt(T0 + 1000);
  await page.setViewportSize({ width: look.width, height: 900 });
  await page.addInitScript(({ lang, theme, dir }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
    if (dir === 'rtl') document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = 'rtl'; });
  }, look);
  await serveApi(page);
  for (const [path, json] of Object.entries(screen.serves ?? {})) await page.route(url => pathOf(url) === path, route => route.fulfill({ json }));
  let asked = 0;
  let aborted = 0;
  let fail = false;
  let open: () => void = () => {};
  let gate = new Promise<void>(go => { open = go; });
  page.on('requestfailed', request => { if (pathOf(request.url()) === screen.held) aborted++; });
  await page.route(url => pathOf(url) === screen.held, async route => {
    asked++;
    await gate;
    /* An ask the page stopped while it was held has nobody to answer. */
    if (fail) return route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'The server could not answer.' } } }).catch(() => {});
    return screen.answer(route).catch(() => {});
  });
  await screen.open(page, look.lang);
  /* The clock moves only once the page asked and holds the room: a page still starting would set its timers later. */
  await expect.poll(() => asked).toBeGreaterThan(0);
  await expect(screen.place(page).locator('.load-busy, .load-boot').first()).toBeAttached();
  return {
    asked: () => asked,
    aborted: () => aborted,
    release: () => open(),
    failing: on => {
      fail = on;
      if (on) return;
      gate = new Promise<void>(go => { open = go; });
    },
    answered: () => page.waitForResponse(r => pathOf(r.url()) === screen.held),
  };
}

const boxesOf = (blocks: Locator[]) => Promise.all(blocks.map(async b => (await b.boundingBox())!));

/* The turning ring stands before its words, on their first line, not above them. */
async function expectBeside(mark: Locator, words: Locator) {
  const [m, w] = await boxesOf([mark, words]);
  expect(m.x + m.width).toBeLessThanOrEqual(w.x);
  expect(m.y + m.height / 2).toBeGreaterThan(w.y);
  expect(m.y + m.height / 2).toBeLessThan(w.y + w.height);
}

/* On a whole screen the ring stands over its words, across their middle. */
async function expectAbove(mark: Locator, words: Locator) {
  const [m, w] = await boxesOf([mark, words]);
  expect(m.y + m.height).toBeLessThanOrEqual(w.y);
  expect(Math.abs(m.x + m.width / 2 - (w.x + w.width / 2))).toBeLessThanOrEqual(1);
}

/* Each box within half a pixel of the other. */
function expectSameBoxes(after: { x: number; y: number; width: number; height: number }[], before: typeof after) {
  expect(after).toHaveLength(before.length);
  after.forEach((box, i) => {
    for (const side of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(box[side] - before[i]![side])).toBeLessThanOrEqual(0.5);
  });
}

const EN: Look = { lang: 'en', theme: 'cyberpunk', width: 1440 };
const busyWords = (screen: Screen, t: Words) => screen.busy?.(t) ?? t.common.loading;
const BUSY = '.load-busy, .load-boot';
const busyOf = (screen: Screen, page: Page) => screen.place(page).locator(screen.form === 'screen' ? '.load-boot' : '.load-busy').first();
const roomOf = (screen: Screen, page: Page) => screen.place(page).locator('.load-hold').first();

for (const screen of SCREENS) {
  test.describe(`${screen.name} loading`, () => {
    test('holds its room unseen for 400 ms, then the ring with its words for at least 500 ms; once the data came nothing shown moves', async ({ page }) => {
      const t = words('en');
      const hold = await openHeld(page, screen, EN);
      const busy = busyOf(screen, page);
      await expect(busy).toHaveClass(/unseen/);
      await expect(busy).toHaveText(busyWords(screen, t));
      /* One status a screen: a second part shows its words with no live role. */
      expect(await busy.getAttribute('role')).toBe(screen.live === false ? null : 'status');
      for (const block of screen.shown(page, 'en')) await expect(block).toBeVisible();
      const before = await boxesOf(screen.shown(page, 'en'));
      await page.clock.runFor(RING_DELAY_MS - 1);
      await expect(busy).toHaveClass(/unseen/);
      await page.clock.runFor(1);
      await expect(busy).not.toHaveClass(/unseen/);
      await expect(busy.locator('.spinner')).toBeVisible();
      if (screen.form === 'screen') await expectAbove(busy.locator('.spinner'), busy.getByText(busyWords(screen, t), { exact: true }));
      else await expectBeside(busy.locator('.spinner'), busy.getByText(busyWords(screen, t), { exact: true }));
      await expect(roomOf(screen, page)).toHaveAttribute('aria-busy', 'true');
      await expect(screen.arrived(page, 'en')).toHaveCount(0);
      const answered = hold.answered();
      hold.release();
      await answered;
      /* The data came 0 ms after the ring showed: it waits for the ring's least time. */
      await page.clock.runFor(RING_MIN_MS - 2);
      await expect(busy).toBeVisible();
      await expect(screen.arrived(page, 'en')).toHaveCount(0);
      await page.clock.runFor(2);
      await expect(screen.arrived(page, 'en')).toBeVisible();
      await expect(screen.place(page).locator(BUSY)).toHaveCount(0);
      expectSameBoxes(await boxesOf(screen.shown(page, 'en')), before);
    });

    test('shows no ring at all for data that comes within 400 ms', async ({ page }) => {
      const hold = await openHeld(page, screen, EN);
      const answered = hold.answered();
      hold.release();
      await answered;
      await expect(screen.arrived(page, 'en')).toBeVisible();
      await expect(screen.place(page).locator('.load-busy:not(.unseen), .load-boot:not(.unseen)')).toHaveCount(0);
    });

    test('says at 10 s that it takes longer than usual with the ring still turning, gives the ask up at 30 s and says why, and Retry asks again with the ring at once, the focus in the room', async ({ page }) => {
      const t = words('en');
      const hold = await openHeld(page, screen, EN);
      await page.clock.runFor(SLOW_MS);
      const slow = screen.place(page).locator('.load-fail.slow');
      await expect(slow).toHaveAttribute('role', 'status');
      await expect(slow.locator('.lf-t')).toHaveText(t.common.tooLong);
      await expect(slow.locator('.lf-t .spinner')).toBeVisible();
      await expect(slow.locator('.lf-h')).toHaveText(t.load.slowHint);
      await expect(roomOf(screen, page)).toHaveAttribute('aria-busy', 'true');
      await page.clock.runFor(FAIL_MS - SLOW_MS);
      const failed = screen.place(page).locator('.load-fail:not(.slow)');
      await expect(failed).toHaveAttribute('role', 'alert');
      await expect(failed.locator('.lf-t')).toHaveText(t.load.failed.timeout);
      await expect(failed.locator('.lf-h')).toHaveText(t.load.hint.timeout);
      await expect(failed.locator('.spinner')).toHaveCount(0);
      await expect(roomOf(screen, page)).toHaveAttribute('aria-busy', 'false');
      if (screen.cancels) await expect.poll(hold.aborted).toBeGreaterThan(0);
      const retry = failed.getByRole('button', { name: t.common.retry, exact: true });
      await retry.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(retry).toBeFocused();
      expect(await retry.evaluate(el => { const s = getComputedStyle(el); return [el.matches(':focus-visible'), s.outlineStyle, s.outlineWidth]; })).toEqual([true, 'solid', '2px']);
      const asked = hold.asked();
      await retry.press('Enter');
      await expect.poll(hold.asked).toBeGreaterThan(asked);
      await expect(busyOf(screen, page)).not.toHaveClass(/unseen/);
      await expect(roomOf(screen, page)).toBeFocused();
      const answered = hold.answered();
      hold.release();
      await answered;
      await page.clock.runFor(RING_MIN_MS);
      await expect(screen.arrived(page, 'en')).toBeVisible();
      await expect(screen.place(page).locator('.load-fail')).toHaveCount(0);
    });

    test('says why at once when the server answers with an error, and Retry asks again', async ({ page }) => {
      const t = words('en');
      const hold = await openHeld(page, screen, EN);
      hold.failing(true);
      const answered = hold.answered();
      hold.release();
      await answered;
      const failed = screen.place(page).getByRole('alert');
      await expect(failed.locator('.lf-t')).toHaveText(t.load.failed.server);
      await expect(failed.locator('.lf-h')).toHaveText(t.load.hint.server);
      await expect(screen.place(page).locator('.load-busy:not(.unseen), .load-boot:not(.unseen)')).toHaveCount(0);
      const asked = hold.asked();
      hold.failing(false);
      await failed.getByRole('button', { name: t.common.retry, exact: true }).click();
      await expect.poll(hold.asked).toBeGreaterThan(asked);
      const again = hold.answered();
      hold.release();
      await again;
      await page.clock.runFor(RING_MIN_MS);
      await expect(screen.arrived(page, 'en')).toBeVisible();
      await expect(screen.place(page).getByRole('alert')).toHaveCount(0);
    });

    test('holds the ring still with its words for a person who asked for less motion', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openHeld(page, screen, EN);
      await page.clock.runFor(RING_DELAY_MS);
      const ring = busyOf(screen, page).locator('.spinner');
      await expect(ring).toBeVisible();
      await expect(busyOf(screen, page)).toHaveText(busyWords(screen, words('en')));
      expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
      /* A quarter of the ring is its arc. */
      const colours = await ring.evaluate(el => { const s = getComputedStyle(el); return [s.borderTopColor, s.borderRightColor]; });
      expect(colours[0]).not.toBe(colours[1]);
    });
  });
}

test.describe('the tracker list while its tasks come', () => {
  test('holds rows of the size of its rows, which its first rows take in place, with the column names and the group head at once', async ({ page }) => {
    const hold = await openHeld(page, SCREENS[0]!, EN);
    await page.clock.runFor(RING_DELAY_MS);
    const heldRows = page.locator('.tr-held .tr-row');
    const count = await heldRows.count();
    expect(count).toBeGreaterThan(3);
    const held = await boxesOf(await heldRows.all());
    for (const row of held) expect(Math.abs(row.height - 37)).toBeLessThanOrEqual(0.5);
    const heads = await boxesOf([page.locator('.tr-held .tr-group-head'), page.locator('.tr-held .tr-head')]);
    const answered = hold.answered();
    hold.release();
    await answered;
    await page.clock.runFor(RING_MIN_MS);
    const rows = page.locator('.tr-list:not(.tr-held) .tr-group').first().locator('.tr-rows > .tr-row');
    await expect(rows.first()).toBeVisible();
    expectSameBoxes(await boxesOf((await rows.all()).slice(0, count)), held);
    expectSameBoxes(await boxesOf([page.locator('.tr-group-head').first(), page.locator('.tr-head').first()]), heads);
  });

  test('holds as many rows as it showed last in this tab, the next time it loads', async ({ page }) => {
    const hold = await openHeld(page, SCREENS[0]!, EN);
    hold.release();
    await expect(SCREENS[0]!.arrived(page, 'en')).toBeVisible();
    const shown = await page.locator('.tr-list .tr-row').count();
    hold.failing(false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.clock.runFor(RING_DELAY_MS);
    await expect(page.locator('.tr-held .tr-row')).toHaveCount(Math.min(shown, 40));
  });
});

/* The pictures for the check against the style book: each state of a load of each screen, on a phone and a desktop, in both
   languages and the three skins Design checks, and Russian, the longest, turned right to left. */
const LOOKS: Look[] = [
  ...(['en', 'ru'] as const).flatMap(lang => (['cyberpunk', 'light', 'matrix'] as const).flatMap(theme => [375, 1440].map(width => ({ lang, theme, width })))),
  ...[375, 1440].map(width => ({ lang: 'ru' as const, theme: 'cyberpunk', width, dir: 'rtl' as const })),
];

for (const screen of SCREENS) for (const look of LOOKS) {
  const name = `${screen.name}-${look.lang}-${look.theme}-${look.width}${look.dir ? `-${look.dir}` : ''}`;
  test(`each state of a load stays inside the screen ${name}`, async ({ page, browserName }) => {
    const t = words(look.lang);
    const shot = (state: string) => page.screenshot({ path: `${SHOTS}/${browserName}-${name}-${state}.png`, animations: 'disabled' });
    const inside = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const hold = await openHeld(page, screen, look);
    await page.clock.runFor(RING_DELAY_MS);
    await expect(busyOf(screen, page)).not.toHaveClass(/unseen/);
    await inside();
    await shot('loading');
    await page.clock.runFor(SLOW_MS - RING_DELAY_MS);
    await expect(screen.place(page).locator('.load-fail.slow .lf-t')).toHaveText(t.common.tooLong);
    await screen.place(page).getByRole('button', { name: t.common.retry, exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await inside();
    await shot('slow');
    await page.clock.runFor(FAIL_MS - SLOW_MS);
    await expect(screen.place(page).locator('.load-fail:not(.slow) .lf-t')).toHaveText(t.load.failed.timeout);
    await inside();
    await shot('failed');
    await screen.place(page).getByRole('button', { name: t.common.retry, exact: true }).click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(busyOf(screen, page)).not.toHaveClass(/unseen/);
    await shot('reduced');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    hold.release();
    await page.clock.runFor(RING_MIN_MS);
    await expect(screen.arrived(page, look.lang)).toBeVisible();
    await inside();
    await shot('ready');
  });
}
