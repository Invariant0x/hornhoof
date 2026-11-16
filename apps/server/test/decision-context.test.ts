import { randomUUID } from 'node:crypto';
import type { ServerMessage } from '@hornhoof/protocol';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { orchestratorDecisionHeaders } from '../src/auth/internal.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agentInbox, agents, companies, departments, jobs, people, proposals, requests, subscriptions, taskEvents, teams } from '../src/db/schema.js';
import { ceoPrincipal, decisionPrincipal, machinePrincipal, typedWentIn, withInputLock } from '../src/modules/conversation/decision-context.js';
import { said } from '../src/modules/conversation/live.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { repeatedTurn } from '../src/modules/conversation/turn-words.js';
import { agentParty, personParty } from '../src/modules/events/parties.js';
import { appendEvent, appendOutgoing, earlierTalk, listEvents } from '../src/modules/events/store.js';
import { BUILTIN } from './builtin.js';
import { answerDirectly, ask, createTask } from '../src/modules/tasks/engine.js';
import { logTurnFact } from '../src/modules/tasks/turn-log.js';
import { ONLY_CEO_ASKED } from '../src/modules/tools/control.js';
import { as, invitePerson, listen, mcp, setUpCompany, testApp, until } from './helpers.js';

/* Whose input lock decisions asked for, in order: a decision the orchestrator takes waits there for words going in. */
const locks = vi.hoisted(() => [] as string[]);
vi.mock('../src/modules/conversation/decision-context.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/modules/conversation/decision-context.js')>();
  return { ...real, lockedFor: ((ctx, on, fn) => { if (on) locks.push(on.agentId); return real.lockedFor(ctx, on, fn); }) as typeof real.lockedFor };
});

const TOKEN = 'tool-token-decisions-0123456789abcdef';
type Say = Extract<ServerMessage, { type: 'agent.say' }>;
type Result = { content: { type: string; text: string }[]; isError?: boolean };

/* Acme with Development, its head Hana and Bruno; Dan of Development, Zed of the whole company without the mark and Dave
   the CEO delegate; the orchestrator's running turn, which nobody wrote into yet. */
async function company() {
  const { app, db } = await testApp();
  await listen(app);
  const ceo = await setUpCompany(app);
  const ctx = app.ctx;
  const [acme] = await db.select().from(companies);
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId: acme!.id, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const tokens = {
    ceo,
    dan: await invitePerson(app, ceo, { name: 'Dan', email: 'dan@acme.com', access: { departments: [dev!.id] } }),
    zed: await invitePerson(app, ceo, { name: 'Zed', email: 'zed@acme.com', access: { whole: true } }),
    dave: await invitePerson(app, ceo, { name: 'Dave', email: 'dave@acme.com', access: { whole: true } }),
  };
  const ids = Object.fromEntries((await db.select().from(people)).map(p => [p.name.toLowerCase(), p.id])) as Record<'ivan' | 'dan' | 'zed' | 'dave', string>;
  await app.inject({ method: 'PUT', url: `/api/people/${ids.dave}/ceo-delegate`, payload: { isCeoDelegate: true }, ...as(ceo) });
  const [job] = await db
    .insert(jobs)
    .values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: orchestrator!.id, kind: 'conversation', prompt: '', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(TOKEN) })
    .returning();
  const { task } = await createTask(ctx, { agentId: hana.id }, { title: 'Checkout', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true });
  /* Words into the orchestrator's turn, kept as the window keeps them. */
  const wrote = async (personId: string | null, text = 'Go on.', extra: Record<string, unknown> = {}) =>
    (await appendEvent(ctx, { companyId: acme!.id, agentId: orchestrator!.id, jobId: job!.id, kind: 'message', data: { text, ...extra }, personId })).seq;
  const asking = async (q: Parameters<typeof ask>[3]) => (await ask(ctx, bruno.id, task.id, q)).request;
  const open = async (id: string) => (await db.select().from(requests).where(eq(requests.id, id)))[0]!.status === 'open';
  return { app, db, ctx, acme: acme!, sub: sub!, orchestrator: orchestrator!, dev: dev!, hana, bruno, task, job: job!, tokens, ids, wrote, asking, open };
}

const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Result;
const text = (r: Result) => r.content[0]!.text;

