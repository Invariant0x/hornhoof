import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, people, subscriptions } from '../src/db/schema.js';
import { createTask, submit } from '../src/modules/tasks/engine.js';
import { taskDetail } from '../src/modules/tasks/views.js';
import { setUpCompany, testApp } from './helpers.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

async function fixture() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [company] = await db.select().from(companies);
  const [person] = await db.select().from(people);
  const [claude] = await db.select().from(subscriptions);
  const [codex] = await db.insert(subscriptions).values({ companyId: company!.id, provider: 'codex', kind: 'personal', label: 'Code', ownerPersonId: person!.id, status: 'ready' }).returning();
  const [department] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, subscriptionId: string, model: string) =>
    (await db.insert(agents).values({ companyId: company!.id, departmentId: department!.id, name, kind, roleKey, subscriptionId, model }).returning())[0]!;
  const head = await hire('Head', 'head', 'DEV-HEAD', claude!.id, 'claude-opus-5-5');
  const author = await hire('Author', 'worker', 'DEV-BE', codex!.id, 'gpt-6.1-sol');
  const reviewer = await hire('Reviewer', 'worker', 'DEV-REV', claude!.id, 'claude-opus-5-5');
  app.ctx.readCommit = async () => ({ branch: 'task-1', commitSha: HEAD });
  app.ctx.readCompare = async () => ({ complete: true, baseSha: BASE, headSha: HEAD, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
  const input = {
    title: 'Keep totals', brief: 'Keep the total correct.', body: 'Change logic/totals.ts.',
    departmentId: department!.id, assigneeAgentId: author.id, executor: true,
    small: true, paths: ['logic/totals.ts'], reviewerAgentId: reviewer.id,
  };
  const { task } = await createTask(app.ctx, { agentId: head.id }, input);
  const detail = async (id = task.id) => {
    const { loadTask } = await import('../src/modules/tasks/engine.js');
    return taskDetail(app.ctx, await loadTask(db, id), () => true);
  };
  return { ctx: app.ctx, task, author, reviewer, detail };
}

describe('the only Development work route', () => {
  it('starts small work at Development with a required pending Review', async () => {
    const { author, detail } = await fixture();
    expect(await detail()).toMatchObject({
      echelons: {
        stage: 'development', phase: 'active', ownerAgentId: author.id,
        stages: expect.arrayContaining([
          expect.objectContaining({ stage: 'architecture', status: 'skipped' }),
          expect.objectContaining({ stage: 'development', status: 'active' }),
          expect.objectContaining({ stage: 'review', status: 'pending' }),
        ]),
      },
    });
  });

  it('hands code to Review even when the head did not supply old gates', async () => {
    const { ctx, task, author, reviewer, detail } = await fixture();
    const moved = await submit(ctx, author.id, task.id, { summary: 'Keep totals.', evidence: 'Changed source ready for review.', review: { baseCommit: BASE } });
    expect(moved.task).toMatchObject({ status: 'review', assigneeAgentId: reviewer.id });
    expect(await detail()).toMatchObject({ echelons: { stage: 'review', ownerAgentId: reviewer.id } });
    expect(moved.wakes.map(wake => wake.agentId)).toEqual([reviewer.id]);
  });
});
