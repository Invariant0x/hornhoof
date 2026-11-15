import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { taskWaits, waitNotices, waitPolicies } from '../src/db/schema.js';
import { notificationMessage } from '../src/modules/events/notifications.js';
import { aclCompany, leaks, type AclCompany } from './agent-view-company.js';
import { as } from './helpers.js';

type Viewer = keyof AclCompany['tokens'];
type Crew = keyof AclCompany['crew'];
const ROLES: { viewer: Viewer; agent: Crew; canSetPolicy: boolean; canReplan: boolean }[] = [
  { viewer: 'ann', agent: 'mine', canSetPolicy: false, canReplan: false },
  { viewer: 'bob', agent: 'other', canSetPolicy: false, canReplan: false },
  { viewer: 'olga', agent: 'owned', canSetPolicy: true, canReplan: true },
  { viewer: 'wes', agent: 'wide', canSetPolicy: false, canReplan: false },
  { viewer: 'clara', agent: 'far', canSetPolicy: true, canReplan: true },
  { viewer: 'ceo', agent: 'far', canSetPolicy: true, canReplan: true },
];
const DATES = { ownerMs: 3_600_000, headMs: 7_200_000, decisionMs: 10_800_000, reviewIntervalMs: 3_600_000 };
const plan = (c: AclCompany) => {
  const at = Date.now();
  return { version: 1, ownerDueAt: new Date(at + DATES.ownerMs).toISOString(), headDueAt: new Date(at + DATES.headMs).toISOString(),
    decisionDueAt: new Date(at + DATES.decisionMs).toISOString(), provenance: { kind: 'explicit_promise', actor: { personId: c.ids.ceo }, ref: 'screen-promise', revision: 1, origin: 'screen' },
    finalReview: { headAgentId: c.crew.head.id, anchorAt: new Date(at + DATES.decisionMs).toISOString(), intervalMs: DATES.reviewIntervalMs } };
};

async function waiting(c: AclCompany, agent: Crew) {
  const task = await c.work(`Private work of ${c.crew[agent].name}`, c.crew[agent], c.crew[agent].departmentId!);
  const [wait] = await c.db.insert(taskWaits).values({ companyId: c.companyId, taskId: task.id, kind: 'external', sourceKey: `wait_for:${randomUUID()}`,
    sourceRevision: 0, state: 'legacy_needs_plan', ownerAgentId: c.crew[agent].id, finalDecisionPersonId: c.ids.olga }).returning();
  return { task, wait: wait! };
}

async function card(c: AclCompany, wait: typeof taskWaits.$inferSelect, viewer: Viewer, delivered = true) {
  const [notice] = await c.db.insert(waitNotices).values({ companyId: c.companyId, personId: c.ids[viewer], dedupKey: randomUUID(),
    waitId: wait.id, generation: wait.generation, level: 3, purpose: `fixture:${randomUUID()}`, routeRevision: wait.routeRevision,
    guard: { tasks: [], wait: { id: wait.id, generation: wait.generation, routeRevision: wait.routeRevision } },
    message: await notificationMessage(c.app.ctx, c.companyId, 'wait_overdue', 'A wait reached its date.'), deliveredAt: delivered ? new Date() : null }).returning();
  return notice!;
}

