import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ComputerAccessView, MachineView, Org } from '../src/types';
import { LANGUAGES, type ShippedLanguage, type Messages } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { box, ME, serveApi } from './api';

/* The existing card controls keep their geometry with standing access and no approval steps. */
test.describe.configure({ timeout: 0 });

type Look = { lang: ShippedLanguage; theme: 'light' | 'dark'; width: 1440 | 375 };
const messages: Record<ShippedLanguage, Messages> = { en, ru };
const rtl = /^(ar|fa|he|ur)(-|$)/;
const ranked = LANGUAGES.map(({ id }) => {
  const { machines, window } = messages[id];
  const { closed, open, full, closedText, offlineText, forOrchestrator, forTeam, openText, fullText, forTasks, reopen, opening, closing, failed, retry } = machines.computer;
  const words = [machines.access, closed, open, full, closedText, offlineText, forOrchestrator, forTeam, openText, fullText, forTasks, reopen, opening, closing, failed, retry, window.computerMac, window.computerClose];
  return { id, length: words.join('').length };
}).sort((a, b) => a.length - b.length);
const locales = [...new Set([ranked[0]!.id, ranked.at(-1)!.id, ...LANGUAGES.filter(({ id }) => rtl.test(id)).map(({ id }) => id)])];
const LOOKS: Look[] = locales.flatMap(lang => (['light', 'dark'] as const).flatMap(theme => ([1440, 375] as const).map(width => ({ lang, theme, width }))));
const named = ({ lang, theme, width }: Look) => `${lang} ${theme} ${width}`;
const GIB = 1024 ** 3;

const IVAN = { id: 'p1', name: 'Ivan' };
const ANNA = { id: 'p2', name: 'Anna' };
type View = ComputerAccessView;
const access = (id: string, hostname: string, owner: { id: string }, over: Partial<View> = {}): View => ({
  machine: { id, networkId: `n-${id}`, name: hostname, hostname, personId: owner.id, role: 'worker', os: 'linux', data: false },
  reachable: true, open: true, scope: 'orchestrator', employees: [], canOpen: owner.id === IVAN.id, canClose: owner.id === IVAN.id,
  ...over,
});

const machine = (id: string, hostname: string, owner: { id: string; name: string }, over: Partial<MachineView> = {}): MachineView => ({
  id, hostname, os: 'linux', arch: 'x86_64', owner, online: true, lastSeenAt: null, plans: [],
  load: { cpus: 8, load: 1, memFree: 10 * GIB, memTotal: 16 * GIB, jobs: 0, tests: 0, cpuModel: 'AMD EPYC', diskFree: 200 * GIB, diskTotal: 500 * GIB },
  lendsTests: true, running: { agents: [], parts: [] }, programs: [], keepsBackups: false, heldBackups: 0, ...over,
} as MachineView);

const LONG = 'build-server-eu-west-01.internal';
function startViews(): Record<string, View> {
  const mac = access('m3', 'studio-mac', IVAN, { scope: 'all_agents' });
  return {
    m1: access('m1', 'build-host', IVAN),
    m2: access('m2', 'build-node', ANNA, { open: false, scope: null }),
    m3: { ...mac, machine: { ...mac.machine, os: 'darwin' } },
    m4: access('m4', LONG, IVAN, { reachable: false, employees: [{ employeeId: 'a1', taskId: 't1' }] }),
  };
}
const HOSTS: Record<string, [string, { id: string; name: string }, Partial<MachineView>]> = {
  m1: ['build-host', IVAN, {}], m2: ['build-node', ANNA, {}], m3: ['studio-mac', IVAN, { os: 'darwin', arch: 'arm64' }], m4: [LONG, IVAN, { online: false }],
};

type Sent = { path: string; body: unknown };

