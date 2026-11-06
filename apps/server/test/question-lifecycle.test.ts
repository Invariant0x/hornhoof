import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, approvalPolicies, jobs, pendingWakes, people, requestInternal, requests, subscriptions, taskEvents, tasks, taskWaits, waitPolicies } from '../src/db/schema.js';
import { mayOpenRequest } from '../src/modules/tasks/decisions.js';
import { answerDirectly, ask, createTask, handOver, silentTurn, type Task } from '../src/modules/tasks/engine.js';
import { claimQuestions } from '../src/modules/tasks/question-intents.js';
import { questionDisclosure } from '../src/modules/tasks/question-disclosure.js';
import { wakeAll, wakePrompt } from '../src/modules/tasks/wake.js';
import { requestSourceKey } from '../src/modules/tasks/wait-state.js';
import { questionSourceKey } from '../src/modules/tasks/wait-producers.js';
import { as, invitePerson } from './helpers.js';
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
    expect((await c.waitsOf(c.work)).filter(w => w.endedAt === null)).toMatchObject([{ kind: 'external', ownerAgentId: c.watcher.id }]);
    expect((await c.turnsFor(c.watcher.id))[0]!.prompt).toContain('The key is broken');
    const ops = await c.run(c.watcher.id);
    const guard = { ...c.guard, operationId: randomUUID(), expectedRouteRevision: 2 };
    const classify = await call(ops.client as Client, 'classify_human_intent', { ...guard, classification: { kind: 'human_only_action', actionBinding: { kind: 'owner_login', resourceId: c.sub.id } }, humanEnvelope: { situation: 'The plan needs a login.', requiredAction: 'Log in.', options: [] } });
    expect(classify.content[0]!.text).toContain('not yours');
    const settled = await call(ops.client as Client, 'resolve_question', { ...guard, resolution: 'Rotated.' });
    expect(settled.isError, settled.content[0]!.text).toBeFalsy();
  });
});

