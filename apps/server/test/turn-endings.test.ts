import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { agentEvents, agents, companies, departments, jobs, people, subscriptions, taskEvents, tasks, turns } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { GONE_ALONG, pump } from '../src/modules/conversation/queue.js';
import { REPORT_WINDOW_MS } from '../src/modules/conversation/report-notices.js';
import { identityOf } from '../src/modules/nodes/hub.js';
import { createTask, report, submit, verdict } from '../src/modules/tasks/engine.js';
import { routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { BASE, HEAD } from './development-echelons-fixture.js';
import { connectNode, listen, setUpCompany, testApp, until, type FakeNode, echelonsTurn } from './helpers.js';
import { recorded } from './recorded-fixture.js';
import { BUILTIN } from './builtin.js';

const NODE_KEY = 'k'.repeat(40);

type Run = { type: 'job.run'; jobId: string; prompt: string; sessionId: string | null };
type Exit = { code: number | null; signal: string | null };

/* A company on the built-in node: Development with Hana at its head, Bruno who does the work and Rita checking its candidate, and
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
  await until(() => app.ctx.hub.isReady(identityOf(sub!, null, null, BUILTIN)!));
  const dept = async (templateKey: 'development' | 'operations', roleCode: string) => (await db.insert(departments).values({ companyId, templateKey, roleCode }).returning())[0]!;
  const [dev, ops] = [await dept('development', 'DEV'), await dept('operations', 'OPS')];
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: 'claude-opus-5-5', subscriptionId: sub!.id, skills: app.ctx.templates.roles.get(roleKey)?.skills.filter(s => s.on).map(s => s.id) ?? [] }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD', dev.id);
  const bruno = await hire('Bruno', 'worker', 'DEV-BE', dev.id);
  const rita = await hire('Rita', 'worker', 'DEV-REV', dev.id);
  const rob = await hire('Rob', 'worker', 'OPS-FIX', ops.id);
  const ctx = app.ctx;
  await db.update(departments).set({ repoUrl: 'https://github.com/acme/shop.git' }).where(eq(departments.id, dev.id));
  ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: HEAD });
  ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
  await echelonsTurn(db, companyId);
  const task = (await createTask(ctx, { agentId: hana.id }, { title: 'Checkout API', brief: '', body: 'POST /checkout.', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true, small: true, paths: ['logic/totals.ts'], reviewerAgentId: rita.id })).task;
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
  /* The node says the turn's program ended without its work done, as it ended. The server acknowledges the end once it
     has handled it, the next turn it makes for it included. */
  const failed = async (run: Run, exit: Exit, more: { sessionId?: string | null; tail?: string; error?: 'agent_failed' | 'timeout' } = {}) => {
    node.send({ type: 'job.done', jobId: run.jobId, ok: false, sessionId: more.sessionId ?? null, result: '', tail: more.tail ?? 'Program ended.', error: more.error ?? 'agent_failed', exit });
    await until(() => node.acks.includes(run.jobId));
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
  const handIn = async () => wakeAll(ctx, (await submit(ctx, bruno.id, task.id, { summary: 'POST /checkout works.', evidence: 'Changed total tests.', review: { baseCommit: BASE } })).wakes);
  /* A turn that brings a report waits a short while for other reports to join it: here the server's pump runs past that
     window at once, instead of the test waiting it out. */
  const pastReportWindow = async (agentId: string) => {
    await until(async () => (await turnsOf(agentId)).length > 0);
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + REPORT_WINDOW_MS + 1);
    try {
      await pump(ctx, agentId);
    } finally {
      clock.mockRestore();
    }
  };
  return { app, db, ctx, companyId, sub: sub!, node, hana, bruno, rita, rob, task, turnsOf, jobOf, taskNow, runOf, nextTurn, failed, ended, brunoAtWork, handIn, pastReportWindow };
}

