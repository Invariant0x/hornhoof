import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, jobs, programInstances, tasks } from '../src/db/schema.js';
import { enqueueTurn, GONE_ALONG, insertTurn, pump } from '../src/modules/conversation/queue.js';
import { expireOperatorCases } from '../src/modules/program-operator/cases.js';
import { checkOperatorHealth } from '../src/modules/program-operator/health.js';
import { resumeOperatorProcess } from '../src/modules/program-operator/recovery.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { stuckPrograms } from './program-operator-incident.js';

type Company = Awaited<ReturnType<typeof stuckPrograms>>;
const letter = 'A letter from the head of development: release 0.8.0 waits for your answer.';
const say = (c: Company, agentId: string, text = letter) =>
  enqueueTurn(c.ctx, { companyId: c.companyId, agentId, prompt: text, createdBy: null, message: { personId: null, text, from: 'agent', by: c.head.id, name: c.head.name } });
const taskOf = async (c: Company, agentId: string, number: number, status: 'open' | 'working' = 'working') =>
  (await c.db.insert(tasks).values({ companyId: c.companyId, number, title: `Task ${number}`, body: 'Do it.', status, departmentId: c.dev.id, assigneeAgentId: agentId, executorAgentId: agentId }).returning())[0]!;
const taken = (c: Company, words: string) => c.runs().filter(run => run.prompt.includes(words));

it.each(['operator_unavailable', 'operator_timeout'] as const)('a letter whose turn failed with %s goes out with the next turn, once', async outcome => {
  const c = await stuckPrograms(outcome === 'operator_timeout');
  await say(c, c.orchestrator.id);
  const first = await c.runningOf(c.orchestrator.id);
  await c.unrecorded(c.orchestrator.id, first!.id);
  if (outcome === 'operator_timeout') {
    await expireOperatorCases(c.ctx, new Date(+(await c.caseOf(first!.id)).deadlineAt));
  }
  await c.failedTurn(first!.id);
  expect(await c.jobOf(first!.id)).toMatchObject({ status: 'failed', error: 'agent_failed' });
  const [next, ...more] = await c.continuationsOf(first!.id);
  expect(more).toEqual([]);
  expect(next).toMatchObject({ status: 'queued', agentId: c.orchestrator.id });
  expect(next!.prompt).toContain(letter);

  await c.retryDue(c.orchestrator.id);
  expect(await c.jobOf(next!.id)).toMatchObject({ status: 'running' });
  await c.heard(c.orchestrator.id, next!.id);
  await pump(c.ctx, c.orchestrator.id);
  await checkOperatorHealth(c.ctx);
  expect(await c.continuationsOf(next!.id)).toEqual([]);
  expect(taken(c, letter)).toHaveLength(2);
  expect((await c.turnsOf(c.orchestrator.id)).filter(turn => turn.status === 'queued' || turn.status === 'running')).toEqual([]);
});

it('counts nothing to Operations for each try: the words wait instead of raising a failure per turn', async () => {
  const c = await stuckPrograms();
  await say(c, c.agent.id);
  for (let i = 0; i < 3; i++) await c.failsOnce(c.agent.id);
  expect(await c.turnsOf(c.watcher.id)).toEqual([]);
  expect(await c.turnsOf(c.head.id)).toEqual([]);
});

it('a late receipt of the words cancels the turn that would repeat them', async () => {
  const c = await stuckPrograms();
  await say(c, c.orchestrator.id);
  const first = await c.runningOf(c.orchestrator.id);
  const { fact } = await c.unrecorded(c.orchestrator.id, first!.id);
  await c.failedTurn(first!.id);
  const [next] = await c.continuationsOf(first!.id);
  await c.record({ ...fact, phase: 'taken', elapsedMs: 70000 });
  expect(await c.jobOf(next!.id)).toMatchObject({ status: 'failed', error: 'cancelled' });
  await c.retryDue(c.orchestrator.id);
  expect(taken(c, letter)).toHaveLength(1);
  expect((await c.caseOf(first!.id)).continuationJobId).toBe(next!.id);
});

