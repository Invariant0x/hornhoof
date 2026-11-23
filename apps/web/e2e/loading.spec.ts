import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { CopiesView, DepartmentTree, EventView, MachineView, PersonView, SubView, WaitCard } from '../src/types';
import { agentRoutes } from './agent-window-api';
import { serveApi, TASKS } from './api';
import { stretch } from './pseudo-text';

/* The one department serveApi answers with, whose tasks the tracker lists. */
const DEPARTMENT_ID = 'd2';

/* 19.11: on screens whose data comes in parts, one part showed first and the rest came in with a jump, and nobody could
   tell whether everything had come. The style book's loading (1.5, section 4, #1611): what is known is drawn at once and
   never moves; the room of what is coming is held at its final size, with one ring and its words, which show 400 ms after
   the ask and stay at least 500 ms; at 10 s the load says it takes longer than usual, with the ring still turning, and at
   30 s it gives the ask up and says why; an error answer says why at once; each with Retry, which shows the ring at once,
   keeps the focus in the room and asks again. The server's answers are held back by the test, and the page runs on the
   test's clock, paused, so it moves only as far as a test moves it. */
test.describe.configure({ timeout: 0 });
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

const PERSON: PersonView = {
  id: 'p2', name: 'Mira Stone', email: 'mira@example.com', title: 'Designer', status: 'active', isOwner: false,
  access: { whole: true, departments: [], teams: [] },
};
/* A machine of the company, and a copy of Hornhoof kept on another one, which the machines screen says once they came. It
   lends no tests and has no plan, so its table shows no filter buttons: those come with the data they count. */
const BOX: MachineView = { id: 'm1', hostname: 'hq-box', os: 'linux', arch: 'x86_64', owner: { id: 'p1', name: 'Ivan' }, online: true, lastSeenAt: null, plans: [], load: null, lendsTests: false, running: { agents: [], parts: [] } };
const COPIES: CopiesView = { leader: 'hq-box', copies: [{ hostname: 'spare-box', sync: true }], onlySince: null };
/* A card Hornhoof kept for the person: a task that took longer than it should. */
const LATE: WaitCard = { id: 'c1', about: 'late', taskId: null, number: null, kind: null, level: null, at: '2026-11-19T22:00:00.000Z', turn: null, tag: null } as unknown as WaitCard;

type Lang = 'en' | 'ru';
const words = (lang: Lang) => (lang === 'en' ? en : ru);
type Words = ReturnType<typeof words>;

/* The department's work tree of the running turn, with nobody's time in it yet: the tree and the speed drawer show it. */
const TREE: DepartmentTree = {
  now: '2026-11-19T23:00:00.000Z', turn: { id: 'u3', number: 3, branch: 'turn-3', startedAt: '2026-11-19T21:00:00.000Z' }, repository: true,
  lines: [], time: [], idle: [],
};
/* Bruno of the department, who works on a plan of the CEO's, his card, and one line of his conversation. */
const EMPLOYEE_ROUTES = agentRoutes({ awake: false, hasTask: false, messages: [], connections: 0 });
const LINE: EventView = { seq: 1, kind: 'text', data: { text: 'The checkout form checks the card number before it sends it.' }, jobId: 'j1', person: null, at: '2026-11-19T22:00:00.000Z' };
const AWAKE = { ready: true, reason: null, busy: false, runningJobId: null, queued: 0, terminal: false, canType: true, turnRefused: null };

