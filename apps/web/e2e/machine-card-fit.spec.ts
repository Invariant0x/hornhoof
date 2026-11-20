import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { Language, Messages } from '../src/i18n';
import type { BuiltinView, MachineView, Org, ShownCommand, SubView } from '../src/types';
import { ME, serveApi, serveOwnerKey } from './api';

/* The open card on Machines of a computer that joined before machines had the
   company's core. Its button Make ... a full machine of the company ran past the card's right edge at 32 px, and the
   command it showed widened the table until the whole table stood as entries under Sort by. Its buttons now stay inside
   the card at a touch's height, the command wraps inside the card, and the table stays a table before and after; at the
   width of a phone the table stands as entries as before, its buttons inside the card. */
test.describe.configure({ timeout: 0 });

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const GIB = 1024 ** 3;
const HOST = 'workstation.local';
const OWNER = { id: ME.person.id, name: 'Ivan Korol' };
const COMPANY = { kind: 'company' as const, id: null, name: 'Whole company' };
const machine = (id: string, hostname: string, over: Partial<MachineView> = {}): MachineView => ({
  id, hostname, os: 'darwin', arch: 'arm64', owner: OWNER, online: true, lastSeenAt: null, plans: [],
  load: { cpus: 10, load: 1, memFree: 10 * GIB, memTotal: 12 * GIB, jobs: 0, tests: 0, cpuModel: 'Apple M2 Pro', diskFree: 200 * GIB, diskTotal: 500 * GIB },
  lendsTests: false, running: { agents: [], parts: [] }, ...over,
});
const MACHINES: MachineView[] = [
  machine('m1', 'build-host', { os: 'linux', arch: 'x86_64', lendsTests: true, plans: [{ id: 's1', provider: 'claude', status: 'ready', online: true }] }),
  machine('m2', HOST, { needsCore: true, plans: [{ id: 's2', provider: 'codex', status: 'ready', online: true }] }),
  machine('m3', 'build-box', { owner: { id: 'p2', name: 'Olga' }, os: 'linux', arch: 'x86_64' }),
];
const BUILTIN: BuiltinView = { online: true, load: null, running: { agents: [], parts: [] }, machine: { id: 'm1', hostname: 'build-host' } };
/* A plan of his on another machine, so the card offers Add my plan beside the long button. */
const SUBS: SubView[] = [{
  id: 's1', provider: 'claude', kind: 'personal', label: 'Claude', status: 'ready', online: true, last4: null, owner: OWNER, place: COMPANY,
  machines: [{ id: 'm1', hostname: 'build-host', status: 'ready', online: true }], limits: null, limitsUpdatedAt: null, budget: null,
  isOrchestrator: false, accounts: [], tier: 'Max', accountsDiffer: false, signedInOnce: true, leaseMachine: null, agents: [],
}];
/* The command the server gives for the core: it joins the machine, so the screen shows it with the owner's key. */
const CORE = 'curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join DEMO_ONLY_CORE_JOIN_TOKEN_OF_A_LONG_KIND';
const CORE_SHOWN: ShownCommand = { id: 'c1', kind: 'core', plans: [], machineId: 'm2', machine: HOST, command: CORE, expiresAt: new Date(NOW + 3600_000).toISOString() };

async function messagesFor(language: Language): Promise<Messages> {
  const dictionary = await import(`../src/i18n/${language}.ts`) as Record<string, Messages>;
  return dictionary[language]!;
}

async function openMachines(page: Page, language: Language, skin: 'cyberpunk' | 'light', dir: 'ltr' | 'rtl'): Promise<Messages> {
  const t = await messagesFor(language);
  await page.clock.install({ time: NOW });
  await serveApi(page);
  await serveOwnerKey(page);
  const org: Org = { company: ME.company, orchestrator: null, agents: { total: 0, working: 0 }, people: [], departments: [] };
  const only = (path: string) => (url: URL) => url.pathname === path;
  await page.route(only('/api/org'), route => route.fulfill({ json: org }));
  await page.route(only('/api/subscriptions'), route => route.fulfill({ json: { subscriptions: SUBS } }));
  await page.route(only('/api/machines'), route => route.fulfill({ json: { machines: MACHINES, builtin: BUILTIN, priority: false, move: null, canMove: false, copies: null } }));
  /* Once made, the command is among the shown ones the screen reloads, as the server keeps it. */
  let made = false;
  await page.route(only('/api/machines/m2/core'), route => { made = true; return route.fulfill({ json: CORE_SHOWN }); });
  await page.route(only('/api/nodes/commands'), route => route.fulfill({ json: { commands: made ? [CORE_SHOWN] : [] } }));
  await page.route(only('/api/machines/access'), route => route.fulfill({ json: { views: [] } }));
  await page.addInitScript(({ language, skin }) => { localStorage.setItem('hh-lang', language); localStorage.setItem('hh-theme', skin); }, { language, skin });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(direction => { document.documentElement.dir = direction; }, dir);
  await page.getByRole('navigation').getByRole('button', { name: t.shell.tabs.machines, exact: true }).click();
  await expect(page.locator('.dt > tbody > tr.rm')).toHaveCount(MACHINES.length);
  await page.evaluate(() => document.fonts.ready);
  return t;
}

