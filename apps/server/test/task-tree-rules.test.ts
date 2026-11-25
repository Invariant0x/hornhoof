import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, subscriptions, tasks } from '../src/db/schema.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { requireMoreThanOneChild, requireTreeRules } from '../src/modules/tasks/tree-rules.js';
import { as, echelonsTurn, listen, mcp, setUpCompany, testApp } from './helpers.js';

/* The rules of a new task tree (research #2057): depth 3 at most, a reason for every sub-task, at most 3 sub-tasks of a worker's
   task and 5 under any parent, who may make what, no coordination task with one child, and a parent's title above its child's. */

async function company() {
  const { app, db } = await testApp();
  await listen(app);
  const ceoToken = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [sub] = await db.select().from(subscriptions);
  const [dev, sales] = await db.insert(departments).values([
    { companyId, templateKey: 'development', roleCode: 'DEV', position: 1 },
    { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
  ]).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId = dev!.id) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const sam = await hire('Sam', 'worker', 'SAL-AE', sales!.id);
  await echelonsTurn(db, companyId);
  let n = 0;
  const tools = async (agent: { id: string }) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: agent.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };
  const work = (input: Partial<Parameters<typeof createTask>[2]> = {}) =>
    createTask(app.ctx, { agentId: head.id }, { title: 'Checkout', brief: 'Pay by card.', body: '', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true, resultKind: 'code', ...input }).then(m => m.task);
  return { app, db, ceoToken, dev: dev!, sales: sales!, head, bruno, sam, tools, work };
}