describe('the person an orchestrator turn answers', () => {
  it('keeps the CEO as principal after a visible turn fact on the agent and task', async () => {
    const c = await company();
    const sourceSeq = await c.wrote(c.ids.ivan, 'Approve it.');
    const text = 'Operations requested a program restart.';
    await c.db.update(jobs).set({ answersCeo: true, taskId: c.task.id }).where(eq(jobs.id, c.job.id));

    await logTurnFact(c.ctx, { ...c.job, taskId: c.task.id }, text);

    expect(await decisionPrincipal(c.db, c.job.id)).toEqual({ personId: c.ids.ivan, sourceSeq });
    expect((await listEvents(c.db, c.orchestrator.id, 0)).some(e => e.kind === 'message' && (e.data as { text?: string }).text === text)).toBe(true);
    expect(await c.db.select().from(taskEvents).where(eq(taskEvents.taskId, c.task.id))).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'comment', text: `${c.orchestrator.name}: ${text}` })]));
    await c.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, c.job.id));
    expect((await earlierTalk(c.db, c.orchestrator.id)).some(e => (e.data as { text?: string }).text === text)).toBe(false);
  });

  it('is the last person who wrote into it, unchanged by a letter of an agent or notices of Hornhoof', async () => {
    const c = await company();
    expect(await decisionPrincipal(c.db, c.job.id)).toBeNull();
    await c.wrote(null, 'Please approve my commit.', { from: 'agent', name: 'Hana', by: c.hana.id });
    await c.wrote(null, 'Hornhoof: #1 moved.', { task: { id: c.task.id, number: 1 } });
    expect(await decisionPrincipal(c.db, c.job.id)).toBeNull();
    const first = await c.wrote(c.ids.ivan, 'Approve it.');
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual({ personId: c.ids.ivan, sourceSeq: first });
    await c.wrote(null, 'Please approve my commit.', { from: 'agent', name: 'Hana', by: c.hana.id });
    await c.wrote(null, 'Ivan took an improvement into work: "Logs".');
    await c.wrote(null, 'Ivan took an improvement into work: "Retries".');
    await c.wrote(null, 'Hornhoof: #1 moved.', { task: { id: c.task.id, number: 1 } });
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual({ personId: c.ids.ivan, sourceSeq: first });
    const zeds = await c.wrote(c.ids.zed, 'Approve it.');
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual({ personId: c.ids.zed, sourceSeq: zeds });
    await c.wrote(null, 'Hornhoof: #1 moved.', { task: { id: c.task.id, number: 1 } });
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual({ personId: c.ids.zed, sourceSeq: zeds });
  });

  it('is not changed by the copy of a letter the orchestrator itself sent', async () => {
    const c = await company();
    const ceos = await c.wrote(c.ids.ivan);
    await appendOutgoing(c.ctx, { companyId: c.acme.id, agentId: c.orchestrator.id, jobId: c.job.id, text: 'Please merge #1.', to: await personParty(c.ctx, c.acme.id, c.ids.zed) });
    const kept = await c.db.select().from(agentEvents).where(and(eq(agentEvents.jobId, c.job.id), eq(agentEvents.kind, 'message')));
    expect(kept.length).toBeGreaterThan(1);
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual({ personId: c.ids.ivan, sourceSeq: ceos });
  });

  it('is whoever started a turn without messages, nobody for one Hornhoof started, and nobody once it ended or while words are on their way', async () => {
    const c = await company();
    expect(await decisionPrincipal(c.db, c.job.id)).toBeNull();
    await c.db.update(jobs).set({ createdBy: c.ids.dave }).where(eq(jobs.id, c.job.id));
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual({ personId: c.ids.dave, sourceSeq: null });
    await c.db.update(jobs).set({ decisionInputPending: true }).where(eq(jobs.id, c.job.id));
    expect(await decisionPrincipal(c.db, c.job.id)).toBeNull();
    await c.db.update(jobs).set({ decisionInputPending: false, status: 'done' }).where(eq(jobs.id, c.job.id));
    expect(await decisionPrincipal(c.db, c.job.id)).toBeNull();
    const [workerTurn] = await c.db
      .insert(jobs)
      .values({ companyId: c.acme.id, subscriptionId: c.sub.id, agentId: c.bruno.id, kind: 'conversation', prompt: 'x', timeoutMs: 1000, status: 'running', createdBy: c.ids.ivan })
      .returning();
    expect(await decisionPrincipal(c.db, workerTurn!.id)).toBeNull();
  });
});

describe("the person a department head's turn answers", () => {
  it("is found as for the orchestrator's: the last person who wrote or typed into it, through their assistant too, never an agent or a notice", async () => {
    const c = await company();
    const [turn] = await c.db
      .insert(jobs)
      .values({ companyId: c.acme.id, subscriptionId: c.sub.id, agentId: c.hana.id, kind: 'conversation', prompt: 'x', timeoutMs: 1000, status: 'running', createdBy: c.ids.dan })
      .returning();
    const wrote = async (personId: string | null, text: string, extra: Record<string, unknown> = {}) =>
      (await appendEvent(c.ctx, { companyId: c.acme.id, agentId: c.hana.id, jobId: turn!.id, kind: 'message', data: { text, ...extra }, personId })).seq;
    expect(await decisionPrincipal(c.db, turn!.id)).toEqual({ personId: c.ids.dan, sourceSeq: null });
    const dans = await wrote(c.ids.dan, 'Make a Mobile sub-unit.');
    await wrote(null, 'Please approve my commit.', { from: 'agent', name: 'Bruno', by: c.bruno.id });
    await wrote(null, 'Hornhoof: #1 moved.', { task: { id: c.task.id, number: 1 } });
    expect(await decisionPrincipal(c.db, turn!.id)).toEqual({ personId: c.ids.dan, sourceSeq: dans });
    const ivans = await wrote(c.ids.ivan, 'Hire two developers.', { channel: 'assistant', assistant: { id: randomUUID(), name: 'Ava', message: randomUUID() } });
    expect(await decisionPrincipal(c.db, turn!.id)).toEqual({ personId: c.ids.ivan, sourceSeq: ivans });
    await typedWentIn(c.ctx, c.hana.id, c.ids.dan);
    expect((await decisionPrincipal(c.db, turn!.id))?.personId).toBe(c.ids.dan);
    await c.db.update(jobs).set({ decisionInputPending: true }).where(eq(jobs.id, turn!.id));
    expect(await decisionPrincipal(c.db, turn!.id)).toBeNull();
  });
});