it('a late receipt of the first words cancels a later retry too, not only the first', async () => {
  const c = await stuckPrograms();
  await say(c, c.orchestrator.id);
  const first = await c.runningOf(c.orchestrator.id);
  const { fact } = await c.unrecorded(c.orchestrator.id, first!.id);
  await c.failedTurn(first!.id);
  await c.retryDue(c.orchestrator.id);
  const second = await c.runningOf(c.orchestrator.id);
  await c.unrecorded(c.orchestrator.id, second!.id);
  await c.failedTurn(second!.id);
  const [third] = await c.continuationsOf(second!.id);
  expect(third).toMatchObject({ status: 'queued' });
  await c.record({ ...fact, phase: 'taken', elapsedMs: 200000 });
  expect(await c.jobOf(third!.id)).toMatchObject({ status: 'failed', error: 'cancelled' });
});

it('the retry names the first words, so a program that recorded them after all does not take them twice', async () => {
  const c = await stuckPrograms();
  await say(c, c.orchestrator.id);
  const first = await c.runningOf(c.orchestrator.id);
  const { delivery } = await c.unrecorded(c.orchestrator.id, first!.id);
  await c.failedTurn(first!.id);
  await c.retryDue(c.orchestrator.id);
  const second = await c.runningOf(c.orchestrator.id);
  expect(c.runOf(second!.id)!.operatorSourceDelivery).toEqual(delivery);
});

it('waits longer each time, and goes on trying', async () => {
  const c = await stuckPrograms();
  await say(c, c.orchestrator.id);
  const waits: number[] = [];
  for (let i = 0; i < 6; i++) {
    const running = await c.runningOf(c.orchestrator.id);
    await c.unrecorded(c.orchestrator.id, running!.id);
    const at = new Date();
    await c.failedTurn(running!.id, at);
    const [next] = await c.continuationsOf(running!.id);
    waits.push(Math.round((+next!.notBefore! - +at) / 60000));
    await c.retryDue(c.orchestrator.id);
  }
  expect(waits).toEqual([1, 2, 5, 10, 10, 10]);
});

it('a report on a task keeps its words: the retry says what the turn was woken for', async () => {
  const c = await stuckPrograms();
  const task = await taskOf(c, c.head.id, 328);
  const report = 'Developer reported on #328: the pinned commit is 0123abc and the evidence is attached.';
  await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.head.id, prompt: report, createdBy: null, taskId: task.id, message: { personId: null, text: report, from: 'agent', by: c.agent.id, name: c.agent.name } });
  const first = await c.runningOf(c.head.id);
  await c.unrecorded(c.head.id, first!.id);
  await c.failedTurn(first!.id);
  const [next] = await c.continuationsOf(first!.id);
  expect(next).toMatchObject({ status: 'queued', taskId: task.id });
  expect(next!.prompt).toContain(report);
  expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ status: 'working', assigneeAgentId: c.head.id });
});

/* A wake as a task sends it: what stands on the task when it is queued goes with it, and the queue checks that again. */
const wake = (c: Company, agentId: string, task: typeof tasks.$inferSelect, text: string) =>
  insertTurn(c.ctx, { companyId: c.companyId, agentId, prompt: text, createdBy: null, taskId: task.id, message: { personId: null, text, from: 'agent', by: c.agent.id, name: c.agent.name, taskWake: { why: 'report', status: task.status, stage: task.stage, merging: task.merging, version: task.version } } });

