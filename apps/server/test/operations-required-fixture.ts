import { and, asc, eq, isNull } from 'drizzle-orm';
import { expect } from 'vitest';
import type { Db } from '../src/db/client.js';
import { agentChanges, agentEvents, agents, companies, departments } from '../src/db/schema.js';
import { SETUP, testApp } from './helpers.js';

/* What the tests of the required roles of Operations share: a company set up through the app, and the live staff of its
   Operations. */

export const FOUR = ['OPS-BUGS', 'OPS-HEAD', 'OPS-PROGRAM', 'OPS-WATCH'];
export const NODE_KEY = 'k'.repeat(40);

export async function opsDepartments(db: Db) {
  return db.select().from(departments).where(and(eq(departments.templateKey, 'operations'), isNull(departments.parentId)));
}

/* The live employees of Operations. */
export async function staff(db: Db) {
  const [ops] = await opsDepartments(db);
  return db.select().from(agents).where(and(eq(agents.departmentId, ops!.id), isNull(agents.removedAt))).orderBy(asc(agents.createdAt), asc(agents.id));
}
export const roles = async (db: Db) => (await staff(db)).map(a => a.roleKey).sort();

export async function company(payload: object = {}) {
  const { app, db } = await testApp();
  expect((await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, ...payload } })).statusCode).toBe(201);
  const [acme] = await db.select().from(companies);
  return { app, db, companyId: acme!.id };
}

/* A company as it stood before Operations was required, with what the test leaves in it. */
export async function staffedLike(db: Db, companyId: string, keep: (a: typeof agents.$inferSelect) => boolean) {
  for (const a of await staff(db)) {
    if (keep(a)) continue;
    await db.delete(agentChanges).where(eq(agentChanges.agentId, a.id));
    await db.delete(agents).where(eq(agents.id, a.id));
  }
  await db.delete(agentEvents).where(eq(agentEvents.companyId, companyId));
}
