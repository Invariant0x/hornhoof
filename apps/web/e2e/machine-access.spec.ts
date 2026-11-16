import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ComputerAccessView, MachineView, Org } from '../src/types';
import { box, ME, serveApi, serveOwnerKey } from './api';

/* Computer access in each machine's card in Machines (#1115, Design #1102, sketch B with A's request state). A card says
   whether access is closed, open to the orchestrator until a time, open in full to every agent of the company until a
   time, asked for by the orchestrator, or out of reach while the machine is offline, and who opened it. Its owner opens
   it after choosing for how long (1 hour by default, 8 hours, a day) and for whom; full access to every agent asks once
   more first. Closing is one press, without a question. The server keeps each machine's access as the server of #1119
   would, so every press is checked by what it sends. */

test.describe.configure({ timeout: 180_000 });

type Look = { lang: 'en' | 'ru'; dir: 'ltr' | 'rtl'; theme: 'light' | 'dark'; width: 1440 | 375 };
const LOOKS: Look[] = (['en', 'ru'] as const).flatMap(lang =>
  (['ltr', 'rtl'] as const).flatMap(dir => (['light', 'dark'] as const).flatMap(theme => ([1440, 375] as const).map(width => ({ lang, dir, theme, width })))),
);
const named = ({ lang, dir, theme, width }: Look) => `${lang} ${dir} ${theme} ${width}`;

const NOW = Date.parse('2026-11-16T11:38:00.000Z');
const HOUR = 3_600_000;
const GIB = 1024 ** 3;
const REASON = 'Install Docker and open port 8080 to check the build.';

/* Design's words (strings-ru-en.csv of #1102), as a person reads them. */
const WORDS = {
  en: {
    machines: 'Machines', block: 'Computer access', closed: 'Access closed', open: 'Access open', full: 'Full access for the team', asks: 'Asks for access',
    forOrchestrator: 'For the orchestrator', forTeam: 'Every company agent', openedBy: 'Opened by: Ivan', until: /^Until /,
    choose: 'Open access', close: 'Close access', who: 'Who gets access?', duration: 'Access duration', hour: '1 hour', hours: '8 hours', day: '1 day',
    orchestrator: 'Orchestrator', team: 'Every company agent', cancel: 'Cancel', confirm: 'Open full access for the whole team?', fullButton: 'Open full access',
    openHour: 'Open for 1 hour', notNow: 'Not now', offline: 'The machine is not responding. Access can be opened when it is online.', owner: "Decided by the machine's owner alone.",
  },
  ru: {
    machines: 'Машины', block: 'Доступ к компьютерам', closed: 'Доступ закрыт', open: 'Доступ открыт', full: 'Полный доступ для команды', asks: 'Просит доступ',
    forOrchestrator: 'Для оркестратора', forTeam: 'Все агенты компании', openedBy: 'Открыл: Ivan', until: /^До /,
    choose: 'Открыть доступ', close: 'Закрыть доступ', who: 'Кому открыть доступ?', duration: 'Срок доступа', hour: '1 ч', hours: '8 ч', day: 'Сутки',
    orchestrator: 'Оркестратору', team: 'Всем агентам компании', cancel: 'Отмена', confirm: 'Открыть полный доступ всей команде?', fullButton: 'Открыть полный доступ',
    openHour: 'Открыть на 1 ч', notNow: 'Не сейчас', offline: 'Машина не отвечает. Доступ можно открыть, когда она появится в сети.', owner: 'Решение принимает только владелец машины.',
  },
};

const IVAN = { id: 'p1', name: 'Ivan' };
const ANNA = { id: 'p2', name: 'Anna' };
type Scope = 'orchestrator' | 'all_agents';
/* Access as #1119's server shows it: who it is open to, until when and who opened it. */
type View = ComputerAccessView & { scope: Scope | null; openedBy: { id: string; name: string } | null; openedAt: string | null };

const access = (id: string, hostname: string, owner: { id: string }, over: Partial<View> = {}): View => ({
  machine: { id, networkId: `n-${id}`, name: hostname, hostname, personId: owner.id, role: 'worker', os: 'linux', data: false },
  reachable: true, until: null, asked: null, canOpen: owner.id === IVAN.id, canClose: true, key: 'not_needed', scope: null, openedBy: null, openedAt: null,
  ...over,
});
const opened = (scope: Scope, hours: number, by = IVAN): Partial<View> => ({ scope, until: new Date(NOW + hours * HOUR).toISOString(), openedBy: by, openedAt: new Date(NOW).toISOString() });

const machine = (id: string, hostname: string, owner: { id: string; name: string }, over: Partial<MachineView> = {}): MachineView => ({
  id, hostname, os: 'linux', arch: 'x86_64', owner, online: true, lastSeenAt: null, plans: [],
  load: { cpus: 8, load: 1, memFree: 10 * GIB, memTotal: 16 * GIB, jobs: 0, tests: 0, cpuModel: 'AMD EPYC', diskFree: 200 * GIB, diskTotal: 500 * GIB },
  lendsTests: true, running: { agents: [], parts: [] }, programs: [], keepsBackups: false, heldBackups: 0, ...over,
} as MachineView);