async function openMachines(page: Page, look: Look, id: string) {
  await page.setViewportSize({ width: look.width, height: look.width === 375 ? 2400 : 1400 });
  await serveApi(page);
  await page.addInitScript(({ lang, theme, dir }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
    if (dir === 'rtl') document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = 'rtl'; });
  }, { ...look, dir: rtl.test(look.lang) ? 'rtl' : 'ltr' });
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
  await page.route(/\/api\/machines\/[^/]+\/access\/(open|close)$/, route => {
    const path = new URL(route.request().url()).pathname;
    const [, , , key, , action] = path.split('/');
    sent.push({ path, body: route.request().postData() });
    const open = action === 'open';
    views[key!] = { ...views[key!]!, open, scope: open ? 'orchestrator' : null, employees: [] };
    return route.fulfill({ json: views[key!] });
  });
  await page.goto(`/machines/${id}`);
  await page.evaluate(async () => { await document.fonts.ready; });
  const card = page.getByRole('article', { name: HOSTS[id]![0], exact: true });
  await expect(card).toBeVisible();
  return { card, sent, errors, t: messages[look.lang] };
}

const blockOf = (card: Locator, t: Messages) => card.getByRole('region', { name: t.machines.access, exact: true });
/* A picture of the card for Design, by the state it shows. */
const snap = (card: Locator, name: string) => card.screenshot({ path: test.info().outputPath(`${name}.png`), animations: 'disabled' });

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
  test(`the owner closes and reopens standing access after confirming: ${named(look)}`, async ({ page }) => {
    const { card, sent, errors, t } = await openMachines(page, look, 'm1');
    const block = blockOf(card, t);
    const c = t.machines.computer;
    await expect(block.getByText(c.open, { exact: true })).toBeVisible();
    await expectFits(page, card, block, look.width);
    await snap(card, 'open');
    await block.getByRole('button', { name: t.window.computerClose, exact: true }).click();
    await page.getByRole('alertdialog', { name: t.machines.confirm.closeAccess.title }).getByRole('button', { name: t.machines.confirm.closeAccess.yes, exact: true }).click();
    await expect(block.getByText(c.closedText, { exact: true })).toBeVisible();
    await expectFits(page, card, block, look.width);
    await snap(card, 'closed');
    await block.getByRole('button', { name: c.reopen, exact: true }).click();
    await page.getByRole('alertdialog', { name: t.machines.confirm.openAccess.title }).getByRole('button', { name: t.machines.confirm.openAccess.yes, exact: true }).click();
    await expect(block.getByText(c.forOrchestrator, { exact: true })).toBeVisible();
    expect(sent).toEqual([{ path: '/api/machines/m1/access/close', body: null }, { path: '/api/machines/m1/access/open', body: null }]);
    await expect(block.getByLabel(t.common.password)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test(`the card shows delegations and lets the owner close access while offline: ${named(look)}`, async ({ page }) => {
    const { card, sent, errors, t } = await openMachines(page, look, 'm4');
    const c = t.machines.computer;
    const block = blockOf(card, t);
    await expect(block.getByText(c.offlineText, { exact: true })).toBeVisible();
    await expect(block.getByText(c.forTasks, { exact: true })).toBeVisible();
    await expectFits(page, card, block, look.width);
    await snap(card, 'offline');
    await expect(block.getByRole('button', { name: t.window.computerClose, exact: true })).toBeVisible();
    for (const [id, status] of [['m2', c.closed], ['m3', c.full]] as const) {
      const host = HOSTS[id]![0];
      await page.getByRole('button', { name: t.tables.openCard(host), exact: true }).click();
      const other = page.getByRole('article', { name: host, exact: true });
      const access = blockOf(other, t);
      await expect(access.getByText(status, { exact: true })).toBeVisible();
      await expectFits(page, other, access, look.width);
      if (id === 'm2') await expect(access.getByRole('button')).toHaveCount(0);
    }
    expect(sent).toEqual([]);
    expect(errors).toEqual([]);
  });
}