type Res = { content: { text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as Res;
const said = (r: Res) => r.content[0]!.text;
const child = (parent: { number: number }, extra: Record<string, unknown> = {}) => ({ title: 'Card form', brief: 'The form.', body: '', executor: undefined as unknown, parent: parent.number, ...extra });

describe('the rules of a new task tree', () => {
  it('A1: refuses a fourth level, and says why', async () => {
    const { head, bruno, work, tools } = await company();
    const top = await work({ title: 'Payments' });
    const second = await work({ title: 'Cards', parentId: top.id });
    const third = await work({ title: 'Card form', parentId: second.id });
    const result = await call(await tools(head), 'create_task', { ...child(third), executor: bruno.id, subtaskReason: 'independent_result' });
    expect(result.isError).toBe(true);
    expect(said(result)).toContain('3 levels deep at most');
  });

  it('A2: asks a reason of a sub-task, keeps it, and asks none of a task with nothing above it', async () => {
    const { db, head, bruno, work, tools } = await company();
    const top = await work({ title: 'Payments' });
    const client = await tools(head);
    const without = await call(client, 'create_task', { ...child(top), executor: bruno.id });
    expect(without.isError).toBe(true);
    expect(said(without)).toContain('needs its reason');
    expect(said(without)).toContain('parallel_block');
    const given = await call(client, 'create_task', { ...child(top), executor: bruno.id, subtaskReason: 'parallel_block' });
    expect(given.isError, said(given)).toBeFalsy();
    const [made] = await db.select().from(tasks).where(eq(tasks.title, 'Card form'));
    expect(made!.subtaskReason).toBe('parallel_block');
    const alone = await call(client, 'create_task', { title: 'Refunds', brief: 'Give money back.', body: '', executor: bruno.id });
    expect(alone.isError, said(alone)).toBeFalsy();
  });

  it('A4: lets a head make five sub-tasks under a task and no sixth', async () => {
    const { head, bruno, work, tools } = await company();
    const top = await work({ title: 'Payments' });
    for (let i = 1; i <= 5; i++) await work({ title: `Part ${i}`, parentId: top.id });
    const result = await call(await tools(head), 'create_task', { ...child(top), executor: bruno.id, subtaskReason: 'other_owner' });
    expect(result.isError).toBe(true);
    expect(said(result)).toContain('a second parent');
  });

  it('A4 and A5: a worker makes three sub-tasks of its own task without the head, never a fourth, never under another worker\'s task, never one with nothing above it', async () => {
    const { ctx, bruno, head, work, sam } = await companyCtx();
    const own = await work({ title: 'Mine', assigneeAgentId: bruno.id });
    const creator = { id: bruno.id, kind: 'worker' as const, departmentId: own.departmentId };
    for (let i = 1; i <= 3; i++) {
      await requireTreeRules(ctx, creator, own, 'parallel_block');
      await work({ title: `Step ${i}`, parentId: own.id });
    }
    await expect(requireTreeRules(ctx, creator, own, 'parallel_block')).rejects.toMatchObject({ status: 403 });
    await expect(requireTreeRules(ctx, { id: head.id, kind: 'head', departmentId: own.departmentId }, own, 'parallel_block')).resolves.toBeUndefined();
    const another = await work({ title: 'Not Bruno\'s', assigneeAgentId: head.id });
    await expect(requireTreeRules(ctx, creator, another, 'parallel_block')).rejects.toMatchObject({ status: 403 });
    await expect(requireTreeRules(ctx, creator, null, undefined)).rejects.toMatchObject({ status: 403 });
    await expect(requireTreeRules(ctx, { id: 'orchestrator', kind: 'orchestrator', departmentId: null }, own, 'independent_result')).resolves.toBeUndefined();
    await expect(requireTreeRules(ctx, { id: head.id, kind: 'head', departmentId: own.departmentId }, null, undefined)).resolves.toBeUndefined();
    await expect(requireTreeRules(ctx, { id: sam.id, kind: 'head', departmentId: sam.departmentId }, own, 'other_owner')).rejects.toMatchObject({ status: 403 });
  });

  it('A9: refuses to close a coordination task that holds one sub-task, and closes one that holds two', async () => {
    const { app, head, bruno, work, tools } = await company();
    const parent = await work({ title: 'Whole result', resultKind: 'coordination', assigneeAgentId: head.id, executor: false });
    const only = await work({ title: 'The one part', parentId: parent.id, subtaskReason: 'independent_result' });
    const client = await tools(head);
    const one = await call(client, 'report', { task: parent.number, done: true, summary: 'All in.', recorded: { path: 'reports/whole.md' } });
    expect(one.isError).toBe(true);
    expect(said(one)).toContain('holds two or more');
    expect(only.assigneeAgentId).toBe(bruno.id);
    /* Two parts are a coordination task's own work, a part cancelled leaves the lone one it was, and a tree of before the rules (no reasons) closes as it did. */
    await work({ title: 'The other part', parentId: parent.id, subtaskReason: 'other_owner' });
    await expect(requireMoreThanOneChild(app.ctx, parent)).resolves.toBeUndefined();
    const old = await work({ title: 'Older whole', resultKind: 'coordination', assigneeAgentId: head.id, executor: false });
    await work({ title: 'Older part', parentId: old.id });
    await expect(requireMoreThanOneChild(app.ctx, old)).resolves.toBeUndefined();
  });

  it('A10: shows the parent\'s title above the child\'s where the child is made', async () => {
    const { head, bruno, work, tools } = await company();
    const top = await work({ title: 'Payments by card, refunds and receipts' });
    const result = await call(await tools(head), 'create_task', { ...child(top), executor: bruno.id, subtaskReason: 'independent_result' });
    expect(result.isError, said(result)).toBeFalsy();
    expect(said(result)).toContain(`Under #${top.number} "Payments by card, refunds and receipts" (the whole result): #`);
    expect(said(result)).toContain('"Card form"');
  });

  it('keeps the depth and the budget for a person\'s own route too, with no reason asked', async () => {
    const { app, ceoToken, dev, work } = await company();
    const top = await work({ title: 'Payments' });
    const second = await work({ title: 'Cards', parentId: top.id });
    const third = await work({ title: 'Card form', parentId: second.id });
    const deeper = await app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 'Too deep', brief: 'x', body: '', department: dev.id, parent: third.id }, ...as(ceoToken) });
    expect(deeper.statusCode).toBe(400);
    expect(deeper.json().error.message).toContain('3 levels deep');
    const fine = await app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 'Under cards', brief: 'x', body: '', department: dev.id, parent: second.id }, ...as(ceoToken) });
    expect(fine.statusCode).toBe(201);
  });
});

async function companyCtx() {
  const c = await company();
  return { ...c, ctx: c.app.ctx };
}
