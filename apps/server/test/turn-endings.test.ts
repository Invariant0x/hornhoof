import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, agents, companies, departments, jobs, subscriptions, taskEvents, tasks } from '../src/db/schema.js';
import { identityOf } from '../src/modules/nodes/hub.js';
import { createTask, submit, verdict } from '../src/modules/tasks/engine.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { connectNode, listen, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);

type Run = { type: 'job.run'; jobId: string; prompt: string; sessionId: string | null };
type Exit = { code: number | null; signal: string | null };

/* A company on the built-in node: Development with Hana at its head, Bruno who does the work and Rita at its gate, and
   Rob of Operations, who has a timer. */
async function company() {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [sub] = await db.select().from(subscriptions);
  const node: FakeNode = await connectNode(url, NODE_KEY);
  node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [] });
  await until(async () => (await db.select().from(subscriptions))[0]!.status === 'ready');
  await until(() => app.ctx.hub.isReady(identityOf(sub!, null)));
  const dept = async (templateKey: 'development' | 'operations', roleCode: string) => (await db.insert(departments).values({ companyId, templateKey, roleCode }).returning())[0]!;
  const [dev, ops] = [await dept('development', 'DEV'), await dept('operations', 'OPS')];
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD', dev.id);
  const bruno = await hire('Bruno', 'worker', 'DEV-ENG', dev.id);
  const rita = await hire('Rita', 'worker', 'DEV-REV', dev.id);
  const rob = await hire('Rob', 'worker', 'OPS-FIX', ops.id);
  const ctx = app.ctx;
  const task = (await createTask(ctx, { agentId: hana.id }, { title: 'Checkout API', brief: '', body: 'POST /checkout.', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true, gates: [rita.id] })).task;
  const turnsOf = (agentId: string) => db.select().from(jobs).where(eq(jobs.agentId, agentId)).orderBy(asc(jobs.createdAt));
  const jobOf = async (id: string) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
  const taskNow = async () => (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!;
  /* The runs the node got, by job, whichever order they come in. */
  const runs = new Map<string, Run>();
  const runOf = async (jobId: string): Promise<Run> => {
    while (!runs.has(jobId)) {
      const m = await node.next();
      if (m.type === 'job.run') runs.set(m.jobId, m as Run);
    }
    return runs.get(jobId)!;
  };
  /* The agent's newest turn, once it went out to the node. */
  const nextTurn = async (agentId: string, after = 0): Promise<Run> => {
    await until(async () => (await turnsOf(agentId)).length > after);
    return runOf((await turnsOf(agentId))[after]!.id);
  };
  /* The node says the turn's program ended without its work done, as it ended. */
  const failed = async (run: Run, exit: Exit, more: { sessionId?: string | null; tail?: string; error?: 'agent_failed' | 'timeout' } = {}) => {
    node.send({ type: 'job.done', jobId: run.jobId, ok: false, sessionId: more.sessionId ?? null, result: '', tail: more.tail ?? 'Program ended.', error: more.error ?? 'agent_failed', exit });
    await until(async () => (await jobOf(run.jobId)).finishedAt !== null);
  };
  const ended = async (run: Run) => {
    node.send({ type: 'job.done', jobId: run.jobId, ok: true, sessionId: null, result: 'Done.', tail: '', error: null });
    await until(async () => (await jobOf(run.jobId)).finishedAt !== null);
  };
  /* Bruno's turn on his task goes out to the node. */
  const brunoAtWork = async () => {
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    return nextTurn(bruno.id);
  };
  /* What Bruno hands in while his turn runs, and the wakes it brings. */
  const handIn = async () => wakeAll(ctx, (await submit(ctx, bruno.id, task.id, { summary: 'POST /checkout works.', evidence: 'npm test: 12 passed' })).wakes);
  const settle = () => new Promise(r => setTimeout(r, 150));
  return { app, db, ctx, companyId, sub: sub!, node, hana, bruno, rita, rob, task, turnsOf, jobOf, taskNow, runOf, nextTurn, failed, ended, brunoAtWork, handIn, settle };
}

