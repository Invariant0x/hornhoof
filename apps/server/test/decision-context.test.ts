import { randomUUID } from 'node:crypto';
import type { ServerMessage } from '@hornhoof/protocol';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { orchestratorDecisionHeaders } from '../src/auth/internal.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agentInbox, agents, companies, departments, jobs, people, proposals, requests, subscriptions, taskEvents, teams } from '../src/db/schema.js';
import { ceoPrincipal, checkDelegation, decisionPrincipal, machinePrincipal, standingPrincipal, typedWentIn } from '../src/modules/conversation/decision-context.js';
import { said } from '../src/modules/conversation/live.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { repeatedTurn } from '../src/modules/conversation/turn-words.js';
import { agentParty, personParty } from '../src/modules/events/parties.js';
import { appendEvent, appendOutgoing, earlierTalk, listEvents } from '../src/modules/events/store.js';
import { BUILTIN } from './builtin.js';
import { answerDirectly, ask, createTask } from '../src/modules/tasks/engine.js';
import { logTurnFact } from '../src/modules/tasks/turn-log.js';
import { keptAnswer } from '../src/modules/tools/calls.js';
import { as, invitePerson, listen, mcp, setUpCompany, testApp, until } from './helpers.js';

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

describe('the owner authority of an orchestrator turn', () => {
  it('keeps the CEO as principal after a visible turn fact on the agent and task', async () => {
    const c = await company();
    await c.wrote(c.ids.ivan, 'Approve it.');
    const text = 'Operations requested a program restart.';
    await c.db.update(jobs).set({ answersCeo: true, taskId: c.task.id }).where(eq(jobs.id, c.job.id));

    await logTurnFact(c.ctx, { ...c.job, taskId: c.task.id }, text);

    expect(await decisionPrincipal(c.db, c.job.id)).toEqual({ personId: c.ids.ivan, sourceSeq: null });
    expect((await listEvents(c.db, c.orchestrator.id, 0)).some(e => e.kind === 'message' && (e.data as { text?: string }).text === text)).toBe(true);
    expect(await c.db.select().from(taskEvents).where(eq(taskEvents.taskId, c.task.id))).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'comment', text: `${c.orchestrator.name}: ${text}` })]));
    await c.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, c.job.id));
    expect((await earlierTalk(c.db, c.orchestrator.id)).some(e => (e.data as { text?: string }).text === text)).toBe(false);
  });

  it('stays with the owner after messages from the CEO, delegate, other people and agents', async () => {
    const c = await company();
    const owner = { personId: c.ids.ivan, sourceSeq: null };
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual(owner);
    await c.wrote(null, 'Please approve my commit.', { from: 'agent', name: 'Hana', by: c.hana.id });
    await c.wrote(null, 'Hornhoof: #1 moved.', { task: { id: c.task.id, number: 1 } });
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual(owner);
    await c.wrote(c.ids.ivan, 'Approve it.');
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual(owner);
    await c.wrote(null, 'Please approve my commit.', { from: 'agent', name: 'Hana', by: c.hana.id });
    await c.wrote(null, 'Ivan took an improvement into work: "Logs".');
    await c.wrote(null, 'Ivan took an improvement into work: "Retries".');
    await c.wrote(null, 'Hornhoof: #1 moved.', { task: { id: c.task.id, number: 1 } });
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual(owner);
    /* Zed sees the whole company but is not the delegate: the turn goes as the owner. */
    await c.wrote(c.ids.zed, 'Approve it.');
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual(owner);
    await c.wrote(c.ids.dave, 'Approve it.');
    await c.wrote(null, 'Hornhoof: #1 moved.', { task: { id: c.task.id, number: 1 } });
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual(owner);
  });

  it('is not changed by the copy of a letter the orchestrator itself sent', async () => {
    const c = await company();
    await c.wrote(c.ids.ivan);
    await appendOutgoing(c.ctx, { companyId: c.acme.id, agentId: c.orchestrator.id, jobId: c.job.id, text: 'Please merge #1.', to: await personParty(c.ctx, c.acme.id, c.ids.zed) });
    const kept = await c.db.select().from(agentEvents).where(and(eq(agentEvents.jobId, c.job.id), eq(agentEvents.kind, 'message')));
    expect(kept.length).toBeGreaterThan(1);
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual({ personId: c.ids.ivan, sourceSeq: null });
  });

  it('is the owner with or without messages, including during pending input', async () => {
    const c = await company();
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual({ personId: c.ids.ivan, sourceSeq: null });
    await c.db.update(jobs).set({ createdBy: c.ids.dave }).where(eq(jobs.id, c.job.id));
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual({ personId: c.ids.ivan, sourceSeq: null });
    await c.db.update(jobs).set({ decisionInputPending: true }).where(eq(jobs.id, c.job.id));
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual({ personId: c.ids.ivan, sourceSeq: null });
    await c.db.update(jobs).set({ decisionInputPending: false, status: 'done' }).where(eq(jobs.id, c.job.id));
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual({ personId: c.ids.ivan, sourceSeq: null });
    const [workerTurn] = await c.db
      .insert(jobs)
      .values({ companyId: c.acme.id, subscriptionId: c.sub.id, agentId: c.bruno.id, kind: 'conversation', prompt: 'x', timeoutMs: 1000, status: 'running', createdBy: c.ids.ivan })
      .returning();
    expect(await decisionPrincipal(c.db, workerTurn!.id)).toBeNull();
  });
});

