import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { buildApp } from '../src/app.js';
import { companies, people, sessions, subscriptions } from '../src/db/schema.js';
import { hashToken } from '../src/crypto/tokens.js';
import { as, setUpCompany, testApp } from './helpers.js';

async function fixture() {
  const { app, db, config } = await testApp();
  const owner = await setUpCompany(app);
  const [a] = await db.select().from(subscriptions);
  const [b] = await db.insert(subscriptions).values({ companyId: a!.companyId, ownerPersonId: a!.ownerPersonId, provider: 'kimi', kind: 'personal', label: 'Second subscription', status: 'ready' }).returning();
  const patch = (id: string, payload: object, token = owner) => app.inject({ method: 'PATCH', url: `/api/subscriptions/${id}/budget`, payload, ...as(token) });
  return { app, db, config, owner, a: a!, b: b!, patch };
}

describe('subscription budget API', () => {
  it('defaults existing and newly connected subscriptions to 100 with honest control coverage', async () => {
    const c = await fixture();
    const res = await c.app.inject({ url: '/api/subscriptions', ...as(c.owner) });
    expect(res.statusCode).toBe(200);
    const rows = res.json().subscriptions;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ budgetPercent: 100, budget: { control: 'unavailable', decision: { allowed: true, reason: null } } });
    expect((await c.db.select().from(subscriptions)).map(s => s.budgetPercent)).toEqual([100, 100]);
  });

  it('persists 0, 90 and 100 independently, returns confirmed values and survives app recreation', async () => {
    const c = await fixture();
    const starts = await c.db.select().from(subscriptions);
    for (const budgetPercent of [0, 90, 100, 90]) {
      const res = await c.patch(c.a.id, { budgetPercent });
      expect(res.statusCode).toBe(200);
      expect(res.json().subscription).toMatchObject({ id: c.a.id, budgetPercent, budget: { control: 'unavailable' } });
      expect((await c.db.select().from(subscriptions).where(eq(subscriptions.id, c.a.id)))[0]).toEqual({ ...starts[0], budgetPercent });
      expect((await c.db.select().from(subscriptions).where(eq(subscriptions.id, c.b.id)))[0]).toEqual(starts[1]);
    }
    const repeated = await c.patch(c.a.id, { budgetPercent: 90 });
    expect(repeated.statusCode).toBe(200);
    await c.app.close();
    const replacement = await buildApp({ db: c.db, config: c.config });
    onTestFinished(() => replacement.close());
    const rows = (await replacement.inject({ url: '/api/subscriptions', ...as(c.owner) })).json().subscriptions;
    expect(rows.map((s: { budgetPercent: number }) => s.budgetPercent)).toEqual([90, 100]);
  });

  it('rejects invalid percentages, extra fields and invalid ids without changing settings', async () => {
    const c = await fixture();
    for (const payload of [{}, ...[-1, 101, 90.5, '90', null, true].map(budgetPercent => ({ budgetPercent })), { budgetPercent: 90, role: 'owner' }, { budgetPercent: 90, limits: {} }, { budgetPercent: 90, apiKey: 'synthetic-not-a-real-key' }]) {
      const res = await c.patch(c.a.id, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ code: 'validation', reason: 'budget_invalid' });
    }
    expect((await c.patch('invalid-id', { budgetPercent: 90 })).statusCode).toBe(400);
    expect((await c.patch('00000000-0000-4000-8000-000000000000', { budgetPercent: 90 })).statusCode).toBe(404);
    expect((await c.db.select().from(subscriptions)).map(s => s.budgetPercent)).toEqual([100, 100]);
  });

  it('requires same-company ownership or company scope, never an employee or node bearer token', async () => {
    const c = await fixture();
    const [departmentPerson] = await c.db.insert(people).values({ companyId: c.a.companyId, name: 'Department person', email: 'department@example.test', status: 'active', scopeKind: 'listed' }).returning();
    const token = 'synthetic-department-session';
    await c.db.insert(sessions).values({ personId: departmentPerson!.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 60_000) });
    expect((await c.patch(c.a.id, { budgetPercent: 90 }, token)).statusCode).toBe(403);
    await c.db.update(subscriptions).set({ ownerPersonId: departmentPerson!.id }).where(eq(subscriptions.id, c.b.id));
    expect((await c.patch(c.b.id, { budgetPercent: 90 }, token)).statusCode).toBe(200);
    expect((await c.patch(c.b.id, { budgetPercent: 91 })).statusCode).toBe(200);
    for (const bearer of ['synthetic-employee-tool-token', 'synthetic-node-key']) {
      const res = await c.app.inject({ method: 'PATCH', url: `/api/subscriptions/${c.a.id}/budget`, payload: { budgetPercent: 0 }, headers: { authorization: `Bearer ${bearer}` } });
      expect(res.statusCode).toBe(401);
    }
    expect((await c.db.select().from(subscriptions).where(eq(subscriptions.id, c.a.id)))[0]!.budgetPercent).toBe(100);
  });

  it('scopes both lookup and mutation to the authenticated company and hides removed subscriptions', async () => {
    const c = await fixture();
    const [other] = await c.db.insert(companies).values({ name: 'Other company', singleton: false }).returning();
    const [person] = await c.db.insert(people).values({ companyId: other!.id, name: 'Other owner', email: 'other@example.test', status: 'active', scopeKind: 'company' }).returning();
    const [foreign] = await c.db.insert(subscriptions).values({ companyId: other!.id, ownerPersonId: person!.id, provider: 'kimi', kind: 'personal', label: 'Foreign subscription', status: 'ready' }).returning();
    const res = await c.patch(foreign!.id, { budgetPercent: 0 });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.reason).toBe('subscription_unknown');
    const rows = (await c.app.inject({ url: '/api/subscriptions', ...as(c.owner) })).json().subscriptions;
    expect(rows.map((s: { id: string }) => s.id)).not.toContain(foreign!.id);
    expect((await c.db.select().from(subscriptions).where(eq(subscriptions.id, foreign!.id)))[0]).toEqual(foreign);
    await c.db.update(subscriptions).set({ removedAt: new Date() }).where(eq(subscriptions.id, c.b.id));
    expect((await c.patch(c.b.id, { budgetPercent: 90 })).statusCode).toBe(404);
  });
});
