import { describe, expect, it } from 'vitest';
import { agents, companies, departments, people, tasks, waitPolicies } from '../src/db/schema.js';
import { nextReview, planFromPolicy, waitRoute } from '../src/modules/tasks/wait-policy.js';
import { createTestDb } from './helpers.js';

const HOUR = 3_600_000;
const NOON = new Date('2030-01-01T12:00:00.000Z');
const later = (hours: number) => new Date(NOON.getTime() + hours * HOUR).toISOString();

async function fixture() {
  const db = await createTestDb();
  const [company] = await db.insert(companies).values({ name: 'Acme' }).returning();
  const [department, parent] = await db.insert(departments).values([{ companyId: company!.id, templateKey: 'development', roleCode: 'DEV' }, { companyId: company!.id, templateKey: 'operations', roleCode: 'OPS' }]).returning();
  const [head] = await db.insert(agents).values({ companyId: company!.id, departmentId: department!.id, kind: 'head', name: 'Hana', model: '' }).returning();
  const [ceo, ann] = await db.insert(people).values([
    { companyId: company!.id, name: 'Ceo', email: 'ceo@example.test', status: 'active', scopeKind: 'company', isOwner: true },
    { companyId: company!.id, name: 'Ann', email: 'ann@example.test', status: 'active', scopeKind: 'company' },
  ]).returning();
  const policy = (change: Partial<typeof waitPolicies.$inferInsert> = {}) => db.insert(waitPolicies).values({
    companyId: company!.id, departmentId: department!.id, kind: 'run', stage: 'queue', version: 1, ownerMs: HOUR, headMs: 2 * HOUR, decisionMs: 3 * HOUR, reviewIntervalMs: 4 * HOUR, createdByPersonId: ceo!.id, ...change,
  });
  const from = (change: Partial<Parameters<typeof planFromPolicy>[1]> = {}) => db.transaction(tx => planFromPolicy(tx, { companyId: company!.id, departmentId: department!.id, kind: 'run', stage: 'queue', at: NOON, ...change }));
  return { db, company: company!, department: department!, parent: parent!, head: head!, ceo: ceo!, ann: ann!, policy, from };
}

describe('planFromPolicy', () => {
  it('makes up no plan where the department set none', async () => {
    const c = await fixture();
    expect(await c.from()).toBeNull();
  });

  it('counts its dates from the moment the stage began and says which version they came from', async () => {
    const c = await fixture();
    await c.policy();
    expect(await c.from()).toEqual({
      version: 1, ownerDueAt: later(1), headDueAt: later(2), decisionDueAt: later(3),
      provenance: { kind: 'department_policy', actor: { personId: c.ceo.id }, ref: expect.stringMatching(/^wait-policy:/) as string, revision: 1, origin: 'run:queue' },
      finalReview: { headAgentId: c.head.id, anchorAt: later(3), intervalMs: 4 * HOUR },
    });
  });

  it('keeps each stage its own clock', async () => {
    const c = await fixture();
    await c.policy();
    await c.policy({ stage: 'execution', ownerMs: 5 * HOUR, headMs: 6 * HOUR, decisionMs: 7 * HOUR });
    expect((await c.from({ stage: 'execution' }))!.ownerDueAt).toBe(later(5));
    expect((await c.from({ stage: 'queue' }))!.ownerDueAt).toBe(later(1));
    expect(await c.from({ stage: 'prepare' })).toBeNull();
  });

  it('takes the newest version, and a plan made before keeps its dates', async () => {
    const c = await fixture();
    await c.policy();
    const before = await c.from();
    await c.policy({ version: 2, ownerMs: 9 * HOUR, headMs: 9 * HOUR, decisionMs: 9 * HOUR });
    const after = await c.from();
    expect(after!.provenance.revision).toBe(2);
    expect(after!.ownerDueAt).toBe(later(9));
    expect(before!.ownerDueAt).toBe(later(1));
  });

  it('takes no policy of another department or kind', async () => {
    const c = await fixture();
    await c.policy();
    expect(await c.from({ departmentId: c.parent.id })).toBeNull();
    expect(await c.from({ kind: 'person' })).toBeNull();
  });

  it('makes no plan without a real head to review it', async () => {
    const c = await fixture();
    await c.policy({ departmentId: c.parent.id });
    expect(await c.from({ departmentId: c.parent.id })).toBeNull();
  });
});

