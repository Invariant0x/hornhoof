import { expect, test, type Page } from '@playwright/test';
import type { BuiltinView, MachineView, Org } from '../src/types';
import { ME, serveApi } from './api';

/* The company moved its server to another machine. The machine it was installed on first can now be removed like any
   joined machine: the question names what is at risk before the yes, Cancel keeps the machine, and a yes takes it off the
   list. The machine that leads offers no removal at all. Every answer of the server is the test's own. */

const LEADER = 'new-leader';
const FORMER = 'former-build-server';
const IDLE = { agents: [], parts: [] };
const machine = (id: string, hostname: string, extra: Partial<MachineView>): MachineView => ({
  id, hostname, os: 'linux', arch: 'x86_64', owner: { id: ME.id, name: ME.name }, online: true, lastSeenAt: null, plans: [], load: null,
  lendsTests: true, running: IDLE, drain: null, ...extra,
});
const LEAD = machine('m-lead', LEADER, {});
const OLD = machine('m-old', FORMER, { serverInstall: true, online: false, lastSeenAt: '2026-11-20T20:53:00.000Z' });
const BUILTIN: BuiltinView = { online: true, load: null, running: IDLE, machine: { id: LEAD.id, hostname: LEADER } };
/* The last copy of the company's data besides the leader, and no report of the agents' working copies on it. */
const RISKS = { lastReplica: true, onlyBackup: false, uncollectedData: false };

async function openMachines(page: Page) {
  const state = { listed: [LEAD, OLD], removed: [] as string[], asked: [] as string[] };
  await serveApi(page);
  await page.addInitScript(() => {
    localStorage.setItem('hh-lang', 'en');
    localStorage.setItem('hh-theme', 'light');
  });
  const org: Org = { company: ME.company, orchestrator: null, agents: { total: 0, working: 0 }, people: [], departments: [] };
  await page.route('**/api/org', route => route.fulfill({ json: org }));
  await page.route('**/api/machines', route => route.fulfill({ json: { machines: state.listed, builtin: BUILTIN } }));
  await page.route('**/api/machines/*/removal', route => {
    state.asked.push(new URL(route.request().url()).pathname.split('/')[3]);
    return route.fulfill({ json: RISKS });
  });
  await page.route('**/api/machines/*/disconnect', route => {
    const id = new URL(route.request().url()).pathname.split('/')[3];
    state.removed.push(id);
    state.listed = state.listed.filter(m => m.id !== id);
    return route.fulfill({ status: 204, body: '' });
  });
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [] } }));
  await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/machines/access', route => route.fulfill({ json: { views: [] } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Machines', exact: true }).click();
  return state;
}

const open = (page: Page, host: string) => page.getByRole('button', { name: `Open the card of ${host}`, exact: true });

test('removes a former server only after showing the risks and getting a yes', async ({ page }) => {
  const state = await openMachines(page);
  await open(page, FORMER).click();
  const remove = page.getByRole('button', { name: `Remove ${FORMER}`, exact: true });
  await expect(remove).toBeVisible();

  await remove.click();
  const ask = page.getByRole('alertdialog');
  await expect(ask).toBeVisible();
  await expect(ask.getByText(`Remove ${FORMER} from the company?`)).toBeVisible();
  await expect(ask.getByText('It keeps the only copy of the company’s data apart from the leader.', { exact: false })).toBeVisible();
  await expect(ask.getByText('Agents’ working copies on it may hold changes not committed or pushed.', { exact: false })).toBeVisible();
  expect(state.asked).toEqual([OLD.id]);
  await ask.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(ask).toBeHidden();
  expect(state.removed).toEqual([]);
  await expect(open(page, FORMER)).toBeVisible();

  await remove.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeHidden();
  expect(state.removed).toEqual([OLD.id]);
  await expect(open(page, FORMER)).toHaveCount(0);
  await expect(open(page, LEADER)).toBeVisible();
});

test('offers no removal of the machine that leads', async ({ page }) => {
  await openMachines(page);
  await open(page, LEADER).click();
  await expect(page.getByRole('article', { name: LEADER })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(`^(Remove|Disconnect) ${LEADER}$`) })).toHaveCount(0);
});