/* a-host is closed and Ivan's; build-node is Anna's and open to the orchestrator by her; studio-mac is open in full;
   test-node is offline; the build server is asked for. */
const LONG = 'build-server-eu-west-01.internal';
function startViews(): Record<string, View> {
  return {
    m1: access('m1', 'a-host', IVAN),
    m2: access('m2', 'build-node', ANNA, opened('orchestrator', 1, ANNA)),
    m3: { ...access('m3', 'studio-mac', IVAN, opened('all_agents', 8)), machine: { ...access('m3', 'studio-mac', IVAN).machine, os: 'darwin' } },
    m4: access('m4', 'test-node', IVAN, { reachable: false }),
    m5: access('m5', LONG, IVAN, { asked: { reason: REASON, at: new Date(NOW - 10 * 60_000).toISOString() } }),
  };
}
const HOSTS: Record<string, [string, { id: string; name: string }, Partial<MachineView>]> = {
  m1: ['a-host', IVAN, {}], m2: ['build-node', ANNA, {}], m3: ['studio-mac', IVAN, { os: 'darwin', arch: 'arm64' }], m4: ['test-node', IVAN, { online: false }], m5: [LONG, IVAN, {}],
};

type Sent = { path: string; body: unknown };

async function openMachines(page: Page, look: Look, id: string) {
  await page.setViewportSize({ width: look.width, height: look.width === 375 ? 2400 : 1400 });
  await page.clock.install({ time: NOW });
  await serveApi(page);
  await serveOwnerKey(page);
  await page.addInitScript(({ lang, theme, dir }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
    if (dir === 'rtl') document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = 'rtl'; });
  }, look);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const views = startViews();
  const sent: Sent[] = [];
  const org: Org = { company: ME.company, orchestrator: null, agents: { total: 0, working: 0 }, people: [], departments: [] };
  await page.route('**/api/org', route => route.fulfill({ json: org }));
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [] } }));
  await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/machines/*/connections', route => route.fulfill({ json: { summary: { drops: 0, averageMs: null, cause: null }, events: [] } }));
  await page.route('**/api/machines', route => route.fulfill({ json: {
    machines: Object.entries(HOSTS).map(([key, [hostname, owner, over]]) => machine(key, hostname, owner, { ...over, access: views[key] })),
    builtin: null, priority: false, move: null, canMove: false, copies: null,
  } }));
  await page.route('**/api/machines/access', route => route.fulfill({ json: { views: Object.values(views) } }));
  await page.route(/\/api\/machines\/[^/]+\/access\/(open|close|decline)$/, route => {
    const path = new URL(route.request().url()).pathname;
    const [, , , key, , action] = path.split('/');
    const body = route.request().postDataJSON() as { scope?: Scope; hours?: number } | null;
    sent.push({ path, body });
    const now = views[key!]!;
    views[key!] = action === 'open'
      ? { ...now, asked: null, ...opened(body?.scope ?? 'orchestrator', body?.hours ?? 24) }
      : { ...now, asked: null, until: action === 'close' ? null : now.until, scope: action === 'close' ? null : now.scope, openedBy: action === 'close' ? null : now.openedBy, canOpen: now.machine.personId === IVAN.id };
    return route.fulfill({ json: views[key!] });
  });
  await page.goto(`/machines/${id}`);
  await page.evaluate(async () => { await document.fonts.ready; });
  const card = page.getByRole('article', { name: HOSTS[id]![0], exact: true });
  await expect(card).toBeVisible();
  return { card, sent, errors, words: WORDS[look.lang], views };
}

const blockOf = (card: Locator, words: (typeof WORDS)['en']) => card.getByRole('region', { name: words.block, exact: true });

