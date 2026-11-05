import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, agents, jobs, people, subscriptions, tasks } from '../src/db/schema.js';
import { insertTurn, pump } from '../src/modules/conversation/queue.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { turnAgain } from '../src/modules/tasks/again.js';
import { comment, createTask, submit, verdict, type Task, type Wake } from '../src/modules/tasks/engine.js';
import { repeatedTurn } from '../src/modules/tasks/wake-state.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { failureCompany } from './failure-company.js';

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
/* What the role templates set; templates.test.ts holds them to it. */
const REVIEWER = 'xhigh';
const HEAD = 'high';

async function gateCompany() {
  const c = await failureCompany();
  const { ctx, db } = c;
  await db.update(subscriptions).set({ models: [{ id: 'm', name: 'M', efforts: LEVELS }] }).where(eq(subscriptions.id, c.sub.id));
  const [person] = await db.select().from(people);
  const [rita] = await db.insert(agents).values({ companyId: c.companyId, name: 'Rita', kind: 'worker', roleKey: 'DEV-REV', departmentId: c.dev.id, subscriptionId: c.sub.id, model: '' }).returning();
  const reviewer = rita!;
  const bruno = c.agent;
  const parent = (await createTask(ctx, { personId: person!.id }, { title: 'Payments', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.head.id })).task;
  const task = async (title: string, gate = reviewer.id): Promise<Task> =>
    (await createTask(ctx, { agentId: c.head.id }, { title, brief: '', body: '', departmentId: c.dev.id, parentId: parent.id, assigneeAgentId: bruno.id, executor: true, gates: [gate] })).task;
  /* A turn that brings a report waits a moment for what else comes; here nothing does. */
  const wake = async (wakes: Wake[]) => {
    await wakeAll(ctx, wakes);
    await db.update(jobs).set({ notBefore: null }).where(eq(jobs.status, 'queued'));
    for (const w of wakes) await pump(ctx, w.agentId);
  };
  /* Word for word the same hand-in is taken for a repeat of the last. */
  let handedIn = 0;
  const handIn = async (t: Task) => wake((await submit(ctx, bruno.id, t.id, { summary: `Done, take ${++handedIn}.`, evidence: 'npm test' })).wakes);
  const sendBack = async (t: Task, by = reviewer.id) => wake((await verdict(ctx, by, t.id, { pass: false, comment: 'A test is missing.' })).wakes);
  const running = async (agentId: string) => (await db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.status, 'running'))))[0];
  const endTurn = async (agentId: string) =>
    handleNodeMessage(ctx, BUILTIN, { type: 'job.done', jobId: (await running(agentId))!.id, ok: true, sessionId: 'session', result: 'Done.', tail: '', error: null });
  /* The level of every turn the agent's program was started for, in the order they went out. */
  const levels = async (agentId: string) => {
    const own = new Set((await c.turnsOf(agentId)).map(j => j.id));
    return c.sent.mock.calls.map(([, frame]) => frame as unknown as { type: string; jobId: string; effort: string | null }).filter(f => f.type === 'job.run' && own.has(f.jobId)).map(f => f.effort);
  };
  /* Work sent back once and fixed, so the reviewer's next word on it is a look again. Its turns are over. */
  const sentBackOnce = async (t: Task, by = reviewer.id) => {
    await handIn(t);
    await sendBack(t, by);
    await endTurn(by);
    await endTurn(bruno.id);
  };
  const card = (agentId: string, effort: string | null) => db.update(agents).set({ effort }).where(eq(agents.id, agentId));
  const cardOf = async (agentId: string) => (await db.select({ effort: agents.effort }).from(agents).where(eq(agents.id, agentId)))[0]!.effort;
  const busy = async (agentId: string) => {
    await insertTurn(ctx, { companyId: c.companyId, agentId, prompt: 'Something else.', createdBy: null });
    await pump(ctx, agentId);
  };
  return { ...c, reviewer, bruno, task, wake, handIn, sendBack, running, endTurn, levels, sentBackOnce, card, cardOf, busy };
}

