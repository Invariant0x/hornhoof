/* What the tests of operations-plan.test.ts start from, also the ones that take a database of their own. */
import { and, eq, isNull } from 'drizzle-orm';
import { expect } from 'vitest';
import type { Db } from '../src/db/client.js';
import { agents, companies, departments, people, subscriptions } from '../src/db/schema.js';
import { as, sessionFrom, SETUP, testApp } from './helpers.js';

/* A company whose Operations has no plan yet, and an empty Development to tell it from. */
export async function company() {
  const { app, db } = await testApp();
  const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, orchestrator: { mode: 'later' } } });
  expect(res.statusCode).toBe(201);
  const ceo = sessionFrom(res);
  const built = await app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: [{ template: 'development' }] }, ...as(ceo) });
  expect(built.statusCode).toBe(201);
  const [acme] = await db.select().from(companies);
  const [owner] = await db.select().from(people);
  const [ops] = await db.select().from(departments).where(eq(departments.templateKey, 'operations'));
  const [dev] = await db.select().from(departments).where(eq(departments.templateKey, 'development'));
  return { app, db, ceo, companyId: acme!.id, ownerId: owner!.id, ops: ops!, dev: dev! };
}
export type Company = Awaited<ReturnType<typeof company>>;

export async function operator(db: Db) {
  const [row] = await db.select().from(agents).where(and(eq(agents.roleKey, 'OPS-PROGRAM'), isNull(agents.removedAt)));
  return row!;
}

export async function addKey(c: Company, target: object = { kind: 'any' }): Promise<string> {
  const res = await c.app.inject({ method: 'POST', url: '/api/subscriptions', payload: { provider: 'anthropic_api', kind: 'api_key', label: 'Key', apiKey: 'sk-ant-api03-a-key-5678', target }, ...as(c.ceo) });
  expect(res.statusCode).toBe(201);
  return res.json().subscription.id as string;
}

/* A plan as a machine reported it, for what the routes do not make at once. */
export async function addPlan(c: Company, values: Partial<typeof subscriptions.$inferInsert> = {}): Promise<string> {
  const [row] = await c.db
    .insert(subscriptions)
    .values({ companyId: c.companyId, provider: 'claude', kind: 'personal', label: 'Plan', ownerPersonId: c.ownerId, status: 'ready', ...values })
    .returning({ id: subscriptions.id });
  return row!.id;
}
