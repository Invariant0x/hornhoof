import { asc, eq } from 'drizzle-orm';
import { vi } from 'vitest';
import { agents, departments, jobs, subscriptions, taskEvents } from '../src/db/schema.js';
import { said } from '../src/modules/conversation/live.js';
import { BUILTIN } from './builtin.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import type { Failure } from '@hornhoof/protocol';
import { as, setUpCompany, testApp } from './helpers.js';

export async function failureCompany(env: NodeJS.ProcessEnv = {}) {
  const { app, db } = await testApp(env);
  const ceo = await setUpCompany(app);
  const ctx = app.ctx;
  const [sub] = await db.select().from(subscriptions);
  const companyId = sub!.companyId;
  await db.update(subscriptions).set({ status: 'ready' }).where(eq(subscriptions.id, sub!.id));
  vi.spyOn(ctx.hub, 'isReady').mockReturnValue(true);
  vi.spyOn(ctx.hub, 'isOnline').mockReturnValue(true);
  vi.spyOn(ctx.hub, 'hasTerminals').mockReturnValue(true);
  /* A node answers the words it is given to type into a running turn. This one says they did not go in, as when the
     program could not take them, so they wait for the next turn at once and no test waits out a silent node. */
  const sent = vi.spyOn(ctx.hub, 'send').mockImplementation((node, message) => {
    if (message.type === 'agent.say') queueMicrotask(() => said(ctx, node, message.ref, false));
    return true;
  });
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
  return { app, db, ctx, ceo, sub: sub!, companyId, dev: dev!, agent, head, watcher, ops: ops!, hire, sent, fail, jobOf, turnsOf, log, as };
}
