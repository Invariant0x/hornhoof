import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, companies, departments, jobs, requestInternal, requests, subscriptions, taskEvents, tasks } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { GONE_ALONG } from '../src/modules/conversation/queue.js';
import { createTask, GOING_ON_TURNS, SILENT_TURNS, submit, verdict } from '../src/modules/tasks/engine.js';
import { routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { afterJob, checkLiveness, wakeAll } from '../src/modules/tasks/wake.js';
import { BASE, HEAD } from './development-echelons-fixture.js';
import { as, listen, mcp, setUpCompany, testApp, echelonsTurn } from './helpers.js';

const TOKEN = 'stuck-policy-tool-token-0123456789ab';

async function company() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [sub] = await db.select().from(subscriptions);
  const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId: acme!.id, kind, name, roleKey, departmentId: dev!.id, model: 'claude-opus-5-5', subscriptionId: sub!.id, skills: app.ctx.templates.roles.get(roleKey)!.skills.filter(s => s.on).map(s => s.id) }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const worker = await hire('Bruno', 'worker', 'DEV-BE');
  const reviewer = await hire('Rita', 'worker', 'DEV-REV');
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  app.ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: HEAD });
  app.ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
  const taskFor = async (agentId: string, createdByAgentId: string, title = 'Checkout', reviewerAgentId?: string) =>
    (await createTask(app.ctx, { agentId: createdByAgentId }, { title, brief: '', body: 'Finish the work.', departmentId: dev!.id, assigneeAgentId: agentId, executor: true, small: true, paths: ['logic/totals.ts'], reviewerAgentId })).task;
  const realProgram = async (jobId: string, agentId: string) => {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    await db.insert(agentEvents).values({ companyId: job!.companyId, agentId, jobId, kind: 'program', data: { program: { state: 'thinking', since: Date.now() - 60_000, tool: null }, alarm: null } });
  };
  const finish = async (agentId: string, taskId: string) => {
    const [job] = await db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.taskId, taskId), eq(jobs.status, 'queued'))).orderBy(asc(jobs.createdAt));
    await db.update(jobs).set({ status: 'running', startedAt: new Date(Date.now() - 60_000) }).where(eq(jobs.id, job!.id));
    await realProgram(job!.id, agentId);
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, job!.id));
    await afterJob(app.ctx, job!.id);
  };
  const commentByHead = async (taskId: string, text: string) => {
    const [answering] = await db.insert(jobs).values({ companyId: dev!.companyId, subscriptionId: sub!.id, agentId: head.id, taskId, kind: 'conversation', prompt: 'Resolve the stuck request.', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(TOKEN) }).returning();
    await listen(app);
    const client = await mcp(app, TOKEN);
    const result = await client.callTool({ name: 'comment', arguments: { task: taskId, text } });
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, answering!.id));
    return { result, answering: answering! };
  };
  await echelonsTurn(db, acme!.id);
  return { app, db, ctx: app.ctx, ceo, dev: dev!, sub: sub!, head, worker, reviewer, orchestrator: orchestrator!, taskFor, realProgram, finish, commentByHead };
}

