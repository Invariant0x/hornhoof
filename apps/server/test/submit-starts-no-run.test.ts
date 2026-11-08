import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { jobs, taskEvents, tasks, testRuns } from '../src/db/schema.js';
import { listen, mcp } from './helpers.js';
import { qualityFixture, SHA } from './review-quality-fixture.js';

type Res = { content: { text: string }[]; isError?: boolean };

/* Whoever builds a change checks it in their own workspace before handing it in; only whole suites go through run_tests. */
describe('a submit', () => {
  it('starts no test run and goes on to its next stage, even where author checks on submit were once turned on', async () => {
    const f = await qualityFixture({ AUTHOR_CHECK: '1' });
    await listen(f.app);
    const token = 'submit-token-0123456789abcdef0123456789';
    await f.db.insert(jobs).values({ companyId: f.author.companyId, subscriptionId: f.author.subscriptionId!, agentId: f.author.id, taskId: f.task.id, kind: 'conversation', prompt: 'Work', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    const client = await mcp(f.app, token);
    const runsBefore = await f.db.select().from(testRuns).where(eq(testRuns.taskId, f.task.id));
    const submit = async (review: Record<string, string>) => (await client.callTool({ name: 'submit', arguments: { task: f.task.number, summary: 'Done', evidence: 'Checked in my workspace.', review } })) as Res;

    const old = await submit({ baseCommit: SHA, authorCheckPlan: 'plan-text' });
    expect(old.isError, old.content[0]!.text).toBe(true);
    expect(old.content[0]!.text).toMatch(/authorCheckPlan/);
    expect(await f.db.select().from(testRuns).where(eq(testRuns.taskId, f.task.id))).toHaveLength(runsBefore.length);

    const handed = await submit({ baseCommit: SHA });
    expect(handed.isError, handed.content[0]!.text).toBeFalsy();
    expect(await f.db.select().from(testRuns).where(eq(testRuns.taskId, f.task.id))).toHaveLength(runsBefore.length);
    const [task] = await f.db.select().from(tasks).where(eq(tasks.id, f.task.id));
    expect(task).toMatchObject({ externalWait: null });
    expect(task!.status).not.toBe('working');
    const submitted = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'submitted')));
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.data.authorCheckOutcome).toBeUndefined();
  });
});