describe("the person a department head's turn answers", () => {
  it('keeps its named owner after messages, assistant input and typed words from other people, agents and notices', async () => {
    const c = await company();
    await c.db.update(departments).set({ ownerPersonId: c.ids.dan }).where(eq(departments.id, c.dev.id));
    const [turn] = await c.db
      .insert(jobs)
      .values({ companyId: c.acme.id, subscriptionId: c.sub.id, agentId: c.hana.id, kind: 'conversation', prompt: 'x', timeoutMs: 1000, status: 'running', createdBy: c.ids.dan })
      .returning();
    const wrote = async (personId: string | null, text: string, extra: Record<string, unknown> = {}) =>
      (await appendEvent(c.ctx, { companyId: c.acme.id, agentId: c.hana.id, jobId: turn!.id, kind: 'message', data: { text, ...extra }, personId })).seq;
    expect(await decisionPrincipal(c.db, turn!.id)).toEqual({ personId: c.ids.dan, sourceSeq: null });
    await wrote(c.ids.dan, 'Make a Mobile sub-unit.');
    await wrote(null, 'Please approve my commit.', { from: 'agent', name: 'Bruno', by: c.bruno.id });
    await wrote(null, 'Hornhoof: #1 moved.', { task: { id: c.task.id, number: 1 } });
    expect(await decisionPrincipal(c.db, turn!.id)).toEqual({ personId: c.ids.dan, sourceSeq: null });
    await wrote(c.ids.ivan, 'Hire two developers.', { channel: 'assistant', assistant: { id: randomUUID(), name: 'Ava', message: randomUUID() } });
    expect(await decisionPrincipal(c.db, turn!.id)).toEqual({ personId: c.ids.dan, sourceSeq: null });
    await typedWentIn(c.ctx, c.hana.id, c.ids.ivan);
    expect(await decisionPrincipal(c.db, turn!.id)).toEqual({ personId: c.ids.dan, sourceSeq: null });
    await c.db.update(jobs).set({ decisionInputPending: true }).where(eq(jobs.id, turn!.id));
    expect(await decisionPrincipal(c.db, turn!.id)).toBeNull();
  });
});

