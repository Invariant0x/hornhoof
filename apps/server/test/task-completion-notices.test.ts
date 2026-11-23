import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, people, subscriptions, tasks } from '../src/db/schema.js';
import { createTask, report } from '../src/modules/tasks/engine.js';
import { setUpCompany, statements, testApp } from './helpers.js';
import { attached } from './recorded-fixture.js';

async function company() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const [head, worker] = await db.insert(agents).values([
    { companyId: acme!.id, kind: 'head', name: 'Hana', roleKey: 'DEV-HEAD', departmentId: dev!.id, model: 'claude-opus-5-5', subscriptionId: sub!.id },
    { companyId: acme!.id, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: dev!.id, model: 'claude-opus-5-5', subscriptionId: sub!.id },
  ]).returning();
  const ctx = app.ctx;
  const parent = (await createTask(ctx, { personId: ceo!.id }, { title: 'Checked report group', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: head!.id, resultKind: 'coordination' })).task;
  const member = async (parentId: string | null = parent.id) => (await createTask(ctx, { agentId: head!.id }, { title: 'Checked aggregate', brief: '', body: '', departmentId: dev!.id, parentId, assigneeAgentId: worker!.id, resultKind: 'coordination' })).task;
  const done = async (id: string) => report(ctx, worker!.id, id, { done: true, summary: 'Checked the referenced results.', recorded: await attached(db, { id, companyId: acme!.id }, worker!.id, 'result.md') });
  return { ctx, db, parent, member, done, head: head!, worker: worker! };
}
const woken = (r: { wakes: { agentId: string; why: string }[] }) => r.wakes.map(w => [w.agentId, w.why]);

describe('completion notices after checked work closes', () => {
  it('tells the parent owner once every child is closed, without a notice for each child', async () => {
    const f = await company();
    const a = await f.member(), b = await f.member();
    expect(woken(await f.done(a.id))).toEqual([]);
    expect(woken(await f.done(b.id))).toEqual([[f.head.id, 'subtasks']]);
  });
  it('locks the parent before closing a child and checking for remaining work', async () => {
    const f = await company();
    const child = await f.member();
    const seen = statements();
    await f.done(child.id);
    const at = (test: (s: { sql: string; params: unknown[] }) => boolean) => seen.findIndex(test);
    const lock = at(s => s.sql.includes('from "tasks"') && s.sql.includes('for no key update') && s.params.includes(f.parent.id));
    const closing = at(s => s.sql.startsWith('update "tasks"') && s.params.includes(child.id));
    const counting = at(s => s.sql.includes('"tasks"."parent_id"') && s.sql.includes('not in') && s.params.includes(f.parent.id));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(closing);
    expect(closing).toBeLessThan(counting);
  });
  it('notifies the current parent owner after a reassignment', async () => {
    const f = await company();
    const child = await f.member();
    const [other] = await f.db.insert(agents).values({ companyId: f.head.companyId, name: 'Coordinator', kind: 'worker', roleKey: 'DEV-BE', departmentId: f.head.departmentId, model: 'claude-opus-5-5', subscriptionId: f.head.subscriptionId }).returning();
    await f.db.update(tasks).set({ assigneeAgentId: other!.id }).where(eq(tasks.id, f.parent.id));
    expect(woken(await f.done(child.id))).toEqual([[other!.id, 'subtasks']]);
  });
  it('still notifies the giver of checked work that has no parent', async () => {
    const f = await company();
    expect(woken(await f.done((await f.member(null)).id))).toEqual([[f.head.id, 'reported']]);
  });
});
