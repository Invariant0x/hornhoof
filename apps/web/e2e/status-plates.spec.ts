import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { LANGUAGES, type ShippedLanguage, type Messages } from '../src/i18n';
import type { BuiltinView, MachineView, Org, PersonView, SubView } from '../src/types';
import { ME, brokenHeaderWords, serveApi } from './api';

/* A status plate and the cells of a table keep their words whole, on Subscriptions & API, Machines and People: as a
   table and as entries, at the widths of a desk, a laptop, a small laptop and a phone, in every shipped language (so in
   the longest and the shortest) and laid out right to left. A word breaks only where it does not fit a line of its own, a
   status is one frame, on one line as long as the rows stand as a table, and the table stands inside its frame. */
test.describe.configure({ timeout: 0 });

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const WIDTHS = [1440, 1280, 1024, 375];
const RTL = /^(?:ar|he|fa|ur|ps|sd|ug|yi)(?:-|$)/;
const OWNER = { id: 'p1', name: 'Ivan Korol' };
const COMPANY = { kind: 'company' as const, id: null, name: 'Whole company' };
/* A machine's name of one long word, which may break only where it does not fit a line of its own. */
const ONE_WORD = 'buildboxwitharatherlongnameofitsownfortesting';

const plan = (id: string, label: string, over: Partial<SubView> = {}): SubView => ({
  id, provider: 'claude', kind: 'personal', label, status: 'ready', online: true, last4: null, owner: OWNER, place: COMPANY,
  machines: [{ id: 'm2', hostname: 'node-a', status: 'ready', online: true }], limits: null, limitsUpdatedAt: null, budget: null,
  isOrchestrator: false, accounts: [], tier: 'Max', accountsDiffer: false, signedInOnce: true, leaseMachine: null, agents: [], ...over,
});
/* What the CEO saw: plans and an API that are ready, owned by a person of two words and serving the whole company, beside
   long limit notes; and plans whose status is several words. */
const SUBS: SubView[] = [
  plan('s1', 'Claude', { isOrchestrator: true }),
  plan('s2', 'Codex', { provider: 'codex', tier: 'Pro', status: 'needs_login', place: { kind: 'department', id: 'd1', name: 'Development' } }),
  plan('s3', 'OpenRouter', { kind: 'api_key', provider: 'openrouter', tier: null, last4: 'WXYZ', machines: [], api: { baseUrl: 'https://openrouter.ai/api', protocol: 'anthropic' } }),
  plan('s4', 'Claude', { status: 'needs_setup', machines: [{ id: 'm3', hostname: ONE_WORD, status: 'needs_setup', online: true }] }),
];

const GIB = 1024 ** 3;
const machine = (id: string, hostname: string, over: Partial<MachineView> = {}): MachineView => ({
  id, hostname, os: 'linux', arch: 'x86_64', owner: OWNER, online: true, lastSeenAt: null, plans: [],
  load: { cpus: 8, load: 1, memFree: 10 * GIB, memTotal: 16 * GIB, jobs: 0, tests: 0, cpuModel: 'AMD EPYC', diskFree: 200 * GIB, diskTotal: 500 * GIB },
  lendsTests: true, running: { agents: [], parts: [] }, ...over,
});
const MACHINES: MachineView[] = [
  machine('m1', 'rack-01', { plans: [{ id: 's1', provider: 'claude', status: 'ready', online: true }] }),
  machine('m2', 'node-a', { plans: [{ id: 's2', provider: 'codex', status: 'needs_login', online: true }], otherBuild: { server: '0.24.0', nodes: ['0.23.6'] } }),
  machine('m3', ONE_WORD),
  machine('m4', 'build-box-with-a-rather-long-name-of-its-own', { online: false, lastSeenAt: '2026-11-15T09:00:00.000Z', load: null, lendsTests: false }),
];
const BUILTIN: BuiltinView = { online: true, load: null, running: { agents: [], parts: [] }, machine: { id: 'm1', hostname: 'rack-01' } };
const WHOLE = { whole: true, departments: [], teams: [] };
const PEOPLE: PersonView[] = [
  { id: 'p1', name: 'Ivan Korol', email: 'ivan@acme.com', title: 'CEO', status: 'active', isOwner: true, access: WHOLE },
  { id: 'p2', name: 'Konstantin Konstantinopolsky', email: 'konstantin@acme.com', title: 'Head of customer operations', status: 'invited', isOwner: false, isCeoDelegate: true, access: WHOLE },
  { id: 'p3', name: 'Mia', email: 'mia@acme.com', title: 'CTO', status: 'disabled', isOwner: false, access: WHOLE },
];