describe("a turn whose program ended without the work done", () => {
  it.each(['done', 'cancelled'] as const)('logs a skipped continuation when the task became %s during the turn', async status => {
    const c = await company();
    const work = await c.brunoAtWork();
    await c.db.update(tasks).set({ status, closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, c.task.id));
    await c.failed(work, { code: 1, signal: null });
    const log = await c.db.select().from(taskEvents).where(eq(taskEvents.taskId, c.task.id));
    expect(log.filter(e => e.kind === 'wake_skipped')).toEqual([expect.objectContaining({ agentId: c.bruno.id, data: { wake: 'continue', job: work.jobId } })]);
    expect((await c.turnsOf(c.bruno.id)).map(j => j.id)).toEqual([work.jobId]);
    expect(await c.turnsOf(c.hana.id)).toEqual([]);
  });

  it.each([null, ''])('continues a turn with requested text %j using the legacy sent text only for null', async requestedPrompt => {
    const c = await company();
    const work = await c.brunoAtWork();
    await c.db.update(jobs).set({ requestedPrompt, prompt: 'Legacy sent work.' }).where(eq(jobs.id, work.jobId));

    await c.failed(work, { code: 1, signal: null });
    const more = await c.nextTurn(c.bruno.id, 1);

    expect(more.prompt.includes('Legacy sent work.')).toBe(requestedPrompt === null);
    expect(more.prompt).toContain('without recording');
  });

  it.each([null, 'bruno-session'])('adds current queue context once when continuing work from session %s anew, and no repository', async sessionId => {
    const c = await company();
    await c.db.update(departments).set({ repoUrl: 'https://example.com/checkout.git', repoBranch: 'main' }).where(eq(departments.id, c.task.departmentId!));
    await c.db.insert(agentEvents).values({ companyId: c.companyId, agentId: c.bruno.id, kind: 'text', data: { text: 'Earlier checkout discussion.' } });
    const work = await c.brunoAtWork();
    expect(work.prompt.match(/Earlier in this conversation/g)).toHaveLength(1);
    expect(work.prompt).not.toContain('checkout.git');
    await c.db.update(departments).set({ repoBranch: 'checkout' }).where(eq(departments.id, c.task.departmentId!));
    await c.db.update(agents).set({ overrides: { base: 'Write the test first, then the code.' } }).where(eq(agents.id, c.bruno.id));

    await c.failed(work, { code: 1, signal: null }, { sessionId });
    const more = await c.nextTurn(c.bruno.id, 1);

    expect(more.sessionId).toBeNull();
    expect(more.prompt.match(/Earlier in this conversation/g)).toHaveLength(1);
    expect(more.prompt).not.toContain('checkout.git');
    expect(more.prompt).not.toContain('(branch');
    expect(more.prompt).toContain(`#${c.task.number} "Checkout API" is yours to do`);
    expect(await c.jobOf(more.jobId)).toMatchObject({ prompt: more.prompt, continueOf: work.jobId });
  });

  it('is done when the turn recorded its verdict before its program exited with an error, and runs no more', async () => {
    const c = await company();
    const work = await c.brunoAtWork();
    await c.handIn();
    await c.ended(work);
    await c.pastReportWindow(c.rita.id);
    const check = await c.nextTurn(c.rita.id);
    await wakeAll(c.ctx, (await verdict(c.ctx, c.rita.id, c.task.id, { pass: true, comment: 'Looks right.', reviewedCommit: HEAD })).wakes);
    await c.failed(check, { code: 1, signal: null }, { tail: 'Verdict pass: true recorded.\n› ' });
    expect(await c.jobOf(check.jobId)).toMatchObject({ status: 'done', error: null, exitCode: 1, exitSignal: null, tail: expect.stringContaining('Verdict pass: true recorded.') });
    expect((await c.turnsOf(c.rita.id)).map(j => j.id)).toEqual([check.jobId]);
    const current = await c.taskNow();
    expect(current.status).not.toBe('done');
    expect(routeSnapshot(await routeOf(c.db, current), current.assigneeAgentId).stage).toBe('tests');
    const shown = await c.db.select(only(agentEvents, 'kind')).from(agentEvents).where(eq(agentEvents.jobId, check.jobId));
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
    expect((await c.turnsOf(c.bruno.id)).map(j => j.id)).toEqual([work.jobId, more.jobId]);
  });

  it('goes on no second time when its continuation records nothing either', async () => {
    const c = await company();
    const work = await c.brunoAtWork();
    await c.failed(work, { code: 1, signal: null }, { sessionId: 'bruno-session' });
    const more = await c.nextTurn(c.bruno.id, 1);
    await c.failed(more, { code: 2, signal: null }, { sessionId: 'bruno-session', tail: 'Error: the model refused.' });
    expect(await c.jobOf(more.jobId)).toMatchObject({ status: 'failed', error: 'agent_failed', exitCode: 2, tail: 'Error: the model refused.' });
    expect((await c.turnsOf(c.bruno.id)).filter(j => j.continueOf === more.jobId)).toEqual([]);
    expect((await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.task.id), eq(taskEvents.kind, 'continued')))).filter(e => (e.data as { continuation?: string }).continuation)).toHaveLength(1);
  });

  it('is not done by what the agent recorded on another task while it ran, and goes on', async () => {
    const c = await company();
    /* Where the department keeps code, a worker closes a task without code only through its head; these keep none. */
    await c.db.update(departments).set({ repoUrl: null }).where(eq(departments.id, c.task.departmentId!));
    const other = (await createTask(c.ctx, { agentId: c.hana.id }, { title: 'Refund email', brief: '', body: 'Send it.', departmentId: c.task.departmentId, assigneeAgentId: c.bruno.id })).task;
    const work = await c.brunoAtWork();
    /* While his turn on the checkout runs, he reports on the refund email, and nothing on the checkout. */
    await report(c.ctx, c.bruno.id, other.id, { done: true, summary: 'Refund email sent.', ...(await recorded(c.ctx, other.id, c.bruno.id)) });
    await c.failed(work, { code: 1, signal: null }, { sessionId: 'bruno-session' });
    expect(await c.jobOf(work.jobId)).toMatchObject({ status: 'failed', error: 'agent_failed' });
    const more = await c.nextTurn(c.bruno.id, 1);
    expect(await c.jobOf(more.jobId)).toMatchObject({ taskId: c.task.id, continueOf: work.jobId });
    expect(await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.task.id), eq(taskEvents.kind, 'report')))).toEqual([]);
  });

  it("is done by what a head recorded on a task whose turn went out inside it", async () => {
    const c = await company();
    const [ceo] = await c.db.select().from(people);
    const held = async (title: string) => (await createTask(c.ctx, { personId: ceo!.id }, { title, brief: '', body: '', departmentId: c.task.departmentId, assigneeAgentId: c.hana.id })).task;
    const [payments, refunds] = [await held('Payments'), await held('Refunds')];
    /* Hold the head busy so both task wakes go out together. */
    const [busy] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.sub.id, agentId: c.hana.id, kind: 'conversation', prompt: 'Plan the turn.', timeoutMs: 60_000, status: 'running', startedAt: new Date() }).returning();
    await wakeAll(c.ctx, [payments, refunds].map(task => ({ agentId: c.hana.id, taskId: task.id, why: 'assigned' })));
    await c.ended({ type: 'job.run', jobId: busy!.id, prompt: 'Plan the turn.', sessionId: null });
    const work = await c.nextTurn(c.hana.id, 1);
    await until(async () => (await c.turnsOf(c.hana.id)).some(j => j.taskId === refunds.id && j.result === GONE_ALONG));
    await report(c.ctx, c.hana.id, refunds.id, { done: true, summary: 'Refunds shipped.', ...(await recorded(c.ctx, refunds.id, c.hana.id)) });
    await c.failed(work, { code: 1, signal: null });
    expect(await c.jobOf(work.jobId)).toMatchObject({ status: 'done', error: null, exitCode: 1 });
  });

  it('carries the original work when a head continues inside another task turn without its old session', async () => {
    const c = await company();
    const [ceo] = await c.db.select().from(people);
    const held = async (title: string) => (await createTask(c.ctx, { personId: ceo!.id }, { title, brief: '', body: '', departmentId: c.task.departmentId, assigneeAgentId: c.hana.id })).task;
    const [payments, refunds] = [await held('Payments'), await held('Refunds')];
    await wakeAll(c.ctx, [{ agentId: c.hana.id, taskId: payments.id, why: 'assigned' }]);
    const work = await c.nextTurn(c.hana.id);
    await wakeAll(c.ctx, [{ agentId: c.hana.id, taskId: refunds.id, why: 'assigned' }]);
    await c.db.update(agents).set({ overrides: { base: 'Write the test first, then the code.' } }).where(eq(agents.id, c.hana.id));
    /* The old assignment is outside the bounded catch-up history. */
    await c.db.insert(agentEvents).values(Array.from({ length: 25 }, (_, i) => ({ companyId: c.companyId, agentId: c.hana.id, jobId: work.jobId, kind: 'text' as const, data: { text: `Planning step ${i}.` } })));
    await c.failed(work, { code: 1, signal: null }, { sessionId: 'hana-session' });
    const more = await c.nextTurn(c.hana.id, 1);
    expect(await c.jobOf(more.jobId)).toMatchObject({ taskId: refunds.id });
    expect(more.sessionId).toBeNull();
    expect(more.prompt).toContain(`#${payments.number} "Payments" is your department's`);
  });

  it('carries what the turn was asked when its session cannot go on, as his instructions changed meanwhile', async () => {
    const c = await company();
    /* Bruno last finished a turn before the company's turn opened, so a new session of his starts clean, with no catch-up. */
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.sub.id, agentId: c.bruno.id, kind: 'conversation', prompt: 'Earlier work.', timeoutMs: 60_000, status: 'done', sessionId: 'earlier-session', createdAt: ago(60), startedAt: ago(60), finishedAt: ago(55) });
    await c.db.update(turns).set({ title: 'Checkout', createdByAgentId: orchestrator!.id, openedAt: ago(30) }).where(eq(turns.companyId, c.companyId));
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: c.task.id, why: 'assigned' }]);
    const work = await c.nextTurn(c.bruno.id, 1);
    await c.db.update(agents).set({ overrides: { base: 'Write the test first, then the code.' } }).where(eq(agents.id, c.bruno.id));
    await c.failed(work, { code: 1, signal: null }, { sessionId: 'bruno-session' });
    const more = await c.nextTurn(c.bruno.id, 2);
    expect(await c.jobOf(more.jobId)).toMatchObject({ continueOf: work.jobId });
    expect(more.sessionId).toBeNull();
    expect(more.prompt).toContain('without recording');
    expect(more.prompt).toContain(`#${c.task.number} "Checkout API" is yours to do`);
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
    expect((await c.turnsOf(c.rob.id)).map(j => j.id)).toEqual([timer!.id]);
  });
});