describe('putting a question before a person', () => {
  const envelope = { situation: 'The release of the new checkout is ready.', requiredAction: 'Approve it or decline it.', options: [] };
  const COMMIT = 'd'.repeat(40);

  async function approval() {
    const c = await company();
    const work = await c.task();
    const { request } = await ask(c.ctx, c.agent.id, work.id, { kind: 'approval', text: 'Run npm publish on the node, then merge.', commit: COMMIT, topic: 'release' });
    const head = await c.run(c.head.id);
    const guard = { operationId: randomUUID(), source: { kind: 'task_request', id: request.id }, expectedRevision: 1, expectedRouteRevision: 1 };
    const ready = { kind: 'ready_result', artifact: { kind: 'commit', sha: COMMIT } };
    const classify = (more: Record<string, unknown> = {}, client = head.client as Client) => call(client, 'classify_human_intent', { ...guard, classification: ready, humanEnvelope: envelope, ...more });
    return { ...c, work, request, guard, ready, classify, head: { ...c.head, client: head.client as Client, job: head.job } };
  }

  it('shows the person what whoever put it there wrote, and never the words of the agent', async () => {
    const c = await approval();
    const res = await c.classify();
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ source: c.guard.source, audience: 'human', revision: 1, routeRevision: 1, classificationId: expect.any(String), digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const seen = await c.seen();
    expect(seen.counts.total).toBe(1);
    const text = JSON.stringify(seen);
    expect(text).toContain('The release of the new checkout is ready.');
    expect(text).not.toContain('npm publish');
    const shown = (await c.app.inject({ url: `/api/tasks/${c.work.id}`, ...as(c.ceo) })).json();
    expect(JSON.stringify(shown.task.requests)).not.toContain('npm publish');
    expect((await c.questionsOf(c.work))[0]).toMatchObject({ audience: 'human', status: 'open', triageAgentId: c.head.id });
  });

  it('keeps everything it rests on: the source, its revisions, who asked, the task as it was, and who takes it', async () => {
    const c = await approval();
    await c.classify();
    const [ceo] = await c.db.select().from(people).where(eq(people.isOwner, true));
    const snapshot = (await c.questionsOf(c.work))[0]!.classification!;
    expect(snapshot).toMatchObject({
      source: c.guard.source, revision: 1, routeRevision: 1, classification: c.ready, humanEnvelope: envelope, materialRevision: 1,
      sourceBinding: { companyId: c.companyId, authorAgentId: c.agent.id, taskAssignment: { taskId: c.work.id, assigneeAgentId: c.agent.id, executorAgentId: c.agent.id, stage: 0 } },
      authority: { recipientPersonIds: [ceo!.id], purpose: { kind: 'decision', decisionKind: 'approval' } },
    });
    expect(snapshot.authority.authorityDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.materialDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('moves its wait from the one who had it to the person, of that one question', async () => {
    const c = await approval();
    await c.classify();
    const [ceo] = await c.db.select().from(people).where(eq(people.isOwner, true));
    const waits = await c.waitsOf(c.work);
    expect(waits.find(w => w.kind === 'external')).toMatchObject({ sourceKey: questionSourceKey(c.request.id), state: 'superseded' });
    expect(waits.find(w => w.kind === 'person')).toMatchObject({ sourceKey: questionSourceKey(c.request.id), ownerPersonId: ceo!.id, sourceRevision: 1, state: 'legacy_needs_plan' });
  });

  it('lets the person answer, with the real person kept and the task going on', async () => {
    const c = await approval();
    await c.classify();
    const res = await c.app.inject({ method: 'POST', url: `/api/requests/${c.request.id}`, payload: { approve: true }, ...as(c.ceo) });
    expect(res.statusCode, res.body).toBe(200);
    const [ceo] = await c.db.select().from(people).where(eq(people.isOwner, true));
    expect((await c.questionsOf(c.work))[0]).toMatchObject({ status: 'approved', answeredBy: ceo!.id, commit: COMMIT });
    expect(await c.statusOf(c.work)).toBe('working');
    expect((await c.waitsOf(c.work)).find(w => w.kind === 'person')).toMatchObject({ state: 'resolved' });
  });

  it('refuses a commit the question does not show, and pictures it does not show', async () => {
    const c = await approval();
    const other = await c.classify({ classification: { kind: 'ready_result', artifact: { kind: 'commit', sha: 'e'.repeat(40) } } });
    expect(other.isError).toBe(true);
    const pictures = await c.classify({ classification: { kind: 'ready_result', artifact: { kind: 'design', imageIds: [randomUUID()] } } });
    expect(pictures.isError).toBe(true);
    expect((await c.questionsOf(c.work))[0]).toMatchObject({ audience: 'internal', classification: null });
  });

  it('takes no commands, code or markup in what the person reads, and nothing of the agent falls back in their place', async () => {
    const c = await approval();
    for (const situation of ['Run `npm publish` now.', 'Then git push origin main', '<script>x</script>', '**Approve**']) {
      const res = await c.classify({ humanEnvelope: { ...envelope, situation } });
      expect(res.isError, situation).toBe(true);
    }
    expect((await c.questionsOf(c.work))[0]).toMatchObject({ audience: 'internal', classification: null });
  });

  it('takes no field it does not know: not a person, not a role, not who is asking', async () => {
    const c = await approval();
    for (const more of [{ recipientPersonId: randomUUID() }, { actorKind: 'person' }, { authority: { recipientPersonIds: [randomUUID()] } }]) {
      const res = await c.app.inject({ method: 'POST', url: '/api/internal-intents/classify', headers: { authorization: `Bearer wait-flow-${c.head.id}` }, payload: { ...c.guard, classification: c.ready, humanEnvelope: envelope, ...more } });
      expect(res.statusCode).toBe(400);
      const tool = await c.classify(more);
      expect(tool.isError, JSON.stringify(more)).toBe(true);
    }
    expect((await c.questionsOf(c.work))[0]).toMatchObject({ audience: 'internal' });
  });

  it('refuses the asker, whoever it quotes, and an outsider', async () => {
    const c = await approval();
    const worker = await c.run(c.agent.id);
    const own = await c.classify({}, worker.client as Client);
    expect(own.content[0]!.text).toContain('not yours');
    const outsider = await c.run(c.watcher.id);
    expect((await c.classify({}, outsider.client as Client)).content[0]!.text).toContain('not yours');
    const delegated = await c.app.inject({ method: 'POST', url: '/api/internal-intents/classify', payload: { ...c.guard, classification: c.ready, humanEnvelope: envelope }, ...as(c.ceo) });
    expect(delegated.statusCode).toBe(401);
    expect((await c.questionsOf(c.work))[0]).toMatchObject({ audience: 'internal' });
  });

  it('says plainly that what has no real way to be done cannot go to a person, and keeps nothing', async () => {
    const c = await approval();
    for (const kind of ['payment', 'manual_machine_action']) {
      const res = await c.classify({ classification: { kind: 'human_only_action', actionBinding: { kind, resourceId: 'res-1' } } });
      expect(res.isError, kind).toBe(true);
      expect(res.content[0]!.text).toContain('source_producer_unavailable');
    }
    expect((await c.questionsOf(c.work))[0]).toMatchObject({ audience: 'internal', classification: null });
  });

  it('gives a login to the one who owns the plan, and it takes that and nothing else', async () => {
    const c = await company();
    const work = await c.task();
    const { request } = await ask(c.ctx, c.agent.id, work.id, { kind: 'question', text: 'The plan needs its owner to log in.' });
    const token = await invitePerson(c.app, c.ceo, { name: 'Olga', email: 'olga@example.com', access: { departments: [c.watcher.departmentId!], teams: [] } });
    const [olga] = await c.db.select().from(people).where(eq(people.email, 'olga@example.com'));
    await c.db.update(subscriptions).set({ ownerPersonId: olga!.id }).where(eq(subscriptions.id, c.sub.id));
    const head = await c.run(c.head.id);
    const res = await call(head.client as Client, 'classify_human_intent', { operationId: randomUUID(), source: { kind: 'task_request', id: request.id }, expectedRevision: 1, expectedRouteRevision: 1, classification: { kind: 'human_only_action', actionBinding: { kind: 'owner_login', resourceId: c.sub.id } }, humanEnvelope: { situation: 'The plan stopped working.', requiredAction: 'Log in to it again.', options: [] } });
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    const seen = (await c.app.inject({ url: '/api/requests', ...as(token) })).json();
    expect(seen.requests).toEqual([]);
    expect(seen.addressed).toMatchObject([{ id: request.id, canAnswer: true, text: expect.stringContaining('The plan stopped working.') }]);
    expect(JSON.stringify(seen.addressed)).not.toContain(work.title);
    expect(JSON.stringify(seen.addressed)).not.toContain('Bruno');
    expect((await c.app.inject({ url: `/api/tasks/${work.id}`, ...as(token) })).statusCode).toBe(403);
    const taken = await c.app.inject({ method: 'POST', url: `/api/requests/${request.id}`, payload: { answer: 'Done.' }, ...as(token) });
    expect(taken.statusCode, taken.body).toBe(200);
    expect((await c.questionsOf(work))[0]).toMatchObject({ status: 'answered', answeredBy: olga!.id });
  });

  describe('once things changed under it', () => {
    it('sends it back inside when the task has another holder, and the person cannot take the old one', async () => {
      const c = await approval();
      await c.classify();
      await c.db.update(tasks).set({ assigneeAgentId: c.head.id, executorAgentId: c.head.id }).where(eq(tasks.id, c.work.id));
      const res = await c.app.inject({ method: 'POST', url: `/api/requests/${c.request.id}`, payload: { approve: true }, ...as(c.ceo) });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.reason).toBe('stale_route');
      expect((await c.questionsOf(c.work))[0]).toMatchObject({ audience: 'internal', status: 'open', routeRevision: 2, answeredBy: null, classification: null });
      expect((await c.seen()).counts.total).toBe(0);
      expect(await c.db.select({ why: pendingWakes.why, agentId: pendingWakes.agentId }).from(pendingWakes)).toContainEqual({ why: 'question', agentId: c.head.id });
    });

    it('sends it back inside when who may take it changed', async () => {
      const c = await approval();
      await c.classify();
      const [ceo] = await c.db.select().from(people).where(eq(people.isOwner, true));
      const token = await invitePerson(c.app, c.ceo, { name: 'Dana', email: 'dana@example.com', access: { whole: true } });
      expect(token).toBeTruthy();
      await c.db.update(people).set({ isCeoDelegate: true }).where(eq(people.email, 'dana@example.com'));
      const res = await c.app.inject({ method: 'POST', url: `/api/requests/${c.request.id}`, payload: { approve: true }, ...as(c.ceo) });
      expect(res.statusCode).toBe(409);
      expect((await c.questionsOf(c.work))[0]).toMatchObject({ audience: 'internal', answeredBy: null });
      expect(ceo).toBeTruthy();
    });

    it('refuses to classify on what was read before, retries give what they gave', async () => {
      const c = await approval();
      const first = await c.classify();
      const again = await c.classify();
      expect(again.isError, again.content[0]!.text).toBeFalsy();
      expect(JSON.parse(again.content[0]!.text)).toEqual(JSON.parse(first.content[0]!.text));
      const other = await c.classify({ humanEnvelope: { ...envelope, situation: 'Something else entirely.' } });
      expect(other.content[0]!.text).toContain('operation_conflict');
      const later = await c.classify({ operationId: randomUUID() });
      expect(later.content[0]!.text).toContain('stale_route');
    });

    it('cannot be settled inside any more once a person has it', async () => {
      const c = await approval();
      await c.classify();
      const late = await call(c.head.client, 'resolve_question', { ...c.guard, operationId: randomUUID(), resolution: 'No need.' });
      expect(late.content[0]!.text).toContain('stale_route');
      expect((await c.questionsOf(c.work))[0]).toMatchObject({ status: 'open', audience: 'human' });
    });

    it('cannot be classified once it is settled', async () => {
      const c = await approval();
      await call(c.head.client, 'resolve_question', { ...c.guard, operationId: randomUUID(), resolution: 'No need.' });
      const late = await c.classify();
      expect(late.content[0]!.text).toContain('source_closed');
      expect((await c.questionsOf(c.work))[0]).toMatchObject({ status: 'resolved_internal', audience: 'internal', classification: null });
    });
  });
});

describe('what a person may be shown of a question', () => {
  const COMMIT = 'd'.repeat(40);
  const envelope = { situation: 'The release of the new checkout is ready.', requiredAction: 'Approve it or decline it.', options: [] };

  async function before() {
    const c = await company();
    const work = await c.task();
    const { request } = await ask(c.ctx, c.agent.id, work.id, { kind: 'approval', text: 'Merge it.', commit: COMMIT, topic: 'release' });
    const head = await c.run(c.head.id);
    const source = { kind: 'task_request' as const, id: request.id };
    const classify = () => call(head.client as Client, 'classify_human_intent', { operationId: randomUUID(), source, expectedRevision: 1, expectedRouteRevision: 1, classification: { kind: 'ready_result', artifact: { kind: 'commit', sha: COMMIT } }, humanEnvelope: envelope });
    const [ceo] = await c.db.select().from(people).where(eq(people.isOwner, true));
    const shown = (personId = ceo!.id, expected?: { revision: number; routeRevision: number }, companyId = c.companyId) =>
      c.db.transaction(tx => questionDisclosure(tx, { personId, companyId }, source, expected));
    const reason = (p: Promise<unknown>) => p.then(() => 'ok', (err: { reason?: string }) => err.reason ?? String(err));
    return { ...c, work, request, source, classify, shown, reason, ceoId: ceo!.id };
  }

  it('binds exactly what was put before them: the source, its revisions, the classification and its material', async () => {
    const c = await before();
    await c.classify();
    const [row] = await c.questionsOf(c.work);
    const shown = await c.shown();
    expect(shown).toMatchObject({
      source: c.source, revision: 1, routeRevision: 1, personId: c.ceoId,
      classificationId: row!.classification!.classificationId, digest: row!.classification!.digest, materialRevision: row!.classification!.materialRevision, materialDigest: row!.classification!.materialDigest,
    });
    expect(shown).toMatchObject({ kind: 'task_request', companyId: c.companyId, request: { id: c.request.id }, task: { id: c.work.id } });
    expect(await c.reason(c.shown(c.ceoId, { revision: 1, routeRevision: 1 }))).toBe('ok');
  });

  it('is nothing while the question is inside the company', async () => {
    const c = await before();
    expect(await c.reason(c.shown())).toBe('classification_required');
  });

  it('is nothing for someone it was not put before, or from another company', async () => {
    const c = await before();
    await c.classify();
    const [zed] = await c.db.insert(people).values({ companyId: c.companyId, name: 'Zed', email: 'zed@example.test', status: 'active', scopeKind: 'company' }).returning();
    expect(await c.reason(c.shown(zed!.id))).toBe('question_not_allowed');
    expect(await c.reason(c.shown(c.ceoId, undefined, randomUUID()))).toBe('request_unknown');
  });

  it('is nothing for what was read before, once answered, or once what it rested on changed', async () => {
    const c = await before();
    await c.classify();
    expect(await c.reason(c.shown(c.ceoId, { revision: 2, routeRevision: 1 }))).toBe('stale_revision');
    expect(await c.reason(c.shown(c.ceoId, { revision: 1, routeRevision: 2 }))).toBe('stale_route');
    await c.db.update(tasks).set({ stage: 1 }).where(eq(tasks.id, c.work.id));
    expect(await c.reason(c.shown())).toBe('stale_route');
    await c.db.update(tasks).set({ stage: 0 }).where(eq(tasks.id, c.work.id));
    await c.db.update(requests).set({ status: 'approved' }).where(eq(requests.id, c.request.id));
    expect(await c.reason(c.shown())).toBe('source_closed');
  });
});

describe('an approval a department asks for', () => {
  const envelope = { situation: 'A price change of 40 euros is ready to go out.', requiredAction: 'Approve it or decline it.', options: [] };

  async function policyApproval() {
    const c = await company();
    const work = await c.task();
    const asker = await c.run(c.agent.id, work.id);
    const res = await call(asker.client as Client, 'request_approval', { task: work.number, channel: 'price', kind: 'price change', amount: 40, text: 'Change the price with the admin script.' });
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    expect(res.content[0]!.text).toContain('Hana');
    const [request] = await c.questionsOf(work);
    const head = await c.run(c.head.id);
    const { questions } = JSON.parse((await call(head.client as Client, 'internal_questions', {})).content[0]!.text) as { questions: { approval: { digest: string } }[] };
    const guard = { operationId: randomUUID(), source: { kind: 'task_request', id: request!.id }, expectedRevision: 1, expectedRouteRevision: 1 };
    return { ...c, work, request: request!, guard, lead: head.client as Client, digest: questions[0]!.approval.digest };
  }

  it('stays inside first like any other, and reaches no person by its channel', async () => {
    const c = await policyApproval();
    expect(c.request).toMatchObject({ audience: 'internal', triageAgentId: c.head.id, approvalChannel: 'price' });
    expect(await c.seen()).toMatchObject({ requests: [], counts: { total: 0 } });
  });

  it('comes before the person with its exact channel, kind and amount, and is taken as an approval', async () => {
    const c = await policyApproval();
    const res = await call(c.lead, 'classify_human_intent', { ...c.guard, classification: { kind: 'ready_result', artifact: { kind: 'policy', digest: c.digest } }, humanEnvelope: envelope });
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    const seen = (await c.seen()) as unknown as { requests: { approval: unknown; text: string }[] };
    expect(seen.requests[0]).toMatchObject({ approval: { channel: 'price', kind: 'price change', amount: 40 } });
    expect(JSON.stringify(seen)).not.toContain('admin script');
    expect((await c.questionsOf(c.work))[0]!.classification).toMatchObject({ authority: { purpose: { kind: 'decision', decisionKind: 'approval' } } });
    const taken = await c.app.inject({ method: 'POST', url: `/api/requests/${c.request.id}`, payload: { approve: true }, ...as(c.ceo) });
    expect(taken.statusCode, taken.body).toBe(200);
    expect((await c.questionsOf(c.work))[0]).toMatchObject({ status: 'approved' });
  });

  it('refuses a digest of anything else: the client does not decide what it approves', async () => {
    const c = await policyApproval();
    const res = await call(c.lead, 'classify_human_intent', { ...c.guard, classification: { kind: 'ready_result', artifact: { kind: 'policy', digest: 'f'.repeat(64) } }, humanEnvelope: envelope });
    expect(res.isError).toBe(true);
    expect((await c.questionsOf(c.work))[0]).toMatchObject({ audience: 'internal', classification: null });
  });

  it('is not taken for a commit, and a commit approval is not taken for it', async () => {
    const c = await policyApproval();
    const commit = await call(c.lead, 'classify_human_intent', { ...c.guard, classification: { kind: 'ready_result', artifact: { kind: 'commit', sha: 'a'.repeat(40) } }, humanEnvelope: envelope });
    expect(commit.isError).toBe(true);
    const work = await c.task();
    const { request } = await ask(c.ctx, c.agent.id, work.id, { kind: 'approval', text: 'Release?', commit: 'a'.repeat(40) });
    const policy = await call(c.lead, 'classify_human_intent', { operationId: randomUUID(), source: { kind: 'task_request', id: request.id }, expectedRevision: 1, expectedRouteRevision: 1, classification: { kind: 'ready_result', artifact: { kind: 'policy', digest: c.digest } }, humanEnvelope: envelope });
    expect(policy.isError).toBe(true);
  });

  it('goes without a question where the policy lets the work go, as before', async () => {
    const c = await company();
    const work = await c.task();
    await c.db.insert(approvalPolicies).values({ companyId: c.companyId, departmentId: c.dev.id, channel: 'price', mode: 'within_limits', limitAmount: 100 });
    const asker = await c.run(c.agent.id, work.id);
    const res = await call(asker.client as Client, 'request_approval', { task: work.number, channel: 'price', kind: 'price change', amount: 40, text: 'Small change.' });
    expect(res.content[0]!.text).toContain('No approval needed');
    expect(await c.questionsOf(work)).toEqual([]);
  });
});

describe('a task that stands still', () => {
  async function still() {
    const c = await company();
    const work = await c.task();
    const silence = async () => silentTurn(c.ctx, c.agent.id, (await c.db.select().from(tasks).where(eq(tasks.id, work.id)))[0]!);
    return { ...c, work, silence };
  }
  const silent = async (c: Awaited<ReturnType<typeof still>>, times = 3) => {
    for (let i = 0; i < times; i++) await wakeAll(c.ctx, (await c.silence()).wakes);
  };

  it('is told to its head on the third turn, once however often it is seen, and to no person', async () => {
    const c = await still();
    await silent(c);
    const asked = await c.questionsOf(c.work);
    expect(asked).toMatchObject([{ kind: 'stuck', audience: 'internal', triageAgentId: c.head.id, status: 'open' }]);
    expect(asked[0]!.sourceKey).toMatch(new RegExp(`^stuck:${c.work.id}:`));
    expect(await c.seen()).toMatchObject({ requests: [], counts: { total: 0 } });
    expect(await c.statusOf(c.work)).toBe('waiting');
    await silent(c);
    expect(await c.questionsOf(c.work)).toHaveLength(1);
    expect(await c.turnsFor(c.head.id)).toHaveLength(1);
    expect(await c.turnsFor(c.orchestrator.id)).toEqual([]);
  });

  it('of a head is told to the orchestrator', async () => {
    const c = await company();
    const work = await c.held(c.head.id);
    for (let i = 0; i < 3; i++) await wakeAll(c.ctx, (await silentTurn(c.ctx, c.head.id, (await c.db.select().from(tasks).where(eq(tasks.id, work.id)))[0]!)).wakes);
    expect(await c.questionsOf(work)).toMatchObject([{ kind: 'stuck', triageAgentId: c.orchestrator.id, audience: 'internal' }]);
    expect(await c.turnsFor(c.orchestrator.id)).toHaveLength(1);
    expect(await c.seen()).toMatchObject({ requests: [], counts: { total: 0 } });
  });

  it('with nobody to tell is kept for when someone is: no wait, no date, no person told, and the task stays as it is', async () => {
    const c = await still();
    await c.db.update(agents).set({ removedAt: new Date() }).where(inArray(agents.id, [c.head.id, c.orchestrator.id]));
    await silent(c);
    const [question] = await c.questionsOf(c.work);
    expect(question).toMatchObject({ audience: 'internal', triageAgentId: null, routeRevision: 1 });
    expect((await c.sidecar(question!.id))?.recoveryIntent).toMatchObject({ sourceKey: questionSourceKey(question!.id), reason: 'internal_route_unavailable' });
    expect(await c.waitsOf(c.work)).toEqual([]);
    expect(await c.statusOf(c.work)).not.toBe('waiting');
    expect(await c.seen()).toMatchObject({ requests: [], counts: { total: 0 } });
    await silent(c);
    expect(await c.questionsOf(c.work)).toHaveLength(1);
  });

  it('is picked up once someone can look, one time, with a new revision and its wait', async () => {
    const c = await still();
    await c.db.update(agents).set({ removedAt: new Date() }).where(inArray(agents.id, [c.head.id, c.orchestrator.id]));
    await silent(c);
    await claimQuestions(c.ctx);
    expect((await c.questionsOf(c.work))[0]).toMatchObject({ triageAgentId: null, routeRevision: 1 });
    await c.db.update(agents).set({ removedAt: null }).where(inArray(agents.id, [c.head.id, c.orchestrator.id]));
    await claimQuestions(c.ctx);
    await claimQuestions(c.ctx);
    const [question] = await c.questionsOf(c.work);
    expect(question).toMatchObject({ triageAgentId: c.head.id, routeRevision: 2 });
    expect((await c.sidecar(question!.id))?.recoveryIntent).toMatchObject({ reason: 'plan_unavailable' });
    expect(await c.waitsOf(c.work)).toMatchObject([{ kind: 'external', ownerAgentId: c.head.id, sourceRevision: 2 }]);
    expect(await c.statusOf(c.work)).toBe('waiting');
    expect(await c.turnsFor(c.head.id)).toHaveLength(1);
  });
});

describe('a question whose route is no more', () => {
  it('goes on to the orchestrator when its head has gone, told once', async () => {
    const c = await company();
    const work = await c.task();
    await ask(c.ctx, c.agent.id, work.id, { kind: 'question', text: 'Which one?' });
    await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.head.id));
    await claimQuestions(c.ctx);
    await claimQuestions(c.ctx);
    expect((await c.questionsOf(work))[0]).toMatchObject({ triageAgentId: c.orchestrator.id, routeRevision: 2, status: 'open' });
    expect(await c.turnsFor(c.orchestrator.id)).toHaveLength(1);
    expect((await c.waitsOf(work)).filter(w => w.endedAt === null)).toMatchObject([{ ownerAgentId: c.orchestrator.id }]);
  });

  it('stays with Operations once handed there, while it can look', async () => {
    const c = await company();
    const work = await c.task();
    const { request } = await ask(c.ctx, c.agent.id, work.id, { kind: 'question', text: 'Which one?' });
    await c.db.update(requests).set({ triageAgentId: c.watcher.id }).where(eq(requests.id, request.id));
    await claimQuestions(c.ctx);
    expect((await c.questionsOf(work))[0]).toMatchObject({ triageAgentId: c.watcher.id, routeRevision: 1 });
  });

  it('gets a new revision when its task gets another holder, and what was read before no longer acts on it', async () => {
    const c = await company();
    const work = await c.task();
    const { request } = await ask(c.ctx, c.agent.id, work.id, { kind: 'question', text: 'Which one?' });
    const head = await c.run(c.head.id);
    const [other] = await c.db.insert(agents).values({ companyId: c.companyId, name: 'Rita', kind: 'worker', roleKey: 'DEV-BE', departmentId: c.dev.id, subscriptionId: c.sub.id, model: '' }).returning();
    await handOver(c.ctx, (await c.db.select().from(tasks).where(eq(tasks.id, work.id)))[0]!, other!.id, 'Over to Rita.');
    expect((await c.questionsOf(work))[0]).toMatchObject({ routeRevision: 2, status: 'open' });
    const stale = await call(head.client as Client, 'resolve_question', { operationId: randomUUID(), source: { kind: 'task_request', id: request.id }, expectedRevision: 1, expectedRouteRevision: 1, resolution: 'Old.' });
    expect(stale.content[0]!.text).toContain('stale_route');
  });
});

