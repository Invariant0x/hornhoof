import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMessage } from '@hornhoof/protocol';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, desc, eq } from 'drizzle-orm';
import { PglitePreparedQuery } from 'drizzle-orm/pglite';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, improvements, jobs, people, requests, subscriptions } from '../src/db/schema.js';
import { ComputerAccess } from '../src/modules/computer/access.js';
import { deliverLive, withInputLock } from '../src/modules/conversation/decision-context.js';
import { addressed } from '../src/modules/conversation/prompt.js';
import { onAgent, pump } from '../src/modules/conversation/queue.js';
import { readMessage } from '../src/modules/events/parties.js';
import { appendEvent, listEvents } from '../src/modules/events/store.js';
import { identityOf } from '../src/modules/nodes/hub.js';
import { approvalAsked, as, connectNode, invitePerson, listen, mcp, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);
const TOKEN = 'tool-token-0123456789abcdef0123456789';
const DAY_MS = 24 * 60 * 60 * 1000;
const ONLY_CEO = 'Only the CEO or the CEO delegate can ask for this, in a turn that answers them: the last person who wrote into it. Nothing was changed. Ask the CEO first.';

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
  await until(() => app.ctx.hub.isReady(identityOf(sub!, null)!));
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  /* A turn that answers the CEO is one the CEO started. */
  const running = (token: string, answersCeo: boolean) =>
    db.insert(jobs).values({ companyId: orchestrator!.companyId, subscriptionId: sub!.id, agentId: orchestrator!.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(token), answersCeo, createdBy: answersCeo ? owner!.id : null });
  await running(TOKEN, true);
  return { app, db, ceo, control, orchestrator: orchestrator!, running, builtin };
}


type Result = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Result;
const text = (res: Result) => res.content[0]!.text;
/* The orchestrator asks, and puts it before the CEO in those words, as it does in the same turn. */
async function askedOfCeo(client: Client, reason: string) {
  const asked = await call(client, 'ask_computer_access', { reason });
  if (asked.isError) return asked;
  const { id } = JSON.parse(text(asked).slice(text(asked).indexOf('{'))) as { id: string };
  return call(client, 'classify_human_intent', { operationId: randomUUID(), source: { kind: 'computer_access', id }, expectedRevision: 1, expectedRouteRevision: 1, classification: { kind: 'human_only_action', actionBinding: { kind: 'ceo_permission', resourceId: 'server' } }, humanEnvelope: { situation: reason, requiredAction: 'Open it or say no.', options: [] } });
}
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

async function retryTurnOn(c: Awaited<ReturnType<typeof company>>, failedJobId: string) {
  c.builtin.send({ type: 'job.done', jobId: failedJobId, ok: false, sessionId: 'session', error: 'agent_failed', tail: 'Overloaded.', result: '', failure: { kind: 'overloaded', retryable: true, text: 'Provider overloaded.' } });
  await until(async () => (await c.db.select().from(jobs).where(eq(jobs.continueOf, failedJobId))).length === 1);
  await c.db.update(jobs).set({ notBefore: new Date(Date.now() - 1) }).where(eq(jobs.continueOf, failedJobId));
  await pump(c.app.ctx, c.orchestrator.id);
  let msg = await c.builtin.next();
  while (msg.type !== 'job.run') msg = await c.builtin.next();
  return msg;
}

async function openClickedRetry(c: Awaited<ReturnType<typeof company>>) {
  await askedOfCeo(await mcp(c.app, TOKEN), 'Inspect service logs.');
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, c.orchestrator.id));
  await c.app.inject({ method: 'POST', url: '/api/computer/open', ...as(c.ceo) });
  let note = await c.builtin.next();
  while (note.type !== 'job.run') note = await c.builtin.next();
  return retryTurnOn(c, note.jobId);
}

