import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMessage } from '@hornhoof/protocol';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { PglitePreparedQuery } from 'drizzle-orm/pglite';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agentInbox, agents, companies, computerRuns, departments, improvements, jobs, machines, people, requests, subscriptions } from '../src/db/schema.js';
import { idOnly } from '../src/db/selections.js';
import { ORCHESTRATOR_SKILLS } from '../src/modules/agents/instructions.js';
import type { Computers } from '../src/modules/computer/access.js';
import { deliverLive, withInputLock } from '../src/modules/conversation/decision-context.js';
import { addressed } from '../src/modules/conversation/prompt.js';
import { enqueueTurn, onAgent, pump } from '../src/modules/conversation/queue.js';
import { readMessage } from '../src/modules/events/parties.js';
import { appendEvent } from '../src/modules/events/store.js';
import { hostIdOf } from '../src/modules/network/join.js';
import { thisMachine } from '../src/modules/network/store.js';
import { builtinOf, identityOf } from '../src/modules/nodes/hub.js';
import { approvalAsked, as, connectNode, invitePerson, listen, mcp, setUpCompany, testApp, until } from './helpers.js';
import { companyRows, testComputers } from './helpers-computer.js';
import { prepareSharedDatabase } from './helpers-db.js';

await prepareSharedDatabase();

const NODE_KEY = 'k'.repeat(40);
const TOKEN = 'tool-token-0123456789abcdef0123456789';
/* A wait for a command's answer that no test outlasts, for commands that are answered. */
const NEVER_MS = 2_147_483_647;
/* The server's own machine, with no name its keeper told yet, which the CEO owns. */
const HOST_ID = hostIdOf('server-0001-abcd');
/* The built-in node of the machine this test's server runs on. */
const BUILTIN = builtinOf(HOST_ID);

/* A company whose server's own machine has its keeper asking, with its updater alive, and a running turn of the
   orchestrator that answers the CEO. */
async function company({ updater = true, env = {} as NodeJS.ProcessEnv } = {}) {
  const control = mkdtempSync(join(tmpdir(), 'hh-control-'));
  const { app, db } = await testApp({ NODE_KEY, HORNHOOF_CONTROL_DIR: control, HORNHOOF_MACHINE_ID: HOST_ID, ...env });
  const url = await listen(app);
  const ceo = await companyRows(app, 'computer company', () => setUpCompany(app), vi.isFakeTimers() ? new Date() : undefined);
  const [acme] = await db.select().from(companies);
  const machine = (await thisMachine(db, app.ctx.config, acme!.id)).id;
  testComputers(app).seen(machine, updater);
  const builtin = await connectNode(url, NODE_KEY);
  onTestFinished(() => builtin.close());
  builtin.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [] });
  await until(async () => (await db.select().from(subscriptions))[0]!.status === 'ready');
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [sub] = await db.select().from(subscriptions);
  await until(() => app.ctx.hub.isReady(identityOf(sub!, null, null, BUILTIN)!));
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  /* A turn that answers the CEO is one the CEO started. */
  const running = (token: string, answersCeo: boolean) =>
    db.insert(jobs).values({ companyId: orchestrator!.companyId, subscriptionId: sub!.id, agentId: orchestrator!.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(token), answersCeo, createdBy: answersCeo ? owner!.id : null });
  await running(TOKEN, true);
  return { app, db, ceo, control, machine, orchestrator: orchestrator!, running, builtin };
}

type Company = Awaited<ReturnType<typeof company>>;

/* The same access with another wait for a command's answer. */
function withWait(c: Pick<Company, 'app' | 'machine'>, waitMs: number): Computers {
  const computer = testComputers(c.app, { waitMs });
  computer.seen(c.machine, true);
  return computer;
}

/* The commands that wait for the machine's keeper or are out with it. */
async function checkOpen(c: Company, client: Awaited<ReturnType<typeof mcp>>) {
  const [ran] = await Promise.all([call(client, 'computer', { command: 'df -h' }), answerAs(c, 'Plenty.\n')]);
  expect(text(ran)).toBe('Exit code 0.\nPlenty.\n');
}

const pending = (db: Company['db']) => db.select(idOnly(computerRuns)).from(computerRuns).where(inArray(computerRuns.state, ['waiting', 'sent']));