describe('tools only the CEO asks for, in a turn', () => {
  const ONLY_CEO = 'Only the CEO or the CEO delegate can ask for this, in a turn that answers them: the last person who wrote into it. Nothing was changed. Ask the CEO first.';

  /* The CEO's turn as the window keeps one: the CEO wrote into it. */
  async function ceoTurn() {
    const c = await company();
    await c.db.update(jobs).set({ answersCeo: true }).where(eq(jobs.id, c.job.id));
    await c.wrote(c.ids.ivan, 'Look after the team.');
    const person = async (id: string) => (await c.db.select().from(people).where(eq(people.id, id)))[0]!;
    return { ...c, client: await mcp(c.app, TOKEN), person };
  }

  it('go by the person the turn answers now: after a person without the right wrote, they change nobody and nothing', async () => {
    const c = await ceoTurn();
    await c.wrote(c.ids.zed, 'Disable Dave.');
    const asked: [string, Record<string, unknown>][] = [
      ['change_person', { person: c.ids.dave, status: 'disabled' }],
      ['invite_again', { person: c.ids.dave }],
      ['invite_person', { name: 'Eve', email: 'eve@acme.com', title: '', access: { whole: true } }],
    ];
    for (const [name, args] of asked) {
      const refused = await call(c.client, name, args);
      expect(refused.isError, name).toBe(true);
      expect(text(refused), name).toBe(ONLY_CEO);
    }
    expect(await c.person(c.ids.dave)).toMatchObject({ status: 'active', scopeKind: 'company', isCeoDelegate: true });
    expect((await c.db.select().from(people)).map(p => p.name).sort()).toEqual(['Dan', 'Dave', 'Ivan', 'Zed']);
    /* The CEO's word again: the turn may. */
    await c.wrote(c.ids.ivan, 'Disable Dave.');
    expect((await call(c.client, 'change_person', { person: c.ids.dave, status: 'disabled' })).isError).toBeFalsy();
    expect(await c.person(c.ids.dave)).toMatchObject({ status: 'disabled', isCeoDelegate: false });
  });

  it("go as the CEO delegate in a turn that answers the delegate, whose own limits the routes see", async () => {
    const c = await ceoTurn();
    await c.wrote(c.ids.dave, 'Give me only Development.');
    const locked = await call(c.client, 'change_person', { person: c.ids.dave, access: { departments: [c.dev.id] } });
    expect(locked.isError).toBe(true);
    expect(text(locked)).toBe('Only the CEO changes the access or status of the CEO delegate.');
    expect(await c.person(c.ids.dave)).toMatchObject({ scopeKind: 'company', isCeoDelegate: true });
    /* What the delegate may do on their own screen, the turn does for them. */
    expect((await call(c.client, 'change_person', { person: c.ids.zed, title: 'Sales' })).isError).toBeFalsy();
    expect(await c.person(c.ids.zed)).toMatchObject({ title: 'Sales' });
  });

  it("refuse an employee's own subscription and skills that grant tools after a person without the right wrote", async () => {
    const c = await ceoTurn();
    await c.wrote(c.ids.zed, 'Move yourself.');
    expect(text(await call(c.client, 'change_employee', { employee: c.orchestrator.id, subscription: c.sub.id }))).toBe(ONLY_CEO);
    await c.wrote(c.ids.ivan, 'Move yourself.');
    expect((await call(c.client, 'change_employee', { employee: c.orchestrator.id, subscription: c.sub.id })).isError).toBeFalsy();
  });
});

