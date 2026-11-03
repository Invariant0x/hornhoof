import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, jobs, people, subscriptions } from '../src/db/schema.js';
import { ComputerAccess } from '../src/modules/computer/access.js';
import { listEvents } from '../src/modules/events/store.js';
import { identityOf } from '../src/modules/nodes/hub.js';
import { as, connectNode, invitePerson, listen, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);
const TOKEN = 'tool-token-0123456789abcdef0123456789';
const DAY_MS = 24 * 60 * 60 * 1000;
const ONLY_CEO = 'Only the CEO can ask for this. Ask the CEO first.';

/* A company whose server has an updater, and a running turn of the orchestrator that answers the CEO. */
async function company({ updater = true, env = {} as NodeJS.ProcessEnv } = {}) {
  const control = mkdtempSync(join(tmpdir(), 'hh-control-'));
  if (updater) writeFileSync(join(control, 'alive'), '');
  const { app, db } = await testApp({ NODE_KEY, HORNHOOF_CONTROL_DIR: control, ...env });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  onTestFinished(() => builtin.close());
  builtin.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [] });
  await until(async () => (await db.select().from(subscriptions))[0]!.status === 'ready');
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [sub] = await db.select().from(subscriptions);
  await until(() => app.ctx.hub.isReady(identityOf(sub!, null)));
  const running = (token: string, answersCeo: boolean) =>
    db.insert(jobs).values({ companyId: orchestrator!.companyId, subscriptionId: sub!.id, agentId: orchestrator!.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(token), answersCeo });
  await running(TOKEN, true);
  return { app, db, ceo, control, orchestrator: orchestrator!, running, builtin };
}

async function mcp(app: FastifyInstance, token = TOKEN): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  onTestFinished(() => client.close());
  return client;
}

type Result = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: object) => (await client.callTool({ name, arguments: args })) as Result;
const text = (res: Result) => res.content[0]!.text;
const settings = (control: string) => JSON.parse(readFileSync(join(control, 'computer.json'), 'utf8'));
const lines = async (db: Awaited<ReturnType<typeof company>>['db'], agentId: string) =>
  (await db.select().from(agentEvents).where(and(eq(agentEvents.agentId, agentId), eq(agentEvents.kind, 'computer')))).map(e => e.data);

/* The updater's side: answers the first command it finds with this output. */
async function answerAs(control: string, output: string, exit = 0) {
  const dir = join(control, 'computer');
  await until(() => existsSync(dir) && readdirSync(dir).some(f => !f.endsWith('.out.json')), 5000);
  const file = readdirSync(dir).find(f => !f.endsWith('.out.json'))!;
  const asked = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  writeFileSync(join(dir, `${asked.id}.out.json`), JSON.stringify({ id: asked.id, exit, output }));
  return asked as { id: string; command: string; timeout: number };
}