type Result = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Result;
const text = (res: Result) => res.content[0]!.text;
const lines = async (db: Awaited<ReturnType<typeof company>>['db'], agentId: string) =>
  (await db.select().from(agentEvents).where(and(eq(agentEvents.agentId, agentId), eq(agentEvents.kind, 'computer')))).map(e => e.data);

/* The machine's keeper's side: takes the next command and answers it with this output. */
async function answerAs(c: Pick<Company, 'app' | 'machine'>, output: string, exit = 0) {
  let run: { id: string; command: string; timeout: number } | undefined;
  await until(async () => (run = (await c.app.ctx.computer.take(c.machine, [])).runs[0]) !== undefined);
  expect(await c.app.ctx.computer.answer(c.machine, run!.id, { exit, output })).toBe(true);
  return run!;
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

async function startRetry(c: Company) {
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, c.orchestrator.id));
  await enqueueTurn(c.app.ctx, { companyId: c.orchestrator.companyId, agentId: c.orchestrator.id, prompt: 'Inspect service logs.', createdBy: null, message: { personId: null, text: 'Inspect service logs.', notification: { source: 'wait_ended', tasks: [] } } });
  let opened = await c.builtin.next();
  while (opened.type !== 'job.run') opened = await c.builtin.next();
  return retryTurnOn(c, opened.jobId);
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
  it("runs the orchestrator's command through the updater and gives back the exit code and output", async () => {
    const c = await company();
    const { app, ceo } = c;
    await app.inject({ method: 'POST', url: '/api/computer/open', ...as(ceo) });
    const client = await mcp(app, TOKEN);
    const [res, asked] = await Promise.all([call(client, 'computer', { command: 'uname -a', timeoutSeconds: 30 }), answerAs(c, 'Linux debian 6.12\n', 3)]);
    expect(asked).toMatchObject({ command: 'uname -a', timeout: 30 });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toBe('Exit code 3.\nLinux debian 6.12\n');
  });

  /* Codex gives up on a tool after a minute, so a long command answers that it runs, and its result comes later. */
  it('tells the orchestrator a long command still runs, and gives its result when asked for it', async () => {
    const c = await company();
    const { app, ceo } = c;
    const computer = withWait(c, 300);
    const waits = vi.spyOn(computer, 'wait');
    await app.inject({ method: 'POST', url: '/api/computer/open', ...as(ceo) });
    const client = await mcp(app, TOKEN);
    /* The wait for an answer runs on a clock that stands still until the test moves it past the wait, once that wait began. */
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => { vi.useRealTimers(); });
    const outwaited = async <T>(asked: Promise<T>, waited: number): Promise<T> => {
      await until(() => waits.mock.calls.length === waited);
      vi.advanceTimersByTime(300);
      return asked;
    };
    const started = await outwaited(call(client, 'computer', { command: 'apt-get upgrade -y', timeoutSeconds: 900 }), 1);
    expect(started.isError).toBeFalsy();
    const id = text(started).match(/computer_result with id ([0-9a-f-]{36})/)![1]!;
    expect(text(started)).toMatch(/^Still running\./);
    expect(text(await outwaited(call(client, 'computer_result', { id }), 2))).toMatch(/^Still running\./);
    await answerAs(c, 'Upgraded 3 packages.\n');
    expect(text(await call(client, 'computer_result', { id }))).toBe('Exit code 0.\nUpgraded 3 packages.\n');
    /* The answer is kept for a day, and a command nobody made is none. */
    expect(text(await call(client, 'computer_result', { id }))).toBe('Exit code 0.\nUpgraded 3 packages.\n');
    const gone = await call(client, 'computer_result', { id: '0f0f0f0f-0000-4000-8000-00000000000a' });
    expect(gone.isError).toBe(true);
  });

  it('refuses commands while the owner keeps access closed and runs them in any turn after reopening, including after an Enter in its terminal', async () => {
    const c = await company();
    const { app, db, ceo, orchestrator, running } = c;
    expect((await app.inject({ method: 'POST', url: '/api/computer/close', ...as(ceo) })).statusCode).toBe(200);
    const closed = await call(await mcp(app, TOKEN), 'computer', { command: 'uname -a' });
    expect(text(closed)).toBe('The owner closed access to the company server.');
    withWait(c, NEVER_MS);
    await app.inject({ method: 'POST', url: '/api/computer/open', ...as(ceo) });
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator.id));
    /* A turn nobody started and no person wrote into, and one with a notice of Hornhoof in it: the access holds in both. */
    const woke = 'tool-token-woke-0123456789abcdef0123';
    await running(woke, false);
    const [first] = await Promise.all([call(await mcp(app, woke), 'computer', { command: 'uname -a' }), answerAs(c, 'Linux\n')]);
    expect(text(first)).toBe('Exit code 0.\nLinux\n');
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const [wokeJob] = await db.update(jobs).set({ createdBy: owner!.id }).where(and(eq(jobs.agentId, orchestrator.id), eq(jobs.status, 'running'))).returning();
    await appendEvent(app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, jobId: wokeJob!.id, kind: 'message', data: { text: 'Hornhoof notice.', notification: { source: 'wait_ended', tasks: [] } } });
    const [second] = await Promise.all([call(await mcp(app, woke), 'computer', { command: 'uptime' }), answerAs(c, 'up 2 days\n')]);
    expect(text(second)).toBe('Exit code 0.\nup 2 days\n');
    /* An Enter with no known speaker keeps the same access. */
    await db.update(jobs).set({ answersCeo: true }).where(eq(jobs.id, wokeJob!.id));
    await appendEvent(app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, jobId: wokeJob!.id, kind: 'typed', data: {}, personId: null });
    await checkOpen(c, await mcp(app, woke));
    expect(await pending(c.db)).toEqual([]);
  });

  it("keeps working on the open machine in later turns, woken by an employee's letter or by a wake, with no new word of the CEO, until access closes", async () => {
    const c = await company();
    const { app, db, ceo, orchestrator, builtin } = c;
    withWait(c, NEVER_MS);
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator.id));

    const [sub] = await db.select().from(subscriptions);
    const [ops] = await db.insert(departments).values({ companyId: orchestrator.companyId, templateKey: 'operations', roleCode: 'OPS' }).returning();
    const [head] = await db.insert(agents).values({ companyId: orchestrator.companyId, kind: 'head', name: 'Hana', model: 'claude-opus-5-5', roleKey: 'OPS-HEAD', departmentId: ops!.id, subscriptionId: sub!.id, skills: [] }).returning();
    const nextTurn = async (message: { text: string; from?: 'agent'; name?: string; by?: string; notification?: { source: 'wait_ended'; tasks: [] } }) => {
      await enqueueTurn(app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, prompt: message.text, createdBy: null, message: { personId: null, ...message } });
      let run = await builtin.next();
      while (run.type !== 'job.run') run = await builtin.next();
      return run;
    };
    /* Hana's letter wakes a turn of its own: the access her letter did not open still holds in it. */
    const byLetter = await nextTurn({ text: 'The disk of the server is full again.', from: 'agent', name: 'Hana', by: head!.id });
    const [onLetter] = await Promise.all([call(await mcp(app, byLetter.toolToken!), 'computer', { command: 'docker image prune -f' }), answerAs(c, 'Reclaimed 3 GB.\n')]);
    expect(text(onLetter)).toBe('Exit code 0.\nReclaimed 3 GB.\n');
    builtin.send({ type: 'job.done', jobId: byLetter.jobId, ok: true, sessionId: 'session', result: 'Done.', tail: '', error: null });
    await until(async () => (await db.select().from(jobs).where(eq(jobs.id, byLetter.jobId)))[0]!.status === 'done');

    /* A wake of its own timer, as a wait ends. */
    const byWake = await nextTurn({ text: 'The wait for the disk check ended.', notification: { source: 'wait_ended', tasks: [] } });
    const wakeClient = await mcp(app, byWake.toolToken!);
    const [onWake] = await Promise.all([call(wakeClient, 'computer', { command: 'df -h' }), answerAs(c, 'Plenty.\n')]);
    expect(text(onWake)).toBe('Exit code 0.\nPlenty.\n');

    expect((await app.inject({ method: 'POST', url: '/api/computer/close', ...as(ceo) })).statusCode).toBe(200);
    const shut = await call(wakeClient, 'computer', { command: 'df -h' });
    expect(shut.isError).toBe(true);
    expect(text(shut)).toBe('The owner closed access to the company server.');
    expect(await pending(c.db)).toEqual([]);
  });

  it("keeps computer access and owner authority after another person writes into the turn", async () => {
    const c = await company();
    const { app, db, ceo, orchestrator, builtin } = c;
    withWait(c, NEVER_MS);
    await invitePerson(app, ceo, { name: 'Zed', email: 'zed@example.com', access: { whole: true } });
    const [zed] = await db.select().from(people).where(eq(people.name, 'Zed'));
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator.id));
    await enqueueTurn(app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, prompt: 'Free disk space.', createdBy: null, message: { personId: null, text: 'Free disk space.', notification: { source: 'wait_ended', tasks: [] } } });
    let note = await builtin.next();
    while (note.type !== 'job.run') note = await builtin.next();
    const client = await mcp(app, note.toolToken!);
    const [ran] = await Promise.all([call(client, 'computer', { command: 'df -h' }), answerAs(c, 'Plenty.\n')]);
    expect(text(ran)).toBe('Exit code 0.\nPlenty.\n');
    /* What only the CEO may, the orchestrator does in any turn as the owner, regardless of who started it. */
    const request = await approvalAsked(app);
    expect((await call(client, 'answer_request', { request: request.id, approve: true })).isError).toBeFalsy();
    expect((await db.select().from(requests).where(eq(requests.id, request.id)))[0]).toMatchObject({ status: 'approved' });
    expect((await call(client, 'invite_person', { name: 'Eve', email: 'eve@example.com', title: '', access: { whole: true } })).isError).toBeFalsy();
    expect((await db.select().from(people).where(eq(people.name, 'Eve')))).toHaveLength(1);
    await appendEvent(app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, jobId: note.jobId, kind: 'message', data: { text: 'Check the disk.' }, personId: zed!.id });
    await checkOpen(c, client);
    expect(await pending(c.db)).toEqual([]);
  });

  it('keeps computer access in a running turn when Hornhoof types improvement notices or an employee writes into it', async () => {
    const c = await company();
    const { app, db, ceo, orchestrator, builtin } = c;
    withWait(c, NEVER_MS);
    await invitePerson(app, ceo, { name: 'Zed', email: 'zed@example.com', access: { whole: true } });
    const [zed] = await db.select().from(people).where(eq(people.name, 'Zed'));

    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator.id));
    builtin.send({ type: 'hello', version: '0.6.0', loggedIn: true, terminals: true, running: [] });
    await until(() => app.ctx.hub.hasTerminals(BUILTIN));
    await enqueueTurn(app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, prompt: 'Inspect service logs.', createdBy: null, message: { personId: null, text: 'Inspect service logs.', notification: { source: 'wait_ended', tasks: [] } } });
    let note = await builtin.next();
    while (note.type !== 'job.run') note = await builtin.next();
    const client = await mcp(app, note.toolToken!);

    const [first] = await Promise.all([call(client, 'computer', { command: 'df -h' }), answerAs(c, 'Plenty.\n')]);
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
    const [sub] = await db.select().from(subscriptions);
    const [ops] = await db.insert(departments).values({ companyId: orchestrator.companyId, templateKey: 'operations', roleCode: 'OPS' }).returning();
    const [hana] = await db.insert(agents).values({ companyId: orchestrator.companyId, kind: 'head', name: 'Hana', model: 'claude-opus-5-5', roleKey: 'OPS-HEAD', departmentId: ops!.id, subscriptionId: sub!.id, skills: [] }).returning();
    await appendEvent(app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, jobId: note.jobId, kind: 'message', data: { text: 'Checks finished.', from: 'agent', name: 'Hana', by: hana!.id } });
    const events = await db.select().from(agentEvents).where(and(eq(agentEvents.jobId, note.jobId), eq(agentEvents.kind, 'message')));
    expect(events.length).toBe(6);

    const answering = answerAs(c, 'Healthy.\n').catch(() => null);
    const second = await call(client, 'computer', { command: 'journalctl -n 5' });
    expect(text(second)).toBe('Exit code 0.\nHealthy.\n');
    await answering;
    expect((await call(client, 'invite_person', { name: 'Eve', email: 'eve@example.com', title: '', access: { whole: true } })).isError).toBeFalsy();

    await appendEvent(app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, jobId: note.jobId, kind: 'message', data: { text: 'Check the disk.' }, personId: zed!.id });
    await checkOpen(c, client);
  });

  it('keeps computer access on a second retry after pending input was not kept on the first retry', async () => {
    const c = await company();
    withWait(c, NEVER_MS);
    await invitePerson(c.app, c.ceo, { name: 'Zed', email: 'zed@example.com', access: { whole: true } });
    const [zed] = await c.db.select().from(people).where(eq(people.name, 'Zed'));

    const retried = await startRetry(c);
    c.builtin.send({ type: 'hello', version: '0.6.0', loggedIn: true, terminals: true, running: [retried.jobId] });
    await until(() => c.app.ctx.hub.hasTerminals(BUILTIN));
    const retryClient = await mcp(c.app, retried.toolToken!);
    const [first] = await Promise.all([call(retryClient, 'computer', { command: 'df -h' }), answerAs(c, 'Plenty.\n')]);
    expect(text(first)).toBe('Exit code 0.\nPlenty.\n');

    const unkept = deliverLive(c.app.ctx, c.orchestrator.id, 'Stop.', { source: { personId: zed!.id, data: { text: 'Stop.' } } }, async () => {});
    let say = await c.builtin.next();
    while (say.type !== 'agent.say') say = await c.builtin.next();
    c.builtin.send({ type: 'agent.said', ref: say.ref, ok: false });
    expect(await unkept).toBeNull();
    await checkOpen(c, retryClient);

    const secondRetry = await retryTurnOn(c, retried.jobId);
    await checkOpen(c, await mcp(c.app, secondRetry.toolToken!));
    expect(await pending(c.db)).toEqual([]);
  });

  it.each(['unheard', 'queued'] as const)('keeps computer access when saved words are replayed via %s after a non-CEO message', async mode => {
    const c = await company();
    withWait(c, NEVER_MS);
    await invitePerson(c.app, c.ceo, { name: 'Zed', email: 'zed@example.com', access: { whole: true } });
    const [zed] = await c.db.select().from(people).where(eq(people.name, 'Zed'));

    const retried = await startRetry(c);
    const [marked] = await c.db.select().from(agentEvents).where(and(eq(agentEvents.jobId, retried.jobId), eq(agentEvents.kind, 'typed')));
    const { data, message } = readMessage(marked!.data);
    const replayText = addressed((data as { text: string }).text, message!);

    const validReplay = await replaySavedWords(c, mode, retried.jobId, replayText);
    const [first] = await Promise.all([call(await mcp(c.app, validReplay.toolToken), 'computer', { command: 'df -h' }), answerAs(c, 'Plenty.\n')]);
    expect(text(first)).toBe('Exit code 0.\nPlenty.\n');

    await appendEvent(c.app.ctx, { companyId: c.orchestrator.companyId, agentId: c.orchestrator.id, jobId: validReplay.jobId, kind: 'message', data: { text: 'Check the disk.' }, personId: zed!.id });
    const afterZed = await replaySavedWords(c, mode, validReplay.jobId, replayText);
    await checkOpen(c, await mcp(c.app, afterZed.toolToken));
    expect(await pending(c.db)).toEqual([]);
  });

  it.each(['unheard', 'queued'] as const)('keeps computer access when live input lands between the %s replay read and its store', async mode => {
    const c = await company();
    withWait(c, NEVER_MS);
    await invitePerson(c.app, c.ceo, { name: 'Zed', email: 'zed@example.com', access: { whole: true } });
    const [zed] = await c.db.select().from(people).where(eq(people.name, 'Zed'));

    const retried = await startRetry(c);
    c.builtin.send({ type: 'hello', version: '0.6.0', loggedIn: true, terminals: true, running: [retried.jobId] });
    await until(() => c.app.ctx.hub.hasTerminals(BUILTIN));
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
    await checkOpen(c, await mcp(c.app, retried.toolToken!));

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
    await checkOpen(c, await mcp(c.app, replayToken));
    expect(await pending(c.db)).toEqual([]);
  });

  it("names the machine by the name its keeper told, in what its owner sees and in the log", async () => {
    const c = await company();
    const { app, db, ceo, orchestrator } = c;
    await db.update(machines).set({ hostname: 'debian-box' }).where(eq(machines.id, c.machine));
    expect((await app.inject({ method: 'GET', url: '/api/computer', ...as(ceo) })).json().machine).toBe('debian-box');
    await app.inject({ method: 'POST', url: '/api/computer/close', ...as(ceo) });
    expect((await app.inject({ method: 'POST', url: '/api/computer/open', ...as(ceo) })).json().machine).toBe('debian-box');
    expect(await lines(db, orchestrator.id)).toEqual([
      { state: 'closed', machine: 'debian-box' }, { state: 'reopened', machine: 'debian-box' },
    ]);
  });

  it('is not offered on a server without an updater', async () => {
    const c = await company({ updater: false });
    const { app, ceo } = c;
    expect((await app.inject({ method: 'GET', url: '/api/computer', ...as(ceo) })).json()).toMatchObject({ available: false });
    const asked = await call(await mcp(app, TOKEN), 'computer', { command: 'uname' });
    expect(asked.isError).toBe(true);
    expect(text(asked)).toContain('cannot reach');
  });
});