/* The table as it stands: as a table or as entries, with its head shown, and whether it needs more than its frame. */
const tableState = (page: Page) => page.locator('table.dt').evaluate(table => {
  const host = table.parentElement!;
  const head = table.querySelector('thead')!;
  return {
    fit: (table as HTMLElement).dataset.fit ?? null,
    table: getComputedStyle(table).display === 'table',
    head: getComputedStyle(head).display !== 'none' && head.getBoundingClientRect().height > 0,
    fits: table.scrollWidth <= host.clientWidth + 0.5,
  };
});

/* How far the element stands past the card on either side, in px, and its height. */
const placeIn = async (card: Locator, element: Locator) => element.evaluate((el, frame) => {
  const [a, b] = [el.getBoundingClientRect(), frame!.getBoundingClientRect()];
  return { past: Math.max(0, b.left - a.left, a.right - b.right), height: a.height };
}, await card.elementHandle());

async function expectTable(page: Page, place: string) {
  expect(await tableState(page), place).toEqual({ fit: null, table: true, head: true, fits: true });
}

async function expectInside(card: Locator, element: Locator, place: string, tall = false) {
  const { past, height } = await placeIn(card, element);
  expect(past, `${place}: past the card`).toBeLessThanOrEqual(0.5);
  if (tall) expect(height, `${place}: height`).toBeGreaterThanOrEqual(44);
}

/* The card is open, the long button shown and pressed, the command shown. before: what is done with the card before the
   button is pressed. */
async function makeCore(page: Page, t: Messages, wide: boolean, before?: (card: Locator) => Promise<unknown>) {
  const card = page.getByRole('article', { name: HOST });
  const button = card.getByRole('button', { name: t.machines.makeCore(HOST), exact: true });
  const where = wide ? 'desk' : 'phone';
  await page.getByRole('button', { name: t.tables.openCard(HOST), exact: true }).click();
  await expect(button).toBeVisible();
  if (wide) await expectTable(page, `${where}: card open`);
  for (const act of await card.locator('.machine-actions .act').all()) await expectInside(card, act, `${where}: ${await act.innerText()}`, true);
  await before?.(card);
  await button.click();
  const command = card.locator('.add-plan');
  await expect(command.locator('code').first()).toContainText('--owner-key');
  /* The command's own font comes only once a command is shown. */
  await page.evaluate(() => document.fonts.ready);
  if (wide) await expectTable(page, `${where}: command shown`);
  await expectInside(card, command, `${where}: command`);
  for (const code of await command.locator('code').all()) await expectInside(card, code, `${where}: command line`);
  return card;
}

test('at the width of a desk the open card keeps its buttons and its command inside, and the table stays a table', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const t = await openMachines(page, 'en', 'cyberpunk', 'ltr');
  await expectTable(page, 'desk: closed');
  await makeCore(page, t, true);
  await page.getByRole('button', { name: t.tables.openCard(HOST), exact: true }).click();
  await expect(page.getByRole('article', { name: HOST })).toHaveCount(0);
  await expectTable(page, 'desk: card closed again');
});

test('at the width of a phone the table stands as entries and the open card keeps its buttons and its command inside', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 2600 });
  const t = await openMachines(page, 'en', 'cyberpunk', 'ltr');
  expect((await tableState(page)).table).toBe(false);
  await makeCore(page, t, false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

/* The pictures for Design, only when asked for: HH_CARD_SHOTS=1. */
const LOOKS = [['en', 'cyberpunk', 'ltr'], ['ru', 'cyberpunk', 'ltr'], ['en', 'light', 'ltr'], ['ru', 'light', 'ltr'], ['ru', 'cyberpunk', 'rtl'], ['en', 'light', 'rtl']] as const;
for (const width of [1440, 375]) {
  for (const [language, skin, dir] of LOOKS) {
    test(`pictures of the open card at ${width} px, ${language} ${skin} ${dir}`, async ({ page, browserName }, info: TestInfo) => {
      test.skip(!process.env.HH_CARD_SHOTS, 'pictures only when asked for');
      await page.setViewportSize({ width, height: width < 600 ? 2600 : 1600 });
      const t = await openMachines(page, language, skin, dir);
      const name = `${width}-${language}-${skin}-${dir}-${browserName}`;
      const card = await makeCore(page, t, width > 600, card => card.screenshot({ path: info.outputPath(`machine-card-button-${name}.png`), animations: 'disabled' }));
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`machine-card-command-${name}.png`), fullPage: true, animations: 'disabled' });
    });
  }
}
