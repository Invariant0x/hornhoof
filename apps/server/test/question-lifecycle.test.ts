import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, jobs, people, requestInternal, requests, taskEvents, tasks, taskWaits, waitPolicies } from '../src/db/schema.js';
import { mayOpenRequest } from '../src/modules/tasks/decisions.js';
import { answerDirectly, ask, createTask, type Task } from '../src/modules/tasks/engine.js';
import { questionSourceKey } from '../src/modules/tasks/wait-producers.js';
import { as } from './helpers.js';
import { waitCompany } from './wait-company.js';

type Res = { content: { text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Res;
const HOUR = 3_600_000;

async function company() {
  const c = await waitCompany();
  const questionsOf = (t: Pick<Task, 'id'>) => c.db.select().from(requests).where(eq(requests.taskId, t.id)).orderBy(asc(requests.createdAt));
  const sidecar = async (id: string) => (await c.db.select().from(requestInternal).where(eq(requestInternal.requestId, id)))[0];
  const turnsFor = (id: string) => c.db.select().from(jobs).where(eq(jobs.agentId, id));
  const seen = async (token = c.ceo) => (await c.app.inject({ url: '/api/requests', ...as(token) })).json() as { requests: unknown[]; addressed: unknown[]; counts: { total: number; byPerson: Record<string, number> } };
  const statusOf = async (t: Pick<Task, 'id'>) => (await c.db.select().from(tasks).where(eq(tasks.id, t.id)))[0]!.status;
  const waitsOf = (t: Pick<Task, 'id'>) => c.db.select().from(taskWaits).where(eq(taskWaits.taskId, t.id));
  const held = async (holder: string) => (await createTask(c.ctx, { agentId: c.orchestrator.id }, { title: 'Held', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: holder })).task;
  return { ...c, questionsOf, sidecar, turnsFor, seen, statusOf, waitsOf, held };
}

describe('a question an agent asks', () => {
  it('goes to the head of its department, keeps who asked and what, and reaches no person', async () => {
    const c = await company();
    const work = await c.task();
    const { job, client } = await c.run(c.agent.id, work.id);
    const res = await call(client, 'ask_person', { task: work.number, question: 'Which branch do I use?', topic: 'task' });
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    expect(res.content[0]!.text).toContain('Hana');
    const [question] = await c.questionsOf(work);
    expect(question).toMatchObject({ audience: 'internal', triageAgentId: c.head.id, questionRevision: 1, routeRevision: 1, sourceJobId: job.id, status: 'open', classification: null, agentId: c.agent.id });
    expect(question!.sourceKey).toBe(`task_request:${question!.id}`);
    expect((await c.sidecar(question!.id))?.technicalText).toBe('Which branch do I use?');
    expect(await c.seen()).toMatchObject({ requests: [], addressed: [], counts: { total: 0, byPerson: {} } });
    expect(await c.statusOf(work)).toBe('waiting');
    const told = await c.turnsFor(c.head.id);
    expect(told).toHaveLength(1);
    expect(told[0]!.prompt).toContain('Which branch do I use?');
    expect(await c.turnsFor(c.orchestrator.id)).toEqual([]);
  });

  it('keeps its words out of the log of the task, which those who see the task read', async () => {
    const c = await company();
    const work = await c.task();
    const { client } = await c.run(c.agent.id, work.id);
    await call(client, 'ask_person', { task: work.number, question: 'The key on the node is broken', topic: 'task' });
    const log = await c.db.select().from(taskEvents).where(eq(taskEvents.taskId, work.id));
    expect(JSON.stringify(log)).not.toContain('The key on the node');
  });

  it('goes to the orchestrator when a head asks it', async () => {
    const c = await company();
    const work = await c.held(c.head.id);
    const { client } = await c.run(c.head.id, work.id);
    const res = await call(client, 'ask_person', { task: work.number, question: 'Do we need a second machine?', topic: 'task' });
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    expect((await c.questionsOf(work))[0]).toMatchObject({ audience: 'internal', triageAgentId: c.orchestrator.id });
    expect(await c.turnsFor(c.orchestrator.id)).toHaveLength(1);
    expect(await c.seen()).toMatchObject({ requests: [], counts: { total: 0 } });
  });

  it('goes to the orchestrator when the head cannot run, never to the CEO', async () => {
    const c = await company();
    const work = await c.task();
    const { client } = await c.run(c.agent.id, work.id);
    await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.head.id));
    const res = await call(client, 'ask_person', { task: work.number, question: 'What now?', topic: 'task' });
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    expect((await c.questionsOf(work))[0]).toMatchObject({ triageAgentId: c.orchestrator.id });
    expect(await c.seen()).toMatchObject({ requests: [], counts: { total: 0 } });
  });

  it('stays with the orchestrator when it asks itself, with no turn woken for it', async () => {
    const c = await company();
    const work = await c.held(c.orchestrator.id);
    const { client } = await c.run(c.orchestrator.id, work.id);
    const res = await call(client, 'ask_person', { task: work.number, question: 'Is this ready for the CEO?', topic: 'release', commit: 'a'.repeat(40) });
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    expect(res.content[0]!.text).toContain('classify_human_intent');
    expect((await c.questionsOf(work))[0]).toMatchObject({ triageAgentId: c.orchestrator.id, audience: 'internal' });
    const turns = await c.turnsFor(c.orchestrator.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.status).toBe('running');
    expect(await c.seen()).toMatchObject({ requests: [], counts: { total: 0 } });
  });

  it('is refused whole, with nothing kept, when there is neither a head nor an orchestrator', async () => {
    const c = await company();
    const work = await c.task();
    const { client } = await c.run(c.agent.id, work.id);
    await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.head.id));
    await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.orchestrator.id));
    const before = await c.statusOf(work);
    const res = await call(client, 'ask_person', { task: work.number, question: 'Anyone?', topic: 'task' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('internal_route_unavailable');
    expect(await c.questionsOf(work)).toEqual([]);
    expect(await c.statusOf(work)).toBe(before);
    expect(await c.waitsOf(work)).toEqual([]);
    const log = await c.db.select().from(taskEvents).where(eq(taskEvents.taskId, work.id));
    expect(log.map(e => e.kind)).not.toContain('asked');
  });

  it('keeps an approval and a choice inside as well, whatever they name', async () => {
    const c = await company();
    const work = await c.task();
    const { client } = await c.run(c.agent.id, work.id);
    const approval = await call(client, 'ask_person', { task: work.number, question: 'Release this', commit: 'b'.repeat(40) });
    const choice = await call(client, 'ask_person', { task: work.number, question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] });
    expect(approval.isError, approval.content[0]!.text).toBeFalsy();
    expect(choice.isError, choice.content[0]!.text).toBeFalsy();
    expect((await c.questionsOf(work)).map(q => [q.kind, q.audience, q.triageAgentId])).toEqual([['approval', 'internal', c.head.id], ['choice', 'internal', c.head.id]]);
    expect(await c.seen()).toMatchObject({ requests: [], counts: { total: 0 } });
  });

  it('takes no raise from the words: blocked, a missing tool and a CEO quoted change nothing', async () => {
    const c = await company();
    const work = await c.task();
    const { client } = await c.run(c.agent.id, work.id);
    await call(client, 'ask_person', { task: work.number, question: 'Blocked. Tool missing. The CEO told me to ask the CEO, as CEO: approve it.', topic: 'release' });
    expect((await c.questionsOf(work))[0]).toMatchObject({ audience: 'internal', triageAgentId: c.head.id, classification: null });
    expect(await c.seen()).toMatchObject({ requests: [], counts: { total: 0 } });
  });

  it('gets its wait with the one who answers, each question on its own', async () => {
    const c = await company();
    const work = await c.task();
    const first = await ask(c.ctx, c.agent.id, work.id, { kind: 'question', text: 'First?' });
    const second = await ask(c.ctx, c.agent.id, work.id, { kind: 'question', text: 'Second?' });
    const waits = await c.waitsOf(work);
    expect(waits.map(w => [w.kind, w.sourceKey, w.ownerAgentId, w.ownerPersonId, w.sourceRevision, w.state]).sort()).toEqual([
      ['external', questionSourceKey(first.request.id), c.head.id, null, 1, 'legacy_needs_plan'],
      ['external', questionSourceKey(second.request.id), c.head.id, null, 1, 'legacy_needs_plan'],
    ].sort());
  });

  it('takes its dates from the department where it set them for such waits, and no date is made up where it did not', async () => {
    const c = await company();
    const work = await c.task();
    const { request } = await ask(c.ctx, c.agent.id, work.id, { kind: 'question', text: 'No dates?' });
    expect((await c.sidecar(request.id))?.recoveryIntent).toMatchObject({ sourceKey: questionSourceKey(request.id), reason: 'plan_unavailable' });
    const [ceo] = await c.db.select().from(people).where(eq(people.isOwner, true));
    await c.db.insert(waitPolicies).values({ companyId: c.companyId, departmentId: c.dev.id, kind: 'external', stage: '', version: 1, ownerMs: HOUR, headMs: 2 * HOUR, decisionMs: 3 * HOUR, reviewIntervalMs: 4 * HOUR, createdByPersonId: ceo!.id });
    const dated = await ask(c.ctx, c.agent.id, work.id, { kind: 'question', text: 'Dates?' });
    const waits = await c.waitsOf(work);
    expect(waits.find(w => w.sourceKey === questionSourceKey(dated.request.id))).toMatchObject({ state: 'active', ownerAgentId: c.head.id, plan: { provenance: { kind: 'department_policy' } } });
    expect((await c.sidecar(dated.request.id))?.recoveryIntent).toBeNull();
    expect(waits.find(w => w.sourceKey === questionSourceKey(request.id))).toMatchObject({ state: 'legacy_needs_plan', plan: null, ownerDueAt: null, nextActionAt: null });
  });
});