/* The block inside its card and the screen, every button at least 44 px, no word cut. */
async function expectFits(page: Page, card: Locator, block: Locator, width: number) {
  const [outer, inner] = [await box(card), await box(block)];
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - 0.5);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
  for (const button of await block.getByRole('button').all()) {
    const b = await box(button);
    expect(Math.round(b.height), await button.innerText()).toBeGreaterThanOrEqual(44);
    expect(Math.round(b.width), await button.innerText()).toBeGreaterThanOrEqual(44);
  }
  expect(await block.evaluate(root => [...root.querySelectorAll('*')].filter(el => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible').length)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

for (const look of LOOKS) {
  test(`opens a machine to the orchestrator for the hour it chose, and closes it in one press: ${named(look)}`, async ({ page }) => {
    const { card, sent, errors, words } = await openMachines(page, look, 'm1');
    const block = blockOf(card, words);
    await expect(block.getByText(words.closed, { exact: true })).toBeVisible();
    await expectFits(page, card, block, look.width);
    await block.getByRole('button', { name: words.choose, exact: true }).click();
    await expect(block.getByText(words.who, { exact: true })).toBeVisible();
    /* One hour is chosen until another is pressed. */
    const durations = block.getByRole('group', { name: words.duration });
    await expect(durations.getByRole('button', { name: words.hour, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(durations.getByRole('button', { name: words.hours, exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expectFits(page, card, block, look.width);
    await block.getByRole('button', { name: words.orchestrator, exact: true }).click();
    await expect(block.getByText(words.open, { exact: true })).toBeVisible();
    await expect(block.getByText(words.forOrchestrator, { exact: true })).toBeVisible();
    await expect(block.getByText(words.until)).toBeVisible();
    await expect(block.getByText(words.openedBy, { exact: true })).toBeVisible();
    expect(sent).toEqual([{ path: '/api/machines/m1/access/open', body: { scope: 'orchestrator', hours: 1 } }]);
    await expectFits(page, card, block, look.width);
    /* Closing asks nothing. */
    await block.getByRole('button', { name: words.close, exact: true }).click();
    await expect(block.getByText(words.closed, { exact: true })).toBeVisible();
    expect(sent.map(one => one.path)).toEqual(['/api/machines/m1/access/open', '/api/machines/m1/access/close']);
    if (look.dir === 'rtl') expect(await block.evaluate(el => getComputedStyle(el).direction)).toBe('rtl');
    expect(errors).toEqual([]);
  });

  test(`opens full access to every agent only after asking once more, and Cancel opens nothing: ${named(look)}`, async ({ page }) => {
    const { card, sent, errors, words } = await openMachines(page, look, 'm1');
    const block = blockOf(card, words);
    const choose = block.getByRole('button', { name: words.choose, exact: true });
    await choose.click();
    await block.getByRole('group', { name: words.duration }).getByRole('button', { name: words.hours, exact: true }).click();
    await block.getByRole('button', { name: words.team, exact: true }).click();
    await expect(block.getByText(words.confirm, { exact: true })).toBeVisible();
    await expectFits(page, card, block, look.width);
    expect(sent).toEqual([]);
    await block.getByRole('button', { name: words.cancel, exact: true }).click();
    await expect(block.getByText(words.confirm, { exact: true })).toHaveCount(0);
    await expect(choose).toBeFocused();
    expect(sent).toEqual([]);
    await choose.click();
    await block.getByRole('group', { name: words.duration }).getByRole('button', { name: words.hours, exact: true }).click();
    await block.getByRole('button', { name: words.team, exact: true }).click();
    await block.getByRole('button', { name: words.fullButton, exact: true }).click();
    await expect(block.getByText(words.full, { exact: true })).toBeVisible();
    await expect(block.getByText(words.forTeam, { exact: true })).toBeVisible();
    expect(sent).toEqual([{ path: '/api/machines/m1/access/open', body: { scope: 'all_agents', hours: 8, confirm: true } }]);
    expect(errors).toEqual([]);
  });

  test(`says each state of access, and who may act on it: ${named(look)}`, async ({ page }) => {
    const { card, sent, errors, words } = await openMachines(page, look, 'm5');
    /* Asked for: the reason, the hour and the answers. */
    const asked = blockOf(card, words);
    await expect(asked.getByText(words.asks, { exact: true })).toBeVisible();
    await expect(asked.getByText(REASON)).toBeVisible();
    await expectFits(page, card, asked, look.width);
    await asked.getByRole('button', { name: words.notNow, exact: true }).click();
    await expect(asked.getByText(words.asks, { exact: true })).toHaveCount(0);
    expect(sent.map(one => one.path)).toEqual(['/api/machines/m5/access/decline']);
    /* Anna's machine, open to the orchestrator by her: the CEO closes it but does not open it. */
    await page.goto('/machines/m2');
    const anna = blockOf(page.getByRole('article', { name: 'build-node', exact: true }), words);
    await expect(anna.getByText(words.open, { exact: true })).toBeVisible();
    await expect(anna.getByText(words.openedBy.replace('Ivan', 'Anna'), { exact: true })).toBeVisible();
    await expect(anna.getByRole('button', { name: words.close, exact: true })).toBeVisible();
    await expect(anna.getByRole('button', { name: words.choose, exact: true })).toHaveCount(0);
    /* Full access on the Mac. */
    await page.goto('/machines/m3');
    const mac = blockOf(page.getByRole('article', { name: 'studio-mac', exact: true }), words);
    await expect(mac.getByText(words.full, { exact: true })).toBeVisible();
    await expect(mac.getByText(words.forTeam, { exact: true })).toBeVisible();
    /* Offline: nothing to open. */
    await page.goto('/machines/m4');
    const away = blockOf(page.getByRole('article', { name: 'test-node', exact: true }), words);
    await expect(away.getByText(words.offline, { exact: true })).toBeVisible();
    await expect(away.getByRole('button')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
