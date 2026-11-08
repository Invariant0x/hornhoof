import { and, eq } from 'drizzle-orm';
import { agents, companies, departments, jobs, people, subscriptions, taskEvents, testParts, testRuns } from '../src/db/schema.js';
import { createTask, submit } from '../src/modules/tasks/engine.js';
import type { AuthorCheckResult, Quality } from '../src/modules/tasks/review-quality.js';
import { setUpCompany, testApp } from './helpers.js';

export const SHA = 'a'.repeat(40);
export const OTHER = 'b'.repeat(40);

export async function qualityFixture(env: NodeJS.ProcessEnv = {}) {
  const { app, db } = await testApp(env);
  await setUpCompany(app);
  const [company] = await db.select().from(companies);
  const companyId = company!.id;
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }).returning();
  const [author] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Author', roleKey: 'DEV-BE', departmentId: dev!.id, subscriptionId: sub!.id, model: '' }).returning();
  const task = (await createTask(app.ctx, { personId: ceo!.id }, { title: 'Author check', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: author!.id, executor: true })).task;
  const [job] = await db.insert(jobs).values({ companyId, agentId: author!.id, taskId: task.id, subscriptionId: sub!.id, kind: 'conversation', prompt: 'Check', timeoutMs: 1000 }).returning();
  const [run] = await db.insert(testRuns).values({ companyId, taskId: task.id, agentId: author!.id, jobId: job!.id, departmentId: dev!.id, number: 1, branch: `task-${task.number}`, commitSha: SHA, command: 'author-check', timeoutMs: 1000, status: 'passed', finishedAt: new Date() }).returning();
  const [part] = await db.insert(testParts).values({ companyId, runId: run!.id, part: 1, status: 'passed', commit: SHA, exitCode: 0 }).returning();
  const record = {
    version: 1, producer: 'author-check-v1', companyId, taskId: task.id, authorId: author!.id, jobId: job!.id, runId: run!.id, submissionCommit: SHA, checkCommit: SHA,
    scope: { kind: 'changed', paths: ['logic/totals.ts'] },
    stages: ['format', 'lint', 'types', 'tests', 'crapper', 'dryer'].map(name => ({ name, status: 'passed', exitCode: 0, partId: part!.id })),
    numbers: { tests: { passed: 12, failed: 0, skipped: 1, total: 13 }, changedLines: { covered: 18, total: 20 }, worstCrap: 6.5, dryerFlags: 2 },
  };
  type FixtureRecord = Omit<typeof record, 'numbers'> & { numbers: AuthorCheckResult['numbers'] };
  const seed = async (value: FixtureRecord = record, actor: string | null = null) => {
    const [current] = await db.select().from(testRuns).where(eq(testRuns.id, run!.id));
    const receipts = await db.select().from(testParts).where(eq(testParts.runId, run!.id));
    const receipt = { status: current!.status, parts: receipts.map(p => ({ id: p.id, status: p.status, commit: p.commit, exitCode: p.exitCode })) };
    return db.insert(taskEvents).values({ companyId, taskId: task.id, kind: 'comment', agentId: actor, text: 'Structured author check', data: { authorCheck: { ...value, receipt } } });
  };
  const read = async () => {
    await submit(app.ctx, author!.id, task.id, { summary: 'Done', evidence: 'Author check' });
    const [event] = await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'submitted')));
    return (event!.data.review as { quality: Quality; gateCounts: { source: string } });
  };
  return { db, app, task, author: author!, job: job!, run: run!, part: part!, record, seed, read };
}