describe('answer_request in a turn', () => {
  it('takes a decision only the CEO takes in a turn that answers the CEO or the delegate, and keeps for whom', async () => {
    const c = await company();
    const client = await mcp(c.app, TOKEN);
    for (const who of ['ivan', 'dave'] as const) {
      const request = await c.asking({ kind: 'approval', text: 'Merge?', commit: (who === 'ivan' ? 'a' : 'b').repeat(40) });
      const seq = await c.wrote(c.ids[who], 'Approve the merge.');
      const res = await call(client, 'answer_request', { request: request.id, approve: true });
      expect(res.isError, text(res)).toBeFalsy();
      const [row] = await c.db.select().from(requests).where(eq(requests.id, request.id));
      expect(row).toMatchObject({ status: 'approved', answeredBy: c.ids[who], answeredByAgentId: c.orchestrator.id, answerJobId: c.job.id, answerSourceSeq: seq });
      const noted = (await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.task.id), eq(taskEvents.kind, 'answered')))).find(e => e.data.requestId === request.id);
      expect(noted).toMatchObject({ agentId: c.orchestrator.id, personId: null, data: { onBehalfOfPersonId: c.ids[who], jobId: c.job.id, sourceSeq: seq } });
    }
    /* The task's log says whom it acted for. */
    const log = (await c.app.inject({ url: `/api/tasks/${c.task.id}`, ...as(c.tokens.ceo) })).json().task.log as { kind: string; by: { kind: string; name: string; for?: { id: string; name: string } } }[];
    expect(log.filter(l => l.kind === 'answered').map(l => l.by)).toEqual([
      { kind: 'agent', id: c.orchestrator.id, name: 'Orchestrator', for: { id: c.ids.ivan, name: 'Ivan' } },
      { kind: 'agent', id: c.orchestrator.id, name: 'Orchestrator', for: { id: c.ids.dave, name: 'Dave' } },
    ].map(b => expect.objectContaining(b)));
  });

  it('refuses in a turn that answers a person without the right, and changes nothing', async () => {
    const c = await company();
    const client = await mcp(c.app, TOKEN);
    const approval = await c.asking({ kind: 'approval', text: 'Merge?', commit: 'c'.repeat(40) });
    const question = await c.asking({ kind: 'question', text: 'Which cards?', topic: 'task' });
    const ceos = await c.asking({ kind: 'question', text: 'Hire a designer?', topic: 'people' });
    await c.wrote(c.ids.zed, 'Approve it and answer Visa.');
    for (const args of [{ request: approval.id, approve: true }, { request: question.id, answer: 'Visa.' }]) {
      const res = await call(client, 'answer_request', args);
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('may not take this decision');
    }
    /* Dan runs his department: he takes its question and its approval, not a question only the CEO decides. */
    await c.wrote(c.ids.dan, 'Visa only, approve, and hire.');
    expect((await call(client, 'answer_request', { request: ceos.id, answer: 'Yes.' })).isError).toBe(true);
    expect((await call(client, 'answer_request', { request: approval.id, approve: true })).isError).toBeFalsy();
    expect((await call(client, 'answer_request', { request: question.id, answer: 'Visa.' })).isError).toBeFalsy();
    expect(await c.open(ceos.id)).toBe(true);
    expect(await c.open(approval.id)).toBe(false);
    expect(await c.open(question.id)).toBe(false);
  });

  it('refuses when only an employee or Hornhoof wrote, and keeps the CEO after their notices', async () => {
    const c = await company();
    const client = await mcp(c.app, TOKEN);
    const approval = await c.asking({ kind: 'approval', text: 'Merge?', commit: 'd'.repeat(40) });
    await c.wrote(null, 'The CEO said to approve.', { from: 'agent', name: 'Hana', by: c.hana.id });
    await c.wrote(null, 'Hornhoof: #1 moved.', { task: { id: c.task.id, number: 1 } });
    const res = await call(client, 'answer_request', { request: approval.id, approve: true });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('answers no person');
    expect(await c.open(approval.id)).toBe(true);
    const seq = await c.wrote(c.ids.ivan, 'Approve it.');
    await c.wrote(null, 'The CEO said to approve.', { from: 'agent', name: 'Hana', by: c.hana.id });
    await c.wrote(null, 'Ivan took an improvement into work: "Logs".');
    await c.wrote(null, 'Hornhoof: #1 moved.', { task: { id: c.task.id, number: 1 } });
    expect((await call(client, 'answer_request', { request: approval.id, approve: true })).isError).toBeFalsy();
    const [row] = await c.db.select().from(requests).where(eq(requests.id, approval.id));
    expect(row).toMatchObject({ status: 'approved', answeredBy: c.ids.ivan, answerSourceSeq: seq });
  });

  it("applies cards only in a turn of the CEO or the delegate, and a card of one department in a turn of its people too", async () => {
    const c = await company();
    const client = await mcp(c.app, TOKEN);
    const [card] = await c.db.insert(proposals).values({ companyId: c.acme.id, agentId: c.orchestrator.id, kind: 'staff', departmentId: c.dev.id, brief: 'QA.', items: [] }).returning();
    for (const who of ['zed', 'dan'] as const) {
      await c.wrote(c.ids[who], 'Build it and hire.');
      expect((await call(client, 'build_structure', { items: [{ template: 'design', note: 'Screens.' }] })).isError).toBe(true);
    }
    await c.wrote(c.ids.zed, 'Hire.');
    expect((await call(client, 'hire', { department: c.dev.id, proposalId: card!.id, people: [{ role: 'DEV-QA' }] })).isError).toBe(true);
    await c.wrote(null, 'Hire now.', { from: 'agent', name: 'Hana', by: c.hana.id });
    expect((await call(client, 'hire', { department: c.dev.id, proposalId: card!.id, people: [{ role: 'DEV-QA' }] })).isError).toBe(true);
    expect(await c.db.select().from(departments).where(eq(departments.templateKey, 'design'))).toEqual([]);
    expect((await c.db.select().from(proposals).where(eq(proposals.id, card!.id)))[0]!.status).toBe('pending');
    const seq = await c.wrote(c.ids.dave, 'Hire the QA.');
    expect((await call(client, 'hire', { department: c.dev.id, proposalId: card!.id, people: [{ role: 'DEV-QA' }] })).isError).toBeFalsy();
    expect((await c.db.select().from(proposals).where(eq(proposals.id, card!.id)))[0]).toMatchObject({ status: 'applied', appliedBy: c.ids.dave });
    const [applied] = await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.orchestrator.id), eq(agentEvents.kind, 'applied')));
    expect(applied!.data).toMatchObject({ onBehalfOfPersonId: c.ids.dave, jobId: c.job.id, sourceSeq: seq });
    /* Dan runs Development: a card that changes only its staff is his to apply. */
    const [his] = await c.db.insert(proposals).values({ companyId: c.acme.id, agentId: c.orchestrator.id, kind: 'staff', departmentId: c.dev.id, brief: 'A second QA.', items: [] }).returning();
    await c.wrote(c.ids.dan, 'Hire the QA.');
    expect((await call(client, 'hire', { department: c.dev.id, proposalId: his!.id, people: [{ role: 'DEV-QA' }] })).isError).toBeFalsy();
    expect((await c.db.select().from(proposals).where(eq(proposals.id, his!.id)))[0]).toMatchObject({ status: 'applied', appliedBy: c.ids.dan });
  });
});

describe('a decision of the orchestrator as it is kept', () => {
  it('is refused with 409 when someone wrote into the turn after the orchestrator looked, and with 403 once the turn ended', async () => {
    const c = await company();
    const approval = await c.asking({ kind: 'approval', text: 'Merge?', commit: 'e'.repeat(40) });
    const seq = await c.wrote(c.ids.ivan, 'Approve it.');
    const post = (sourceSeq: number | null) =>
      c.app.inject({ method: 'POST', url: `/api/requests/${approval.id}`, payload: { approve: true }, headers: orchestratorDecisionHeaders({ personId: c.ids.ivan, agentId: c.orchestrator.id, jobId: c.job.id, sourceSeq }) });
    await c.wrote(c.ids.ivan, 'No, wait.');
    const stale = await post(seq);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.reason).toBe('decision_context_changed');
    expect(await c.open(approval.id)).toBe(true);
    await c.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, c.job.id));
    const ended = await post(seq + 1);
    expect(ended.statusCode).toBe(403);
    expect(ended.json().error.reason).toBe('decision_context_missing');
    expect(await c.open(approval.id)).toBe(true);
  });

  it('takes the decision headers only from Hornhoof itself', async () => {
    const c = await company();
    const approval = await c.asking({ kind: 'approval', text: 'Merge?', commit: 'f'.repeat(40) });
    await c.wrote(c.ids.ivan, 'Approve it.');
    const headers = orchestratorDecisionHeaders({ personId: c.ids.ivan, agentId: c.orchestrator.id, jobId: c.job.id, sourceSeq: 1 });
    const forged = await c.app.inject({ method: 'POST', url: `/api/requests/${approval.id}`, payload: { approve: true }, headers: { ...headers, 'x-hornhoof-internal': 'f'.repeat(64) }, ...as(c.tokens.zed) });
    expect(forged.statusCode).toBe(403);
    expect(forged.json().error.reason).toBe('decision_not_allowed');
    expect(await c.open(approval.id)).toBe(true);
  });

  it('waits for words going into the turn, and goes by them once they are kept', async () => {
    const c = await company();
    const approval = await c.asking({ kind: 'approval', text: 'Merge?', commit: '1'.repeat(40) });
    await c.wrote(c.ids.ivan, 'Approve it.');
    let release!: () => void;
    const held = withInputLock(c.ctx, c.orchestrator.id, () => new Promise<void>(r => (release = r)));
    const client = await mcp(c.app, TOKEN);
    let done = false;
    const asked = locks.filter(id => id === c.orchestrator.id).length;
    const answering = call(client, 'answer_request', { request: approval.id, approve: true }).then(r => ((done = true), r));
    await until(() => locks.filter(id => id === c.orchestrator.id).length > asked);
    expect(done).toBe(false);
    /* Zed's words went in meanwhile, kept before the lock goes. */
    await c.wrote(c.ids.zed, 'Approve it.');
    release();
    await held;
    const res = await answering;
    expect(res.isError).toBe(true);
    expect(await c.open(approval.id)).toBe(true);
  });
});