describe("a turn whose program ended without the work done", () => {
  it('is done when the turn recorded its verdict before its program exited with an error, and runs no more', async () => {
    const c = await company();
    const work = await c.brunoAtWork();
    await c.handIn();
    await c.ended(work);
    const check = await c.nextTurn(c.rita.id);
    await wakeAll(c.ctx, (await verdict(c.ctx, c.rita.id, c.task.id, { pass: true, comment: 'Looks right.' })).wakes);
    await c.failed(check, { code: 1, signal: null }, { tail: 'Verdict pass: true recorded.\n› ' });
    expect(await c.jobOf(check.jobId)).toMatchObject({ status: 'done', error: null, exitCode: 1, exitSignal: null, tail: expect.stringContaining('Verdict pass: true recorded.') });
    await c.settle();
    expect((await c.turnsOf(c.rita.id)).map(j => j.id)).toEqual([check.jobId]);
    expect((await c.taskNow()).status).not.toBe('review');
    const shown = await c.db.select({ kind: agentEvents.kind }).from(agentEvents).where(eq(agentEvents.jobId, check.jobId));
    expect(shown.map(e => e.kind)).not.toContain('failed');
  });

  it('is done when it handed its work in before its time ran out', async () => {
    const c = await company();
    const work = await c.brunoAtWork();
    await c.handIn();
    await c.failed(work, { code: null, signal: 'SIGTERM' }, { error: 'timeout' });
    expect(await c.jobOf(work.jobId)).toMatchObject({ status: 'done', error: null, exitSignal: 'SIGTERM' });
  });

  it('keeps how its program ended and goes on once in its session, which is done once it records the work', async () => {
    const c = await company();
    const work = await c.brunoAtWork();
    const tail = "The program waited at its prompt for 300 s without ending Hornhoof's turn, so Hornhoof ended it.";
    await c.failed(work, { code: null, signal: 'SIGTERM' }, { sessionId: 'bruno-session', tail });
    expect(await c.jobOf(work.jobId)).toMatchObject({ status: 'failed', error: 'agent_failed', exitCode: null, exitSignal: 'SIGTERM', tail });
    /* Once, in the same session, reminded to finish with its tool. */
    const more = await c.nextTurn(c.bruno.id, 1);
    expect(await c.jobOf(more.jobId)).toMatchObject({ taskId: c.task.id, continueOf: work.jobId });
    expect(more.sessionId).toBe('bruno-session');
    expect(more.prompt).toContain('without recording');
    expect(more.prompt).toContain('SIGTERM');
    expect(more.prompt).not.toContain('is yours to do');
    const [note] = await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.task.id), eq(taskEvents.kind, 'continued')));
    expect(note).toMatchObject({ agentId: c.bruno.id, data: { job: work.jobId, continuation: more.jobId, exit: { code: null, signal: 'SIGTERM' } } });
    /* It hands the work in, though its program exits with an error after. */
    await c.handIn();
    await c.failed(more, { code: 1, signal: null }, { sessionId: 'bruno-session' });
    expect(await c.jobOf(more.jobId)).toMatchObject({ status: 'done', error: null, exitCode: 1 });
    await c.settle();
    expect((await c.turnsOf(c.bruno.id)).map(j => j.id)).toEqual([work.jobId, more.jobId]);
  });

  it('goes on no second time when its continuation records nothing either', async () => {
    const c = await company();
    const work = await c.brunoAtWork();
    await c.failed(work, { code: 1, signal: null }, { sessionId: 'bruno-session' });
    const more = await c.nextTurn(c.bruno.id, 1);
    await c.failed(more, { code: 2, signal: null }, { sessionId: 'bruno-session', tail: 'Error: the model refused.' });
    expect(await c.jobOf(more.jobId)).toMatchObject({ status: 'failed', error: 'agent_failed', exitCode: 2, tail: 'Error: the model refused.' });
    await c.settle();
    expect((await c.turnsOf(c.bruno.id)).filter(j => j.continueOf === more.jobId)).toEqual([]);
    expect((await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.task.id), eq(taskEvents.kind, 'continued')))).filter(e => (e.data as { continuation?: string }).continuation)).toHaveLength(1);
  });

  it('starts anew with the same work when its program never named a session to go on in', async () => {
    const c = await company();
    const work = await c.brunoAtWork();
    await c.failed(work, { code: 1, signal: null }, { sessionId: null });
    const more = await c.nextTurn(c.bruno.id, 1);
    expect(more.prompt).toContain('without recording');
    expect(more.prompt).toContain(`#${c.task.number} "Checkout API" is yours to do`);
  });

  it('keeps how the program of a turn without a task ended, and leaves it to its next round', async () => {
    const c = await company();
    const [timer] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.sub.id, agentId: c.rob.id, kind: 'conversation', prompt: 'Your round.', timeoutMs: 60_000, status: 'running', startedAt: new Date() }).returning();
    await c.failed({ type: 'job.run', jobId: timer!.id, prompt: 'Your round.', sessionId: null }, { code: 2, signal: null }, { tail: 'Error: the round broke.' });
    expect(await c.jobOf(timer!.id)).toMatchObject({ status: 'failed', error: 'agent_failed', exitCode: 2, exitSignal: null, tail: 'Error: the round broke.' });
    await c.settle();
    expect((await c.turnsOf(c.rob.id)).map(j => j.id)).toEqual([timer!.id]);
  });
});
