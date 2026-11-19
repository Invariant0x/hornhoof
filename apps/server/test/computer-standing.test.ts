import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { expect, it, onTestFinished, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agentInbox, agents, companies, computerRuns, jobs, machines, people, subscriptions, tasks } from '../src/db/schema.js';
import { ComputerCarrier } from '../src/modules/keeper/computer.js';
import { keyPrint } from '../src/modules/computer/owner-key.js';
import { VIA } from '../src/modules/network/via.js';
import { companyRows, SERVER_MACHINE_ENV, testComputers } from './helpers-computer.js';
import { prepareSharedDatabase } from './helpers-db.js';
import { as, invitePerson, listen, mcp, setUpCompany, testApp } from './helpers.js';

await prepareSharedDatabase();

async function company() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-18T12:00:00Z'));
  onTestFinished(() => { vi.useRealTimers(); });
  const { app, db } = await testApp({ ...SERVER_MACHINE_ENV, TUNNEL_HOST: 'localhost' });
  const { ceo, owner, machine, orch, worker, other, task, plan, publicKey } = await companyRows(app, 'standing computer access', async () => {
    const ceo = await setUpCompany(app);
    const owner = await invitePerson(app, ceo, { name: 'Machine owner', email: 'machine-owner@example.test', access: { whole: true } });
    const [person] = await db.select().from(people).where(eq(people.email, 'machine-owner@example.test'));
    const [company] = await db.select().from(companies);
    const [plan] = await db.select().from(subscriptions);
    const [orch] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const hire = async (name: string) => (await db.insert(agents).values({ companyId: company!.id, subscriptionId: plan!.id, kind: 'worker', name, roleKey: 'DEV-BE', model: '' }).returning())[0]!;
    const worker = await hire('Worker');
    const other = await hire('Other worker');
    const [task] = await db.insert(tasks).values({ companyId: company!.id, number: 1, title: 'Check the sample', assigneeAgentId: worker.id }).returning();
    const publicKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const [machine] = await db.insert(machines).values({ companyId: company!.id, personId: person!.id, machineKey: 'remote-001', networkId: 'c'.repeat(64), hostname: 'sample-host', role: 'worker', ownerPin: keyPrint(publicKey) }).returning();
    return { ceo, owner, machine: machine!, orch: orch!, worker, other, task: task!, plan: plan!, publicKey };
  });
  testComputers(app, { waitMs: 0 });
  await listen(app);
  const keeper = { remoteAddress: '127.0.0.1', headers: { [VIA]: machine.id, 'x-hornhoof-keeper': '1' } };
  const take = (query = 'standing=1&updater=1') => app.inject({ url: `/api/network/computer?${query}`, ...keeper });
  const run = async (agent = orch, taskId?: string, inbox = false) => {
    const token = `standing-computer-${agent.id}-${taskId ?? 'conversation'}-${inbox}`;
    const [job] = await db.insert(jobs).values({ companyId: machine.companyId, agentId: agent.id, subscriptionId: plan.id, kind: 'conversation', status: 'running', prompt: 'Check a recorded sample.', timeoutMs: 1000, taskId: inbox ? null : taskId, inboxWake: inbox, toolTokenHash: hashToken(token) }).returning();
    if (inbox) await db.insert(agentInbox).values({ companyId: machine.companyId, agentId: agent.id, jobId: job!.id, taskId, status: 'read', kind: 'notification', senderKind: 'agent', senderAgentId: orch.id, senderName: orch.name, text: 'Check the recorded sample.' });
    return mcp(app, token);
  };
  const change = (action: 'open' | 'close', token = owner) => app.inject({ method: 'POST', url: `/api/machines/${machine.id}/access/${action}`, ...as(token) });
  return { app, db, ceo, owner, machine, worker, other, task, keeper, take, run, change, publicKey };
}

const command = { machine: 'sample-host', command: 'recorded sample' };

it('runs an orchestrator command on a connected machine without an opening or an expiry', async () => {
  const c = await company();
  vi.setSystemTime(new Date('2030-01-01T12:00:00Z'));
  expect((await c.take()).statusCode).toBe(200);
  const client = await c.run();
  expect(await client.callTool({ name: 'computer', arguments: command })).not.toHaveProperty('isError', true);
  expect((await c.take('updater=1')).json()).toMatchObject({ access: null, runs: [] });
  const { access, runs } = (await c.take()).json();
  expect(access).toEqual({ standing: true });
  expect(runs).toEqual([{ id: expect.any(String), command: command.command, timeout: 300 }]);
  const id = runs[0].id as string;
  expect((await c.app.inject({ method: 'POST', url: `/api/network/computer/${id}`, payload: { exit: 0, output: 'recorded output' }, ...c.keeper })).statusCode).toBe(204);
  expect(await client.callTool({ name: 'computer_result', arguments: { id } })).toMatchObject({ content: [{ text: 'Exit code 0.\nrecorded output' }] });
});

