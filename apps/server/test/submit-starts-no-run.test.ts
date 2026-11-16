import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, people, subscriptions, taskEvents, tasks, testRuns } from '../src/db/schema.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { echelonsTurn, listen, mcp, setUpCompany, testApp } from './helpers.js';

type Res = { content: { text: string }[]; isError?: boolean };
const SHA = 'a'.repeat(40);

/* Whoever builds a change checks it in their own workspace before handing it in; only whole suites go through run_tests. */
describe('a submit', () => {
  it('starts no test run and goes on to its next stage, even where author checks on submit were once turned on', async () => {
    const { app, db } = await testApp({ AUTHOR_CHECK: '1' });
    await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [ceo] = await db.select().from(people);
    const [sub] = await db.select().from(subscriptions);
    const [dev] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }).returning();
    const hire = async (kind: 'head' | 'worker', roleKey: string) => (await db.insert(agents).values({ companyId: company!.id, kind, name: roleKey, roleKey, departmentId: dev!.id, subscriptionId: sub!.id, model: 'claude-opus-5-5',
      skills: app.ctx.templates.roles.get(roleKey)?.skills.filter(skill => skill.on).map(skill => skill.id) ?? [] }).returning())[0]!;
    await hire('head', 'DEV-HEAD');
    const author = await hire('worker', 'DEV-BE');
    await echelonsTurn(db, company!.id);
    const task = (await createTask(app.ctx, { personId: ceo!.id }, { title: 'Author check', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: author.id, executor: true, small: true, paths: ['**'] })).task;
    app.ctx.readCompare = async (_repo, refs) => ({ complete: true, baseSha: refs.base, headSha: refs.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
    await listen(app);
    const token = 'submit-token-0123456789abcdef0123456789';
    await db.insert(jobs).values({ companyId: author.companyId, subscriptionId: author.subscriptionId!, agentId: author.id, taskId: task.id, kind: 'conversation', prompt: 'Work', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    const client = await mcp(app, token);
    const submit = async (review: Record<string, string>) => (await client.callTool({ name: 'submit', arguments: { task: task.number, summary: 'Done', evidence: 'Checked in my workspace.', review } })) as Res;

    const old = await submit({ baseCommit: SHA, authorCheckPlan: 'plan-text' });
    expect(old.isError, old.content[0]!.text).toBe(true);
    expect(old.content[0]!.text).toMatch(/authorCheckPlan/);

    const handed = await submit({ baseCommit: SHA });
    expect(handed.isError, handed.content[0]!.text).toBeFalsy();
    expect(await db.select().from(testRuns).where(eq(testRuns.taskId, task.id))).toEqual([]);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row).toMatchObject({ externalWait: null });
    expect(row!.status).not.toBe('working');
    const submitted = await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'submitted')));
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.data.authorCheckOutcome).toBeUndefined();
  });
});