describe('company control tools', () => {

  /* The CEO's turn as the window keeps one: the CEO wrote into it. */
  async function ceoTurn() {
    const c = await company();
    await c.db.update(jobs).set({ answersCeo: true }).where(eq(jobs.id, c.job.id));
    await c.wrote(c.ids.ivan, 'Look after the team.');
    const person = async (id: string) => (await c.db.select().from(people).where(eq(people.id, id)))[0]!;
    return { ...c, client: await mcp(c.app, TOKEN), person };
  }

  it('go as the owner after a person without the right wrote, and say so only when the company has no owner', async () => {
    const c = await ceoTurn();
    await c.wrote(c.ids.zed, 'Invite Eve and disable Dave.');
    const invited = await call(c.client, 'invite_person', { name: 'Eve', email: 'eve@acme.com', title: '', access: { whole: true } });
    expect(invited.isError, text(invited)).toBeFalsy();
    expect((await c.db.select().from(people)).map(p => p.name).sort()).toEqual(['Dan', 'Dave', 'Eve', 'Ivan', 'Zed']);
    expect((await call(c.client, 'change_person', { person: c.ids.dave, status: 'disabled' })).isError).toBeFalsy();
    expect(await c.person(c.ids.dave)).toMatchObject({ status: 'disabled', isCeoDelegate: false });
    await c.db.update(people).set({ isOwner: false }).where(eq(people.id, c.ids.ivan));
    expect(text(await call(c.client, 'invite_again', { person: c.ids.dan }))).toBe('This company has no active owner.');
  });

  it("change an employee's own subscription after a person without the right wrote, as the owner", async () => {
    const c = await ceoTurn();
    await c.wrote(c.ids.zed, 'Move yourself.');
    expect((await call(c.client, 'change_employee', { employee: c.orchestrator.id, subscription: c.sub.id })).isError).toBeFalsy();
  });
});

it('uses the owner across named MCP, generic MCP and HTTP while delegate input is pending', async () => {
  const c = await company();
  const client = await mcp(c.app, TOKEN);
  await c.wrote(c.ids.dave, 'Mark Dan as the delegate.');
  const path = `/api/people/${c.ids.dan}/ceo-delegate`;
  const headers = { authorization: `Bearer ${TOKEN}` };
  expect.soft((await c.app.inject({ url: '/api/people', headers })).statusCode).toBe(200);
  const called = await call(client, 'change_person', { person: c.ids.dave, access: { departments: [c.dev.id] } });
  expect.soft(called.isError, text(called)).toBeFalsy();
  await c.db.update(jobs).set({ decisionInputPending: true }).where(eq(jobs.id, c.job.id));
  const built = await call(client, 'build_structure', { items: [{ template: 'design', note: 'Screens.' }] });
  expect(built.isError, text(built)).toBeFalsy();
  expect((await call(client, 'api', { path: '/api/people' })).isError).toBeFalsy();
  expect((await c.app.inject({ method: 'PUT', url: path, headers, payload: { isCeoDelegate: false } })).statusCode).toBe(200);
});

it('returns the same machine command in the named tool and the owner screen, with no join code in the conversation', async () => {
  const c = await company();
  const client = await mcp(c.app, TOKEN);
  const result = await call(client, 'machine_command', {});
  expect(result.isError, text(result)).toBeFalsy();
  const made = JSON.parse(text(result));
  expect(made.command).toContain('--join ');
  const screen = (await c.app.inject({ url: '/api/nodes/commands', ...as(c.tokens.ceo) })).json();
  expect(screen.commands).toMatchObject([{ id: made.id, command: made.command }]);
  const code = made.command.split('--join ')[1];
  await appendEvent(c.ctx, { companyId: c.acme.id, agentId: c.orchestrator.id, jobId: c.job.id, kind: 'tool_result', data: { summary: made.command } });
  const saved = await c.db.select().from(agentEvents).where(eq(agentEvents.agentId, c.orchestrator.id));
  expect(JSON.stringify(saved)).toContain('--join [hidden]');
  expect(JSON.stringify(saved)).not.toContain(code);
  expect(JSON.stringify(keptAnswer(result))).not.toContain(code);
});

it('shows pending decision cards to the orchestrator through the same HTTP view as the owner', async () => {
  const c = await company();
  const [card] = await c.db.insert(proposals).values({ companyId: c.acme.id, agentId: c.orchestrator.id, brief: 'Add Support.', items: [] }).returning();
  const client = await mcp(c.app, TOKEN);
  const result = await call(client, 'api', { path: '/api/requests' });
  expect(result.isError, text(result)).toBeFalsy();
  expect(JSON.parse(text(result)).proposals).toMatchObject([{ id: card!.id }]);
});