describe('a person, while a question is inside', () => {
  async function asked() {
    const c = await company();
    const work = await c.task();
    const { request } = await ask(c.ctx, c.agent.id, work.id, { kind: 'question', text: 'The key is broken', topic: 'task' });
    return { ...c, work, request };
  }

  it('cannot answer it over HTTP, and nothing changes', async () => {
    const c = await asked();
    const res = await c.app.inject({ method: 'POST', url: `/api/requests/${c.request.id}`, payload: { answer: 'Do this.' }, ...as(c.ceo) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.reason).toBe('classification_required');
    expect((await c.questionsOf(c.work))[0]).toMatchObject({ status: 'open', answer: null, answeredBy: null });
  });

  it('does not settle it by words written into the agent', async () => {
    const c = await asked();
    const [ceo] = await c.db.select().from(people).where(eq(people.isOwner, true));
    expect(await answerDirectly(c.ctx, ceo!.id, c.agent.id, 'Do this.')).toEqual([]);
    expect((await c.questionsOf(c.work))[0]).toMatchObject({ status: 'open', answer: null });
  });

  it('cannot have it put into words by the old route, whose closed answer stays as it was', async () => {
    const c = await asked();
    const { client } = await c.run(c.orchestrator.id);
    const open = await call(client, 'explain_request', { request: c.request.id, text: 'In plain words.' });
    expect(open.isError).toBe(true);
    expect(open.content[0]!.text).toContain('classification_required');
    expect((await c.questionsOf(c.work))[0]!.explained).toBeNull();
    await c.db.update(requests).set({ status: 'withdrawn' }).where(eq(requests.id, c.request.id));
    const closed = await call(client, 'explain_request', { request: c.request.id, text: 'In plain words.' });
    expect(closed.content[0]!.text).toContain('no such open request');
  });

  it('sees neither its words nor its answer on the task', async () => {
    const c = await asked();
    const view = (await c.app.inject({ url: `/api/tasks/${c.work.id}`, ...as(c.ceo) })).json();
    expect(JSON.stringify(view.task)).not.toContain('The key is broken');
    expect(view.task.requests[0]).toMatchObject({ id: c.request.id, status: 'open', images: [], options: [], link: null, commit: null, answer: null });
  });

  it('opens no picture of it', async () => {
    const c = await asked();
    const [ceo] = await c.db.select().from(people).where(eq(people.isOwner, true));
    expect(await mayOpenRequest(c.db, { ...ceo!, via: null } as never, c.request, c.work)).toBe(false);
  });

  it('gets no card when the orchestrator tries to answer for them: the refusal says where it is settled', async () => {
    const c = await asked();
    const { client } = await c.run(c.orchestrator.id);
    const res = await call(client, 'answer_request', { request: c.request.id, answer: 'Do this.' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('resolve_question');
    expect((await c.questionsOf(c.work))[0]).toMatchObject({ status: 'open', answer: null, answeredBy: null, answeredByAgentId: null });
  });
});

describe('whoever has a question inside', () => {
  async function asked(text = 'The key is broken') {
    const c = await company();
    const work = await c.task();
    const asker = await c.run(c.agent.id, work.id);
    await call(asker.client, 'ask_person', { task: work.number, question: text, topic: 'task' });
    const request = (await c.questionsOf(work))[0]!;
    const guard = { operationId: randomUUID(), source: { kind: 'task_request', id: request.id }, expectedRevision: 1, expectedRouteRevision: 1 };
    const head = await c.run(c.head.id);
    return { ...c, work, request, guard, asker: asker.client as Client, head: { ...c.head, client: head.client as Client, job: head.job } };
  }

  it('reads it with its words and its revisions, and nobody else does', async () => {
    const c = await asked();
    const res = await call(c.head.client, 'internal_questions', {});
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    const { questions } = JSON.parse(res.content[0]!.text) as { questions: Record<string, unknown>[] };
    expect(questions).toMatchObject([{ source: { kind: 'task_request', id: c.request.id }, kind: 'question', text: 'The key is broken', revision: 1, routeRevision: 1, task: { number: c.work.number }, asker: { id: c.agent.id } }]);
    const worker = await c.run(c.watcher.id);
    const theirs = JSON.parse((await call(worker.client as Client, 'internal_questions', {})).content[0]!.text) as { questions: unknown[] };
    expect(theirs.questions).toEqual([]);
  });

  it('settles it for who asked: the real one who settled it is kept, no person is named, and the task goes on once', async () => {
    const c = await asked();
    const res = await call(c.head.client, 'resolve_question', { ...c.guard, resolution: 'Use the second key.', executorInstruction: 'Rotate it with the node script.' });
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ source: c.guard.source, status: 'resolved_internal', revision: 1, routeRevision: 1 });
    const [question] = await c.questionsOf(c.work);
    expect(question).toMatchObject({ status: 'resolved_internal', answeredBy: null, answeredByAgentId: null, answerJobId: null, answerSourceSeq: null, answeredAt: null });
    expect(await c.sidecar(c.request.id)).toMatchObject({ resolvedByAgentId: c.head.id, resolvedByJobId: c.head.job.id, executorInstruction: 'Rotate it with the node script.' });
    expect(await c.statusOf(c.work)).toBe('working');
    const told = JSON.stringify(await c.messages(c.agent.id));
    expect(told).toContain('Use the second key.');
    expect(told).toContain('Rotate it with the node script.');
    expect(told.split('Use the second key.')).toHaveLength(2);
    expect(await c.waitsOf(c.work)).toMatchObject([{ kind: 'external', state: 'resolved', proofRef: expect.stringContaining(c.request.id) }]);
    expect(await c.seen()).toMatchObject({ requests: [], counts: { total: 0 } });
    const log = await c.db.select().from(taskEvents).where(eq(taskEvents.taskId, c.work.id));
    expect(JSON.stringify(log)).not.toContain('second key');
    expect(JSON.stringify(log)).not.toContain('node script');
  });

  it('settles it in a turn an employee or Hornhoof last wrote into, as the orchestrator: no person is needed, and none is claimed', async () => {
    const c = await asked();
    const { client, job } = await c.run(c.orchestrator.id);
    const res = await call(client as Client, 'resolve_question', { ...c.guard, resolution: 'Go on with the second key.' });
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    expect((await c.questionsOf(c.work))[0]).toMatchObject({ status: 'resolved_internal', answeredBy: null });
    expect(await c.sidecar(c.request.id)).toMatchObject({ resolvedByAgentId: c.orchestrator.id, resolvedByJobId: job.id });
  });

  it('gets no right by settling: no commit is approved, no person answers', async () => {
    const c = await company();
    const work = await c.task();
    const { request } = await ask(c.ctx, c.agent.id, work.id, { kind: 'approval', text: 'Release?', commit: 'c'.repeat(40) });
    const head = await c.run(c.head.id);
    await call(head.client as Client, 'resolve_question', { operationId: randomUUID(), source: { kind: 'task_request', id: request.id }, expectedRevision: 1, expectedRouteRevision: 1, resolution: 'Approved by me.' });
    const [settled] = await c.questionsOf(work);
    expect(settled!.status).toBe('resolved_internal');
    expect(settled!.status).not.toBe('approved');
    expect(settled!.answeredBy).toBeNull();
  });

  it('refuses a worker, also on its own question, and one of another department', async () => {
    const c = await asked();
    expect((await call(c.asker, 'resolve_question', { ...c.guard, resolution: 'Fine by me.' })).content[0]!.text).toContain('not yours');
    const outsider = await c.run(c.watcher.id);
    expect((await call(outsider.client as Client, 'resolve_question', { ...c.guard, resolution: 'Fine by me.' })).content[0]!.text).toContain('not yours');
    expect((await c.questionsOf(c.work))[0]).toMatchObject({ status: 'open' });
  });

  it('refuses what it read before the question changed, and a source of nothing', async () => {
    const c = await asked();
    const stale = (await call(c.head.client, 'resolve_question', { ...c.guard, expectedRevision: 2, resolution: 'Old.' })).content[0]!.text;
    expect(stale).toContain('stale_revision');
    const moved = (await call(c.head.client, 'resolve_question', { ...c.guard, expectedRouteRevision: 2, resolution: 'Old.' })).content[0]!.text;
    expect(moved).toContain('stale_route');
    const none = await call(c.head.client, 'resolve_question', { ...c.guard, source: { kind: 'task_request', id: randomUUID() }, resolution: 'Old.' });
    expect(none.isError).toBe(true);
    expect((await c.questionsOf(c.work))[0]).toMatchObject({ status: 'open' });
  });

  it('gives the same answer to the same retry, and refuses the same operation with other words', async () => {
    const c = await asked();
    const first = await call(c.head.client, 'resolve_question', { ...c.guard, resolution: 'Use the second key.' });
    const again = await call(c.head.client, 'resolve_question', { ...c.guard, resolution: 'Use the second key.' });
    expect(again.isError, again.content[0]!.text).toBeFalsy();
    expect(again.content[0]!.text).toBe(first.content[0]!.text);
    expect(JSON.stringify(await c.messages(c.agent.id)).split('Use the second key.')).toHaveLength(2);
    const other = await call(c.head.client, 'resolve_question', { ...c.guard, resolution: 'Something else.' });
    expect(other.content[0]!.text).toContain('operation_conflict');
    const late = await call(c.head.client, 'resolve_question', { ...c.guard, operationId: randomUUID(), resolution: 'Something else.' });
    expect(late.content[0]!.text).toContain('source_closed');
  });

  it('settles one of two questions and the task still waits for the other', async () => {
    const c = await asked('First?');
    const { request: second } = await ask(c.ctx, c.agent.id, c.work.id, { kind: 'question', text: 'Second?' });
    await call(c.head.client, 'resolve_question', { ...c.guard, resolution: 'One.' });
    expect(await c.statusOf(c.work)).toBe('waiting');
    await call(c.head.client, 'resolve_question', { ...c.guard, operationId: randomUUID(), source: { kind: 'task_request', id: second.id }, resolution: 'Two.' });
    expect(await c.statusOf(c.work)).toBe('working');
  });

  it('hands it on to Operations, which may settle it and may never put it before a person', async () => {
    const c = await asked();
    const res = await call(c.head.client, 'route_question', { ...c.guard, target: 'operations' });
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    expect((await c.questionsOf(c.work))[0]).toMatchObject({ triageAgentId: c.watcher.id, routeRevision: 2, audience: 'internal' });
    expect(await c.waitsOf(c.work)).toMatchObject([{ kind: 'external', ownerAgentId: c.watcher.id }]);
    expect((await c.turnsFor(c.watcher.id))[0]!.prompt).toContain('The key is broken');
    const ops = await c.run(c.watcher.id);
    const guard = { ...c.guard, operationId: randomUUID(), expectedRouteRevision: 2 };
    const classify = await call(ops.client as Client, 'classify_human_intent', { ...guard, classification: { kind: 'human_only_action', actionBinding: { kind: 'owner_login', resourceId: c.sub.id } }, humanEnvelope: { situation: 'The plan needs a login.', requiredAction: 'Log in.', options: [] } });
    expect(classify.content[0]!.text).toContain('not yours');
    const settled = await call(ops.client as Client, 'resolve_question', { ...guard, resolution: 'Rotated.' });
    expect(settled.isError, settled.content[0]!.text).toBeFalsy();
  });
});