describe('a new installation', () => {
  it("lets the orchestrator clear another employee's inbox and work on the opened machine in a later turn, with nothing set up for it", async () => {
    const c = await company();
    const { app, db, orchestrator, builtin } = c;
    withWait(c, NEVER_MS);
    const [sub] = await db.select().from(subscriptions);
    const [ops] = await db.insert(departments).values({ companyId: orchestrator.companyId, templateKey: 'operations', roleCode: 'OPS' }).returning();
    const [hana] = await db.insert(agents).values({ companyId: orchestrator.companyId, kind: 'head', name: 'Hana', model: 'claude-opus-5-5', roleKey: 'OPS-HEAD', departmentId: ops!.id, subscriptionId: sub!.id, skills: [] }).returning();
    await db.insert(agentInbox).values(['Bruno', 'Rita', 'Sara'].map(name => ({ companyId: orchestrator.companyId, agentId: hana!.id, senderKind: 'hornhoof' as const, senderName: 'Hornhoof', kind: 'notification' as const, source: 'program_alarm', text: `${name} has given no sign of life for 20 minutes.`, createdAt: new Date() })));

    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator.id));

    /* A later turn a wake started, with no word of the CEO in it. */
    await enqueueTurn(app.ctx, { companyId: orchestrator.companyId, agentId: orchestrator.id, prompt: 'The wait for the alarms ended.', createdBy: null, message: { personId: null, text: 'The wait for the alarms ended.', notification: { source: 'wait_ended', tasks: [] } } });
    let wake = await builtin.next();
    while (wake.type !== 'job.run') wake = await builtin.next();
    const client = await mcp(app, wake.toolToken!);
    const letters = JSON.parse(text(await call(client, 'inbox', { employee: hana!.id }))) as { letters: { text: string }[] };
    expect(letters.letters.map(l => l.text)).toEqual(['Bruno has given no sign of life for 20 minutes.', 'Rita has given no sign of life for 20 minutes.', 'Sara has given no sign of life for 20 minutes.']);
    const marked = await call(client, 'inbox_mark', { employee: hana!.id, status: 'done', source: 'program_alarm', receivedBefore: new Date(Date.now() + 1000).toISOString(), reason: 'Stale alarms after the outage.' });
    expect(text(marked)).toBe("Marked 3 letters done in Hana's inbox.");
    const [logged] = (await db.select().from(agentEvents).where(and(eq(agentEvents.agentId, hana!.id), eq(agentEvents.kind, 'message')))).map(e => e.data as { text: string });
    expect(logged!.text).toBe('Orchestrator marked 3 letters done in this inbox. Why: Stale alarms after the outage.');
    const [ran] = await Promise.all([call(client, 'computer', { command: 'df -h' }), answerAs(c, 'Plenty.\n')]);
    expect(text(ran)).toBe('Exit code 0.\nPlenty.\n');

    /* Every new company's orchestrator is told so in its skills. */
    for (const [id, rule] of [['orch-trouble', /Any employee's inbox is open to you/], ['orch-resources', /in any turn or tool step, whoever started it/]] as const) {
      expect(ORCHESTRATOR_SKILLS as readonly string[]).toContain(id);
      expect(app.ctx.templates.skills.get(id)!.body, id).toMatch(rule);
    }
  });
});