const sections = (page: Page, lang: Lang) => page.getByRole('navigation', { name: words(lang).shell.sections, exact: true });
const atPath = (path: string) => async (page: Page) => { await page.goto(path, { waitUntil: 'domcontentloaded' }); };
/* The department opens at its own address; a button of its tools opens what the test holds. */
const inDepartment = (button: (lang: Lang) => string) => async (page: Page, lang: Lang) => {
  await page.goto(`/departments/${DEPARTMENT_ID}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.dv-tools').getByRole('button', { name: button(lang), exact: true }).click();
};
const backOf = (page: Page, lang: Lang) => page.locator('.crumbs').getByRole('button', { name: words(lang).dept.back, exact: true });
const departmentShown = (page: Page, lang: Lang, button: string) => [sections(page, lang), page.locator('.crumb h2'), page.locator('.dv-tools').getByRole('button', { name: button, exact: true })];

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
    /* Its search field and its table's head are drawn at once and stay where they are when the plans come (Design #1656). */
    shown: (page, lang) => [page.getByRole('navigation').first(), page.getByRole('heading', { level: 1, name: words(lang).subs.heading, exact: true }),
      page.locator('section.subs input[type=search]'), page.locator('section.subs table.dt thead')],
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
  {
    name: 'map',
    form: 'screen',
    held: '/api/org',
    open: atPath('/'),
    answer: route => route.fallback(),
    shown: (page, lang) => [sections(page, lang)],
    place: page => page.locator('.map'),
    arrived: (page, lang) => page.getByRole('button', { name: words(lang).map.openOrchestrator, exact: true }),
  },
  {
    name: 'department',
    form: 'screen',
    held: '/api/org',
    open: atPath(`/departments/${DEPARTMENT_ID}`),
    answer: route => route.fallback(),
    /* Back and the bottom bar stand from the first frame; only the schema's body waits (Design on #1654). */
    shown: (page, lang) => [sections(page, lang), backOf(page, lang), page.locator('.dv-acts')],
    place: page => page.locator('.dview'),
    arrived: (page, lang) => page.getByRole('region', { name: words(lang).dept.schema, exact: true }),
  },
  {
    name: 'department-tree',
    form: 'screen',
    held: `/api/departments/${DEPARTMENT_ID}/tree`,
    open: inDepartment(lang => words(lang).dept.treeButton),
    cancels: true,
    answer: route => route.fulfill({ json: { tree: TREE } }),
    /* The tool that opened the tree now takes back to the schema. */
    shown: (page, lang) => departmentShown(page, lang, words(lang).dept.mapButton),
    place: page => page.locator('.tview'),
    arrived: (page, lang) => page.getByRole('region', { name: words(lang).dept.treeCanvas, exact: true }),
  },
  {
    name: 'department-speed',
    held: `/api/departments/${DEPARTMENT_ID}/tree`,
    open: inDepartment(lang => words(lang).dept.speed),
    cancels: true,
    answer: route => route.fulfill({ json: { tree: TREE } }),
    shown: (page, lang) => [...departmentShown(page, lang, words(lang).dept.speed), page.locator('.dv-drawer .dv-drawer-h')],
    place: page => page.locator('aside.dv-drawer'),
    arrived: page => page.locator('aside.dv-drawer dl.sum'),
  },
  {
    name: 'employee-window',
    held: '/api/agents/b1/events',
    /* His window opens from his chip on the department's schema; his history and state are what it waits for. */
    open: async (page, lang) => {
      await page.goto(`/departments/${DEPARTMENT_ID}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('region', { name: words(lang).dept.members, exact: true }).getByRole('button', { name: /Bruno/ }).click();
    },
    answer: route => route.fulfill({ json: { events: [LINE], state: AWAKE } }),
    shown: (page, lang) => [sections(page, lang), page.locator('aside.orch .t-bar'), page.getByRole('button', { name: words(lang).window.close, exact: true })],
    place: page => page.locator('.agent-conversation'),
    arrived: (page, lang) => page.getByRole('log', { name: words(lang).window.chat.conversation, exact: true }),
    serves: { '/api/org': EMPLOYEE_ROUTES['/api/org'], '/api/agents/b1': EMPLOYEE_ROUTES['/api/agents/b1'] },
  },
  {
    name: 'people',
    held: '/api/people',
    open: byTab('people'),
    answer: route => route.fulfill({ json: { people: [PERSON] } }),
    /* Its table's head is drawn at once and stays where it is when the people come (Design #1656). */
    shown: (page, lang) => [page.getByRole('navigation').first(), page.getByRole('heading', { level: 1, name: words(lang).people.heading, exact: true }),
      page.getByRole('button', { name: words(lang).people.invitePerson, exact: true }), page.locator('section.people:not(.machines) table.ptable thead')],
    place: page => page.locator('section.people:not(.machines)'),
    /* The person's name opens their card, on a phone's stacked rows as in the table. */
    arrived: page => page.getByRole('button', { name: 'Mira Stone', exact: true }),
  },
  {
    name: 'machines',
    held: '/api/machines',
    open: byTab('machines'),
    answer: route => route.fulfill({ json: { machines: [BOX], copies: COPIES } }),
    /* The pool's frame, the search field and the table's head are drawn at once and stay where they are (Design #1656). */
    shown: (page, lang) => [page.getByRole('navigation').first(), page.getByRole('heading', { level: 1, name: words(lang).machines.heading, exact: true }),
      page.getByRole('button', { name: words(lang).machines.connect, exact: true }), page.locator('section.machines .pool'),
      page.locator('section.machines input[type=search]'), page.locator('section.machines table.dt thead')],
    place: page => page.locator('section.machines'),
    arrived: (page, lang) => page.getByRole('button', { name: words(lang).tables.openCard('hq-box'), exact: true }),
    serves: { '/api/subscriptions': { subscriptions: [] } },
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

const fontOf = (block: Locator) => block.evaluate(el => getComputedStyle(el).fontFamily);

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
      /* In the body's font everywhere, in a window set in monospace too (style book 1.5, section 4, rule 6). */
      expect(await fontOf(failed)).toBe(await fontOf(page.locator('body')));
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
      const before = await boxesOf(screen.shown(page, 'en'));
      await retry.press('Enter');
      await expect.poll(hold.asked).toBeGreaterThan(asked);
      await expect(busyOf(screen, page)).not.toHaveClass(/unseen/);
      await expect(roomOf(screen, page)).toBeFocused();
      /* The focus goes to the room without scrolling it into view: nothing shown moves. */
      expectSameBoxes(await boxesOf(screen.shown(page, 'en')), before);
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
      /* Nothing runs; the map's signal dots behind a department are paused there. */
      expect(await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length)).toBe(0);
      /* A quarter of the ring is its arc. */
      const colours = await ring.evaluate(el => { const s = getComputedStyle(el); return [s.borderTopColor, s.borderRightColor]; });
      expect(colours[0]).not.toBe(colours[1]);
    });
  });
}