it('lets the orchestrator grant and withdraw access for a named employee and task or for all agents', async () => {
  const c = await company();
  await c.take();
  const orch = await c.run();
  const worker = await c.run(c.worker, c.task.id);
  const other = await c.run(c.other, c.task.id);
  const outsideTask = await c.run(c.worker);
  const computer = (client: typeof orch) => client.callTool({ name: 'computer', arguments: command });
  const named = { machine: c.machine.id, employee: c.worker.id, task: c.task.number };
  const all = { machine: c.machine.id, allAgents: true };
  const access = (args: Record<string, unknown>) => orch.callTool({ name: 'open_computer_access', arguments: args });
  expect(await computer(worker)).toHaveProperty('isError', true);
  expect(await access(named)).not.toHaveProperty('isError', true);
  expect(await computer(outsideTask)).toHaveProperty('isError', true);
  expect(await computer(other)).toHaveProperty('isError', true);
  expect(await computer(worker)).not.toHaveProperty('isError', true);
  expect(await access({ ...named, revoke: true })).not.toHaveProperty('isError', true);
  expect(await computer(worker)).toHaveProperty('isError', true);
  expect(await c.db.select().from(computerRuns)).toMatchObject([{ state: 'done', exit: 126 }]);
  expect(await access(all)).not.toHaveProperty('isError', true);
  expect(await computer(other)).not.toHaveProperty('isError', true);
});

it('creates no person request, decision card or outgoing message when the orchestrator grants access', async () => {
  const c = await company();
  const client = await c.run();
  expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('ask_computer_access');
  expect(await client.callTool({ name: 'open_computer_access', arguments: { machine: c.machine.id, allAgents: true } })).not.toHaveProperty('isError', true);
  for (const token of [c.owner, c.ceo]) {
    const { machineAccess, counts } = (await c.app.inject({ url: '/api/requests', ...as(token) })).json();
    expect(machineAccess ?? []).toEqual([]);
    expect(counts.total).toBe(0);
  }
  expect(await c.db.select().from(agentEvents).where(eq(agentEvents.kind, 'message'))).toEqual([]);
});

it('lets the named employee use access in an inbox turn that carries the task', async () => {
  const c = await company();
  await c.take();
  const orch = await c.run();
  expect(await orch.callTool({ name: 'open_computer_access', arguments: { machine: c.machine.id, employee: c.worker.id, task: c.task.number } })).not.toHaveProperty('isError', true);
  const worker = await c.run(c.worker, c.task.id, true);
  expect(await worker.callTool({ name: 'computer', arguments: command })).not.toHaveProperty('isError', true);
  expect((await c.take()).json().runs).toMatchObject([{ command: command.command }]);
});

it('honors the owner closing access before any opening and only their card can reopen it', async () => {
  const c = await company();
  await c.take();
  const client = await c.run();
  expect((await c.change('close')).json()).toMatchObject({ open: false });
  const refused = await client.callTool({ name: 'computer', arguments: command });
  expect(refused).toMatchObject({ isError: true, content: [{ text: 'The owner closed access to sample-host.' }] });
  expect(await client.callTool({ name: 'open_computer_access', arguments: { machine: c.machine.id, allAgents: true } })).toHaveProperty('isError', true);
  expect((await c.take()).json()).toMatchObject({ access: null, runs: [] });
  expect((await c.change('open', c.ceo)).statusCode).toBe(403);
  expect((await c.change('open')).json()).toMatchObject({ open: true, scope: 'orchestrator' });
  expect(await client.callTool({ name: 'computer', arguments: command })).not.toHaveProperty('isError', true);
});

it('carries a standing command from the authenticated route to an updated pinned keeper and back', async () => {
  const c = await company();
  const controlDir = mkdtempSync(join(tmpdir(), 'hh-standing-computer-'));
  onTestFinished(() => rmSync(controlDir, { recursive: true, force: true }));
  const keeperDir = join(controlDir, 'keeper');
  const computerControl = join(keeperDir, 'computer-control');
  mkdirSync(keeperDir);
  const now = new Date('2026-11-10T10:00:00.000Z');
  const carrier = new ComputerCarrier({
    dir: keeperDir, machine: c.machine.networkId!, pin: () => c.publicKey, trustApp: false, log: () => {}, now: () => now,
    ask: async (method, url, payload) => {
      const res = await c.app.inject({ method, url, ...c.keeper, payload: JSON.stringify(payload), headers: { ...c.keeper.headers, 'content-type': 'application/json' } });
      return { status: res.statusCode, body: res.body ? res.json() : null };
    },
  });
  carrier.prepare();
  const alive = join(computerControl, 'alive');
  writeFileSync(alive, '');
  utimesSync(alive, now, now);
  await carrier.tick();
  const by = { remoteAddress: c.keeper.remoteAddress, headers: { [VIA]: c.machine.id } };
  expect((await c.app.inject({ url: '/api/network/computer?standing=1&updater=1', ...by })).statusCode).toBe(403);
  const client = await c.run();
  expect(await client.callTool({ name: 'computer', arguments: command })).not.toHaveProperty('isError', true);
  await carrier.tick();
  const [run] = await c.db.select().from(computerRuns);
  const file = join(computerControl, 'computer', run!.id);
  expect(JSON.parse(readFileSync(`${file}.json`, 'utf8'))).toMatchObject({ command: command.command });
  writeFileSync(`${file}.out.json`, JSON.stringify({ id: run!.id, exit: 0, output: 'recorded output' }));
  await carrier.tick();
  expect(existsSync(`${file}.json`)).toBe(false);
  expect(await client.callTool({ name: 'computer_result', arguments: { id: run!.id } })).toMatchObject({ content: [{ text: 'Exit code 0.\nrecorded output' }] });
  await c.change('close');
  await carrier.tick();
  expect(JSON.parse(readFileSync(join(computerControl, 'computer.json'), 'utf8'))).toMatchObject({ untilSec: null });
});