describe('stuck turn eligibility', () => {
  it('does not count coalesced turns that accumulated while the machine was off', async () => {
    const c = await company();
    const work = await Promise.all(Array.from({ length: 10 }, (_, i) => c.taskFor(c.head.id, c.orchestrator.id, `Queued ${i}`)));
    for (const task of work) {
      await c.db.update(tasks).set({ silent: SILENT_TURNS - 1 }).where(eq(tasks.id, task.id));
      await c.db.insert(jobs).values(Array.from({ length: 3 }, () => ({ companyId: task.companyId, subscriptionId: c.sub.id, agentId: c.head.id, taskId: task.id, kind: 'conversation' as const, prompt: 'Queued while the machine was off.', timeoutMs: 900000 })));
    }
    const queued = await c.db.select().from(jobs).where(eq(jobs.agentId, c.head.id)).orderBy(asc(jobs.createdAt));
    expect(queued).toHaveLength(30);
    const carrier = queued[0]!;
    const startedAt = new Date();
    await c.db.update(jobs).set({ status: 'running', startedAt }).where(eq(jobs.id, carrier.id));
    await c.realProgram(carrier.id, c.head.id);
    await c.db.update(jobs).set({ status: 'done', result: GONE_ALONG, startedAt, finishedAt: startedAt }).where(and(eq(jobs.agentId, c.head.id), eq(jobs.status, 'queued')));
    await c.db.update(tasks).set({ silent: 0 }).where(eq(tasks.id, carrier.taskId!));
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, carrier.id));

    await afterJob(c.ctx, carrier.id);

    expect(await c.db.select().from(requests)).toEqual([]);
    expect((await c.db.select({ id: tasks.id, silent: tasks.silent }).from(tasks)).find(t => t.id === carrier.taskId)?.silent).toBe(1);
    expect((await c.db.select({ id: tasks.id, silent: tasks.silent }).from(tasks)).filter(t => t.id !== carrier.taskId)).toMatchObject(work.slice(1).map(t => ({ id: t.id, silent: SILENT_TURNS - 1 })));
  });

  it('does not count a turn that opened and closed without a durable program fact', async () => {
    const c = await company();
    const task = await c.taskFor(c.worker.id, c.head.id);
    await c.db.update(tasks).set({ silent: SILENT_TURNS - 1 }).where(eq(tasks.id, task.id));
    await wakeAll(c.ctx, [{ agentId: c.worker.id, taskId: task.id, why: 'assigned' }]);
    const [job] = await c.db.select().from(jobs).where(eq(jobs.taskId, task.id));
    await c.db.update(jobs).set({ status: 'done', startedAt: new Date(Date.now() - 1000), finishedAt: new Date() }).where(eq(jobs.id, job!.id));

    await checkLiveness(c.ctx, job!.id);

    expect(await c.db.select().from(requests)).toEqual([]);
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.silent).toBe(SILENT_TURNS - 1);
  });

  it('leaves an agent failure to the failure mechanism without advancing either stuck counter', async () => {
    const c = await company();
    const task = await c.taskFor(c.worker.id, c.head.id);
    await wakeAll(c.ctx, [{ agentId: c.worker.id, taskId: task.id, why: 'assigned' }]);
    const [job] = await c.db.select().from(jobs).where(eq(jobs.taskId, task.id));
    await c.db.insert(taskEvents).values(Array.from({ length: GOING_ON_TURNS - 1 }, (_, i) => ({ companyId: task.companyId, taskId: task.id, agentId: c.worker.id, kind: 'continued' as const, text: `Earlier ${i}` })));
    await c.db.update(jobs).set({ status: 'failed', error: 'agent_failed', startedAt: new Date(Date.now() - 10 * 60_000), finishedAt: new Date() }).where(eq(jobs.id, job!.id));

    await checkLiveness(c.ctx, job!.id);

    expect(await c.db.select().from(requests)).toEqual([]);
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ silent: 0, status: 'open' });
    expect(await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'continued')))).toHaveLength(GOING_ON_TURNS - 1);
  });
});

