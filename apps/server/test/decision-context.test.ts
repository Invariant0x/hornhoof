import type { ServerMessage } from '@hornhoof/protocol';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { orchestratorDecisionHeaders } from '../src/auth/internal.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, companies, departments, jobs, people, proposals, requests, subscriptions, taskEvents } from '../src/db/schema.js';
import { ceoPrincipal, computerPrincipal, decisionPrincipal, withInputLock } from '../src/modules/conversation/decision-context.js';
import { said } from '../src/modules/conversation/live.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { personParty } from '../src/modules/events/parties.js';
import { appendEvent, appendOutgoing, earlierTalk, listEvents } from '../src/modules/events/store.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { answerDirectly, ask, createTask } from '../src/modules/tasks/engine.js';
import { logTurnFact } from '../src/modules/tasks/turn-log.js';
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
    await c.wrote(c.ids.zed, 'Approve it and answer Visa.');
    for (const args of [{ request: approval.id, approve: true }, { request: question.id, answer: 'Visa.' }]) {
      const res = await call(client, 'answer_request', args);
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('may not take this decision');
    }
    /* Dan takes his department's question, not the approval. */
    await c.wrote(c.ids.dan, 'Visa only, and approve.');
    expect((await call(client, 'answer_request', { request: approval.id, approve: true })).isError).toBe(true);
    expect((await call(client, 'answer_request', { request: question.id, answer: 'Visa.' })).isError).toBeFalsy();
    expect(await c.open(approval.id)).toBe(true);
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

  it('applies cards only in a turn of the CEO or the delegate', async () => {
    const c = await company();
    const client = await mcp(c.app, TOKEN);
    const [card] = await c.db.insert(proposals).values({ companyId: c.acme.id, agentId: c.orchestrator.id, kind: 'staff', departmentId: c.dev.id, brief: 'QA.', items: [] }).returning();
    for (const who of ['zed', 'dan'] as const) {
      await c.wrote(c.ids[who], 'Build it and hire.');
      expect((await call(client, 'build_structure', { items: [{ template: 'design', note: 'Screens.' }] })).isError).toBe(true);
      expect((await call(client, 'hire', { department: c.dev.id, proposalId: card!.id, people: [{ role: 'DEV-QA' }] })).isError).toBe(true);
    }
    await c.wrote(null, 'Hire now.', { from: 'agent', name: 'Hana', by: c.hana.id });
    expect((await call(client, 'hire', { department: c.dev.id, proposalId: card!.id, people: [{ role: 'DEV-QA' }] })).isError).toBe(true);
    expect(await c.db.select().from(departments).where(eq(departments.templateKey, 'design'))).toEqual([]);
    expect((await c.db.select().from(proposals).where(eq(proposals.id, card!.id)))[0]!.status).toBe('pending');
    const seq = await c.wrote(c.ids.dave, 'Hire the QA.');
    expect((await call(client, 'hire', { department: c.dev.id, proposalId: card!.id, people: [{ role: 'DEV-QA' }] })).isError).toBeFalsy();
    expect((await c.db.select().from(proposals).where(eq(proposals.id, card!.id)))[0]).toMatchObject({ status: 'applied', appliedBy: c.ids.dave });
    const [applied] = await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.orchestrator.id), eq(agentEvents.kind, 'applied')));
    expect(applied!.data).toMatchObject({ onBehalfOfPersonId: c.ids.dave, jobId: c.job.id, sourceSeq: seq });
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
  const principals = async (c: Awaited<ReturnType<typeof company>>) => [await ceoPrincipal(c.db, c.job.id), await computerPrincipal(c.db, c.job.id)];
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