describe('how hard each turn thinks', () => {
  it('starts a first look at the base and the look again at the fixes at medium', async () => {
    const c = await gateCompany();
    const task = await c.task('Checkout API');
    await c.handIn(task);
    expect(await c.levels(c.reviewer.id)).toEqual([REVIEWER]);
    await c.sendBack(task);
    await c.endTurn(c.reviewer.id);
    await c.handIn(task);
    expect(await c.levels(c.reviewer.id)).toEqual([REVIEWER, 'medium']);
  });

  it('keeps the base for the fixes themselves, as nothing says they are mechanical', async () => {
    const c = await gateCompany();
    await c.card(c.bruno.id, 'high');
    const task = await c.task('Checkout API');
    await c.handIn(task);
    await c.sendBack(task);
    expect(await c.levels(c.bruno.id)).toEqual(['high']);
  });

  it('takes medium for merging what passed its gates', async () => {
    const c = await gateCompany();
    await c.card(c.bruno.id, 'high');
    const task = await c.task('Checkout API');
    await c.db.update(tasks).set({ status: 'working', merging: true }).where(eq(tasks.id, task.id));
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'merge' }]);
    expect(await c.levels(c.bruno.id)).toEqual(['medium']);
  });

  it('holds the level on the card for first looks, lowers the look again and leaves the card as it was', async () => {
    const c = await gateCompany();
    await c.card(c.reviewer.id, 'max');
    const task = await c.task('Checkout API');
    await c.sentBackOnce(task);
    await c.handIn(task);
    await c.endTurn(c.reviewer.id);
    await c.handIn(await c.task('Refunds'));
    expect(await c.levels(c.reviewer.id)).toEqual(['max', 'medium', 'max']);
    expect(await c.cardOf(c.reviewer.id)).toBe('max');
  });

  it('claims no level for a model that names none, on a look again either', async () => {
    const c = await gateCompany();
    await c.db.update(subscriptions).set({ models: [{ id: 'm', name: 'M' }] }).where(eq(subscriptions.id, c.sub.id));
    const task = await c.task('Checkout API');
    await c.sentBackOnce(task);
    await c.handIn(task);
    expect(await c.levels(c.reviewer.id)).toEqual([null, null]);
  });

  it('never changes a running turn: what comes while it runs starts no program, and the next turn takes its own level', async () => {
    const c = await gateCompany();
    const lookedAt = await c.task('Checkout API');
    await c.sentBackOnce(lookedAt);
    await c.handIn(await c.task('Refunds'));
    const firstLook = await c.running(c.reviewer.id);
    expect(await c.levels(c.reviewer.id)).toEqual([REVIEWER, REVIEWER]);
    const before = c.sent.mock.calls.length;

    await c.handIn(lookedAt);
    await c.card(c.reviewer.id, 'low');
    await pump(c.ctx, c.reviewer.id);

    expect(c.sent.mock.calls.length).toBe(before);
    expect((await c.running(c.reviewer.id))!.id).toBe(firstLook!.id);
    await c.card(c.reviewer.id, null);
    await c.endTurn(c.reviewer.id);
    expect(await c.levels(c.reviewer.id)).toEqual([REVIEWER, REVIEWER, 'medium']);
  });

  it('goes back to the base on the turn after a look again', async () => {
    const c = await gateCompany();
    const task = await c.task('Checkout API');
    await c.sentBackOnce(task);
    await c.handIn(task);
    await c.endTurn(c.reviewer.id);
    await c.handIn(await c.task('Refunds'));
    expect(await c.levels(c.reviewer.id)).toEqual([REVIEWER, 'medium', REVIEWER]);
  });

  it('keeps medium when a look again is run once more', async () => {
    const c = await gateCompany();
    const task = await c.task('Checkout API');
    await c.sentBackOnce(task);
    await c.handIn(task);
    const look = (await c.running(c.reviewer.id))!;
    await c.db.update(jobs).set({ status: 'failed', error: 'machine_restarted' }).where(eq(jobs.id, look.id));
    const ended = await repeatedTurn(c.db, look.id, 'restart');
    await turnAgain(c.ctx, ended!, 'Your last turn was cut.', { retryOf: look.id });
    await pump(c.ctx, c.reviewer.id);
    expect(await c.levels(c.reviewer.id)).toEqual([REVIEWER, 'medium', 'medium']);
  });

  it('gives a comment its own turn at the base when a look again waits with its report', async () => {
    const c = await gateCompany();
    const task = await c.task('Checkout API');
    await c.sentBackOnce(task);
    await c.busy(c.reviewer.id);
    await c.handIn(task);
    await c.wake((await comment(c.ctx, { agentId: c.head.id }, task.id, 'Look at the refunds as well.')).wakes);
    await c.endTurn(c.reviewer.id);
    await c.endTurn(c.reviewer.id);
    expect((await c.levels(c.reviewer.id)).slice(-2)).toEqual(['medium', REVIEWER]);
  });

  it('keeps the base when new words join a waiting turn that needed less', async () => {
    const c = await gateCompany();
    await c.card(c.bruno.id, 'high');
    const task = await c.task('Checkout API');
    await c.db.update(tasks).set({ status: 'working', merging: true }).where(eq(tasks.id, task.id));
    await c.busy(c.bruno.id);
    await c.wake([{ agentId: c.bruno.id, taskId: task.id, why: 'merge' }]);
    await c.wake((await comment(c.ctx, { agentId: c.head.id }, task.id, 'Rebase on the refunds first.')).wakes);
    await c.endTurn(c.bruno.id);
    expect(await c.turnsOf(c.bruno.id)).toHaveLength(2);
    expect(await c.levels(c.bruno.id)).toEqual(['high', 'high']);
  });

  describe('for a head who reads several tasks in one turn', () => {
    async function headAtTwoGates() {
      const c = await gateCompany();
      const [one, two] = [await c.task('Checkout API', c.head.id), await c.task('Refunds', c.head.id)];
      await c.sentBackOnce(one!, c.head.id);
      await c.sentBackOnce(two!, c.head.id);
      await c.busy(c.head.id);
      return { ...c, one: one!, two: two! };
    }

    it('takes medium only when every one of them is a look again', async () => {
      const c = await headAtTwoGates();
      await c.handIn(c.one);
      await c.handIn(c.two);
      await c.endTurn(c.head.id);
      expect((await c.levels(c.head.id)).at(-1)).toBe('medium');
    });

    it('keeps the base when one of them has no words to say why', async () => {
      const c = await headAtTwoGates();
      await c.handIn(c.one);
      await c.handIn(c.two);
      const [waiting] = await c.db.select().from(jobs).where(and(eq(jobs.agentId, c.head.id), eq(jobs.taskId, c.two.id), eq(jobs.status, 'queued')));
      await c.db.delete(agentEvents).where(eq(agentEvents.jobId, waiting!.id));
      await c.endTurn(c.head.id);
      expect((await c.levels(c.head.id)).at(-1)).toBe(HEAD);
    });

    it('keeps the base when one of them is a first look', async () => {
      const c = await headAtTwoGates();
      await c.handIn(c.one);
      await c.handIn(await c.task('Invoices', c.head.id));
      await c.endTurn(c.head.id);
      expect((await c.levels(c.head.id)).at(-1)).toBe(HEAD);
    });
  });
});
