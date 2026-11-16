import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { taskWaits, waitPolicies } from '../src/db/schema.js';
import { createTask } from '../src/modules/tasks/engine.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { aclCompany, type AclCompany } from './agent-view-company.js';
import { company } from './department-owner-fixture.js';
import { as } from './helpers.js';

const HOUR = 3_600_000;
const dates = { ownerMs: HOUR, headMs: 2 * HOUR, decisionMs: 3 * HOUR, reviewIntervalMs: 4 * HOUR };
const put = (c: AclCompany, token: string, kind: string, payload: object) => c.app.inject({ method: 'PUT', url: `/api/departments/${c.dev.id}/wait-policy/${kind}`, payload, ...as(token) });

describe('how long a department gives its waits', () => {
  it('is set by its owner, the CEO or the delegate, and by nobody else', async () => {
    const c = await aclCompany();
    expect((await put(c, c.tokens.ann, 'after', dates)).statusCode).toBe(403);
    expect(await c.db.select().from(waitPolicies)).toEqual([]);
    expect((await put(c, c.tokens.olga, 'after', dates)).statusCode).toBe(200);
    expect((await put(c, c.tokens.ceo, 'review', dates)).statusCode).toBe(200);
    expect((await put(c, c.tokens.clara, 'person', dates)).statusCode).toBe(200);
    expect((await c.get(`/api/departments/${c.dev.id}/wait-policy`, c.tokens.ann)).json()).toMatchObject({ canChange: false });
    expect((await c.get(`/api/departments/${c.dev.id}/wait-policy`, c.tokens.olga)).json().policies).toHaveLength(3);
  });

  it('keeps each change as a new version, and a wait already bound keeps its dates', async () => {
    const c = await aclCompany();
    await put(c, c.tokens.olga, 'after', dates);
    const first = await c.work('First', c.crew.mine);
    const follow = (await createTask(c.app.ctx, { agentId: c.crew.head.id }, { title: 'Follow', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.crew.mine.id, executor: true, after: [first.id], independentNone: 'One piece.' })).task;
    const [bound] = await c.db.select().from(taskWaits).where(eq(taskWaits.taskId, follow.id));
    const res = await put(c, c.tokens.olga, 'after', { ...dates, ownerMs: HOUR / 2 });
    expect(res.json().policies).toMatchObject([{ kind: 'after', version: 2, ownerMs: HOUR / 2 }]);
    expect((await c.db.select().from(waitPolicies))).toHaveLength(2);
    expect((await c.db.select().from(taskWaits).where(eq(taskWaits.id, bound!.id)))[0]).toMatchObject({ ownerDueAt: bound!.ownerDueAt, generation: 1 });
  });

  it('refuses dates out of order, of a product, and a body with more than it takes', async () => {
    const c = await aclCompany();
    expect((await put(c, c.tokens.olga, 'after', { ...dates, ownerMs: 3 * HOUR, headMs: HOUR })).statusCode).toBe(400);
    expect((await put(c, c.tokens.olga, 'after', { ...dates, ownerMs: 0 })).statusCode).toBe(400);
    expect((await put(c, c.tokens.olga, 'after', { ...dates, extra: 1 })).statusCode).toBe(400);
    expect((await put(c, c.tokens.olga, 'nonsense', dates)).statusCode).toBe(400);
    expect(await c.db.select().from(waitPolicies)).toEqual([]);
  });

  it('makes a department strict with the first one, as the record of who set it says', async () => {
    const c = await aclCompany();
    const first = await c.work('First', c.crew.mine);
    const follow = () => createTask(c.app.ctx, { agentId: c.crew.head.id }, { title: 'Follow', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.crew.mine.id, executor: true, after: [first.id], independentNone: 'One piece.' });
    await expect(follow()).resolves.toBeDefined();
    await put(c, c.tokens.olga, 'review', dates);
    await expect(follow()).rejects.toThrow('sets dates for its waits');
    const [policy] = await c.db.select().from(waitPolicies);
    expect(policy).toMatchObject({ createdByPersonId: c.ids.olga, createdByAgentId: null, version: 1 });
  });
});