describe('answer_request in a turn', () => {
  it('records the agent and owner for answers regardless of the speaker', async () => {
    const c = await company();
    const client = await mcp(c.app, TOKEN);
    for (const who of ['ivan', 'dave'] as const) {
      const request = await c.asking({ kind: 'approval', text: 'Merge?', commit: (who === 'ivan' ? 'a' : 'b').repeat(40) });
      await c.wrote(c.ids[who], 'Approve the merge.');
      const res = await call(client, 'answer_request', { request: request.id, approve: true });
      expect(res.isError, text(res)).toBeFalsy();
      const [row] = await c.db.select().from(requests).where(eq(requests.id, request.id));
      expect(row).toMatchObject({ status: 'approved', answeredBy: c.ids.ivan, answeredByAgentId: c.orchestrator.id, answerJobId: c.job.id, answerSourceSeq: null });
      const noted = (await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.task.id), eq(taskEvents.kind, 'answered')))).find(e => e.data.requestId === request.id);
      expect(noted).toMatchObject({ agentId: c.orchestrator.id, personId: null, data: { onBehalfOfPersonId: c.ids.ivan, jobId: c.job.id, sourceSeq: null } });
    }
    /* The task's log says whom it acted for. */
    const log = (await c.app.inject({ url: `/api/tasks/${c.task.id}`, ...as(c.tokens.ceo) })).json().task.log as { kind: string; by: { kind: string; name: string; for?: { id: string; name: string } } }[];
    expect(log.filter(l => l.kind === 'answered').map(l => l.by)).toEqual([
      { kind: 'agent', id: c.orchestrator.id, name: 'Orchestrator', for: { id: c.ids.ivan, name: 'Ivan' } },
      { kind: 'agent', id: c.orchestrator.id, name: 'Orchestrator', for: { id: c.ids.ivan, name: 'Ivan' } },
    ].map(b => expect.objectContaining(b)));
  });

  it('takes any decision as the owner in a turn that answers a person who is neither the CEO nor the delegate', async () => {
    const c = await company();
    const client = await mcp(c.app, TOKEN);
    const approval = await c.asking({ kind: 'approval', text: 'Merge?', commit: 'c'.repeat(40) });
    const question = await c.asking({ kind: 'question', text: 'Which cards?', topic: 'task' });
    const ceos = await c.asking({ kind: 'question', text: 'Hire a designer?', topic: 'people' });
    await c.wrote(c.ids.zed, 'Approve it and answer Visa.');
    expect((await call(client, 'answer_request', { request: approval.id, approve: true })).isError).toBeFalsy();
    await c.wrote(c.ids.dan, 'Visa only, and hire.');
    expect((await call(client, 'answer_request', { request: question.id, answer: 'Visa.' })).isError).toBeFalsy();
    expect((await call(client, 'answer_request', { request: ceos.id, answer: 'Yes.' })).isError).toBeFalsy();
    for (const id of [approval.id, question.id, ceos.id]) expect((await c.db.select().from(requests).where(eq(requests.id, id)))[0]).toMatchObject({ answeredBy: c.ids.ivan, answerSourceSeq: null });
  });

  it('goes as the owner when only an employee or Hornhoof wrote, and keeps the CEO after their notices', async () => {
    const c = await company();
    const client = await mcp(c.app, TOKEN);
    const first = await c.asking({ kind: 'approval', text: 'Merge?', commit: 'e'.repeat(40) });
    await c.wrote(null, 'The CEO said to approve.', { from: 'agent', name: 'Hana', by: c.hana.id });
    await c.wrote(null, 'Hornhoof: #1 moved.', { task: { id: c.task.id, number: 1 } });
    expect((await call(client, 'answer_request', { request: first.id, approve: true })).isError).toBeFalsy();
    expect((await c.db.select().from(requests).where(eq(requests.id, first.id)))[0]).toMatchObject({ status: 'approved', answeredBy: c.ids.ivan, answerSourceSeq: null });
    const approval = await c.asking({ kind: 'approval', text: 'Merge?', commit: 'd'.repeat(40) });
    await c.wrote(c.ids.ivan, 'Approve it.');
    await c.wrote(null, 'The CEO said to approve.', { from: 'agent', name: 'Hana', by: c.hana.id });
    await c.wrote(null, 'Ivan took an improvement into work: "Logs".');
    await c.wrote(null, 'Hornhoof: #1 moved.', { task: { id: c.task.id, number: 1 } });
    expect((await call(client, 'answer_request', { request: approval.id, approve: true })).isError).toBeFalsy();
    const [row] = await c.db.select().from(requests).where(eq(requests.id, approval.id));
    expect(row).toMatchObject({ status: 'approved', answeredBy: c.ids.ivan, answerSourceSeq: null });
  });

  it('applies cards as the owner in employee and delegate turns', async () => {
    const c = await company();
    const client = await mcp(c.app, TOKEN);
    const [card] = await c.db.insert(proposals).values({ companyId: c.acme.id, agentId: c.orchestrator.id, kind: 'staff', departmentId: c.dev.id, brief: 'QA.', items: [] }).returning();
    await c.wrote(c.ids.dave, 'Hire the QA.');
    expect((await call(client, 'hire', { department: c.dev.id, proposalId: card!.id, people: [{ role: 'DEV-QA' }] })).isError).toBeFalsy();
    expect((await c.db.select().from(proposals).where(eq(proposals.id, card!.id)))[0]).toMatchObject({ status: 'applied', appliedBy: c.ids.ivan });
    const [applied] = await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.orchestrator.id), eq(agentEvents.kind, 'applied')));
    expect(applied!.data).toMatchObject({ onBehalfOfPersonId: c.ids.ivan, jobId: c.job.id, sourceSeq: null });
    const [second] = await c.db.insert(proposals).values({ companyId: c.acme.id, agentId: c.orchestrator.id, kind: 'staff', departmentId: c.dev.id, brief: 'A second QA.', items: [] }).returning();
    await c.wrote(c.ids.zed, 'Hire another one.');
    await c.wrote(null, 'Hire now.', { from: 'agent', name: 'Hana', by: c.hana.id });
    expect((await call(client, 'hire', { department: c.dev.id, proposalId: second!.id, people: [{ role: 'DEV-QA' }] })).isError).toBeFalsy();
    expect((await c.db.select().from(proposals).where(eq(proposals.id, second!.id)))[0]).toMatchObject({ status: 'applied', appliedBy: c.ids.ivan });
    const built = await call(client, 'build_structure', { items: [{ template: 'design', note: 'Screens.' }] });
    expect(built.isError, text(built)).toBeFalsy();
    expect(await c.db.select().from(departments).where(eq(departments.templateKey, 'design'))).toHaveLength(1);
  });
});