describe('the database', () => {
  it('takes no policy with its dates out of order, or nobody behind it', async () => {
    const c = await fixture();
    await expect(c.policy({ headMs: HOUR / 2 })).rejects.toThrow();
    await expect(c.policy({ reviewIntervalMs: 0 })).rejects.toThrow();
    await expect(c.policy({ createdByPersonId: null })).rejects.toThrow();
  });

  it('keeps one policy for each version', async () => {
    const c = await fixture();
    await c.policy();
    await expect(c.policy()).rejects.toThrow();
  });
});

describe('nextReview', () => {
  const review = { headAgentId: '00000000-0000-4000-8000-000000000001', anchorAt: NOON.toISOString(), intervalMs: HOUR };

  it('takes the next one of the sequence after the moment', () => {
    expect(nextReview(review, NOON, NOON)).toEqual({ at: new Date(later(1)), skipped: 0 });
    expect(nextReview(review, NOON, new Date(later(0.5)))).toEqual({ at: new Date(later(1)), skipped: 0 });
  });

  it('counts the ones a late sweep passed over, on the same sequence', () => {
    expect(nextReview(review, NOON, new Date(later(3.5)))).toEqual({ at: new Date(later(4)), skipped: 3 });
    expect(nextReview(review, new Date(later(2)), new Date(later(3)))).toEqual({ at: new Date(later(4)), skipped: 1 });
  });

  it('has no next one without repeats', () => {
    expect(nextReview({ ...review, intervalMs: null }, NOON, new Date(later(9)))).toEqual({ at: null, skipped: 0 });
  });
});

describe('waitRoute', () => {
  const task = (departmentId: string | null, companyId: string) => ({ companyId, departmentId } as Pick<typeof tasks.$inferSelect, 'companyId' | 'departmentId'>);
  const route = (c: Awaited<ReturnType<typeof fixture>>, departmentId: string | null) => c.db.transaction(tx => waitRoute(tx, task(departmentId, c.company.id)));

  it('has the department\'s named owner decide', async () => {
    const c = await fixture();
    const { eq } = await import('drizzle-orm');
    await c.db.update(departments).set({ ownerPersonId: c.ann.id }).where(eq(departments.id, c.department.id));
    expect(await route(c, c.department.id)).toEqual({ finalDecisionPersonId: c.ann.id, fallbackToCeo: false });
  });

  it('goes to the owner of the department above', async () => {
    const c = await fixture();
    const { eq } = await import('drizzle-orm');
    await c.db.update(departments).set({ ownerPersonId: c.ann.id }).where(eq(departments.id, c.parent.id));
    await c.db.update(departments).set({ parentId: c.parent.id }).where(eq(departments.id, c.department.id));
    expect(await route(c, c.department.id)).toEqual({ finalDecisionPersonId: c.ann.id, fallbackToCeo: false });
  });

  it('keeps the CEO as who decides when there is none, or no department', async () => {
    const c = await fixture();
    expect(await route(c, c.department.id)).toEqual({ finalDecisionPersonId: c.ceo.id, fallbackToCeo: true });
    expect(await route(c, null)).toEqual({ finalDecisionPersonId: c.ceo.id, fallbackToCeo: true });
  });

  it('does not take someone who only has access for the owner', async () => {
    const c = await fixture();
    const { eq } = await import('drizzle-orm');
    await c.db.update(people).set({ status: 'disabled' }).where(eq(people.id, c.ann.id));
    await c.db.update(departments).set({ ownerPersonId: c.ann.id }).where(eq(departments.id, c.department.id));
    expect(await route(c, c.department.id)).toEqual({ finalDecisionPersonId: c.ceo.id, fallbackToCeo: true });
  });
});