/* The head is busy, so both wakes wait and the first takes the second along. */
async function headTakesTaskAlong(c: Company) {
  const one = await taskOf(c, c.head.id, 330, 'open'), two = await taskOf(c, c.head.id, 331, 'open');
  const words = 'The second task moved.';
  const [busy] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.head.id, subscriptionId: c.sub.id, nodeId: c.identity.nodeId, kind: 'conversation', prompt: 'Busy.', timeoutMs: 1000, status: 'running', startedAt: new Date() }).returning();
  await wake(c, c.head.id, one, 'The first task moved.');
  const along = await wake(c, c.head.id, two, words);
  await handleNodeMessage(c.ctx, c.identity, { type: 'job.done', jobId: busy!.id, ok: true, sessionId: 'session', tail: 'Done.', result: 'Done.', error: null });
  expect(await c.jobOf(along)).toMatchObject({ status: 'done', result: GONE_ALONG });
  return { two, words, along, carrier: (await c.runningOf(c.head.id))! };
}

it('a task that went out inside the unheard turn is told again by the next one, though going out set it to work', async () => {
  const c = await stuckPrograms();
  const { two, words, along, carrier } = await headTakesTaskAlong(c);
  expect((await c.db.select().from(tasks).where(eq(tasks.id, two.id)))[0]).toMatchObject({ status: 'working', version: two.version + 1 });
  await c.unrecorded(c.head.id, carrier.id);
  await c.failedTurn(carrier.id);
  await c.retryDue(c.head.id);
  await pump(c.ctx, c.head.id);
  const next = await c.runningOf(c.head.id);
  expect(next!.id).not.toBe(carrier.id);
  expect(next!.prompt).toContain(words);
  expect(await c.jobOf(along)).toMatchObject({ status: 'done', result: GONE_ALONG });
});

it('a late receipt also ends the repeat of a task that went out inside that turn', async () => {
  const c = await stuckPrograms();
  const { two, words, along, carrier } = await headTakesTaskAlong(c);
  await c.unrecorded(c.head.id, carrier.id);
  await c.failedTurn(carrier.id);
  const [repeat] = await c.continuationsOf(along);
  expect(repeat).toMatchObject({ status: 'queued', taskId: two.id });
  expect(repeat!.prompt).toContain(words);
  await c.heard(c.head.id, carrier.id);
  expect(await c.jobOf(repeat!.id)).toMatchObject({ status: 'failed', error: 'cancelled' });
});

it('does not tell again a task closed since the turn went out', async () => {
  const c = await stuckPrograms();
  const { two, along, carrier } = await headTakesTaskAlong(c);
  await c.db.update(tasks).set({ status: 'cancelled', closedAt: new Date() }).where(eq(tasks.id, two.id));
  await c.unrecorded(c.head.id, carrier.id);
  await c.failedTurn(carrier.id);
  expect(await c.continuationsOf(along)).toEqual([]);
});

it('a program held until its owner passes it says on what it was told, and each task that went along, though going out set them to work', async () => {
  const c = await stuckPrograms();
  const { words, along, carrier } = await headTakesTaskAlong(c);
  await c.db.update(programInstances).set({ active: false }).where(eq(programInstances.id, await c.instanceOf(c.head.id)));
  await c.unrecorded(c.head.id, carrier.id);
  await c.failedTurn(carrier.id);
  expect(await c.caseOf(carrier.id)).toMatchObject({ recoveryHold: true });
  expect(await resumeOperatorProcess(c.ctx, c.head.id, c.identity.nodeId)).toBe(true);
  await pump(c.ctx, c.head.id);
  const next = await c.runningOf(c.head.id);
  expect(next!.prompt).toContain('The first task moved.');
  expect(next!.prompt).toContain(words);
  expect(await c.continuationsOf(along)).toHaveLength(1);
});

it('a late receipt in a held program ends those too', async () => {
  const c = await stuckPrograms();
  const { along, carrier } = await headTakesTaskAlong(c);
  await c.db.update(programInstances).set({ active: false }).where(eq(programInstances.id, await c.instanceOf(c.head.id)));
  await c.unrecorded(c.head.id, carrier.id);
  await c.failedTurn(carrier.id);
  await resumeOperatorProcess(c.ctx, c.head.id, c.identity.nodeId);
  const [repeat] = await c.continuationsOf(along);
  const { fact } = await c.deliveryFact(c.head.id, carrier.id);
  await c.record({ ...fact, phase: 'taken', elapsedMs: 100 } as typeof fact);
  expect(await c.jobOf(repeat!.id)).toMatchObject({ status: 'failed', error: 'cancelled' });
});

