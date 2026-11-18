/* What the tests of pipeline-report.test.ts start from, also the ones that take a database of their own. */
import { eq } from 'drizzle-orm';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, requests, subscriptions, taskEvents, taskRoutes, tasks, testParts, testRuns, turns } from '../src/db/schema.js';
import { createRoute, routeOf } from '../src/modules/tasks/echelons-store.js';
import { developmentStages } from './templates-once.js';
import { listen, mcp, setUpCompany, testApp } from './helpers.js';

export const T0 = Date.parse('2026-11-04T14:00:00.000Z');
export const at = (minutes: number) => new Date(T0 + minutes * 60_000);
export const min = (n: number) => n * 60;

export async function company() {
  const { app, db } = await testApp();
  await listen(app);
  const ceoToken = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [dev, sales] = await db
    .insert(departments)
    .values([
      { companyId, templateKey: 'development', roleCode: 'DEV', position: 1 },
      { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2, about: 'We sell.' },
    ])
    .returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD', dev!.id);
  const sara = await hire('Sara', 'head', 'SAL-HEAD', sales!.id);
  const bruno = await hire('Bruno', 'worker', 'DEV-BE', dev!.id);
  const sam = await hire('Sam', 'worker', 'SAL-AE', sales!.id);

  let n = 0;
  const turn = async (number: number, status: 'open' | 'closed', from: number | null, to: number | null, title = `Turn ${number}`, departmentId = dev!.id) =>
    (await db.insert(turns).values({ companyId, departmentId, number, title, goal: title, status, createdAt: at(from ?? 0), openedAt: from === null ? null : at(from), closedAt: to === null ? null : at(to) }).returning())[0]!;
  const task = async (turnId: string, number: number, over: Partial<typeof tasks.$inferInsert> = {}) => {
    const closed = ['done', 'cancelled'].includes(over.status ?? 'done');
    const [row] = await db.insert(tasks).values({ companyId, number, turnId, title: `Task ${number}`, departmentId: dev!.id, executorAgentId: bruno.id, assigneeAgentId: bruno.id, status: 'done', createdAt: at(0), closedAt: at(30), updatedAt: at(30), ...over, ...(closed ? { assigneeAgentId: null } : {}) }).returning();
    await db.transaction(async tx => {
      await createRoute(tx, row!, {}, developmentStages());
      if (!closed) return;
      const route = await routeOf(tx, row!);
      /* Historical metrics do not fabricate a completed checker or candidate. */
      await tx.update(taskRoutes).set({ state: { ...route.state, stage: null, phase: 'done', stages: [] } }).where(eq(taskRoutes.taskId, row!.id));
    });
    return row!;
  };
  const event = (taskId: string, kind: typeof taskEvents.$inferInsert.kind, minutes: number, data: Record<string, unknown> = {}) =>
    db.insert(taskEvents).values({ companyId, taskId, kind, data, createdAt: at(minutes) });
  const job = async (agentId: string, taskId: string | null, over: Partial<typeof jobs.$inferInsert> = {}) =>
    (await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId, taskId, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'done', createdAt: at(0), startedAt: at(0), finishedAt: at(1), ...over }).returning())[0]!;
  const tools = async (agent: { id: string }) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: agent.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };
  return { app, db, ctx: app.ctx, companyId, ceoToken, orchestrator: orchestrator!, dev: dev!, sales: sales!, hana, sara, bruno, sam, turn, task, event, job, tools };
}
export type Company = Awaited<ReturnType<typeof company>>;

/* A task handed in, passed and merged at these minutes. */
export async function passed(c: Company, taskId: string, submit: number, pass: number, merge: number) {
  await c.event(taskId, 'submitted', submit);
  await c.event(taskId, 'verdict', pass, { pass: true });
  await c.event(taskId, 'submitted', merge, { merged: true });
}

export async function run(c: Company, taskId: string, number: number, kind: 'tests' | 'work', from: number, to: number, parts: [number, number, number][]) {
  const job = await c.job(c.bruno.id, taskId);
  const [row] = await c.db.insert(testRuns).values({ companyId: c.companyId, number, taskId, agentId: c.bruno.id, jobId: job.id, kind, command: 'npm test', parts: parts.length, timeoutMs: 60000, status: 'passed', createdAt: at(from), finishedAt: at(to) }).returning();
  for (const [i, [queued, started, finished]] of parts.entries()) {
    await c.db.insert(testParts).values({ companyId: c.companyId, runId: row!.id, part: i + 1, status: 'passed', createdAt: at(queued), queuedAt: at(queued), startedAt: at(started), finishedAt: at(finished) });
  }
  return row!;
}

/* A closed turn 7 of two tasks of development and one of sales, each with what happened to it, and a task of a later turn. */
export async function closedTurn(c: Company) {
  const seven = await c.turn(7, 'closed', 0, 120);
  const one = await c.task(seven.id, 1, { workKind: 'bug' });
  const two = await c.task(seven.id, 2, { after: [one.id], closedAt: at(60) });
  const three = await c.task(seven.id, 3, { departmentId: c.sales.id, executorAgentId: c.sam.id, assigneeAgentId: c.sam.id, closedAt: at(100) });
  await passed(c, one.id, 10, 20, 30);
  await c.event(two.id, 'started', 30);
  await c.event(two.id, 'submitted', 40);
  await c.event(two.id, 'verdict', 45, { pass: false, rework: true });
  await c.event(two.id, 'submitted', 50);
  await c.event(two.id, 'verdict', 50, { pass: true });
  await c.event(two.id, 'submitted', 60, { merged: true });
  await c.event(three.id, 'submitted', 100);
  await c.event(one.id, 'updated', 11, { externalWait: { reason: 'Test run 1', since: at(11).toISOString(), until: at(90).toISOString() } });
  await c.event(one.id, 'updated', 19, { externalWait: null });
  await run(c, one.id, 1, 'tests', 11, 15, [[11, 12, 15]]);
  await c.db.insert(requests).values({ companyId: c.companyId, taskId: three.id, agentId: c.sam.id, kind: 'question', text: 'Which?', status: 'answered', createdAt: at(10), answeredAt: at(70) });
  await c.job(c.bruno.id, one.id, { createdAt: at(1), startedAt: at(3), finishedAt: at(10) });
  await c.job(c.bruno.id, two.id, { createdAt: at(31), startedAt: at(31), finishedAt: at(33), status: 'failed', error: 'machine_restarted', interruption: { cause: 'update', at: at(33).toISOString(), node: { id: null, name: 'n' }, task: 2 } });
  await c.job(c.sam.id, three.id, { createdAt: at(5), startedAt: at(5), finishedAt: at(6), status: 'failed', error: 'agent_failed' });
  return { seven, one, two, three };
}