/* rows: how many rows the table shows; card: a row of a sorting table opens its card under it. */
type Screen = { key: 'subscriptions' | 'machines' | 'people'; rows: number; card: boolean; tab: (t: Messages) => string };
const SCREENS: Screen[] = [
  { key: 'subscriptions', rows: SUBS.length, card: true, tab: t => t.shell.tabs.subscriptions },
  { key: 'machines', rows: MACHINES.length, card: true, tab: t => t.shell.tabs.machines },
  { key: 'people', rows: PEOPLE.length, card: false, tab: t => t.shell.tabs.people },
];
const ROWS = '.dt > tbody > tr.rm, .ptable > tbody > tr';
const TABLE = 'table.dt, table.ptable';

async function messagesFor(language: ShippedLanguage): Promise<Messages> {
  const dictionary = await import(`../src/i18n/${language}.ts`) as Record<string, Messages>;
  return dictionary[language]!;
}

async function serve(page: Page, subs = SUBS) {
  await page.clock.install({ time: NOW });
  await serveApi(page);
  const org: Org = { company: ME.company, orchestrator: null, agents: { total: 0, working: 0 }, people: [], departments: [] };
  const only = (path: string) => (url: URL) => url.pathname === path;
  await page.route(only('/api/org'), route => route.fulfill({ json: org }));
  await page.route(only('/api/subscriptions'), route => route.fulfill({ json: { subscriptions: subs } }));
  await page.route(only('/api/machines'), route => route.fulfill({ json: { machines: MACHINES, builtin: BUILTIN, priority: false, move: null, canMove: false, copies: null } }));
  await page.route(only('/api/nodes/commands'), route => route.fulfill({ json: { commands: [] } }));
  await page.route(only('/api/machines/access'), route => route.fulfill({ json: { views: [] } }));
  await page.route(only('/api/people'), route => route.fulfill({ json: { people: PEOPLE } }));
}

async function open(page: Page, screen: Screen, language: ShippedLanguage, theme: 'light' | 'dark', dir: 'ltr' | 'rtl') {
  await page.evaluate(({ language, theme }) => { localStorage.setItem('hh-lang', language); localStorage.setItem('hh-theme', theme); }, { language, theme });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(direction => { document.documentElement.dir = direction; }, dir);
  await page.getByRole('navigation').getByRole('button', { name: screen.tab(await messagesFor(language)), exact: true }).click();
  await expect(page.locator(ROWS)).toHaveCount(screen.rows);
  await page.evaluate(() => document.fonts.ready);
}

/* The words of the rows and of every status and badge on the page that stand on more than one line: a run of letters and
   digits split across lines is a word broken inside, as Ready into Read and y. */
const brokenWords = (page: Page) => page.evaluate(rows => {
  const broken: string[] = [];
  for (const root of document.querySelectorAll(`${rows}, .status, .badge`)) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const word of (node.textContent ?? '').matchAll(/[\p{L}\p{N}]+/gu)) {
        const range = document.createRange();
        range.setStart(node, word.index);
        range.setEnd(node, word.index + word[0].length);
        const lines = new Set([...range.getClientRects()].filter(r => r.width > 0).map(r => Math.round(r.top)));
        if (lines.size > 1) broken.push(word[0]);
      }
    }
  }
  return broken;
}, ROWS);

/* Each status of the rows: its frames (one, never split across lines) and the lines its words take inside. */
const statuses = (page: Page) => page.locator(ROWS).locator('.status').evaluateAll(all => all.map(el => {
  const range = document.createRange();
  range.selectNodeContents(el);
  const lines = new Set([...range.getClientRects()].filter(r => r.width > 0).map(r => Math.round(r.top))).size;
  return { text: el.textContent ?? '', frames: el.getClientRects().length, lines };
}));

/* The rows stand as a table (not as entries, as on a phone or where whole words do not fit). */
const asTable = (page: Page) => page.locator(TABLE).evaluate(el => getComputedStyle(el).display === 'table');
/* The table stands inside the frame that measures it. */
const tableFits = (page: Page) => page.locator(TABLE).evaluate(el => el.parentElement!.scrollWidth <= el.parentElement!.clientWidth + 1);
const pageFits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
/* How many letters the rows and headers show: what ranks the languages from the longest to the shortest. */
const shownLength = (page: Page) => page.locator(TABLE).evaluate(el => (el.textContent ?? '').replace(/\s+/g, '').length);

async function check(page: Page, place: string) {
  const table = await asTable(page);
  /* Only the machine's name of one long word may break, where as entries it does not fit a line of its own. */
  expect((await brokenWords(page)).filter(word => table || word !== ONE_WORD), `${place}: no word is broken inside`).toEqual([]);
  expect(await brokenHeaderWords(page), `${place}: no header word is broken inside`).toEqual([]);
  for (const status of await statuses(page)) {
    expect(status.frames, `${place}: ${status.text} is one frame`).toBe(1);
    if (table || !/\s/.test(status.text)) expect(status.lines, `${place}: ${status.text} stands on one line`).toBe(1);
  }
  expect(await tableFits(page), `${place}: the table stands inside its frame`).toBe(true);
  expect(await pageFits(page), `${place}: nothing goes past the screen`).toBe(true);
  return table;
}