describe('wait routes use real role and personal-card authority', () => {
  it.each(ROLES)('$viewer reads policy and only the owner, CEO or delegate changes it', async ({ viewer, canSetPolicy }) => {
    const c = await aclCompany(), url = `/api/departments/${c.dev.id}/wait-policy`;
    const read = await c.get(url, c.tokens[viewer]);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ policies: [], canChange: canSetPolicy });
    const put = await c.app.inject({ method: 'PUT', url: `${url}/after`, payload: DATES, ...as(c.tokens[viewer]) });
    expect(put.statusCode, put.body).toBe(canSetPolicy ? 200 : 403);
    const saved = await c.db.select().from(waitPolicies);
    expect(saved).toHaveLength(canSetPolicy ? 1 : 0);
    if (canSetPolicy) expect(saved[0]).toMatchObject({ departmentId: c.dev.id, createdByPersonId: c.ids[viewer], version: 1, ...DATES });
  });

  it.each(ROLES)('$viewer reads visible task waits and replans only with decision authority', async ({ viewer, agent, canReplan }) => {
    const c = await aclCompany(), { task, wait } = await waiting(c, agent);
    const history = await c.get(`/api/tasks/${task.id}/waits`, c.tokens[viewer]);
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().waits).toMatchObject([{ id: wait.id, state: 'legacy_needs_plan' }]);
    const result = await c.app.inject({ method: 'POST', url: `/api/waits/${wait.id}/replan`,
      payload: { expectedGeneration: 1, plan: plan(c), reason: 'The accountable person promised.' }, ...as(c.tokens[viewer]) });
    expect(result.statusCode, result.body).toBe(canReplan ? 200 : 403);
    const [saved] = await c.db.select().from(taskWaits).where(eq(taskWaits.id, wait.id));
    expect(saved).toMatchObject({ generation: canReplan ? 2 : 1, state: canReplan ? 'active' : 'legacy_needs_plan' });
  });

  it.each(ROLES)('$viewer reads and acknowledges only their delivered cards, without changing the wait', async ({ viewer, agent }) => {
    const c = await aclCompany(), { wait, task } = await waiting(c, agent);
    const own = await card(c, wait, viewer), other = await card(c, wait, viewer === 'ceo' ? 'ann' : 'ceo');
    const pending = await card(c, wait, viewer, false);
    const page = await c.get('/api/wait-cards', c.tokens[viewer]);
    expect(page.statusCode).toBe(200);
    expect(page.json().cards).toMatchObject([{ id: own.id, taskId: task.id, number: task.number }]);
    expect(page.json().cards).toHaveLength(1);
    expect(page.body).not.toContain(other.id);
    expect(page.body).not.toContain(pending.id);
    expect(leaks(page, [{ id: c.crew[agent].id, name: c.crew[agent].name }, { id: randomUUID(), name: task.title }])).toEqual([]);
    const before = await c.db.select().from(taskWaits).where(eq(taskWaits.id, wait.id));
    const ack = (id: string) => c.app.inject({ method: 'POST', url: `/api/wait-cards/${id}/ack`, ...as(c.tokens[viewer]) });
    expect((await ack(other.id)).statusCode).toBe(404);
    expect((await ack(pending.id)).statusCode).toBe(404);
    expect((await ack(own.id)).statusCode).toBe(200);
    expect((await ack(own.id)).statusCode).toBe(200);
    expect((await c.get('/api/wait-cards', c.tokens[viewer])).json().cards).toEqual([]);
    expect(await c.db.select().from(taskWaits).where(eq(taskWaits.id, wait.id))).toEqual(before);
    expect((await c.db.select().from(waitNotices).where(eq(waitNotices.id, own.id)))[0]).toMatchObject({ acknowledgedByPersonId: c.ids[viewer], acknowledgedAt: expect.any(Date) as Date });
  });

  it("lets a department owner read the waits of another department's work, as everyone does, but not replan them or change its policy", async () => {
    const c = await aclCompany(), { task, wait } = await waiting(c, 'far');
    expect((await c.get(`/api/tasks/${task.id}/waits`, c.tokens.olga)).statusCode).toBe(200);
    const result = await c.app.inject({ method: 'POST', url: `/api/waits/${wait.id}/replan`,
      payload: { expectedGeneration: 1, plan: plan(c), reason: 'Not a visibility grant.' }, ...as(c.tokens.olga) });
    expect([result.statusCode, result.json().error.reason]).toEqual([403, 'task_not_yours']);
    expect((await c.app.inject({ method: 'PUT', url: `/api/departments/${c.sales.id}/wait-policy/after`, payload: DATES, ...as(c.tokens.olga) })).statusCode).toBe(403);
    expect((await c.db.select().from(taskWaits))[0]!.generation).toBe(1);
    expect(await c.db.select().from(waitPolicies)).toEqual([]);
  });

  it('lets a person who owns a visible wait replan it without department-owner powers', async () => {
    const c = await aclCompany(), { wait } = await waiting(c, 'mine');
    await c.db.update(taskWaits).set({ ownerAgentId: null, ownerPersonId: c.ids.ann }).where(eq(taskWaits.id, wait.id));
    const result = await c.app.inject({ method: 'POST', url: `/api/waits/${wait.id}/replan`,
      payload: { expectedGeneration: 1, plan: plan(c), reason: 'I answer for it.' }, ...as(c.tokens.ann) });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().wait).toMatchObject({ id: wait.id, generation: 2 });
  });

  it('requires a signed-in person on all six routes', async () => {
    const c = await aclCompany(), { task, wait } = await waiting(c, 'mine'), notice = await card(c, wait, 'ann');
    for (const url of [`/api/departments/${c.dev.id}/wait-policy`, `/api/tasks/${task.id}/waits`, '/api/wait-cards']) {
      expect((await c.app.inject({ url })).statusCode, url).toBe(401);
    }
    for (const options of [
      { method: 'PUT' as const, url: `/api/departments/${c.dev.id}/wait-policy/after`, payload: DATES },
      { method: 'POST' as const, url: `/api/waits/${wait.id}/replan`, payload: { expectedGeneration: 1, plan: plan(c), reason: 'No identity.' } },
      { method: 'POST' as const, url: `/api/wait-cards/${notice.id}/ack` },
    ]) expect((await c.app.inject(options)).statusCode, options.url).toBe(401);
  });
});
