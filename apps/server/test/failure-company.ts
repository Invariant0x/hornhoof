import { asc, eq } from 'drizzle-orm';
import { vi } from 'vitest';
import { agents, departments, jobs, subscriptions, taskEvents } from '../src/db/schema.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import type { Failure } from '@hornhoof/protocol';
import { as, setUpCompany, testApp } from './helpers.js';

export async function failureCompany() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const ctx = app.ctx;
  const [sub] = await db.select().from(subscriptions);
  const companyId = sub!.companyId;
  await db.update(subscriptions).set({ status: 'ready' }).where(eq(subscriptions.id, sub!.id));
  vi.spyOn(ctx.hub, 'isReady').mockReturnValue(true);
  vi.spyOn(ctx.hub, 'isOnline').mockReturnValue(true);
  vi.spyOn(ctx.hub, 'hasTerminals').mockReturnValue(true);
  const sent = vi.spyOn(ctx.hub, 'send').mockReturnValue(true);
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
  const [ops] = await db.insert(departments).values({ companyId, templateKey: 'operations', roleCode: 'OPS' }).returning();
  const hire = async (name: string, kind: 'worker' | 'head', roleKey: string, departmentId: string) =>
    (await db.insert(agents).values({ companyId, name, kind, roleKey, departmentId, subscriptionId: sub!.id, model: '' }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD', dev!.id);
  const agent = await hire('Bruno', 'worker', 'DEV-BE', dev!.id);
  const watcher = await hire('Walt', 'worker', 'OPS-WATCH', ops!.id);
  const jobOf = async (id: string) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
  const turnsOf = (id = agent.id) => db.select().from(jobs).where(eq(jobs.agentId, id)).orderBy(asc(jobs.createdAt));
  const fail = (id: string, failure?: Failure, now = new Date()) => handleNodeMessage(ctx, BUILTIN, { type: 'job.done', jobId: id, ok: false, sessionId: 'session', error: 'agent_failed', tail: 'Failed.', result: '', ...(failure ? { failure } : {}) }, now);
  const log = (id: string) => db.select().from(taskEvents).where(eq(taskEvents.taskId, id));
  return { app, db, ctx, ceo, sub: sub!, companyId, dev: dev!, agent, head, watcher, sent, fail, jobOf, turnsOf, log, as };
}
