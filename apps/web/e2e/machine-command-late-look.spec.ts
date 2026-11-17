import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { en as t } from '../src/i18n/en';
import type { MachineView, ShownCommand, SubView } from '../src/types';
import { serveRoutes } from './routes-api';

/* The Machines screen looks at the server again every 5 s (REFRESH_MS in Machines.tsx). An answer to a look can reach the
   page after the person cancelled or made a command, though the server read it before: such an answer is older than the
   screen and must change none of its commands. The page runs on a paused clock, so the only look between the steps is
   the one the test makes, and the test lets its answer through itself. */
const NOW = Date.parse('2026-11-17T10:00:00Z');
const REFRESH_MS = 5000;
const HOST = 'first-box';
const command = (id: string, kind: ShownCommand['kind'], machineId?: string): ShownCommand => ({
  id, kind, plans: [], machine: machineId ? HOST : null, ...(machineId ? { machineId } : {}),
  command: `curl -fsSL https://hornhoof.example.test/install.sh | bash -s -- --${id}`, expiresAt: new Date(NOW + 3_600_000).toISOString(),
});
const MACHINE_COMMAND = command('machine1', 'machine');
const ADD_COMMAND = command('add1', 'add', HOST);
const CORE_COMMAND = command('core1', 'core', HOST);
const box = (hostname: string): MachineView => ({
  id: hostname, hostname, owner: { id: 'p1', name: 'Ivan' }, os: 'linux', arch: 'x86_64', online: false,
  lastSeenAt: null, load: null, plans: [], lendsTests: true, running: { agents: [], parts: [] }, needsCore: true,
});
/* A plan of the person's own that the machine does not run yet, so the card offers to add it. */
const PLAN: SubView = {
  id: 'plan-claude', provider: 'claude', kind: 'personal', label: 'Claude', owner: { id: 'p1', name: 'Ivan' },
  status: 'waiting_machine', online: false, machines: [], last4: null, place: { kind: 'company', id: null, name: 'Whole company' },
  limits: null, budget: null, isOrchestrator: false, accounts: [], tier: null, accountsDiffer: false, signedInOnce: false, leaseMachine: null, agents: [],
};

/* The server as the screen meets it: a look gets the commands the server holds when the look reaches it, and a held
   look gets that answer only when the test lets it go. Every other answer is in the page before the held one. */
async function serve(page: Page, commands: ShownCommand[]) {
  const server = { commands, machines: [box(HOST)], hold: false, held: [] as (() => Promise<void>)[], sent: [] as Promise<void>[] };
  const answer = (route: Route, json: unknown, status = 200) => {
    const sent = route.fulfill({ status, json });
    server.sent.push(sent);
    return sent;
  };
  const make = (route: Route, made: ShownCommand) => {
    server.commands = [...server.commands, made];
    return answer(route, made, 201);
  };
  await serveRoutes(page);
  await page.route('**/api/subscriptions', route => answer(route, { subscriptions: [PLAN] }));
  await page.route('**/api/machines', route => answer(route, { machines: server.machines }));
  await page.route('**/api/nodes/commands', route => {
    const json = { commands: server.commands };
    if (!server.hold) return answer(route, json);
    server.held.push(() => answer(route, json));
  });
  await page.route('**/api/nodes/commands/*/hide', route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2);
    server.commands = server.commands.filter(c => c.id !== id);
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/machines/command', route => make(route, MACHINE_COMMAND));
  await page.route(`**/api/machines/${HOST}/plans`, route => make(route, ADD_COMMAND));
  await page.route(`**/api/machines/${HOST}/core`, route => make(route, CORE_COMMAND));
  return server;
}
type Server = Awaited<ReturnType<typeof serve>>;

/* One look of the screen whose answer waits: what the server holds now is what it answers. */
async function startLook(page: Page, server: Server) {
  server.hold = true;
  server.machines = [box(HOST), box('second-box')];
  await page.clock.runFor(REFRESH_MS);
  await expect.poll(() => server.held.length).toBe(1);
}

/* The held answer reaches the page after every other one; the machine only it brings shows that the page took it in. */
async function endLook(page: Page, server: Server) {
  await Promise.all(server.sent);
  await server.held[0]!();
  await expect(page.getByRole('button', { name: t.tables.openCard('second-box'), exact: true })).toBeVisible();
}

const card = (page: Page) => page.getByRole('article', { name: HOST, exact: true });
type Case = {
  name: string;
  commands: ShownCommand[];
  path: string;
  /* The block that shows the command, and its code. */
  block: (page: Page) => Locator;
  /* What the person does before the look, asking the server nothing. */
  before?: (page: Page) => Promise<void>;
  /* What the person does while the look waits, ending once the screen shows it. */
  act: (page: Page, block: Locator) => Promise<void>;
  open: boolean;
};
const panel = (page: Page) => page.locator('.panel').filter({ has: page.locator('.command-box') });
const inCard = (page: Page) => card(page).locator('.add-plan');
const cancel = async (_page: Page, block: Locator) => {
  await block.getByRole('button', { name: t.subs.cancelCommand, exact: true }).click();
  await expect(block).toHaveCount(0);
};
const CASES: Case[] = [
  { name: 'Cancel of the machine command', commands: [MACHINE_COMMAND], path: '/machines', block: panel, act: cancel, open: false },
  { name: 'Cancel of a plan command', commands: [ADD_COMMAND], path: `/machines/${HOST}`, block: inCard, act: cancel, open: false },
  { name: 'Cancel of the core command', commands: [CORE_COMMAND], path: `/machines/${HOST}`, block: inCard, act: cancel, open: false },
  {
    name: 'Connect', commands: [], path: '/machines', block: panel, open: true,
    act: async (page, block) => {
      await page.getByRole('button', { name: t.machines.connect, exact: true }).click();
      await expect(block.locator('code').first()).toHaveText(MACHINE_COMMAND.command);
    },
  },
  {
    name: 'adding a plan', commands: [], path: `/machines/${HOST}`, block: inCard, open: true,
    before: page => card(page).getByRole('button', { name: t.machines.addPlanLabel(HOST), exact: true }).click(),
    act: async (page, block) => {
      await card(page).getByRole('button', { name: t.machines.addPlanTo('Claude', HOST), exact: true }).click();
      await expect(block.locator('code').first()).toHaveText(ADD_COMMAND.command);
    },
  },
  {
    name: 'making the core command', commands: [], path: `/machines/${HOST}`, block: inCard, open: true,
    act: async (page, block) => {
      await card(page).getByRole('button', { name: t.machines.makeCore(HOST), exact: true }).click();
      await expect(block.locator('code').first()).toHaveText(CORE_COMMAND.command);
    },
  },
];

for (const c of CASES) {
  test(`A look that began before ${c.name} leaves the command ${c.open ? 'open' : 'closed'}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.clock.install({ time: NOW - 60_000 });
    const server = await serve(page, c.commands);
    await page.goto(c.path);
    await page.clock.pauseAt(NOW);
    await expect(page.getByRole('button', { name: t.tables.openCard(HOST), exact: true })).toBeVisible();
    const block = c.block(page);
    if (c.commands.length) await expect(block.locator('code').first()).toHaveText(c.commands[0]!.command);
    await c.before?.(page);
    await startLook(page, server);
    await c.act(page, block);
    await endLook(page, server);
    expect(await block.count(), `the command stays ${c.open ? 'open' : 'closed'}`).toBe(c.open ? 1 : 0);
    expect(errors).toEqual([]);
  });
}