describe('through the orchestrator', () => {
  type Res = { content: { text: string }[]; isError?: boolean };
  const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Res;

  it('sets dates in any turn, as the owner for a person who may not or for nobody, and says what it set', async () => {
    const c = await company();
    const args = { department: c.dev.id, kind: 'after', ...dates };
    expect((await call(await c.tools(c.orchestrator, c.ids.sam), 'set_wait_policy', args)).isError).toBeFalsy();
    expect(await c.db.select().from(waitPolicies)).toMatchObject([{ kind: 'after', version: 1, createdByPersonId: c.ids.ceo }]);
    await c.db.delete(waitPolicies);
    const ceos = await c.tools(c.orchestrator, c.ids.ceo);
    const set = await call(ceos, 'set_wait_policy', args);
    expect(set.isError, set.content[0]!.text).toBeFalsy();
    expect(await c.db.select().from(waitPolicies)).toMatchObject([{ kind: 'after', stage: '', version: 1, createdByPersonId: c.ids.ceo }]);
    const read = JSON.parse((await call(ceos, 'approval_policy', { department: c.dev.id })).content[0]!.text) as { waitDates: unknown[] };
    expect(read.waitDates).toMatchObject([{ kind: 'after', version: 1, ownerMs: HOUR }]);
    expect((await call(ceos, 'set_wait_policy', { ...args, ownerMs: 9 * HOUR })).isError).toBe(true);
  });

  it('gives a wait new dates for who answers for it, and for nobody else', async () => {
    const c = await company();
    const plan = { version: 1, ownerDueAt: new Date(Date.now() + HOUR).toISOString(), headDueAt: new Date(Date.now() + 2 * HOUR).toISOString(), decisionDueAt: new Date(Date.now() + 3 * HOUR).toISOString(), provenance: { kind: 'explicit_promise', actor: { agentId: c.head.id }, ref: 'promise-1', revision: 1, origin: 'tool' }, finalReview: { headAgentId: c.head.id, anchorAt: new Date(Date.now() + 4 * HOUR).toISOString(), intervalMs: HOUR } };
    const first = (await createTask(c.app.ctx, { agentId: c.head.id }, { title: 'First', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.worker.id, executor: true })).task;
    const follow = (await createTask(c.app.ctx, { agentId: c.head.id }, { title: 'Follow', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.worker.id, executor: true, after: [first.id], independentNone: 'One piece.' })).task;
    const [wait] = await c.db.select().from(taskWaits).where(eq(taskWaits.taskId, follow.id));
    const args = { wait: wait!.id, expectedGeneration: wait!.generation, plan, reason: 'The head promised.' };
    expect((await call(await c.tools(c.salesHead), 'replan_wait', args)).isError).toBe(true);
    expect((await c.db.select().from(taskWaits).where(eq(taskWaits.id, wait!.id)))[0]).toMatchObject({ state: 'legacy_needs_plan' });
    const res = await call(await c.tools(c.head), 'replan_wait', args);
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    expect(res.content[0]!.text).toContain(`#${follow.number}`);
    expect((await c.db.select().from(taskWaits).where(eq(taskWaits.id, wait!.id)))[0]).toMatchObject({ state: 'active', generation: wait!.generation + 1 });
    expect((await call(await c.tools(c.head), 'replan_wait', args)).isError).toBe(true);
  });
});

describe('giving a wait new dates', () => {
  const later = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();
  const plan = (c: AclCompany) => ({ version: 1, ownerDueAt: later(1), headDueAt: later(2), decisionDueAt: later(3), provenance: { kind: 'explicit_promise', actor: { personId: c.ids.olga }, ref: 'promise-1', revision: 1, origin: 'screen' }, finalReview: { headAgentId: c.crew.head.id, anchorAt: later(4), intervalMs: HOUR } });
  const legacy = async (c: AclCompany) => {
    const first = await c.work('First', c.crew.mine);
    const follow = (await createTask(c.app.ctx, { agentId: c.crew.head.id }, { title: 'Follow', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.crew.mine.id, executor: true, after: [first.id], independentNone: 'One piece.' })).task;
    return { follow, wait: (await c.db.select().from(taskWaits).where(eq(taskWaits.taskId, follow.id)))[0]! };
  };
  const replan = (c: AclCompany, token: string, id: string, payload: object) => c.app.inject({ method: 'POST', url: `/api/waits/${id}/replan`, payload, ...as(token) });

  it('gives a wait no one planned its first dates, for one who may, with the screen seeing them at once', async () => {
    const c = await aclCompany();
    const { wait, follow } = await legacy(c);
    const res = await replan(c, c.tokens.ceo, wait.id, { expectedGeneration: wait.generation, plan: plan(c), reason: 'Olga promised.' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().wait).toMatchObject({ id: wait.id, state: 'active', generation: 2 });
    expect((await c.get(`/api/tasks/${follow.id}`, c.tokens.ceo)).json().task.waits).toMatchObject([{ state: 'active' }]);
  });

  it('refuses one not theirs, one they do not see and one already moved on', async () => {
    const c = await aclCompany();
    const { wait } = await legacy(c);
    expect((await replan(c, c.tokens.ann, wait.id, { expectedGeneration: wait.generation, plan: plan(c), reason: 'Me.' })).statusCode).toBe(403);
    const far = await c.work('Far', c.crew.far, c.sales.id);
    const hidden = await c.db.insert(taskWaits).values({ companyId: c.companyId, taskId: far.id, kind: 'external', sourceKey: 'wait_for:00000000-0000-4000-8000-000000000001', sourceRevision: 0, state: 'legacy_needs_plan' }).returning();
    expect((await replan(c, c.tokens.ann, hidden[0]!.id, { expectedGeneration: 1, plan: plan(c), reason: 'Me.' })).statusCode).toBe(403);
    expect((await replan(c, c.tokens.ceo, wait.id, { expectedGeneration: wait.generation + 1, plan: plan(c), reason: 'Late.' })).statusCode).toBe(409);
    expect((await replan(c, c.tokens.ceo, '00000000-0000-4000-8000-000000000002', { expectedGeneration: 1, plan: plan(c), reason: 'None.' })).statusCode).toBe(404);
  });
});