/* The screen's top and its whole table: the page scrolls inside its body, so the window is as tall as a table of entries. */
const HEIGHT = (width: number) => (width < 600 ? 2400 : 1300);
async function shoot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`), animations: 'disabled' });
}

/* The languages from the longest to the shortest on a screen, by the letters its table shows. */
async function rank(page: Page, screen: Screen): Promise<ShippedLanguage[]> {
  const ranked: { id: ShippedLanguage; letters: number }[] = [];
  for (const { id } of LANGUAGES) {
    await open(page, screen, id, 'dark', 'ltr');
    ranked.push({ id, letters: await shownLength(page) });
  }
  return ranked.sort((a, b) => b.letters - a.letters || a.id.localeCompare(b.id)).map(r => r.id);
}

/* One look of a screen at every width: closed, and with the first row's card open on a sorting table. A desk shows the
   rows as a table. */
async function every(page: Page, info: TestInfo, browserName: string, screen: Screen, language: ShippedLanguage, dir: 'ltr' | 'rtl') {
  const modes: Record<number, boolean> = {};
  for (const width of WIDTHS) {
    const place = `${screen.key} ${language} ${dir} ${width} ${browserName}`;
    await page.setViewportSize({ width, height: HEIGHT(width) });
    await open(page, screen, language, dir === 'rtl' ? 'light' : 'dark', dir);
    await shoot(page, info, `${screen.key}-${language}-${dir}-${width}-${browserName}`);
    modes[width] = await check(page, place);
    if (!screen.card) continue;
    await page.locator('.dt > tbody > tr.rm .rowbtn').first().click();
    await expect(page.locator('.dt > tbody > tr.det')).toHaveCount(1);
    await check(page, `${place} with a card open`);
  }
  await info.attach(`table-or-entries-${screen.key}-${language}-${dir}`, { body: JSON.stringify(modes), contentType: 'application/json' });
  expect(modes[1440], `${screen.key} ${language} ${dir} 1440 stands as a table`).toBe(true);
}

/* Every shipped language, so the longest and the shortest of each screen, left to right; and a right-to-left one once one
   ships, until then the longest laid out mirrored. */
for (const screen of SCREENS) {
  for (const { id } of LANGUAGES) {
    test(`${screen.key}: status plates and row words stay whole, ${id} ltr, at every width`, async ({ page, browserName }, info) => {
      await serve(page);
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await every(page, info, browserName, screen, id, 'ltr');
    });
  }
  test(`${screen.key}: status plates and row words stay whole, right to left, at every width`, async ({ page, browserName }, info) => {
    await serve(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.setViewportSize({ width: 1440, height: 900 });
    const ranked = await rank(page, screen);
    const rtl = LANGUAGES.map(l => l.id).filter(id => RTL.test(id));
    await info.attach('languages', { body: JSON.stringify({ longestFirst: ranked, rtl: rtl.length ? rtl : 'none shipped, the longest mirrored' }), contentType: 'application/json' });
    await every(page, info, browserName, screen, rtl[0] ?? ranked[0]!, 'rtl');
  });
}

/* What the CEO saw on Subscriptions & API at 1280: every plan Ready in its green frame between Owner and Serves, with long
   limit notes beside it, and Ready broke as Read over y. The column now is as wide as the whole word. */
test('Subscriptions & API: Ready stays on one line in its column, en 1280', async ({ page }) => {
  const ready = [SUBS[0]!, { ...SUBS[1]!, status: 'ready' as const, place: COMPANY }, SUBS[2]!];
  await serve(page, ready);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, { ...SCREENS[0]!, rows: ready.length }, 'en', 'dark', 'ltr');
  expect(await asTable(page)).toBe(true);
  await expect(page.locator('.dt > tbody > tr.rm td.k-status .status.ready')).toHaveCount(3);
  for (const status of await statuses(page)) if (status.text === 'Ready') expect(status, 'Ready is one frame on one line').toEqual({ text: 'Ready', frames: 1, lines: 1 });
  for (const cell of await page.locator('.dt > tbody > tr.rm td.k-status').all()) {
    const [frame, box] = await Promise.all([cell.locator('.status').evaluate(el => el.getBoundingClientRect().width), cell.evaluate(el => el.clientWidth)]);
    expect(frame, 'the frame stands inside its cell').toBeLessThanOrEqual(box);
  }
});
