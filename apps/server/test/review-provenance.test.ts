import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, people, subscriptions, taskEvents, testParts, testRuns } from '../src/db/schema.js';
import { createTask, submit, verdict } from '../src/modules/tasks/engine.js';
import { listen, mcp, setUpCompany, testApp } from './helpers.js';

const FIRST = 'a'.repeat(40);
const SECOND = 'b'.repeat(40);

async function fixture() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const ctx = app.ctx;
  const [company] = await db.select().from(companies);
  const companyId = company!.id;
  const [ceo] = await db.select().from(people);
  const [claude] = await db.select().from(subscriptions);
  const [codex] = await db.insert(subscriptions).values({ companyId, provider: 'codex', kind: 'personal', label: 'Review', ownerPersonId: ceo!.id, status: 'ready' }).returning();
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }).returning();
  const hire = async (name: string, kind: 'worker' | 'head', roleKey: string, subscriptionId = claude!.id) =>
    (await db.insert(agents).values({ companyId, name, kind, roleKey, subscriptionId, departmentId: dev!.id, model: '' }).returning())[0]!;
  const head = await hire('Head', 'head', 'DEV-HEAD');
  const author = await hire('Author', 'worker', 'DEV-BE');
  const reviewer = await hire('Reviewer', 'worker', 'DEV-REV', codex!.id);
  const task = (await createTask(ctx, { agentId: head.id }, { title: 'Keep totals', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: author.id, executor: true, gates: [reviewer.id] })).task;
  let commit = FIRST;
  ctx.readCommit = async () => ({ branch: `task-${task.number}`, commitSha: commit });
  const [job] = await db.insert(jobs).values({ companyId, subscriptionId: claude!.id, agentId: author.id, taskId: task.id, kind: 'conversation', prompt: 'Work', timeoutMs: 1000 }).returning();
  const run = async (commitSha: string, number: number) => {
    const [r] = await db.insert(testRuns).values({ companyId, taskId: task.id, agentId: author.id, jobId: job!.id, departmentId: dev!.id, number, branch: `task-${task.number}`, commitSha, command: 'pytest unit', timeoutMs: 1000, status: 'passed', finishedAt: new Date() }).returning();
    await db.insert(testParts).values({ companyId, runId: r!.id, part: 1, status: 'passed', commit: commitSha, exitCode: 0 });
    return r!;
  };
  const event = async (kind: 'submitted' | 'verdict') => (await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, kind))).orderBy(taskEvents.id)).at(-1)!;
  const tools = async () => {
    await listen(app);
    const token = 'review-tool-token-0123456789abcdef';
    await db.insert(jobs).values({ companyId, agentId: reviewer.id, subscriptionId: codex!.id, taskId: task.id, kind: 'conversation', prompt: 'Review', status: 'running', timeoutMs: 1000, toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };
  return { ctx, db, task, head, author, reviewer, run, event, tools, advance: () => { commit = SECOND; } };
}

describe('pinned review provenance', () => {
  it('delivers the author run ID, exact SHA, verified part counts and computed gate counts', async () => {
    const { ctx, task, author, run, event } = await fixture();
    const good = await run(FIRST, 1);
    const stale = await run(SECOND, 2);
    await submit(ctx, author.id, task.id, { summary: 'Done', evidence: 'Both runs passed' });
    expect((await event('submitted')).data.review).toMatchObject({
      commit: FIRST, branch: `task-${task.number}`, authorId: author.id,
      gateCounts: { passed: 0, returned: 0 },
      runs: expect.arrayContaining([
        expect.objectContaining({ id: good.id, number: 1, commit: FIRST, verified: true, parts: { passed: 1, failed: 0, other: 0 } }),
        expect.objectContaining({ id: stale.id, number: 2, commit: SECOND, verified: false }),
      ]),
    });
  });

  it('rejects a verdict claiming a different commit without recording it', async () => {
    const { ctx, db, task, author, reviewer } = await fixture();
    await submit(ctx, author.id, task.id, { summary: 'Done', evidence: 'Checks' });
    await expect(verdict(ctx, reviewer.id, task.id, { pass: true, comment: 'Good', reviewedCommit: SECOND })).rejects.toMatchObject({ reason: 'task_invalid' });
    expect(await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'verdict')))).toEqual([]);
  });

  it('retains the reviewed revision when its branch moves', async () => {
    const { ctx, task, author, reviewer, event, advance } = await fixture();
    await submit(ctx, author.id, task.id, { summary: 'Done', evidence: 'Checks' });
    const submitted = await event('submitted');
    advance();
    await verdict(ctx, reviewer.id, task.id, { pass: true, comment: 'Checked the pinned candidate', reviewedCommit: FIRST });
    expect((await event('verdict')).data.review).toMatchObject({ commit: FIRST, revision: (submitted.data.review as { revision: string }).revision });
    expect((await event('submitted')).data.review).toEqual(submitted.data.review);
  });

  it('gives the immutable evidence to the reviewer through the task tool', async () => {
    const { ctx, task, author, run, tools } = await fixture();
    const good = await run(FIRST, 1);
    await submit(ctx, author.id, task.id, { summary: 'Done', evidence: 'Checks' });
    const response = await (await tools()).callTool({ name: 'task', arguments: { task: task.number } });
    expect(response.isError).toBeFalsy();
    const content = response.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]!.text)).toMatchObject({ review: { commit: FIRST, runs: [expect.objectContaining({ id: good.id, verified: true })] } });
  });
});