describe('a wake that already waits on the task of the unheard turn', () => {
  async function waitingWake(c: Company) {
    const task = await taskOf(c, c.head.id, 329, 'open');
    await wake(c, c.head.id, task, 'The report that was never heard.');
    await pump(c.ctx, c.head.id);
    const first = (await c.runningOf(c.head.id))!;
    const later = 'A later wake on the same task.';
    const [waiting] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.head.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: later, timeoutMs: 1000, taskId: task.id, status: 'queued' }).returning();
    await c.unrecorded(c.head.id, first.id);
    await c.failedTurn(first.id);
    return { first, later, waiting: waiting! };
  }

  it('leaves that wake its own words, while the unheard ones go in a turn of their own, first', async () => {
    const c = await stuckPrograms();
    const { first, later, waiting } = await waitingWake(c);
    const [next] = await c.continuationsOf(first.id);
    expect(next!.id).not.toBe(waiting.id);
    expect(await c.jobOf(waiting.id)).toMatchObject({ status: 'queued', prompt: later });
    await c.retryDue(c.head.id);
    await pump(c.ctx, c.head.id);
    const running = await c.runningOf(c.head.id);
    expect(running!.id).toBe(next!.id);
    expect(running!.prompt).toContain('The report that was never heard.');
  });

  it('a late receipt ends only the repeat, not that wake', async () => {
    const c = await stuckPrograms();
    const { first, later, waiting } = await waitingWake(c);
    const [next] = await c.continuationsOf(first.id);
    await c.heard(c.head.id, first.id);
    expect(await c.jobOf(next!.id)).toMatchObject({ status: 'failed', error: 'cancelled' });
    expect(await c.jobOf(waiting.id)).toMatchObject({ status: 'running', requestedPrompt: later });
  });
});

it('tells what became of the words in the window and on the task', async () => {
  const c = await stuckPrograms();
  await say(c, c.agent.id);
  const first = await c.runningOf(c.agent.id);
  await c.unrecorded(c.agent.id, first!.id);
  await c.failedTurn(first!.id);
  const [next] = await c.continuationsOf(first!.id);
  const facts = await c.db.select({ data: agentEvents.data }).from(agentEvents).where(and(eq(agentEvents.jobId, first!.id), sql`${agentEvents.data}->>'continuation' = ${next!.id}`));
  expect(facts).toHaveLength(1);
  expect(JSON.stringify(facts[0]!.data)).toContain('did not record these words');
});

it('words the program recorded are not repeated when the turn fails later', async () => {
  const c = await stuckPrograms();
  await say(c, c.agent.id);
  const first = await c.runningOf(c.agent.id);
  const { fact } = await c.unrecorded(c.agent.id, first!.id);
  await c.record({ ...fact, phase: 'taken', elapsedMs: 70000 });
  await c.failedTurn(first!.id);
  expect(await c.continuationsOf(first!.id)).toEqual([]);
  const repeats = (await c.turnsOf(c.agent.id)).filter(turn => turn.prompt.includes(letter) && turn.id !== first!.id);
  expect(repeats).toEqual([]);
});

it('a stopped turn is not repeated', async () => {
  const c = await stuckPrograms();
  await say(c, c.agent.id);
  const first = await c.runningOf(c.agent.id);
  await c.unrecorded(c.agent.id, first!.id);
  await handleNodeMessage(c.ctx, c.identity, { type: 'job.done', jobId: first!.id, ok: false, sessionId: 'session', error: 'cancelled', tail: 'Stopped.', result: '' });
  expect(await c.db.select().from(jobs).where(and(eq(jobs.continueOf, first!.id)))).toEqual([]);
});