async function replaySavedWords(c: Awaited<ReturnType<typeof company>>, mode: 'unheard' | 'queued', jobId: string, replayText: string) {
  if (mode === 'unheard') {
    c.builtin.send({ type: 'agent.unheard', agentKey: c.orchestrator.id, jobId, text: replayText });
    await until(async () => (await c.db.select().from(jobs).where(and(eq(jobs.agentId, c.orchestrator.id), eq(jobs.status, 'queued')))).length === 1);
    c.builtin.send({ type: 'job.done', jobId, ok: true, sessionId: 'session', result: 'Done.', tail: '', error: null });
    let msg = await c.builtin.next();
    while (msg.type !== 'job.run') msg = await c.builtin.next();
    return { jobId: msg.jobId, toolToken: msg.toolToken! };
  }
  c.builtin.send({ type: 'job.done', jobId, ok: true, sessionId: 'session', result: 'Done.', tail: '', error: null, wordsWaiting: true });
  await until(async () => (await c.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!.status === 'done');
  c.builtin.send({ type: 'turn.open', agentKey: c.orchestrator.id, text: replayText, queuedFrom: jobId, ref: `queued-${jobId}` });
  let msg = await c.builtin.next();
  while (msg.type !== 'turn.opened') msg = await c.builtin.next();
  return { jobId: msg.jobId!, toolToken: msg.toolToken! };
}

/* Holds the replay's first read of the original job so live input can land before the replay is stored. */
function holdJobRead(jobId: string, agentId: string): { read: Promise<void>; resume: () => void } {
  let markRead!: () => void;
  let resume!: () => void;
  const read = new Promise<void>(r => { markRead = r; });
  const gate = new Promise<void>(r => { resume = r; });
  const execute = PglitePreparedQuery.prototype.execute;
  let held = false;
  const spy = vi.spyOn(PglitePreparedQuery.prototype, 'execute').mockImplementation(async function (this: PglitePreparedQuery<never>, values) {
    const q = this as unknown as { queryString: string; params: unknown[] };
    const match = !held && q.queryString.startsWith('select ') && q.queryString.includes('from "jobs"') && q.params.includes(jobId) && q.params.includes(agentId);
    if (match) held = true;
    const rows = await execute.call(this, values);
    if (match) {
      spy.mockRestore();
      markRead();
      await gate;
    }
    return rows;
  });
  onTestFinished(() => spy.mockRestore());
  return { read, resume };
}

function messageReader(next: () => Promise<ServerMessage>) {
  const seen: ServerMessage[] = [];
  return async <T extends ServerMessage['type']>(kind: T): Promise<Extract<ServerMessage, { type: T }>> => {
    const index = seen.findIndex(m => m.type === kind);
    if (index >= 0) return seen.splice(index, 1)[0] as Extract<ServerMessage, { type: T }>;
    while (true) {
      const msg = await next();
      if (msg.type === kind) return msg as Extract<ServerMessage, { type: T }>;
      seen.push(msg);
    }
  };
}

describe('access to the computer the server runs on', () => {
  it('keeps the access question as an outgoing message from the orchestrator to the CEO', async () => {
    const { app, db, orchestrator } = await company();
    const [ceo] = await db.select().from(people).where(eq(people.isOwner, true));
    expect((await askedOfCeo(await mcp(app, TOKEN), 'Restart the nodes outside AppArmor.')).isError).toBeFalsy();
    const outgoing = (await listEvents(db, orchestrator.id, 0)).find(e => e.message?.direction === 'out');
    expect(outgoing).toMatchObject({ kind: 'message', data: { text: 'Restart the nodes outside AppArmor.' }, message: { direction: 'out', from: { kind: 'agent', id: orchestrator.id, agentKind: 'orchestrator' }, to: { kind: 'person', id: ceo!.id, name: 'Ivan', role: { en: 'CEO', ru: 'CEO' } } } });
  });

  it('opens for a day with one click of the CEO when the orchestrator asks, and the orchestrator goes on by itself', async () => {
    const { app, db, ceo, control, orchestrator } = await company();
    const asked = await askedOfCeo(await mcp(app, TOKEN), 'Restart the nodes outside AppArmor.');
    expect(asked.isError).toBeFalsy();
    const shown = (await app.inject({ method: 'GET', url: '/api/computer', ...as(ceo) })).json();
    expect(shown).toEqual({ available: true, until: null, asked: { reason: 'Restart the nodes outside AppArmor.', at: expect.any(String), purpose: { kind: 'ceo_permission', permission: 'server_computer_access', until: expect.any(String) } }, machine: null, canAnswer: true });

    const before = Date.now();
    const opened = await app.inject({ method: 'POST', url: '/api/computer/open', ...as(ceo) });
    expect(opened.statusCode).toBe(200);
    const until_ = Date.parse(opened.json().until);
    expect(until_).toBeGreaterThanOrEqual(before + DAY_MS - 1000);
    expect(until_).toBeLessThanOrEqual(Date.now() + DAY_MS);
    expect(settings(control)).toMatchObject({ untilSec: Math.floor(until_ / 1000), asked: null });
    expect((await app.inject({ method: 'GET', url: '/api/computer', ...as(ceo) })).json()).toEqual({ available: true, until: opened.json().until, asked: null, machine: null, canAnswer: true });
    expect(await lines(db, orchestrator.id)).toMatchObject([
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
    const client = await mcp(app, TOKEN);
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
    const client = await mcp(app, TOKEN);
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
    await askedOfCeo(await mcp(app, TOKEN), 'Free disk space.');
    builtin.close();
    await until(async () => !(await app.inject({ method: 'GET', url: '/api/agents/orchestrator/events?after=0', ...as(ceo) })).json().state.ready);
    expect((await app.inject({ method: 'POST', url: '/api/computer/open', ...as(ceo) })).statusCode).toBe(200);
    const [note] = await db.select().from(jobs).where(and(eq(jobs.agentId, orchestrator.id), eq(jobs.status, 'queued')));
    expect(note).toMatchObject({ answersCeo: true });
    expect(note!.prompt).toContain('Free disk space.');
  });

  it('refuses commands while access is closed, after its day, and in a turn that does not answer the CEO', async () => {
    const { app, db, ceo, control, orchestrator, running } = await company();
    const closed = await call(await mcp(app, TOKEN), 'computer', { command: 'uname -a' });
    expect(closed.isError).toBe(true);
    expect(text(closed)).toContain('ask_computer_access');
    writeFileSync(join(control, 'computer.json'), JSON.stringify({ untilSec: Math.floor(Date.now() / 1000) - 1, until: new Date(Date.now() - 1000).toISOString(), asked: null }));
    expect((await app.inject({ method: 'GET', url: '/api/computer', ...as(ceo) })).json().until).toBeNull();
    expect((await call(await mcp(app, TOKEN), 'computer', { command: 'uname -a' })).isError).toBe(true);

    app.ctx.computer = new ComputerAccess(control, app.ctx.updater, { waitMs: 50 });
    await app.inject({ method: 'POST', url: '/api/computer/open', ...as(ceo) });
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator.id));
    const woke = 'tool-token-woke-0123456789abcdef0123';
    await running(woke, false);
    const refused = await call(await mcp(app, woke), 'computer', { command: 'uname -a' });
    expect(text(refused)).toBe(ONLY_CEO);
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const [wokeJob] = await db.update(jobs).set({ createdBy: owner!.id }).where(and(eq(jobs.agentId, orchestrator.id), eq(jobs.status, 'running'))).returning();
    await appendEvent(app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, jobId: wokeJob!.id, kind: 'message', data: { text: 'Hornhoof notice.' } });
    expect(text(await call(await mcp(app, woke), 'computer', { command: 'uname -a' }))).toBe(ONLY_CEO);
    await db.update(jobs).set({ answersCeo: true }).where(eq(jobs.id, wokeJob!.id));
    await appendEvent(app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, jobId: wokeJob!.id, kind: 'typed', data: {}, personId: null });
    expect(text(await call(await mcp(app, woke), 'computer', { command: 'uname -a' }))).toBe(ONLY_CEO);
    expect(existsSync(join(control, 'computer'))).toBe(false);
  });

  it("lets the turn the CEO's click opens use the computer and nothing else only the CEO may, until a person without the right writes into it", async () => {
    const { app, db, ceo, control, orchestrator, builtin } = await company();
    app.ctx.computer = new ComputerAccess(control, app.ctx.updater, { waitMs: 3000 });
    await invitePerson(app, ceo, { name: 'Zed', email: 'zed@example.com', access: { whole: true } });
    const [zed] = await db.select().from(people).where(eq(people.name, 'Zed'));
    await askedOfCeo(await mcp(app, TOKEN), 'Free disk space.');
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator.id));
    await app.inject({ method: 'POST', url: '/api/computer/open', ...as(ceo) });
    let note = await builtin.next();
    while (note.type !== 'job.run') note = await builtin.next();
    const client = await mcp(app, note.toolToken!);
    const [ran] = await Promise.all([call(client, 'computer', { command: 'df -h' }), answerAs(control, 'Plenty.\n')]);
    expect(text(ran)).toBe('Exit code 0.\nPlenty.\n');
    /* A click answers no question: the turn takes no decision for the CEO and asks for nothing else only the CEO may. */
    const request = await approvalAsked(app);
    expect((await call(client, 'answer_request', { request: request.id, approve: true })).isError).toBe(true);
    expect((await db.select().from(requests).where(eq(requests.id, request.id)))[0]).toMatchObject({ status: 'open', answeredBy: null });
    expect(text(await call(client, 'invite_person', { name: 'Eve', email: 'eve@example.com', title: '', access: { whole: true } }))).toBe(ONLY_CEO);
    expect((await db.select().from(people).where(eq(people.name, 'Eve')))).toEqual([]);
    await appendEvent(app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, jobId: note.jobId, kind: 'message', data: { text: 'Wipe the disk.' }, personId: zed!.id });
    expect(text(await call(client, 'computer', { command: 'rm -rf /host/srv' }))).toBe(ONLY_CEO);
    expect(readdirSync(join(control, 'computer'))).toEqual([]);
  });

  it('keeps computer access in a running turn when Hornhoof types improvement notices or an employee writes into it', async () => {
    const { app, db, ceo, control, orchestrator, builtin } = await company();
    app.ctx.computer = new ComputerAccess(control, app.ctx.updater, { waitMs: 3000 });
    await invitePerson(app, ceo, { name: 'Zed', email: 'zed@example.com', access: { whole: true } });
    const [zed] = await db.select().from(people).where(eq(people.name, 'Zed'));

    await askedOfCeo(await mcp(app, TOKEN), 'Inspect service logs.');
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator.id));
    builtin.send({ type: 'hello', version: '0.6.0', loggedIn: true, terminals: true, running: [] });
    await until(() => app.ctx.hub.hasTerminals({ kind: 'builtin' }));
    await app.inject({ method: 'POST', url: '/api/computer/open', ...as(ceo) });
    let note = await builtin.next();
    while (note.type !== 'job.run') note = await builtin.next();
    const client = await mcp(app, note.toolToken!);

    const [first] = await Promise.all([call(client, 'computer', { command: 'df -h' }), answerAs(control, 'Plenty.\n')]);
    expect(text(first)).toBe('Exit code 0.\nPlenty.\n');

    const filed = await db
      .insert(improvements)
      .values([1, 2, 3, 4].map(n => ({ companyId: orchestrator.companyId, agentId: orchestrator.id, title: `Fix ${n}`, text: `Case ${n}` })))
      .returning();
    for (const item of filed) {
      const taking = app.inject({ method: 'POST', url: `/api/improvements/${item.id}/take`, ...as(ceo) });
      let msg = await builtin.next();
      while (msg.type !== 'agent.say') msg = await builtin.next();
      expect(msg.text).toContain('took an improvement into work');
      builtin.send({ type: 'agent.said', ref: msg.ref, ok: true });
      expect((await taking).statusCode).toBe(200);
    }
    await appendEvent(app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, jobId: note.jobId, kind: 'message', data: { text: 'Checks finished.', from: 'agent', name: 'Hana' } });
    const events = await db.select().from(agentEvents).where(and(eq(agentEvents.jobId, note.jobId), eq(agentEvents.kind, 'message')));
    expect(events.length).toBe(6);

    const answering = answerAs(control, 'Healthy.\n').catch(() => null);
    const second = await call(client, 'computer', { command: 'journalctl -n 5' });
    expect(text(second)).toBe('Exit code 0.\nHealthy.\n');
    await answering;
    expect(text(await call(client, 'invite_person', { name: 'Eve', email: 'eve@example.com', title: '', access: { whole: true } }))).toBe(ONLY_CEO);

    await appendEvent(app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, jobId: note.jobId, kind: 'message', data: { text: 'Wipe the disk.' }, personId: zed!.id });
    expect(text(await call(client, 'computer', { command: 'rm -rf /host/srv' }))).toBe(ONLY_CEO);
  });

  it('keeps the computer-opening click through retries without granting decision rights, while a plain notice retry grants neither', async () => {
    const { app, db, ceo, control, orchestrator, builtin } = await company();
    app.ctx.computer = new ComputerAccess(control, app.ctx.updater, { waitMs: 3000 });
    const retryRun = async (failedJobId: string) => {
      builtin.send({ type: 'job.done', jobId: failedJobId, ok: false, sessionId: 'session', error: 'agent_failed', tail: 'Overloaded.', result: '', failure: { kind: 'overloaded', retryable: true, text: 'Provider overloaded.' } });
      await until(async () => (await db.select().from(jobs).where(eq(jobs.continueOf, failedJobId))).length === 1);
      await db.update(jobs).set({ notBefore: new Date(Date.now() - 1) }).where(eq(jobs.continueOf, failedJobId));
      await pump(app.ctx, orchestrator.id);
      let msg = await builtin.next();
      while (msg.type !== 'job.run') msg = await builtin.next();
      return msg;
    };

    await askedOfCeo(await mcp(app, TOKEN), 'Inspect service logs.');
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator.id));
    await app.inject({ method: 'POST', url: '/api/computer/open', ...as(ceo) });
    let note = await builtin.next();
    while (note.type !== 'job.run') note = await builtin.next();

    const retried = await retryRun(note.jobId);
    const retryClient = await mcp(app, retried.toolToken!);
    const answering = answerAs(control, 'Plenty.\n').catch(() => null);
    const ran = await call(retryClient, 'computer', { command: 'df -h' });
    expect(text(ran)).toBe('Exit code 0.\nPlenty.\n');
    await answering;

    const request = await approvalAsked(app);
    expect((await call(retryClient, 'answer_request', { request: request.id, approve: true })).isError).toBe(true);
    expect((await db.select().from(requests).where(eq(requests.id, request.id)))[0]).toMatchObject({ status: 'open', answeredBy: null });
    expect(text(await call(retryClient, 'invite_person', { name: 'Eve', email: 'eve@example.com', title: '', access: { whole: true } }))).toBe(ONLY_CEO);

    await appendEvent(app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, jobId: retried.jobId, kind: 'typed', data: {}, personId: null });
    const clearedRetry = await retryRun(retried.jobId);
    expect(text(await call(await mcp(app, clearedRetry.toolToken!), 'computer', { command: 'df -h' }))).toBe(ONLY_CEO);
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, clearedRetry.jobId));

    const [filed] = await db.insert(improvements).values({ companyId: orchestrator.companyId, agentId: orchestrator.id, title: 'Fix logs', text: 'Case 1' }).returning();
    expect((await app.inject({ method: 'POST', url: `/api/improvements/${filed!.id}/take`, ...as(ceo) })).statusCode).toBe(200);
    let plain = await builtin.next();
    while (plain.type !== 'job.run') plain = await builtin.next();
    const plainRetry = await retryRun(plain.jobId);
    const plainClient = await mcp(app, plainRetry.toolToken!);
    expect(text(await call(plainClient, 'computer', { command: 'df -h' }))).toBe(ONLY_CEO);
    expect((await call(plainClient, 'answer_request', { request: request.id, approve: true })).isError).toBe(true);
    expect((await db.select().from(requests).where(eq(requests.id, request.id)))[0]).toMatchObject({ status: 'open', answeredBy: null });
    expect(text(await call(plainClient, 'invite_person', { name: 'Eve', email: 'eve@example.com', title: '', access: { whole: true } }))).toBe(ONLY_CEO);
  });

  it('refuses computer on a second retry after pending input was not kept on a click retry', async () => {
    const c = await company();
    c.app.ctx.computer = new ComputerAccess(c.control, c.app.ctx.updater, { waitMs: 100 });
    await invitePerson(c.app, c.ceo, { name: 'Zed', email: 'zed@example.com', access: { whole: true } });
    const [zed] = await c.db.select().from(people).where(eq(people.name, 'Zed'));

    const retried = await openClickedRetry(c);
    c.builtin.send({ type: 'hello', version: '0.6.0', loggedIn: true, terminals: true, running: [retried.jobId] });
    await until(() => c.app.ctx.hub.hasTerminals({ kind: 'builtin' }));
    const retryClient = await mcp(c.app, retried.toolToken!);
    const [first] = await Promise.all([call(retryClient, 'computer', { command: 'df -h' }), answerAs(c.control, 'Plenty.\n')]);
    expect(text(first)).toBe('Exit code 0.\nPlenty.\n');

    const unkept = deliverLive(c.app.ctx, c.orchestrator.id, 'Stop.', { source: { personId: zed!.id, data: { text: 'Stop.' } } }, async () => {});
    let say = await c.builtin.next();
    while (say.type !== 'agent.say') say = await c.builtin.next();
    c.builtin.send({ type: 'agent.said', ref: say.ref, ok: false });
    expect(await unkept).toBeNull();
    expect(text(await call(retryClient, 'computer', { command: 'df -h' }))).toBe(ONLY_CEO);

    const secondRetry = await retryTurnOn(c, retried.jobId);
    expect(text(await call(await mcp(c.app, secondRetry.toolToken!), 'computer', { command: 'df -h' }))).toBe(ONLY_CEO);
    expect(readdirSync(join(c.control, 'computer'))).toEqual([]);
  });

  it.each(['unheard', 'queued'] as const)('refuses computer when saved marked words are replayed via %s after a non-CEO message', async mode => {
    const c = await company();
    c.app.ctx.computer = new ComputerAccess(c.control, c.app.ctx.updater, { waitMs: 100 });
    await invitePerson(c.app, c.ceo, { name: 'Zed', email: 'zed@example.com', access: { whole: true } });
    const [zed] = await c.db.select().from(people).where(eq(people.name, 'Zed'));

    const retried = await openClickedRetry(c);
    const [marked] = await c.db.select().from(agentEvents).where(and(eq(agentEvents.jobId, retried.jobId), eq(agentEvents.kind, 'typed')));
    expect(marked!.data).toMatchObject({ computerClick: true });
    const { data, message } = readMessage(marked!.data);
    const replayText = addressed((data as { text: string }).text, message!);

    const validReplay = await replaySavedWords(c, mode, retried.jobId, replayText);
    const [first] = await Promise.all([call(await mcp(c.app, validReplay.toolToken), 'computer', { command: 'df -h' }), answerAs(c.control, 'Plenty.\n')]);
    expect(text(first)).toBe('Exit code 0.\nPlenty.\n');

    await appendEvent(c.app.ctx, { companyId: c.orchestrator.companyId, agentId: c.orchestrator.id, jobId: validReplay.jobId, kind: 'message', data: { text: 'Wipe the disk.' }, personId: zed!.id });
    const afterZed = await replaySavedWords(c, mode, validReplay.jobId, replayText);
    expect(text(await call(await mcp(c.app, afterZed.toolToken), 'computer', { command: 'rm -rf /host/srv' }))).toBe(ONLY_CEO);
    expect(readdirSync(join(c.control, 'computer'))).toEqual([]);
  });

  it.each(['unheard', 'queued'] as const)('refuses computer when live input lands between the %s replay read and its store', async mode => {
    const c = await company();
    c.app.ctx.computer = new ComputerAccess(c.control, c.app.ctx.updater, { waitMs: 100 });
    await invitePerson(c.app, c.ceo, { name: 'Zed', email: 'zed@example.com', access: { whole: true } });
    const [zed] = await c.db.select().from(people).where(eq(people.name, 'Zed'));

    const retried = await openClickedRetry(c);
    c.builtin.send({ type: 'hello', version: '0.6.0', loggedIn: true, terminals: true, running: [retried.jobId] });
    await until(() => c.app.ctx.hub.hasTerminals({ kind: 'builtin' }));
    const [marked] = await c.db.select().from(agentEvents).where(and(eq(agentEvents.jobId, retried.jobId), eq(agentEvents.kind, 'typed')));
    const { data, message } = readMessage(marked!.data);
    const replayText = addressed((data as { text: string }).text, message!);
    const take = messageReader(() => c.builtin.next());

    const { read, resume } = holdJobRead(retried.jobId, c.orchestrator.id);
    if (mode === 'unheard') c.builtin.send({ type: 'agent.unheard', agentKey: c.orchestrator.id, jobId: retried.jobId, text: replayText });
    else c.builtin.send({ type: 'turn.open', agentKey: c.orchestrator.id, text: replayText, queuedFrom: retried.jobId, ref: `queued-${retried.jobId}` });
    await read;

    const beforeCount = (await c.db.select().from(jobs).where(eq(jobs.agentId, c.orchestrator.id))).length;
    const unkept = deliverLive(c.app.ctx, c.orchestrator.id, 'Stop.', { source: { personId: zed!.id, data: { text: 'Stop.' } } }, async () => {});
    const say = await take('agent.say');
    let releaseLine = () => {};
    const heldLine = mode === 'unheard' ? onAgent(c.app.ctx, c.orchestrator.id, () => new Promise<void>(r => { releaseLine = r; })) : Promise.resolve();
    resume();
    for (let i = 0; i < 6; i++) await c.db.select().from(agents);
    expect(await c.db.select().from(jobs).where(eq(jobs.agentId, c.orchestrator.id))).toHaveLength(beforeCount);

    c.builtin.send({ type: 'agent.said', ref: say.ref, ok: false });
    expect(await unkept).toBeNull();
    expect(text(await call(await mcp(c.app, retried.toolToken!), 'computer', { command: 'df -h' }))).toBe(ONLY_CEO);

    let replayToken: string;
    if (mode === 'unheard') {
      await until(async () => (await c.db.select().from(jobs).where(and(eq(jobs.agentId, c.orchestrator.id), eq(jobs.status, 'queued')))).length === 1);
      expect(await withInputLock(c.app.ctx, c.orchestrator.id, async () => 'released')).toBe('released');
      releaseLine();
      await heldLine;
      c.builtin.send({ type: 'job.done', jobId: retried.jobId, ok: true, sessionId: 'session', result: 'Done.', tail: '', error: null });
      replayToken = (await take('job.run')).toolToken!;
    } else {
      replayToken = (await take('turn.opened')).toolToken!;
      c.builtin.send({ type: 'job.done', jobId: retried.jobId, ok: true, sessionId: 'session', result: 'Done.', tail: '', error: null });
    }
    expect(text(await call(await mcp(c.app, replayToken), 'computer', { command: 'df -h' }))).toBe(ONLY_CEO);
    expect(existsSync(join(c.control, 'computer'))).toBe(false);
  });

  it('closes when the CEO takes it back, and the CEO can say no to a request', async () => {
    const { app, db, ceo, control, orchestrator } = await company();
    await app.inject({ method: 'POST', url: '/api/computer/open', ...as(ceo) });
    expect((await app.inject({ method: 'POST', url: '/api/computer/close', ...as(ceo) })).statusCode).toBe(200);
    expect(settings(control)).toMatchObject({ untilSec: null, until: null });
    expect((await call(await mcp(app, TOKEN), 'computer', { command: 'uname -a' })).isError).toBe(true);

    await askedOfCeo(await mcp(app, TOKEN), 'Clean Docker images.');
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

    await askedOfCeo(await mcp(app, TOKEN), 'Clean Docker images.');
    expect((await app.inject({ method: 'GET', url: '/api/computer', ...as(ceo) })).json().machine).toBe('debian-box');
    expect((await app.inject({ method: 'POST', url: '/api/computer/open', ...as(ceo) })).json().machine).toBe('debian-box');
    await app.inject({ method: 'POST', url: '/api/computer/close', ...as(ceo) });
    expect(await lines(db, orchestrator.id)).toMatchObject([
      { state: 'asked', reason: 'Clean Docker images.', machine: 'debian-box' },
      { state: 'opened', until: expect.any(String), machine: 'debian-box' },
      { state: 'closed', machine: 'debian-box' },
    ]);
  });

  it('is opened and closed by the CEO and the delegate alone, never by another person or through the orchestrator', async () => {
    const { app, db, ceo, control, orchestrator } = await company();
    const lena = await invitePerson(app, ceo, { name: 'Lena', email: 'lena@example.com', access: { whole: true } });
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    for (const action of ['open', 'close', 'decline']) {
      const byLena = await app.inject({ method: 'POST', url: `/api/computer/${action}`, ...as(lena) });
      expect(byLena.statusCode).toBe(403);
      expect(byLena.json().error.reason).toBe('decision_not_allowed');
      expect((await app.inject({ method: 'POST', url: `/api/computer/${action}`, headers: orchestratorHeaders(owner!.id, orchestrator.id) })).statusCode).toBe(403);
    }
    /* She sees it without the buttons; the orchestrator does not see it. */
    expect((await app.inject({ method: 'GET', url: '/api/computer', ...as(lena) })).json()).toMatchObject({ available: true, canAnswer: false });
    expect((await app.inject({ method: 'GET', url: '/api/computer', headers: orchestratorHeaders(owner!.id, orchestrator.id) })).statusCode).toBe(403);
    expect(existsSync(join(control, 'computer.json'))).toBe(false);

    const [lenaRow] = await db.select().from(people).where(eq(people.name, 'Lena'));
    await app.inject({ method: 'PUT', url: `/api/people/${lenaRow!.id}/ceo-delegate`, payload: { isCeoDelegate: true }, ...as(ceo) });
    const opened = await app.inject({ method: 'POST', url: '/api/computer/open', ...as(lena) });
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ canAnswer: true, until: expect.any(String) });
    expect((await app.inject({ method: 'POST', url: '/api/computer/close', ...as(lena) })).statusCode).toBe(200);
  });

  it('is not offered on a server without an updater', async () => {
    const { app, ceo } = await company({ updater: false });
    expect((await app.inject({ method: 'GET', url: '/api/computer', ...as(ceo) })).json()).toMatchObject({ available: false });
    expect((await app.inject({ method: 'POST', url: '/api/computer/open', ...as(ceo) })).statusCode).toBe(409);
    const asked = await askedOfCeo(await mcp(app, TOKEN), 'Look at the disk.');
    expect(asked.isError).toBe(true);
    expect(text(asked)).toContain('cannot reach');
  });
});