describe('access to the computer the server runs on', () => {
  it('keeps the access question as an outgoing message from the orchestrator to the CEO', async () => {
    const { app, db, orchestrator } = await company();
    const [ceo] = await db.select().from(people).where(eq(people.isOwner, true));
    expect((await call(await mcp(app), 'ask_computer_access', { reason: 'Restart the nodes outside AppArmor.' })).isError).toBeFalsy();
    const outgoing = (await listEvents(db, orchestrator.id, 0)).find(e => e.message?.direction === 'out');
    expect(outgoing).toMatchObject({ kind: 'message', data: { text: 'Restart the nodes outside AppArmor.' }, message: { direction: 'out', from: { kind: 'agent', id: orchestrator.id, agentKind: 'orchestrator' }, to: { kind: 'person', id: ceo!.id, name: 'Ivan', role: { en: 'CEO', ru: 'CEO' } } } });
  });

  it('opens for a day with one click of the CEO when the orchestrator asks, and the orchestrator goes on by itself', async () => {
    const { app, db, ceo, control, orchestrator } = await company();
    const asked = await call(await mcp(app), 'ask_computer_access', { reason: 'Restart the nodes outside AppArmor.' });
    expect(asked.isError).toBeFalsy();
    const shown = (await app.inject({ method: 'GET', url: '/api/computer', ...as(ceo) })).json();
    expect(shown).toEqual({ available: true, until: null, asked: { reason: 'Restart the nodes outside AppArmor.', at: expect.any(String) }, machine: null });

    const before = Date.now();
    const opened = await app.inject({ method: 'POST', url: '/api/computer/open', ...as(ceo) });
    expect(opened.statusCode).toBe(200);
    const until_ = Date.parse(opened.json().until);
    expect(until_).toBeGreaterThanOrEqual(before + DAY_MS - 1000);
    expect(until_).toBeLessThanOrEqual(Date.now() + DAY_MS);
    expect(settings(control)).toMatchObject({ untilSec: Math.floor(until_ / 1000), asked: null });
    expect((await app.inject({ method: 'GET', url: '/api/computer', ...as(ceo) })).json()).toEqual({ available: true, until: opened.json().until, asked: null, machine: null });
    expect(await lines(db, orchestrator.id)).toEqual([
      { state: 'asked', reason: 'Restart the nodes outside AppArmor.' },
      { state: 'opened', until: opened.json().until },
    ]);
    /* The note that it is open is the CEO's order, so the turn it starts may use the computer. */
    const [note] = await db.select().from(jobs).where(eq(jobs.agentId, orchestrator.id)).orderBy(desc(jobs.createdAt)).limit(1);
    expect(note!.answersCeo).toBe(true);
    expect(note!.prompt).toContain('Restart the nodes outside AppArmor.');
  });

  it("runs the orchestrator's command through the updater and gives back the exit code and output", async () => {
    const { app, ceo, control } = await company();
    await app.inject({ method: 'POST', url: '/api/computer/open', ...as(ceo) });
    const client = await mcp(app);
    const [res, asked] = await Promise.all([call(client, 'computer', { command: 'uname -a', timeoutSeconds: 30 }), answerAs(control, 'Linux debian 6.12\n', 3)]);
    expect(asked).toMatchObject({ command: 'uname -a', timeout: 30 });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toBe('Exit code 3.\nLinux debian 6.12\n');
    expect(readdirSync(join(control, 'computer'))).toEqual([]);
  });

  /* Codex gives up on a tool after a minute, so a long command answers that it runs, and its result comes later. */
  it('tells the orchestrator a long command still runs, and gives its result when asked for it', async () => {
    const { app, ceo, control } = await company();
    app.ctx.computer = new ComputerAccess(control, app.ctx.updater, { waitMs: 300 });
    await app.inject({ method: 'POST', url: '/api/computer/open', ...as(ceo) });
    const client = await mcp(app);
    const started = await call(client, 'computer', { command: 'apt-get upgrade -y', timeoutSeconds: 900 });
    expect(started.isError).toBeFalsy();
    const id = text(started).match(/computer_result with id ([0-9a-f-]{36})/)![1]!;
    expect(text(started)).toMatch(/^Still running\./);
    expect(text(await call(client, 'computer_result', { id }))).toMatch(/^Still running\./);
    await answerAs(control, 'Upgraded 3 packages.\n');
    expect(text(await call(client, 'computer_result', { id }))).toBe('Exit code 0.\nUpgraded 3 packages.\n');
    expect(readdirSync(join(control, 'computer'))).toEqual([]);
    const gone = await call(client, 'computer_result', { id });
    expect(gone.isError).toBe(true);
  });

  it("queues the orchestrator's note while its machine is offline, so it goes on once the machine is back", async () => {
    const { app, db, ceo, orchestrator, builtin } = await company();
    await call(await mcp(app), 'ask_computer_access', { reason: 'Free disk space.' });
    builtin.close();
    await until(async () => !(await app.inject({ method: 'GET', url: '/api/agents/orchestrator/events?after=0', ...as(ceo) })).json().state.ready);
    expect((await app.inject({ method: 'POST', url: '/api/computer/open', ...as(ceo) })).statusCode).toBe(200);
    const [note] = await db.select().from(jobs).where(and(eq(jobs.agentId, orchestrator.id), eq(jobs.status, 'queued')));
    expect(note).toMatchObject({ answersCeo: true });
    expect(note!.prompt).toContain('Free disk space.');
  });

  it('refuses commands while access is closed, after its day, and in a turn that does not answer the CEO', async () => {
    const { app, db, ceo, control, orchestrator, running } = await company();
    const closed = await call(await mcp(app), 'computer', { command: 'uname -a' });
    expect(closed.isError).toBe(true);
    expect(text(closed)).toContain('ask_computer_access');
    writeFileSync(join(control, 'computer.json'), JSON.stringify({ untilSec: Math.floor(Date.now() / 1000) - 1, until: new Date(Date.now() - 1000).toISOString(), asked: null }));
    expect((await app.inject({ method: 'GET', url: '/api/computer', ...as(ceo) })).json().until).toBeNull();
    expect((await call(await mcp(app), 'computer', { command: 'uname -a' })).isError).toBe(true);

    await app.inject({ method: 'POST', url: '/api/computer/open', ...as(ceo) });
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator.id));
    const woke = 'tool-token-woke-0123456789abcdef0123';
    await running(woke, false);
    const refused = await call(await mcp(app, woke), 'computer', { command: 'uname -a' });
    expect(text(refused)).toBe(ONLY_CEO);
    expect(existsSync(join(control, 'computer'))).toBe(false);
  });

  it('closes when the CEO takes it back, and the CEO can say no to a request', async () => {
    const { app, db, ceo, control, orchestrator } = await company();
    await app.inject({ method: 'POST', url: '/api/computer/open', ...as(ceo) });
    expect((await app.inject({ method: 'POST', url: '/api/computer/close', ...as(ceo) })).statusCode).toBe(200);
    expect(settings(control)).toMatchObject({ untilSec: null, until: null });
    expect((await call(await mcp(app), 'computer', { command: 'uname -a' })).isError).toBe(true);

    await call(await mcp(app), 'ask_computer_access', { reason: 'Clean Docker images.' });
    expect((await app.inject({ method: 'POST', url: '/api/computer/decline', ...as(ceo) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/computer', ...as(ceo) })).json().asked).toBeNull();
    expect((await lines(db, orchestrator.id)).map(l => (l as { state: string }).state)).toEqual(['opened', 'closed', 'asked', 'declined']);
  });

  /* The server's computer joined as a machine too: the CEO sees which machine the access is to, wherever they look from. */
  it('names the machine the server runs on, in what the CEO sees and in the log', async () => {
    const hostId = createHash('sha256').update('hornhoof-host:debian-0001-abcd').digest('hex');
    const { app, db, ceo, orchestrator } = await company({ env: { HORNHOOF_HOST_ID: hostId } });
    const { command } = (await app.inject({ method: 'POST', url: '/api/machines/command', ...as(ceo) })).json();
    const join_ = { code: command.split('--join ')[1], machineId: 'debian-0001-abcd', hostname: 'debian-box', os: 'linux', arch: 'x86_64' };
    expect((await app.inject({ method: 'POST', url: '/api/nodes/join', payload: join_ })).statusCode).toBe(200);

    await call(await mcp(app), 'ask_computer_access', { reason: 'Clean Docker images.' });
    expect((await app.inject({ method: 'GET', url: '/api/computer', ...as(ceo) })).json().machine).toBe('debian-box');
    expect((await app.inject({ method: 'POST', url: '/api/computer/open', ...as(ceo) })).json().machine).toBe('debian-box');
    await app.inject({ method: 'POST', url: '/api/computer/close', ...as(ceo) });
    expect(await lines(db, orchestrator.id)).toEqual([
      { state: 'asked', reason: 'Clean Docker images.', machine: 'debian-box' },
      { state: 'opened', until: expect.any(String), machine: 'debian-box' },
      { state: 'closed', machine: 'debian-box' },
    ]);
  });

  it('is opened and closed by the CEO alone, never by another person or through the orchestrator', async () => {
    const { app, db, ceo, control, orchestrator } = await company();
    const lena = await invitePerson(app, ceo, { name: 'Lena', email: 'lena@example.com', access: { whole: true } });
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    for (const action of ['open', 'close', 'decline']) {
      expect((await app.inject({ method: 'POST', url: `/api/computer/${action}`, ...as(lena) })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: `/api/computer/${action}`, headers: orchestratorHeaders(owner!.id, orchestrator.id) })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/api/computer', ...as(lena) })).statusCode).toBe(403);
    expect(existsSync(join(control, 'computer.json'))).toBe(false);
  });

  it('is not offered on a server without an updater', async () => {
    const { app, ceo } = await company({ updater: false });
    expect((await app.inject({ method: 'GET', url: '/api/computer', ...as(ceo) })).json()).toMatchObject({ available: false });
    expect((await app.inject({ method: 'POST', url: '/api/computer/open', ...as(ceo) })).statusCode).toBe(409);
    const asked = await call(await mcp(app), 'ask_computer_access', { reason: 'Look at the disk.' });
    expect(asked.isError).toBe(true);
    expect(text(asked)).toContain('cannot reach');
  });
});