describe('words typed into a running orchestrator turn', () => {
  afterEach(() => vi.restoreAllMocks());

  /* The built-in node shows the turn in a terminal; what it is sent is caught, and said answers for it. */
  function liveTerminal(c: Awaited<ReturnType<typeof company>>) {
    vi.spyOn(c.ctx.hub, 'hasTerminals').mockReturnValue(true);
    const sent: Say[] = [];
    vi.spyOn(c.ctx.hub, 'send').mockImplementation((_node, m) => {
      if (m.type === 'agent.say') sent.push(m);
      return true;
    });
    return sent;
  }
  const pending = async (c: Awaited<ReturnType<typeof company>>) => (await c.db.select().from(jobs).where(eq(jobs.id, c.job.id)))[0]!.decisionInputPending;

  it('leave the turn without a person from before they are typed until their message is kept', async () => {
    const c = await company();
    const sent = liveTerminal(c);
    const ivans = await c.wrote(c.ids.ivan, 'Approve it.');
    const going = enqueueTurn(c.ctx, { companyId: c.acme.id, agentId: c.orchestrator.id, prompt: 'Hana wrote: approve it.', createdBy: null, message: { personId: null, text: 'approve it', from: 'agent', name: 'Hana', by: c.hana.id } });
    await until(() => sent.length === 1);
    expect(await pending(c)).toBe(true);
    expect(await decisionPrincipal(c.db, c.job.id)).toBeNull();
    said(c.ctx, BUILTIN, sent[0]!.ref, true);
    expect(await going).toBe(c.job.id);
    expect(await pending(c)).toBe(false);
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual({ personId: c.ids.ivan, sourceSeq: ivans });
    /* Another person's words in the same way give the turn that person. */
    const zed = enqueueTurn(c.ctx, { companyId: c.acme.id, agentId: c.orchestrator.id, prompt: 'Zed: approve it.', createdBy: c.ids.zed, message: { personId: c.ids.zed, text: 'approve it' } });
    await until(() => sent.length === 2);
    expect(await decisionPrincipal(c.db, c.job.id)).toBeNull();
    said(c.ctx, BUILTIN, sent[1]!.ref, true);
    await zed;
    expect(await decisionPrincipal(c.db, c.job.id)).toMatchObject({ personId: c.ids.zed });
  });

  it('keep the turn without a person when the node does not say they went in', async () => {
    const c = await company();
    const sent = liveTerminal(c);
    await c.wrote(c.ids.ivan, 'Approve it.');
    const going = enqueueTurn(c.ctx, { companyId: c.acme.id, agentId: c.orchestrator.id, prompt: 'Zed: approve.', createdBy: c.ids.zed, message: { personId: c.ids.zed, text: 'approve' } });
    await until(() => sent.length === 1);
    said(c.ctx, BUILTIN, sent[0]!.ref, false);
    expect(await going).not.toBe(c.job.id);
    expect(await pending(c)).toBe(true);
    expect(await decisionPrincipal(c.db, c.job.id)).toBeNull();
  });
});

describe('words of a person to an agent directly', () => {
  it('answer only the questions that person may take', async () => {
    const c = await company();
    const own = await c.asking({ kind: 'question', text: 'Which cards?', topic: 'task' });
    const ceos = await c.asking({ kind: 'question', text: 'Hire a designer?', topic: 'people' });
    const plain = await c.asking({ kind: 'question', text: 'Which bank?' });
    expect(await answerDirectly(c.ctx, c.ids.zed, c.bruno.id, 'Visa.')).toEqual([]);
    expect([await c.open(own.id), await c.open(ceos.id), await c.open(plain.id)]).toEqual([true, true, true]);
    await answerDirectly(c.ctx, c.ids.dan, c.bruno.id, 'Visa.');
    expect([await c.open(own.id), await c.open(ceos.id), await c.open(plain.id)]).toEqual([false, true, true]);
    await answerDirectly(c.ctx, c.ids.dave, c.bruno.id, 'Yes.');
    expect([await c.open(ceos.id), await c.open(plain.id)]).toEqual([false, false]);
  });
});