/* Design #1656: past 10 s and once given up, what the room holds stays: the block that says so stands where the ring and its
   words stood, in the room's first row. */
async function expectKeptRoom(page: Page, first: Locator, kept: Locator[]) {
  for (const [ms, block] of [[SLOW_MS, '.load-fail.slow'], [FAIL_MS - SLOW_MS, '.load-fail:not(.slow)']] as const) {
    await page.clock.runFor(ms);
    await expect(first.locator(block)).toBeVisible();
    for (const part of kept) await expect(part).toBeVisible();
  }
}

test.describe('the tracker list while its tasks come', () => {
  test('keeps its column names, its group head and its held rows past 10 s and once given up', async ({ page }) => {
    await openHeld(page, SCREENS[0]!, EN);
    const rows = page.locator('.tr-held .tr-rows > .tr-row');
    await expectKeptRoom(page, rows.first(), [page.locator('.tr-held .tr-head'), page.locator('.tr-held .tr-group-head'), rows.nth(1)]);
  });

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

  const clippedIn = (block: Locator) => block.evaluate(el =>
    [el, ...el.querySelectorAll<HTMLElement>('*')]
      .filter(e => !e.closest('.sr') && getComputedStyle(e).display !== 'inline' && e.scrollWidth > e.clientWidth + 1)
      .map(e => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} ${e.scrollWidth}>${e.clientWidth}`));

  const SHIFT_LOOKS: Look[] = [
    { lang: 'en', theme: 'cyberpunk', width: 1440 },
    { lang: 'ru', theme: 'light', width: 1440, dir: 'rtl' },
    { lang: 'en', theme: 'light', width: 375, dir: 'rtl' },
    { lang: 'ru', theme: 'cyberpunk', width: 375 },
  ];

  /* #1844: "Taking longer than usual" and load error must never push already-rendered skeleton rows down (deltaY === 0). */
  for (const look of SHIFT_LOOKS) {
    const label = `${look.lang}-${look.dir ?? 'ltr'}-${look.theme}-${look.width}`;
    test(`keeps every held row at deltaY === 0 across loading, slow, error, Retry and arrival, ${label}`, async ({ page }) => {
      const t = words(look.lang);
      const hold = await openHeld(page, SCREENS[0]!, look);
      await page.clock.runFor(RING_DELAY_MS);
      const rows = page.locator('.tr-held .tr-rows > .tr-row');
      const count = await rows.count();
      expect(count).toBeGreaterThan(3);
      await page.evaluate(() => document.fonts.ready);
      const heads = look.width > 640 ? [page.locator('.tr-held .tr-group-head'), page.locator('.tr-held .tr-head')] : [page.locator('.tr-held .tr-group-head')];
      const beforeRows = await boxesOf(await rows.all());
      const beforeHeads = await boxesOf(heads);

      await page.clock.runFor(SLOW_MS - RING_DELAY_MS);
      const slow = rows.first().locator('.load-fail.slow');
      await expect(slow).toBeVisible();
      expect(await clippedIn(slow)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expectSameBoxes(await boxesOf(await rows.all()), beforeRows);
      expectSameBoxes(await boxesOf(heads), beforeHeads);

      await page.clock.runFor(FAIL_MS - SLOW_MS);
      const timedOut = rows.first().locator('.load-fail:not(.slow)');
      await expect(timedOut).toBeVisible();
      expect(await clippedIn(timedOut)).toEqual([]);
      expectSameBoxes(await boxesOf(await rows.all()), beforeRows);
      expectSameBoxes(await boxesOf(heads), beforeHeads);

      /* Retry followed by an immediate 500 server error keeps every held row in place too. */
      const askedForErr = hold.asked();
      hold.failing(true);
      const failed = hold.answered();
      await timedOut.getByRole('button', { name: t.common.retry, exact: true }).click();
      await expect.poll(hold.asked).toBeGreaterThan(askedForErr);
      hold.release();
      await failed;
      const serverErr = rows.first().locator('.load-fail:not(.slow)');
      await expect(serverErr.locator('.lf-t')).toHaveText(t.load.failed.server);
      expect(await clippedIn(serverErr)).toEqual([]);
      expectSameBoxes(await boxesOf(await rows.all()), beforeRows);
      expectSameBoxes(await boxesOf(heads), beforeHeads);

      /* Retry succeeding keeps skeleton rows still until arrival, then places real rows at the same top edge. */
      const askedForData = hold.asked();
      hold.failing(false);
      await serverErr.getByRole('button', { name: t.common.retry, exact: true }).click();
      await expect.poll(hold.asked).toBeGreaterThan(askedForData);
      await expect(rows.first().locator('.load-busy:not(.unseen)')).toBeVisible();
      expectSameBoxes(await boxesOf(await rows.all()), beforeRows);
      const arrived = hold.answered();
      hold.release();
      await arrived;
      await page.clock.runFor(RING_MIN_MS);
      const realRows = page.locator('.tr-list:not(.tr-held) .tr-group').first().locator('.tr-rows > .tr-row');
      await expect(realRows.first()).toBeVisible();
      const real = await realRows.all();
      if (look.width > 640) expectSameBoxes(await boxesOf(real.slice(0, Math.min(real.length, count))), beforeRows.slice(0, Math.min(real.length, count)));
      else expect(Math.abs((await realRows.first().boundingBox())!.y - beforeRows[0]!.y)).toBeLessThanOrEqual(0.5);
      const realHeads = look.width > 640 ? [page.locator('.tr-group-head').first(), page.locator('.tr-head').first()] : [page.locator('.tr-group-head').first()];
      expectSameBoxes(await boxesOf(realHeads), beforeHeads);
    });
  }

  test('keeps held rows at deltaY === 0 when the list holds only two cached rows and keeps room for the error card', async ({ page }) => {
    const two: Screen = { ...SCREENS[0]!, answer: route => route.fulfill({ json: { tasks: TASKS.slice(0, 2) } }) };
    const hold = await openHeld(page, two, EN);
    hold.release();
    await expect(two.arrived(page, 'en')).toBeVisible();
    const askedBefore = hold.asked();
    hold.failing(false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(hold.asked).toBeGreaterThan(askedBefore);
    const rows = page.locator('.tr-held .tr-rows > .tr-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.first().locator('.load-busy')).toBeAttached();
    await page.clock.runFor(RING_DELAY_MS);
    await page.evaluate(() => document.fonts.ready);
    const beforeRows = await boxesOf(await rows.all());
    for (const [ms, sel] of [[SLOW_MS - RING_DELAY_MS, '.load-fail.slow'], [FAIL_MS - SLOW_MS, '.load-fail:not(.slow)']] as const) {
      await page.clock.runFor(ms);
      const notice = rows.first().locator(sel);
      await expect(notice).toBeVisible();
      expectSameBoxes(await boxesOf(await rows.all()), beforeRows);
      const [listBox, noticeBox] = await boxesOf([page.locator('.tr-held .tr-rows'), notice]);
      expect(listBox.y + listBox.height).toBeGreaterThanOrEqual(noticeBox.y + noticeBox.height - 0.5);
    }
  });

  /* Pictures and Y-coordinate proof for Design (#1844), only when HH_TRACKER_SHIFT_SHOTS=1. */
  const SHIFT_SHOT_DIR = process.env.HH_OUT ?? SHOTS;
  const SHIFT_WORDS = [{ lang: 'en', dir: 'ltr' }, { lang: 'ru', dir: 'ltr' }, { lang: 'en', dir: 'rtl' }] as const;
  for (const width of [1440, 375]) {
    for (const theme of ['cyberpunk', 'light'] as const) {
      for (const { lang, dir } of SHIFT_WORDS) {
        const look: Look = { lang, theme, width, ...(dir === 'rtl' ? { dir } : {}) };
        const name = `${lang}-${dir}-${theme}-${width}`;
        test(`tracker shift proof pictures, ${name}`, async ({ page }) => {
          test.skip(!process.env.HH_TRACKER_SHIFT_SHOTS, 'pictures only when asked for');
          const hold = await openHeld(page, SCREENS[0]!, look);
          await page.clock.runFor(RING_DELAY_MS);
          const rows = page.locator('.tr-held .tr-rows > .tr-row');
          await expect(rows.first().locator('.load-busy:not(.unseen)')).toBeVisible();
          await page.evaluate(() => document.fonts.ready);
          const ys = async () => (await boxesOf(await rows.all())).map(b => Number(b.y.toFixed(2)));
          const inside = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          const yLoad = await ys();
          const maxShift = (after: number[]) => Math.max(...after.map((y, i) => Math.abs(y - yLoad[i]!)));
          await inside();
          await page.screenshot({ path: `${SHIFT_SHOT_DIR}/tracker-shift-${name}-loading.png`, animations: 'disabled' });

          await page.clock.runFor(SLOW_MS - RING_DELAY_MS);
          const slow = rows.first().locator('.load-fail.slow');
          await expect(slow).toBeVisible();
          expect(await clippedIn(slow)).toEqual([]);
          await inside();
          const ySlow = await ys();
          expect(maxShift(ySlow)).toBeLessThanOrEqual(0.5);
          await page.screenshot({ path: `${SHIFT_SHOT_DIR}/tracker-shift-${name}-slow.png`, animations: 'disabled' });

          await page.clock.runFor(FAIL_MS - SLOW_MS);
          const failed = rows.first().locator('.load-fail:not(.slow)');
          await expect(failed).toBeVisible();
          expect(await clippedIn(failed)).toEqual([]);
          await inside();
          const yFail = await ys();
          expect(maxShift(yFail)).toBeLessThanOrEqual(0.5);
          await page.screenshot({ path: `${SHIFT_SHOT_DIR}/tracker-shift-${name}-failed.png`, animations: 'disabled' });

          const askedForData = hold.asked();
          hold.failing(false);
          await failed.getByRole('button', { name: words(look.lang).common.retry, exact: true }).click();
          await expect.poll(hold.asked).toBeGreaterThan(askedForData);
          const arrived = hold.answered();
          hold.release();
          await arrived;
          await page.clock.runFor(RING_MIN_MS);
          const realFirst = page.locator('.tr-list:not(.tr-held) .tr-group').first().locator('.tr-rows > .tr-row').first();
          await expect(realFirst).toBeVisible();
          const yArrive0 = Number((await realFirst.boundingBox())!.y.toFixed(2));
          const deltaArrive0 = Math.abs(yArrive0 - yLoad[0]!);
          expect(deltaArrive0).toBeLessThanOrEqual(0.5);
          console.log(`TRACKER_SHIFT ${name} rows=${yLoad.length} yLoad=[${yLoad.slice(0, 6).join(',')}] maxDeltaSlow=${maxShift(ySlow).toFixed(2)} maxDeltaFail=${maxShift(yFail).toFixed(2)} deltaArrive0=${deltaArrive0.toFixed(2)}`);
        });
      }
    }
  }
});

test.describe('the plans while they come', () => {
  test('draw their search field, their count line and their table head at once, hold plan rows, and keep them past 10 s and once given up', async ({ page }) => {
    const t = words('en');
    await openHeld(page, SCREENS[2]!, EN);
    const room = page.locator('section.subs .load-hold');
    await expect(room.getByPlaceholder(t.tables.searchSubscriptions)).toBeVisible();
    await expect(room.locator('p.result')).toBeVisible();
    await expect(room.locator('table.dt thead th').first()).toBeVisible();
    const rows = room.locator('table.dt tbody tr');
    expect(await rows.count()).toBeGreaterThan(1);
    await expectKeptRoom(page, rows.first(), [room.locator('table.dt thead'), rows.nth(1), room.getByPlaceholder(t.tables.searchSubscriptions)]);
  });
});

test.describe('the people and the machines while they come', () => {
  const screenOf = (name: string) => SCREENS.find(screen => screen.name === name)!;

  test('people: draw their table head at once, hold person rows, and keep them past 10 s and once given up', async ({ page }) => {
    await openHeld(page, screenOf('people'), EN);
    const room = page.locator('section.people .load-hold');
    await expect(room.locator('table.ptable thead th').first()).toBeVisible();
    const rows = room.locator('table.ptable tbody tr');
    expect(await rows.count()).toBeGreaterThan(1);
    await expectKeptRoom(page, rows.first(), [room.locator('table.ptable thead'), rows.nth(1)]);
  });

  test('machines: draw the pool, the search field, the count line and the table head at once, hold machine rows, and keep them past 10 s and once given up', async ({ page }) => {
    const t = words('en');
    await openHeld(page, screenOf('machines'), EN);
    const room = page.locator('section.machines .load-hold');
    await expect(page.locator('section.machines .pool')).toBeVisible();
    await expect(room.getByPlaceholder(t.tables.searchMachines)).toBeVisible();
    await expect(room.locator('p.result')).toBeVisible();
    await expect(room.locator('table.dt thead th').first()).toBeVisible();
    const rows = room.locator('table.dt tbody tr');
    expect(await rows.count()).toBeGreaterThan(1);
    await expectKeptRoom(page, rows.first(), [room.locator('table.dt thead'), rows.nth(1), page.locator('section.machines .pool')]);
  });

  /* Design #1667 (style book 1.7, "last known size"): the filter buttons count the machines, so the first load of the
     screen cannot know them and the table moves down once when they come. Once shown in this tab, their row keeps its room
     on the next load, and nothing moves when they come again. */
  test('machines: hold the room of their filter buttons on the next load in this tab, once they showed them', async ({ page }) => {
    const both: Screen = { ...screenOf('machines'), answer: route => route.fulfill({ json: { machines: [BOX, { ...BOX, id: 'm2', hostname: 'lab-box', online: false }], copies: COPIES } }) };
    const head = page.locator('section.machines table.dt thead');
    const hold = await openHeld(page, both, EN);
    hold.release();
    await expect(page.locator('section.machines .tools-r2 .fgroup').first()).toBeVisible();
    const shown = await boxesOf([head]);
    hold.failing(false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.clock.runFor(RING_DELAY_MS);
    await expect(page.locator('section.machines .load-hold table.dt thead')).toBeVisible();
    expectSameBoxes(await boxesOf([head]), shown);
    const answered = hold.answered();
    hold.release();
    await answered;
    await page.clock.runFor(RING_MIN_MS);
    await expect(page.locator('section.machines .tools-r2 .fgroup').first()).toBeVisible();
    expectSameBoxes(await boxesOf([head]), shown);
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
    const failed = screen.place(page).locator('.load-fail:not(.slow)');
    await expect(failed.locator('.lf-t')).toHaveText(t.load.failed.timeout);
    /* The button's quoted name stays on one line (Design #1654), and each sentence reads in its own language's direction,
       its period at its end, on a page laid out right to left too (#1621). */
    expect(await failed.locator('.lf-h .lf-name').evaluate(el => el.getClientRects().length)).toBe(1);
    expect(await failed.locator('p').evaluateAll(words => words.every(p => p.matches(':dir(ltr)')))).toBe(true);
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

/* 20.11: the map drew itself before the person's arrangement came, and then every block it moved jumped to its place.
   The map now stands where it will be only once both the company and the arrangement came; an arrangement that fails to
   come leaves the map as it places itself, as before. */
test.describe('map arrangement', () => {
  async function holdLayout(page: Page) {
    await page.clock.install({ time: Date.parse('2026-11-19T23:00:00Z') });
    await page.setViewportSize({ width: EN.width, height: 900 });
    await page.addInitScript(() => localStorage.setItem('hh-lang', 'en'));
    await serveApi(page);
    let open: () => void = () => {};
    const gate = new Promise<void>(go => { open = go; });
    let fail = false;
    await page.route(url => pathOf(url) === '/api/map/layout', async route => {
      if (route.request().method() !== 'GET') return route.fallback();
      await gate;
      if (fail) return route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'The server could not answer.' } } });
      return route.fulfill({ json: { blocks: { [`dept:${DEPARTMENT_ID}`]: { x: 40, y: 700 } } } });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    return { release: () => open(), failing: () => { fail = true; } };
  }

  test('the map waits for the arrangement, then shows its blocks where the person put them, and they stay', async ({ page }) => {
    const t = words('en');
    const hold = await holdLayout(page);
    const waiting = page.locator('.map').getByRole('status').filter({ hasText: t.common.loading });
    await expect(waiting).toBeVisible();
    const department = page.getByRole('button', { name: /^Development/ });
    await expect(department).toHaveCount(0);
    hold.release();
    await expect(department).toBeVisible();
    await expect(waiting).toHaveCount(0);
    const placed = await department.boundingBox();
    await page.clock.runFor(2_000);
    expect(await department.boundingBox()).toEqual(placed);
  });

  test('an arrangement that fails to come leaves the map as it places itself, with nothing to try again', async ({ page }) => {
    const t = words('en');
    const hold = await holdLayout(page);
    await expect(page.locator('.map').getByRole('status').filter({ hasText: t.common.loading })).toBeVisible();
    hold.failing();
    hold.release();
    await expect(page.getByRole('button', { name: /^Development/ })).toBeVisible();
    await expect(page.locator('.map').getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.map').getByRole('button', { name: t.common.retry, exact: true })).toHaveCount(0);
  });
});

/* 20.11, Design on #1654: a department opened at its own address drew nothing but the indicator while the company came, so
   back, its name and its tools jumped in once it came, and a failure left no way out. What it knows without waiting stands
   at once: back, which works throughout, the plate of its name with an idle bar, its tools, disabled until the company
   came, and the room of Hire. Only the schema's body waits. */
test.describe('department while its company comes', () => {
  const DEPT = SCREENS.find(s => s.name === 'department')!;
  const plate = (page: Page) => page.locator('.crumbs .crumb');
  const tools = (page: Page) => page.locator('.dv-tools button');
  const hire = (page: Page) => page.locator('.dv-acts > .btn');
  async function expectWaiting(page: Page) {
    await expect(backOf(page, 'en')).toBeEnabled();
    await expect(plate(page).locator('.ph')).toHaveCount(1);
    await expect(tools(page)).toHaveCount(4);
    for (const tool of await tools(page).all()) await expect(tool).toBeDisabled();
    /* A person of the whole company may hire: the room of Hire holds its button, disabled with the tools. */
    await expect(hire(page)).toBeDisabled();
    /* The zoom waits with them, muted as they are. */
    const muted = (block: Locator) => block.evaluate(el => getComputedStyle(el).opacity);
    expect(await muted(page.locator('.dv-zoom .zoom'))).toBe(await muted(tools(page).first()));
    expect(await muted(tools(page).first())).not.toBe('1');
  }
  async function expectCame(page: Page) {
    await expect(DEPT.arrived(page, 'en')).toBeVisible();
    await expect(plate(page).locator('h2')).toHaveText('Development');
    for (const tool of await tools(page).all()) await expect(tool).toBeEnabled();
    await expect(hire(page)).toBeEnabled();
  }

  test('draws back, the plate of its name, its tools and the room of Hire at once, and the plate keeps its place and height', async ({ page }) => {
    const hold = await openHeld(page, DEPT, EN);
    await expectWaiting(page);
    const before = (await plate(page).boundingBox())!;
    const answered = hold.answered();
    hold.release();
    await answered;
    await page.clock.runFor(RING_MIN_MS);
    await expectCame(page);
    const after = (await plate(page).boundingBox())!;
    for (const side of ['x', 'y', 'height'] as const) expect(Math.abs(after[side] - before[side])).toBeLessThanOrEqual(0.5);
  });

  test('keeps its tools waiting through a failure, until Retry brings the company', async ({ page }) => {
    const t = words('en');
    const hold = await openHeld(page, DEPT, EN);
    hold.failing(true);
    const failed = hold.answered();
    hold.release();
    await failed;
    await expect(DEPT.place(page).locator('.load-fail')).toHaveAttribute('role', 'alert');
    await expectWaiting(page);
    hold.failing(false);
    await DEPT.place(page).getByRole('button', { name: t.common.retry, exact: true }).click();
    const again = hold.answered();
    hold.release();
    await again;
    await page.clock.runFor(RING_MIN_MS);
    await expectCame(page);
  });

  test('leaves for the map by back while its load failed', async ({ page }) => {
    const hold = await openHeld(page, DEPT, EN);
    hold.failing(true);
    const failed = hold.answered();
    hold.release();
    await failed;
    await expect(DEPT.place(page).locator('.load-fail')).toHaveAttribute('role', 'alert');
    await backOf(page, 'en').click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
    await expect(page.locator('.dview')).toHaveCount(0);
  });
});

/* No pseudo-long language ships, so the test keeps its own (Design #1656): the words of each state of a load about twice as
   long as the English wrap inside their blocks and the screen, on a phone and a desktop. */
for (const screen of SCREENS) for (const width of [375, 1440]) {
  test(`each state of a load wraps inside the screen in a long pseudo translation ${screen.name}-${width}`, async ({ page, browserName }) => {
    const hold = await openHeld(page, screen, { lang: 'en', theme: 'cyberpunk', width });
    const blocks = screen.place(page).locator('.load-busy, .load-boot, .load-fail');
    const check = async (state: string) => {
      for (const block of await blocks.all()) await stretch(block);
      /* A run of text inside a line has no width of its own to overflow: its block is checked. */
      expect(await blocks.evaluateAll(all => all.flatMap(b => [b, ...b.querySelectorAll('*')]).filter(e => !e.closest('.sr') && getComputedStyle(e).display !== 'inline' && e.scrollWidth > e.clientWidth + 1).map(e => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} ${e.scrollWidth}>${e.clientWidth}`))).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `${SHOTS}/${browserName}-${screen.name}-pseudo-${width}-${state}.png`, animations: 'disabled' });
    };
    await page.clock.runFor(RING_DELAY_MS);
    await expect(busyOf(screen, page)).not.toHaveClass(/unseen/);
    await check('loading');
    await page.clock.runFor(SLOW_MS - RING_DELAY_MS);
    await expect(screen.place(page).locator('.load-fail.slow')).toBeVisible();
    await check('slow');
    await page.clock.runFor(FAIL_MS - SLOW_MS);
    await expect(screen.place(page).locator('.load-fail:not(.slow)')).toBeVisible();
    await check('failed');
    hold.release();
  });
}