describe('authentication of an orchestrator decision', () => {
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

  it('records when live input is pending and keeps owner authority', async () => {
    const c = await company();
    const sent = liveTerminal(c);
    await c.wrote(c.ids.ivan, 'Approve it.');
    const going = enqueueTurn(c.ctx, { companyId: c.acme.id, agentId: c.orchestrator.id, prompt: 'Hana wrote: approve it.', createdBy: null, message: { personId: null, text: 'approve it', from: 'agent', name: 'Hana', by: c.hana.id } });
    await until(() => sent.length === 1);
    expect(await pending(c)).toBe(true);
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual({ personId: c.ids.ivan, sourceSeq: null });
    said(c.ctx, BUILTIN, sent[0]!.ref, true);
    expect(await going).toBe(c.job.id);
    expect(await pending(c)).toBe(false);
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual({ personId: c.ids.ivan, sourceSeq: null });
    /* The delegate's words follow the same delivery path. */
    const dave = enqueueTurn(c.ctx, { companyId: c.acme.id, agentId: c.orchestrator.id, prompt: 'Dave: approve it.', createdBy: c.ids.dave, message: { personId: c.ids.dave, text: 'approve it' } });
    await until(() => sent.length === 2);
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual({ personId: c.ids.ivan, sourceSeq: null });
    said(c.ctx, BUILTIN, sent[1]!.ref, true);
    await dave;
    expect(await decisionPrincipal(c.db, c.job.id)).toMatchObject({ personId: c.ids.ivan });
  });

  it('keeps owner authority when the node does not confirm input', async () => {
    const c = await company();
    const sent = liveTerminal(c);
    await c.wrote(c.ids.ivan, 'Approve it.');
    const going = enqueueTurn(c.ctx, { companyId: c.acme.id, agentId: c.orchestrator.id, prompt: 'Zed: approve.', createdBy: c.ids.zed, message: { personId: c.ids.zed, text: 'approve' } });
    await until(() => sent.length === 1);
    said(c.ctx, BUILTIN, sent[0]!.ref, false);
    expect(await going).not.toBe(c.job.id);
    expect(await pending(c)).toBe(true);
    expect(await decisionPrincipal(c.db, c.job.id)).toEqual({ personId: c.ids.ivan, sourceSeq: null });
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

  it.each([true, false])('keeps the owner as principal when the conversation mark is %s', async answersCeo => {
    const c = await company();
    const client = await mcp(c.app, TOKEN);
    await c.db.update(jobs).set({ answersCeo, createdBy: c.ids.dave }).where(eq(jobs.id, c.job.id));
    const approval = await c.asking({ kind: 'approval', text: 'Merge?', commit: 'a'.repeat(40) });
    await c.wrote(c.ids.zed, 'Approve it.');
    expect(await ceoPrincipal(c.db, c.job.id)).toBe(c.ids.ivan);
    await c.wrote(c.ids.dave, 'Approve it.');
    await c.wrote(null, 'A note of Hornhoof.', { notification: { source: 'wait_ended', tasks: [] } });
    expect(await ceoPrincipal(c.db, c.job.id)).toBe(c.ids.ivan);
    expect((await call(client, 'answer_request', { request: approval.id, approve: true })).isError).toBeFalsy();
    expect(await answeredBy(c, approval.id)).toBe(c.ids.ivan);
  });
});

describe("who spoke last in a head's turn, for a command on a machine", () => {
  const HORNHOOF_PARTY = { kind: 'hornhoof', id: null, name: 'Hornhoof', role: null, department: null };
  type Fixture = Awaited<ReturnType<typeof company>>;
  /* A running turn of the head, which nobody wrote into yet. */
  const turn = async (c: Fixture, more: Partial<typeof jobs.$inferInsert> = {}) =>
    (await c.db.insert(jobs).values({ companyId: c.acme.id, subscriptionId: c.sub.id, agentId: c.hana.id, kind: 'conversation', prompt: '', timeoutMs: 900000, status: 'running', ...more }).returning())[0]!;
  const into = (c: Fixture, jobId: string, data: Record<string, unknown>, kind: 'message' | 'typed' = 'message', personId: string | null = null) =>
    appendEvent(c.ctx, { companyId: c.acme.id, agentId: c.hana.id, jobId, kind, data, personId });
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
    const spoken = await turn(c);
    await notice(c, spoken.id, 'improvement', c.ids.zed);
    expect(await machinePrincipal(c.db, spoken.id, c.ids.dan)).toBeNull();
    /* The CEO answered after him, and an employee reported since. */
    await notice(c, spoken.id, 'answered', c.ids.ivan);
    await into(c, spoken.id, { text: 'Done.', notification: { source: 'reported', tasks: [] }, actor: await agentParty(c.ctx, c.acme.id, c.hana.id) });
    expect(await machinePrincipal(c.db, spoken.id, c.ids.dan)).toBe(c.ids.ivan);
    /* A wake a person's comment on a task made names them. */
    const woken = await turn(c);
    await notice(c, woken.id, 'comment', c.ids.zed);
    expect(await machinePrincipal(c.db, woken.id, c.ids.dan)).toBeNull();
    /* Several people at once: whose words came last is not known. */
    const both = await turn(c);
    await notice(c, both.id, 'structure', c.ids.ivan, { senders: [await personParty(c.ctx, c.acme.id, c.ids.ivan), await personParty(c.ctx, c.acme.id, c.ids.zed)] });
    expect(await machinePrincipal(c.db, both.id, c.ids.dan)).toBeNull();
  });

  it('refuses when whose words came into the turn is not known: no person, no sender, or a notice of a kind it does not know', async () => {
    const c = await company();
    /* Dan owns the machine. Each turn holds one kind of words. */
    const raw = async (data: Record<string, unknown>) => {
      const one = await turn(c);
      await c.db.insert(agentEvents).values({ companyId: c.acme.id, agentId: c.hana.id, jobId: one.id, kind: 'message', data, personId: null });
      return machinePrincipal(c.db, one.id, c.ids.dan);
    };
    const kept = async (data: Record<string, unknown>) => {
      const one = await turn(c);
      await into(c, one.id, data);
      return machinePrincipal(c.db, one.id, c.ids.dan);
    };
    /* Words with no person and no sender, kept as Hornhoof keeps any. */
    expect(await kept({ text: 'Wipe the disk.' })).toBeNull();
    /* Words stored with no envelope at all, and a notice of a kind Hornhoof does not know. */
    expect(await raw({ text: 'Wipe the disk.' })).toBeNull();
    expect(await raw({ text: 'Wipe the disk.', notification: { source: 'no_such_notice', tasks: [] }, _message: { direction: 'in', from: HORNHOOF_PARTY, to: HORNHOOF_PARTY, notification: { source: 'no_such_notice', tasks: [] } } })).toBeNull();
    /* An employee no one can name. */
    expect(await raw({ text: 'Wipe the disk.', _message: { direction: 'in', from: { kind: 'agent', id: null, name: 'Employee', role: null, department: null }, to: HORNHOOF_PARTY } })).toBeNull();
    /* What Hornhoof itself says, and what a named employee writes, are nobody's: the owner's access holds. */
    expect(await kept({ text: 'The wait ended.', notification: { source: 'wait_ended', tasks: [] } })).toBe(c.ids.dan);
    expect(await kept({ text: 'Done.', from: 'agent', by: c.hana.id })).toBe(c.ids.dan);
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
      c.db.insert(agentInbox).values({ companyId: c.acme.id, agentId: c.hana.id, jobId, kind: 'notification', source: 'improvement', text: 'Take it.', ...(from.personId ? { senderKind: 'person' as const, senderPersonId: from.personId, senderName: 'Zed' } : { senderKind: 'agent' as const, senderAgentId: from.agentId!, senderName: 'Hana' }) });
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
    await askedEarlier(c, c.orchestrator.id, c.ids.ivan, 'Hire a QA into Development once the Codex test answers, and give it a Mobile sub-unit for urgent work.');
    await notice(c, c.orchestrator.id, c.job.id);
    expect((await c.db.select().from(jobs).where(eq(jobs.id, c.job.id)))[0]!.answersCeo).toBe(false);
    const client = await mcp(c.app, TOKEN);
    const hired = await call(client, 'hire', { department: c.dev.id, people: [{ role: 'DEV-QA' }] });
    expect(hired.isError, text(hired)).toBeFalsy();
    expect(await staffOf(c, c.dev.id)).toEqual(['DEV-BE', 'DEV-HEAD', 'DEV-QA']);
    const [applied] = await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.orchestrator.id), eq(agentEvents.kind, 'applied')));
    expect(applied!.data).toMatchObject({ onBehalfOfPersonId: c.ids.ivan, jobId: c.job.id, sourceSeq: null });
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

  it("takes a person's decisions, people and access in a later turn too, as the owner", async () => {
    const c = await company();
    const approval = await c.asking({ kind: 'approval', text: 'Merge?', commit: '2'.repeat(40) });
    await askedEarlier(c, c.orchestrator.id, c.ids.zed, 'Approve the merge and invite Eve.');
    await notice(c, c.orchestrator.id, c.job.id);
    const client = await mcp(c.app, TOKEN);
    const answered = await call(client, 'answer_request', { request: approval.id, approve: true });
    expect(answered.isError, text(answered)).toBeFalsy();
    expect((await c.db.select().from(requests).where(eq(requests.id, approval.id)))[0]!.answeredBy).toBe(c.ids.ivan);
    const invited = await call(client, 'invite_person', { name: 'Eve', email: 'eve@acme.com', title: '', access: { whole: true } });
    expect(invited.isError, text(invited)).toBeFalsy();
    expect((await c.db.select().from(people)).map(p => p.name).sort()).toEqual(['Dan', 'Dave', 'Eve', 'Ivan', 'Zed']);
  });

  it('hires on the word of an employee, as the owner, when no person ever asked', async () => {
    const c = await company();
    await c.wrote(null, 'The CEO wants a QA, hire one now.', { from: 'agent', name: 'Hana', by: c.hana.id });
    await notice(c, c.orchestrator.id, c.job.id);
    const client = await mcp(c.app, TOKEN);
    expect((await call(client, 'hire', { department: c.dev.id, people: [{ role: 'DEV-QA' }] })).isError).toBeFalsy();
    expect(await staffOf(c, c.dev.id)).toEqual(['DEV-BE', 'DEV-HEAD', 'DEV-QA']);
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

  it('installs a version as the owner when the last person who asked is not the CEO or the delegate', async () => {
    const c = await company();
    await askedEarlier(c, c.orchestrator.id, c.ids.ivan, 'Look after the team.');
    await askedEarlier(c, c.orchestrator.id, c.ids.zed, 'Update Hornhoof to the latest version.');
    await notice(c, c.orchestrator.id, c.job.id);
    const client = await mcp(c.app, TOKEN);
    expect(text(await call(client, 'update_hornhoof', { version: 'latest', whenIdle: true }))).toBe('The updater is not running. Run install.sh server again to update.');
    await c.db.update(people).set({ isOwner: false }).where(eq(people.id, c.ids.ivan));
    expect(text(await call(client, 'update_hornhoof', { version: 'latest', whenIdle: true }))).toBe('This company has no active owner.');
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


describe("a head's department principal in any turn", () => {
  async function headTurn(c: Awaited<ReturnType<typeof company>>, agentId = c.hana.id) {
    const [turn] = await c.db.insert(jobs).values({ companyId: c.acme.id, subscriptionId: c.sub.id, agentId, kind: 'conversation', prompt: 'Department work', timeoutMs: 900000, status: 'running' }).returning();
    return turn!;
  }

  it('uses the named department owner in both decision and management calls with no human message', async () => {
    const c = await company();
    await c.db.update(departments).set({ ownerPersonId: c.ids.dan }).where(eq(departments.id, c.dev.id));
    const turn = await headTurn(c);
    for (const find of [decisionPrincipal, standingPrincipal]) expect(await find(c.db, turn.id)).toEqual({ personId: c.ids.dan, sourceSeq: null });
  });

  it('uses the active CEO if no department owner is named, and never uses a worker as a principal', async () => {
    const c = await company();
    const turn = await headTurn(c);
    expect(await decisionPrincipal(c.db, turn.id)).toEqual({ personId: c.ids.ivan, sourceSeq: null });
    const worker = await headTurn(c, c.bruno.id);
    expect(await decisionPrincipal(c.db, worker.id)).toBeNull();
    expect(await standingPrincipal(c.db, worker.id)).toBeNull();
  });

  it('rechecks a changed owner, disabled owner and lost department access instead of keeping old authority', async () => {
    const c = await company();
    const turn = await headTurn(c);
    await c.db.update(departments).set({ ownerPersonId: c.ids.dan }).where(eq(departments.id, c.dev.id));
    const delegated = { agentId: c.hana.id, jobId: turn.id, personId: c.ids.dan, sourceSeq: null };
    await checkDelegation(c.db, delegated);
    await c.db.update(departments).set({ ownerPersonId: c.ids.zed }).where(eq(departments.id, c.dev.id));
    await expect(checkDelegation(c.db, delegated)).rejects.toMatchObject({ status: 409, reason: 'decision_context_changed' });
    await c.db.update(people).set({ status: 'disabled' }).where(eq(people.id, c.ids.zed));
    expect(await decisionPrincipal(c.db, turn.id)).toEqual({ personId: c.ids.ivan, sourceSeq: null });
    await c.db.update(departments).set({ ownerPersonId: c.ids.dan }).where(eq(departments.id, c.dev.id));
    await c.app.inject({ method: 'PATCH', url: `/api/people/${c.ids.dan}`, payload: { access: { whole: true } }, ...as(c.tokens.ceo) });
    await c.db.update(people).set({ scopeKind: 'listed' }).where(eq(people.id, c.ids.dan));
    await expect(checkDelegation(c.db, delegated)).rejects.toMatchObject({ status: 409, reason: 'decision_context_changed' });
  });

  it('has no principal with pending input, a stopped turn or no active owner', async () => {
    const c = await company();
    const turn = await headTurn(c);
    await c.db.update(jobs).set({ decisionInputPending: true }).where(eq(jobs.id, turn.id));
    expect(await decisionPrincipal(c.db, turn.id)).toBeNull();
    await c.db.update(jobs).set({ decisionInputPending: false, status: 'done' }).where(eq(jobs.id, turn.id));
    expect(await standingPrincipal(c.db, turn.id)).toBeNull();
    await c.db.update(jobs).set({ status: 'running' }).where(eq(jobs.id, turn.id));
    await c.db.update(people).set({ status: 'disabled' }).where(eq(people.id, c.ids.ivan));
    expect(await decisionPrincipal(c.db, turn.id)).toBeNull();
  });
});