describe("a turn's mark that it answers the CEO", () => {
  /* The second is for a machine the CEO owns, as the server's own is. */
  const principals = async (c: Awaited<ReturnType<typeof company>>) => [await ceoPrincipal(c.db, c.job.id), await machinePrincipal(c.db, c.job.id, c.ids.ivan)];
  const answeredBy = async (c: Awaited<ReturnType<typeof company>>, id: string) => (await c.db.select().from(requests).where(eq(requests.id, id)))[0]!.answeredBy;

  it('leaves a release approval and a choice waiting for their own answer when the CEO delegate writes to the agent', async () => {
    const c = await company();
    const approval = await c.asking({ kind: 'approval', text: 'Merge?', commit: 'a'.repeat(40) });
    const choice = await c.asking({ kind: 'choice', text: 'Which bank?', options: [{ label: 'One', image: null }, { label: 'Two', image: null }] });
    const ceos = await c.asking({ kind: 'question', text: 'Hire a designer?', topic: 'people' });
    await answerDirectly(c.ctx, c.ids.dave, c.bruno.id, 'Approved, merge it.');
    expect([await c.open(approval.id), await c.open(choice.id)]).toEqual([true, true]);
    expect([await answeredBy(c, approval.id), await answeredBy(c, choice.id)]).toEqual([null, null]);
    /* A plain word of the delegate took a question for the CEO before the mark too, by canDecide. */
    expect(await answeredBy(c, ceos.id)).toBe(c.ids.dave);
  });

  it.each([true, false])('gives no right by itself, set to %s: a decision goes by the last person who wrote and their own right', async answersCeo => {
    const c = await company();
    const client = await mcp(c.app, TOKEN);
    await c.db.update(jobs).set({ answersCeo, createdBy: c.ids.dave }).where(eq(jobs.id, c.job.id));
    const approval = await c.asking({ kind: 'approval', text: 'Merge?', commit: 'a'.repeat(40) });
    const ceos = await c.asking({ kind: 'question', text: 'Hire a designer?', topic: 'people' });

    await c.wrote(c.ids.zed, 'Approve it.');
    expect(await principals(c)).toEqual([null, null]);
    expect((await call(client, 'answer_request', { request: approval.id, approve: true })).isError).toBe(true);
    expect((await call(client, 'answer_request', { request: ceos.id, answer: 'Yes.' })).isError).toBe(true);
    expect([await c.open(approval.id), await c.open(ceos.id)]).toEqual([true, true]);

    /* A note of Hornhoof changes nobody's right: the turn still answers the last person who wrote. */
    await c.wrote(c.ids.dave, 'Approve it.');
    await c.wrote(null, 'A note of Hornhoof.');
    expect(await principals(c)).toEqual([c.ids.dave, c.ids.dave]);
    expect((await call(client, 'answer_request', { request: approval.id, approve: true })).isError).toBeFalsy();
    expect(await answeredBy(c, approval.id)).toBe(c.ids.dave);
  });

  it("does not make a repeated turn of the CEO delegate a click on the computer's access", async () => {
    const c = await company();
    await c.db.update(jobs).set({ answersCeo: true, createdBy: c.ids.dave }).where(eq(jobs.id, c.job.id));
    await appendEvent(c.ctx, { companyId: c.acme.id, agentId: c.orchestrator.id, jobId: c.job.id, kind: 'typed', data: { text: 'Go on.' }, personId: null });
    expect(await principals(c)).toEqual([null, null]);
  });
});

describe('who spoke last in a turn, for a command on a machine', () => {
  type Fixture = Awaited<ReturnType<typeof company>>;
  /* Another running turn of the orchestrator, which nobody wrote into yet. */
  const turn = async (c: Fixture, more: Partial<typeof jobs.$inferInsert> = {}) =>
    (await c.db.insert(jobs).values({ companyId: c.acme.id, subscriptionId: c.sub.id, agentId: c.orchestrator.id, kind: 'conversation', prompt: '', timeoutMs: 900000, status: 'running', ...more }).returning())[0]!;
  const into = (c: Fixture, jobId: string, data: Record<string, unknown>, kind: 'message' | 'typed' = 'message', personId: string | null = null) =>
    appendEvent(c.ctx, { companyId: c.acme.id, agentId: c.orchestrator.id, jobId, kind, data, personId });
  const notice = async (c: Fixture, jobId: string, source: string, actor: string | null, more: Record<string, unknown> = {}) =>
    into(c, jobId, { text: `A notice of ${source}.`, notification: { source, tasks: [] }, ...(actor ? { actor: await personParty(c.ctx, c.acme.id, actor) } : {}), ...more });

  it("counts a notice that names a person as that person's words, and one of Hornhoof, of an employee or of a click on access as nobody's", async () => {
    const c = await company();
    /* Dan owns the machine: in a turn of nobody's words his open access holds. */
    const nobodys = await turn(c);
    await notice(c, nobodys.id, 'wait_ended', null);
    await into(c, nobodys.id, { text: 'Done, see #7.', notification: { source: 'reported', tasks: [] }, actor: await agentParty(c.ctx, c.acme.id, c.hana.id) });
    await notice(c, nobodys.id, 'computer_access', c.ids.zed, { computerAccess: { machineId: randomUUID() } });
    expect(await machinePrincipal(c.db, nobodys.id, c.ids.dan)).toBe(c.ids.dan);
    /* Zed took an improvement: his words, though Hornhoof tells them. */
    await notice(c, c.job.id, 'improvement', c.ids.zed);
    expect(await machinePrincipal(c.db, c.job.id, c.ids.dan)).toBeNull();
    /* The CEO answered after him, and an employee reported since. */
    await notice(c, c.job.id, 'answered', c.ids.ivan);
    await into(c, c.job.id, { text: 'Done.', notification: { source: 'reported', tasks: [] }, actor: await agentParty(c.ctx, c.acme.id, c.hana.id) });
    expect(await machinePrincipal(c.db, c.job.id, c.ids.dan)).toBe(c.ids.ivan);
    /* A wake a person's comment on a task made names them. */
    const woken = await turn(c);
    await notice(c, woken.id, 'comment', c.ids.zed);
    expect(await machinePrincipal(c.db, woken.id, c.ids.dan)).toBeNull();
    /* Several people at once: whose words came last is not known. */
    const both = await turn(c);
    await notice(c, both.id, 'structure', c.ids.ivan, { senders: [await personParty(c.ctx, c.acme.id, c.ids.ivan), await personParty(c.ctx, c.acme.id, c.ids.zed)] });
    expect(await machinePrincipal(c.db, both.id, c.ids.dan)).toBeNull();
  });

  it("names whose words a repeat carries, not who spoke last in the turn it repeats", async () => {
    const c = await company();
    const zeds = await c.wrote(c.ids.zed, 'Wipe the disk.');
    const ivans = await c.wrote(c.ids.ivan, 'Look at the disk.');
    const words = async (seq: number) => {
      const [e] = await c.db.select().from(agentEvents).where(eq(agentEvents.seq, seq));
      return { personId: e!.personId, data: e!.data };
    };
    const next = async (seq: number) => {
      const { repeated } = await repeatedTurn(c.ctx, c.job, await words(seq), c.job.id);
      const again = await turn(c);
      await into(c, again.id, repeated.data as Record<string, unknown>, 'typed', repeated.personId);
      return machinePrincipal(c.db, again.id, c.ids.dan);
    };
    /* Zed's words the program never took go again, though the CEO wrote after them. */
    expect(await next(zeds)).toBeNull();
    expect(await next(ivans)).toBe(c.ids.ivan);
  });

  it("counts the letters a person sent that woke an inbox turn", async () => {
    const c = await company();
    const letter = (jobId: string, from: { personId?: string; agentId?: string }) =>
      c.db.insert(agentInbox).values({ companyId: c.acme.id, agentId: c.orchestrator.id, jobId, kind: 'notification', source: 'improvement', text: 'Take it.', ...(from.personId ? { senderKind: 'person' as const, senderPersonId: from.personId, senderName: 'Zed' } : { senderKind: 'agent' as const, senderAgentId: from.agentId!, senderName: 'Hana' }) });
    const agentsOnly = await turn(c, { inboxWake: true });
    await letter(agentsOnly.id, { agentId: c.hana.id });
    expect(await machinePrincipal(c.db, agentsOnly.id, c.ids.dan)).toBe(c.ids.dan);
    const zeds = await turn(c, { inboxWake: true });
    await letter(zeds.id, { agentId: c.hana.id });
    await letter(zeds.id, { personId: c.ids.zed });
    expect(await machinePrincipal(c.db, zeds.id, c.ids.dan)).toBeNull();
    /* The CEO's words in that turn come after the letters. */
    await into(c, zeds.id, { text: 'Go on.' }, 'message', c.ids.ivan);
    expect(await machinePrincipal(c.db, zeds.id, c.ids.dan)).toBe(c.ids.ivan);
  });
});