describe('internal stuck routing', () => {
  it('asks the member head without showing the request to the CEO', async () => {
    const c = await company();
    const task = await c.taskFor(c.worker.id, c.head.id);
    await wakeAll(c.ctx, [{ agentId: c.worker.id, taskId: task.id, why: 'assigned' }]);
    for (let i = 0; i < SILENT_TURNS; i++) await c.finish(c.worker.id, task.id);

    const [request] = await c.db.select().from(requests);
    expect(request).toMatchObject({ kind: 'stuck', audience: 'internal', triageAgentId: c.head.id, status: 'open' });
    const addressed = await c.db.select().from(jobs).where(and(eq(jobs.agentId, c.head.id), eq(jobs.status, 'queued')));
    expect(addressed).toHaveLength(1);
    expect(addressed[0]!.prompt).toContain(request!.id);
    expect(addressed[0]!.prompt).toContain('comment');
    expect((await c.app.inject({ url: '/api/requests', ...as(c.ceo) })).json().requests).toEqual([]);
  });

  it('asks the orchestrator about a head and lets it answer without a person principal', async () => {
    const c = await company();
    const task = await c.taskFor(c.head.id, c.orchestrator.id);
    await wakeAll(c.ctx, [{ agentId: c.head.id, taskId: task.id, why: 'assigned' }]);
    for (let i = 0; i < SILENT_TURNS; i++) await c.finish(c.head.id, task.id);
    const [request] = await c.db.select().from(requests);
    expect(request).toMatchObject({ kind: 'stuck', audience: 'internal', triageAgentId: c.orchestrator.id, status: 'open' });
    const addressed = await c.db.select().from(jobs).where(and(eq(jobs.agentId, c.orchestrator.id), eq(jobs.status, 'queued')));
    expect(addressed).toHaveLength(1);
    expect(addressed[0]!.prompt).toContain('answer_request');
    expect((await c.app.inject({ url: '/api/requests', ...as(c.ceo) })).json().requests).toEqual([]);

    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, c.orchestrator.id));
    const [answering] = await c.db.insert(jobs).values({ companyId: c.dev.companyId, subscriptionId: c.sub.id, agentId: c.orchestrator.id, kind: 'conversation', prompt: 'Resolve the stuck request.', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(TOKEN) }).returning();
    await listen(c.app);
    const client = await mcp(c.app, TOKEN);
    const result = await client.callTool({ name: 'answer_request', arguments: { request: request!.id, answer: 'Split the work and continue.' } });

    expect(result.isError).toBeFalsy();
    expect((await c.db.select().from(requests).where(eq(requests.id, request!.id)))[0]).toMatchObject({ status: 'resolved_internal', answeredBy: null, answeredByAgentId: null, answeredAt: null });
    expect((await c.db.select().from(requestInternal).where(eq(requestInternal.requestId, request!.id)))[0]).toMatchObject({ resolvedByAgentId: c.orchestrator.id, resolvedByJobId: answering!.id, executorInstruction: 'Split the work and continue.' });
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ status: 'working', silent: 0 });
    expect((await c.app.inject({ url: '/api/requests', ...as(c.ceo) })).json().requests).toEqual([]);
  });

  it("closes a member request when its head comments and reminds the member after the next quiet turn", async () => {
    const c = await company();
    const task = await c.taskFor(c.worker.id, c.head.id);
    await wakeAll(c.ctx, [{ agentId: c.worker.id, taskId: task.id, why: 'assigned' }]);
    for (let i = 0; i < SILENT_TURNS; i++) await c.finish(c.worker.id, task.id);
    const [request] = await c.db.select().from(requests);
    await c.db.insert(requestInternal).values({ requestId: request!.id, companyId: c.dev.companyId, technicalText: request!.text });

    const { result, answering } = await c.commentByHead(task.id, 'Run the focused test, then continue.');

    expect(result.isError).toBeFalsy();
    expect((await c.db.select().from(requests).where(eq(requests.id, request!.id)))[0]).toMatchObject({ status: 'resolved_internal', answer: 'Run the focused test, then continue.' });
    expect((await c.db.select().from(requestInternal).where(eq(requestInternal.requestId, request!.id)))[0]).toMatchObject({ resolvedByAgentId: c.head.id, resolvedByJobId: answering.id, executorInstruction: 'Run the focused test, then continue.' });
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ status: 'working', silent: 0 });

    await c.finish(c.worker.id, task.id);

    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ status: 'working', silent: 1 });
    expect(await c.db.select().from(requests)).toHaveLength(1);
    const reminders = await c.db.select().from(jobs).where(and(eq(jobs.agentId, c.worker.id), eq(jobs.taskId, task.id), eq(jobs.status, 'queued')));
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.prompt).toContain('without moving it');
  });

  it('does not treat an internal stuck request as a human question that blocks the current Review verdict', async () => {
    const c = await company();
    const task = await c.taskFor(c.worker.id, c.head.id, 'Checkout', c.reviewer.id);
    await submit(c.ctx, c.worker.id, task.id, { summary: 'Ready.', evidence: 'Focused tests passed.', review: { baseCommit: BASE } });
    await wakeAll(c.ctx, [{ agentId: c.reviewer.id, taskId: task.id, why: 'review' }]);
    for (let i = 0; i < SILENT_TURNS; i++) await c.finish(c.reviewer.id, task.id);
    const [request] = await c.db.select().from(requests);
    expect(request).toMatchObject({ kind: 'stuck', audience: 'internal', triageAgentId: c.head.id, status: 'open' });

    const decided = await verdict(c.ctx, c.reviewer.id, task.id, { pass: true, comment: 'Focused evidence covers the change.', reviewedCommit: HEAD });

    expect(decided.task.status).not.toBe('done');
    expect(routeSnapshot(await routeOf(c.db, decided.task), decided.task.assigneeAgentId).stage).toBe('tests');
    expect((await c.db.select().from(requests).where(eq(requests.id, request!.id)))[0]!.status).toBe('open');
  });

  it('assigns an orchestrator stuck on its own task to the live department head', async () => {
    const c = await company();
    const { task } = await createTask(c.ctx, { agentId: c.orchestrator.id }, { title: 'Turn plan', brief: '', body: 'Finish the plan.', departmentId: c.dev.id, assigneeAgentId: c.orchestrator.id });
    await c.db.update(taskEvents).set({ createdAt: new Date(Date.now() - 120_000) }).where(eq(taskEvents.taskId, task.id));
    await c.db.insert(jobs).values({ companyId: c.dev.companyId, subscriptionId: c.sub.id, agentId: c.orchestrator.id, taskId: task.id, kind: 'conversation', prompt: 'Work on the turn plan.', timeoutMs: 900000 });
    for (let i = 0; i < SILENT_TURNS; i++) {
      await c.finish(c.orchestrator.id, task.id);
      const [current] = await c.db.select(only(tasks, 'silent')).from(tasks).where(eq(tasks.id, task.id));
      expect(current?.silent, `silent turns after ${i + 1}`).toBe(i + 1);
    }

    const [request] = await c.db.select().from(requests);
    expect(request).toMatchObject({ kind: 'stuck', audience: 'internal', triageAgentId: c.head.id, status: 'open' });
    const addressed = await c.db.select().from(jobs).where(and(eq(jobs.agentId, c.head.id), eq(jobs.status, 'queued')));
    expect(addressed).toHaveLength(1);
    expect(addressed[0]!.prompt).toContain(request!.id);
  });
});