describe('what was already there when questions moved inside', () => {
  /* As the migration leaves them: the same row, with no one yet to have it. */
  async function legacy(status: 'open' | 'answered' | 'approved') {
    const c = await company();
    const work = await c.task();
    const [ceo] = await c.db.select().from(people).where(eq(people.isOwner, true));
    const closed = status === 'open' ? {} : { answeredBy: ceo!.id, answeredAt: new Date(), answer: 'As it was said.' };
    const [request] = await c.db.insert(requests).values({ companyId: c.companyId, taskId: work.id, agentId: c.agent.id, kind: 'stuck', text: 'It stood still.', status, audience: status === 'open' ? 'internal' : 'legacy', ...closed }).returning();
    await c.db.update(requests).set({ sourceKey: `legacy:task_request:${request!.id}` }).where(eq(requests.id, request!.id));
    if (status === 'open') await c.db.update(tasks).set({ status: 'waiting' }).where(eq(tasks.id, work.id));
    return { ...c, work, request: request!, ceoPerson: ceo! };
  }

  it('reaches its head through the same row and its history, with the old wait on a person over, and no person told', async () => {
    const c = await legacy('open');
    await c.db.insert(taskWaits).values({ companyId: c.companyId, taskId: c.work.id, kind: 'person', sourceKey: requestSourceKey(c.request.id), state: 'legacy_needs_plan', generation: 1, sourceRevision: 0, ownerPersonId: c.ceoPerson.id, sourceState: {} });
    expect(await c.seen()).toMatchObject({ requests: [], counts: { total: 0 } });
    await claimQuestions(c.ctx);
    expect((await c.questionsOf(c.work))[0]).toMatchObject({ id: c.request.id, audience: 'internal', triageAgentId: c.head.id, routeRevision: 2, status: 'open', answeredBy: null });
    const waits = await c.waitsOf(c.work);
    expect(waits.find(w => w.kind === 'person')).toMatchObject({ state: 'superseded' });
    expect(waits.find(w => w.kind === 'external')).toMatchObject({ ownerAgentId: c.head.id });
    expect(await c.turnsFor(c.head.id)).toHaveLength(1);
    expect(await c.seen()).toMatchObject({ requests: [], counts: { total: 0 } });
  });

  it('stays as it ended when it was answered, shown as it was, and is never asked again', async () => {
    const c = await legacy('answered');
    await claimQuestions(c.ctx);
    expect((await c.questionsOf(c.work))[0]).toMatchObject({ audience: 'legacy', status: 'answered', answer: 'As it was said.', answeredBy: c.ceoPerson.id, routeRevision: 1, triageAgentId: null });
    expect(await c.turnsFor(c.head.id)).toEqual([]);
    const shown = (await c.app.inject({ url: `/api/tasks/${c.work.id}`, ...as(c.ceo) })).json();
    expect(shown.task.requests[0]).toMatchObject({ text: 'It stood still.', answer: 'As it was said.', status: 'answered' });
  });

  it('keeps the words of an open one from those who see the task', async () => {
    const c = await legacy('open');
    const shown = (await c.app.inject({ url: `/api/tasks/${c.work.id}`, ...as(c.ceo) })).json();
    expect(JSON.stringify(shown.task.requests)).not.toContain('It stood still.');
  });
});

describe('what an agent reads about asking', () => {
  it('says a question goes inside first, and that a person sees it only when a head or the orchestrator says so', async () => {
    const c = await company();
    const work = await c.task();
    const { client } = await c.run(c.agent.id, work.id);
    const { tools } = await client.listTools();
    const about = (name: string) => tools.find(t => t.name === name)!.description!;
    expect(about('ask_person')).toContain('It goes first to your head');
    expect(about('ask_person')).not.toContain('the people responsible');
    expect(about('request_approval')).toContain('your head or the orchestrator looks at it first');
  });

  it('never tells one who holds the work that a person is the way out', async () => {
    const c = await company();
    const work = await c.task();
    const told = wakePrompt(c.agent, work, { agentId: c.agent.id, taskId: work.id, why: 'assigned' });
    expect(told).toContain('use ask_person');
    expect(told).not.toContain('only a person can answer');
  });
});