describe('management after the turn that answered a person ended', () => {
  const HEAD_TOKEN = 'tool-token-head-later-0123456789abcdef';
  const WORKER_TOKEN = 'tool-token-worker-later-0123456789abc';
  type Fixture = Awaited<ReturnType<typeof company>>;

  /* The person asked in a turn that ended before test_subscription answered: their words stay in that turn only. */
  async function askedEarlier(c: Fixture, agentId: string, personId: string, said: string) {
    const [earlier] = await c.db
      .insert(jobs)
      .values({ companyId: c.acme.id, subscriptionId: c.sub.id, agentId, kind: 'conversation', prompt: said, timeoutMs: 900000, status: 'done', createdBy: personId, answersCeo: true })
      .returning();
    return (await appendEvent(c.ctx, { companyId: c.acme.id, agentId, jobId: earlier!.id, kind: 'message', data: { text: said }, personId })).seq;
  }
  /* The next turn opens on Hornhoof's notice of that answer: no person wrote into it and it answers nobody. */
  const notice = (c: Fixture, agentId: string, jobId: string) =>
    appendEvent(c.ctx, { companyId: c.acme.id, agentId, jobId, kind: 'message', data: { text: 'Hornhoof: the test of the Codex subscription answered: ok.' }, personId: null });
  async function laterTurn(c: Fixture, agentId: string, token: string) {
    const [later] = await c.db
      .insert(jobs)
      .values({ companyId: c.acme.id, subscriptionId: c.sub.id, agentId, kind: 'conversation', prompt: '', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(token) })
      .returning();
    await notice(c, agentId, later!.id);
    return later!;
  }
  const staffOf = async (c: Fixture, departmentId: string) => (await c.db.select().from(agents).where(eq(agents.departmentId, departmentId))).map(a => a.roleKey).sort();

  it("lets the orchestrator hire, build and set a department's resources in its next turn, for the CEO who asked", async () => {
    const c = await company();
    const seq = await askedEarlier(c, c.orchestrator.id, c.ids.ivan, 'Hire a QA into Development once the Codex test answers, and give it a Mobile sub-unit for urgent work.');
    await notice(c, c.orchestrator.id, c.job.id);
    expect((await c.db.select().from(jobs).where(eq(jobs.id, c.job.id)))[0]!.answersCeo).toBe(false);
    const client = await mcp(c.app, TOKEN);
    const hired = await call(client, 'hire', { department: c.dev.id, people: [{ role: 'DEV-QA' }] });
    expect(hired.isError, text(hired)).toBeFalsy();
    expect(await staffOf(c, c.dev.id)).toEqual(['DEV-BE', 'DEV-HEAD', 'DEV-QA']);
    const [applied] = await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.orchestrator.id), eq(agentEvents.kind, 'applied')));
    expect(applied!.data).toMatchObject({ onBehalfOfPersonId: c.ids.ivan, jobId: c.job.id, sourceSeq: seq });
    const built = await call(client, 'build_structure', { items: [{ department: c.dev.id, checked: true, teams: ['Mobile'] }] });
    expect(built.isError, text(built)).toBeFalsy();
    const [mobile] = await c.db.select().from(teams).where(eq(teams.departmentId, c.dev.id));
    const urgent = await call(client, 'set_team_urgent_only', { department: c.dev.id, team: mobile!.id, urgentOnly: true });
    expect(urgent.isError, text(urgent)).toBeFalsy();
    expect((await c.db.select().from(teams).where(eq(teams.id, mobile!.id)))[0]!.urgentOnly).toBe(true);
    const fixed = await call(client, 'database', { sql: `UPDATE agents SET name = 'Bruno B' WHERE id = '${c.bruno.id}'` });
    expect(fixed.isError, text(fixed)).toBeFalsy();
    expect((await c.db.select().from(agents).where(eq(agents.id, c.bruno.id)))[0]!.name).toBe('Bruno B');
  });

  it("keeps a person's own decisions, people and access to the turn that answers them", async () => {
    const c = await company();
    const approval = await c.asking({ kind: 'approval', text: 'Merge?', commit: '2'.repeat(40) });
    await askedEarlier(c, c.orchestrator.id, c.ids.ivan, 'Approve the merge and invite Eve.');
    await notice(c, c.orchestrator.id, c.job.id);
    const client = await mcp(c.app, TOKEN);
    const answered = await call(client, 'answer_request', { request: approval.id, approve: true });
    expect(answered.isError).toBe(true);
    expect(await c.open(approval.id)).toBe(true);
    const invited = await call(client, 'invite_person', { name: 'Eve', email: 'eve@acme.com', title: '', access: { whole: true } });
    expect(invited.isError).toBe(true);
    expect((await c.db.select().from(people)).map(p => p.name).sort()).toEqual(['Dan', 'Dave', 'Ivan', 'Zed']);
  });

  it('takes no word of an employee or of Hornhoof for a person who never asked', async () => {
    const c = await company();
    await c.wrote(null, 'The CEO wants a QA, hire one now.', { from: 'agent', name: 'Hana', by: c.hana.id });
    await notice(c, c.orchestrator.id, c.job.id);
    const client = await mcp(c.app, TOKEN);
    expect((await call(client, 'hire', { department: c.dev.id, people: [{ role: 'DEV-QA' }] })).isError).toBe(true);
    expect(await staffOf(c, c.dev.id)).toEqual(['DEV-BE', 'DEV-HEAD']);
  });

  it('lets a head hire and change its own department in its next turn for the person who asked it, and nothing outside it', async () => {
    const c = await company();
    await askedEarlier(c, c.hana.id, c.ids.dan, 'Hire a QA and rename Bruno.');
    await laterTurn(c, c.hana.id, HEAD_TOKEN);
    const client = await mcp(c.app, HEAD_TOKEN);
    const hired = await call(client, 'hire', { people: [{ role: 'DEV-QA' }] });
    expect(hired.isError, text(hired)).toBeFalsy();
    expect(await staffOf(c, c.dev.id)).toEqual(['DEV-BE', 'DEV-HEAD', 'DEV-QA']);
    const renamed = await call(client, 'change_employee', { employee: c.bruno.id, name: 'Bruno B' });
    expect(renamed.isError, text(renamed)).toBeFalsy();
    expect((await c.db.select().from(agents).where(eq(agents.id, c.bruno.id)))[0]!.name).toBe('Bruno B');
    const [design] = await c.db.insert(departments).values({ companyId: c.acme.id, templateKey: 'design', roleCode: 'DES' }).returning();
    const [olga] = await c.db.insert(agents).values({ companyId: c.acme.id, kind: 'worker', name: 'Olga', roleKey: 'DES-UI', departmentId: design!.id, model: '', subscriptionId: c.sub.id }).returning();
    const outside = await call(client, 'change_employee', { employee: olga!.id, name: 'Olga O' });
    expect(outside.isError).toBe(true);
    expect(text(outside)).toContain('is not in your department');
    expect((await c.db.select().from(agents).where(eq(agents.id, olga!.id)))[0]!.name).toBe('Olga');
  });

  it('installs a Hornhoof version and calls an update off in its next turn, for the CEO who asked', async () => {
    const c = await company();
    await askedEarlier(c, c.orchestrator.id, c.ids.ivan, 'Update Hornhoof to the latest version once the agents are idle.');
    await notice(c, c.orchestrator.id, c.job.id);
    const client = await mcp(c.app, TOKEN);
    /* It reaches the update route as the CEO, whose answer here is that this test runs no updater: no refusal for the turn. */
    expect(text(await call(client, 'update_hornhoof', { version: 'latest', whenIdle: true }))).toBe('The updater is not running. Run install.sh server again to update.');
    expect((await call(client, 'cancel_update', {})).isError).toBeFalsy();
  });

  it('installs no version when the last person who asked is not the CEO or the delegate', async () => {
    const c = await company();
    await askedEarlier(c, c.orchestrator.id, c.ids.ivan, 'Look after the team.');
    await askedEarlier(c, c.orchestrator.id, c.ids.zed, 'Update Hornhoof to the latest version.');
    await notice(c, c.orchestrator.id, c.job.id);
    const client = await mcp(c.app, TOKEN);
    expect(text(await call(client, 'update_hornhoof', { version: 'latest', whenIdle: true }))).toBe(ONLY_CEO_ASKED);
  });

  it('gives an ordinary employee no management tool, whoever asked it before', async () => {
    const c = await company();
    await askedEarlier(c, c.bruno.id, c.ids.ivan, 'Hire a QA.');
    await laterTurn(c, c.bruno.id, WORKER_TOKEN);
    const client = await mcp(c.app, WORKER_TOKEN);
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const name of ['hire', 'build_structure', 'change_employee', 'reset_employee', 'set_team_urgent_only', 'set_repository', 'database']) expect(names, name).not.toContain(name);
    expect((await call(client, 'hire', { department: c.dev.id, people: [{ role: 'DEV-QA' }] })).isError).toBe(true);
    expect(await staffOf(c, c.dev.id)).toEqual(['DEV-BE', 'DEV-HEAD']);
  });
});
