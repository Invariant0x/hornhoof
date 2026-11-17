import { randomUUID } from 'node:crypto';
import { PHONE_LEASE_MS, type PhoneBinding, type PhoneOperation, type PhoneReply } from '@hornhoof/protocol';
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, companyPhones, jobs, machines, nodes, phoneSessions } from '../../db/schema.js';
import { nodeIdentity } from '../nodes/hub.js';
import { taskByRef } from '../tasks/views.js';
import { phoneCapable, phoneRequest } from './rpc.js';
import { phoneById, phoneDenied, phoneGone, phoneInvalid, phoneMissing, phoneOffline, type CompanyPhone, type PhoneSession } from './store.js';
import { idOnly, only } from '../../db/selections.js';

/* An employee or assistant that borrows a phone, and the turn it runs. */
export type PhoneAgent = { id: string; companyId: string; jobId: string | null };

const holding = ['starting', 'active', 'revoking'] as const;
const unfinished = ['queued', ...holding] as const;
const phoneBinding = (p: CompanyPhone): PhoneBinding => ({ phoneId: p.id, serial: p.serial, hardwareKey: p.hardwareKey });

async function liveJob(ctx: Ctx, me: PhoneAgent) {
  if (!me.jobId) throw phoneGone();
  const [job] = await ctx.db.select().from(jobs).where(and(eq(jobs.id, me.jobId), eq(jobs.companyId, me.companyId), eq(jobs.agentId, me.id), eq(jobs.status, 'running')));
  if (!job || job.error === 'cancelled') throw phoneGone();
  const [agent] = await ctx.db.select().from(agents).where(and(eq(agents.id, me.id), eq(agents.companyId, me.companyId), isNull(agents.removedAt)));
  if (!agent) throw phoneGone();
  return job;
}

export async function sessionFor(ctx: Ctx, me: PhoneAgent, id: string): Promise<PhoneSession> {
  const [session] = await ctx.db.select().from(phoneSessions).where(eq(phoneSessions.id, id));
  if (!session) throw phoneMissing();
  if (session.companyId !== me.companyId) throw phoneDenied();
  if (session.agentId !== me.id || session.jobId !== me.jobId) throw phoneGone();
  return session;
}

async function activeSession(ctx: Ctx, me: PhoneAgent, id: string): Promise<{ phone: CompanyPhone; session: PhoneSession }> {
  const session = await sessionFor(ctx, me, id);
  await liveJob(ctx, me);
  const phone = await phoneById(ctx, me.companyId, session.phoneId);
  if (session.status !== 'active' || !phone.lending || session.generation !== phone.generation || !session.leaseUntil || session.leaseUntil.getTime() <= ctx.clock()) throw phoneGone();
  const [binding] = await ctx.db.select(idOnly(nodes)).from(nodes).innerJoin(machines, eq(machines.id, nodes.machineId)).where(and(eq(nodes.id, phone.nodeId), eq(nodes.machineId, phone.machineId), eq(nodes.companyId, phone.companyId), isNull(machines.revokedAt)));
  if (!binding) throw phoneOffline();
  return { phone, session };
}

export async function sessionView(ctx: Ctx, session: PhoneSession) {
  const ahead = session.status === 'queued' ? await ctx.db.select(idOnly(phoneSessions)).from(phoneSessions).where(and(eq(phoneSessions.phoneId, session.phoneId), eq(phoneSessions.status, 'queued'))).orderBy(asc(phoneSessions.order)) : [];
  return { id: session.id, phoneId: session.phoneId, taskId: session.taskId, status: session.status, position: session.status === 'queued' ? ahead.findIndex(s => s.id === session.id) + 1 : 0, reason: session.reason };
}

export async function acquirePhone(ctx: Ctx, me: PhoneAgent, phoneId: string, taskRef?: string | number) {
  const phone = await phoneById(ctx, me.companyId, phoneId);
  const job = await liveJob(ctx, me);
  const task = await taskByRef(ctx, me.companyId, job.taskId ?? taskRef ?? '');
  if (!task) throw phoneInvalid();
  // A task of another person's assistant remains private even within the company.
  const privateIds = [task.assigneeAgentId, task.executorAgentId].filter((v): v is string => Boolean(v));
  if (privateIds.length && (await ctx.db.select(idOnly(agents)).from(agents).where(and(inArray(agents.id, privateIds), eq(agents.kind, 'assistant'), ne(agents.id, me.id)))).length) throw phoneDenied();
  if (!phoneCapable(ctx, nodeIdentity(phone.nodeId))) throw phoneOffline();
  await reconcilePhone(ctx, phoneId);
  const session = await ctx.db.transaction(async tx => {
    const [current] = await tx.select().from(companyPhones).where(eq(companyPhones.id, phoneId)).for('update');
    if (!current?.lending || current.removedAt) throw phoneGone();
    const [existing] = await tx.select().from(phoneSessions).where(and(eq(phoneSessions.phoneId, phoneId), eq(phoneSessions.jobId, job.id), inArray(phoneSessions.status, [...unfinished])));
    if (existing) return existing;
    const [made] = await tx.insert(phoneSessions).values({ companyId: me.companyId, phoneId, agentId: me.id, jobId: job.id, taskId: task.id }).returning();
    return made!;
  });
  await pumpPhone(ctx, phoneId);
  return sessionView(ctx, await sessionFor(ctx, me, session.id));
}

async function pumpPhone(ctx: Ctx, phoneId: string): Promise<void> {
  const next = await ctx.db.transaction(async tx => {
    const [phone] = await tx.select().from(companyPhones).where(eq(companyPhones.id, phoneId)).for('update');
    if (!phone?.lending || phone.removedAt || !phoneCapable(ctx, nodeIdentity(phone.nodeId))) return null;
    const [active] = await tx.select(idOnly(phoneSessions)).from(phoneSessions).where(and(eq(phoneSessions.phoneId, phoneId), inArray(phoneSessions.status, [...holding]))).limit(1);
    if (active) return null;
    const [waiting] = await tx.select({ session: phoneSessions }).from(phoneSessions).innerJoin(jobs, eq(jobs.id, phoneSessions.jobId)).innerJoin(agents, eq(agents.id, phoneSessions.agentId))
      .where(and(eq(phoneSessions.phoneId, phoneId), eq(phoneSessions.status, 'queued'), eq(jobs.status, 'running'), isNull(agents.removedAt)))
      .orderBy(asc(phoneSessions.order)).limit(1);
    if (!waiting) return null;
    const [job] = await tx.select(only(jobs, 'error')).from(jobs).where(eq(jobs.id, waiting.session.jobId));
    if (job?.error === 'cancelled') return null;
    const generation = phone.generation + 1;
    const expires = new Date(ctx.clock() + PHONE_LEASE_MS);
    await tx.update(companyPhones).set({ generation }).where(eq(companyPhones.id, phoneId));
    const [session] = await tx.update(phoneSessions).set({ status: 'starting', generation, leaseUntil: expires, startedAt: new Date(ctx.clock()) }).where(eq(phoneSessions.id, waiting.session.id)).returning();
    return { phone: { ...phone, generation }, session: session! };
  });
  if (!next) return;
  const { phone, session } = next;
  const reply = await phoneRequest(ctx, nodeIdentity(phone.nodeId), { type: 'phone.open', requestId: randomUUID(), grant: { sessionId: session.id, generation: phone.generation, binding: phoneBinding(phone), expiresAt: session.leaseUntil!.toISOString() } });
  if (reply.status !== 'ok') { await finishPhoneSession(ctx, session.id, 'failed'); return; }
  await ctx.db.update(phoneSessions).set({ status: 'active' }).where(and(eq(phoneSessions.id, session.id), eq(phoneSessions.status, 'starting'), eq(phoneSessions.generation, phone.generation)));
}

async function revokeAndSettle(ctx: Ctx, phone: CompanyPhone, session: PhoneSession): Promise<void> {
  const reply = await phoneRequest(ctx, nodeIdentity(phone.nodeId), { type: 'phone.revoke', requestId: randomUUID(), sessionId: session.id, generation: phone.generation, binding: phoneBinding(phone) });
  if (reply.status !== 'ok') return;
  await ctx.db.update(phoneSessions).set({ status: 'ended', endedAt: new Date(ctx.clock()) }).where(and(eq(phoneSessions.id, session.id), eq(phoneSessions.status, 'revoking')));
  await pumpPhone(ctx, phone.id);
}

export async function finishPhoneSession(ctx: Ctx, id: string, reason: PhoneSession['reason']): Promise<void> {
  const [known] = await ctx.db.select().from(phoneSessions).where(eq(phoneSessions.id, id));
  if (!known) return;
  const work = await ctx.db.transaction(async tx => {
    const [phone] = await tx.select().from(companyPhones).where(eq(companyPhones.id, known.phoneId)).for('update');
    const [session] = await tx.select().from(phoneSessions).where(eq(phoneSessions.id, id));
    if (!phone || !session || session.endedAt) return null;
    if (session.status === 'queued') {
      await tx.update(phoneSessions).set({ status: 'cancelled', endedAt: new Date(ctx.clock()), reason }).where(eq(phoneSessions.id, id));
      return null;
    }
    if (session.status === 'revoking') return null;
    const generation = phone.generation + 1;
    await tx.update(companyPhones).set({ generation }).where(eq(companyPhones.id, phone.id));
    await tx.update(phoneSessions).set({ status: 'revoking', reason }).where(eq(phoneSessions.id, id));
    return { phone: { ...phone, generation }, session };
  });
  if (work) await revokeAndSettle(ctx, work.phone, work.session);
}

/* Owner Stop commits the revocation before it contacts the node. The node's acknowledgement is separate. */
export async function stopPhone(ctx: Ctx, phone: CompanyPhone): Promise<void> {
  const work = await ctx.db.transaction(async tx => {
    const [current] = await tx.select().from(companyPhones).where(eq(companyPhones.id, phone.id)).for('update');
    const generation = current!.generation + 1;
    await tx.update(companyPhones).set({ lending: false, generation }).where(eq(companyPhones.id, phone.id));
    await tx.update(phoneSessions).set({ status: 'cancelled', reason: 'stopped', endedAt: new Date(ctx.clock()) }).where(and(eq(phoneSessions.phoneId, phone.id), eq(phoneSessions.status, 'queued')));
    const active = await tx.update(phoneSessions).set({ status: 'revoking', reason: 'stopped' }).where(and(eq(phoneSessions.phoneId, phone.id), inArray(phoneSessions.status, [...holding]))).returning();
    return { phone: { ...current!, generation, lending: false }, active };
  });
  for (const session of work.active) void revokeAndSettle(ctx, work.phone, session).catch(() => ctx.log.error('A phone revocation could not be confirmed.'));
}

export async function reconcilePhone(ctx: Ctx, phoneId: string): Promise<void> {
  const sessions = await ctx.db.select({ session: phoneSessions, status: jobs.status, error: jobs.error }).from(phoneSessions).innerJoin(jobs, eq(jobs.id, phoneSessions.jobId)).where(and(eq(phoneSessions.phoneId, phoneId), isNull(phoneSessions.endedAt)));
  for (const { session, status, error } of sessions) {
    if (session.leaseUntil && session.leaseUntil.getTime() <= ctx.clock()) {
      await ctx.db.transaction(async tx => {
        const [phone] = await tx.select().from(companyPhones).where(eq(companyPhones.id, phoneId)).for('update');
        const [current] = await tx.select().from(phoneSessions).where(eq(phoneSessions.id, session.id));
        if (!current || current.endedAt || !current.leaseUntil || current.leaseUntil.getTime() > ctx.clock()) return;
        await tx.update(companyPhones).set({ generation: phone!.generation + 1 }).where(eq(companyPhones.id, phoneId));
        await tx.update(phoneSessions).set({ status: session.status === 'queued' ? 'cancelled' : 'ended', reason: session.reason ?? 'lost', endedAt: new Date(ctx.clock()) }).where(and(eq(phoneSessions.id, session.id), isNull(phoneSessions.endedAt)));
      });
    } else if (status !== 'running' || error === 'cancelled') await finishPhoneSession(ctx, session.id, error === 'cancelled' ? 'cancelled' : 'lost');
  }
  await pumpPhone(ctx, phoneId);
}

export async function releaseJobPhones(ctx: Ctx, jobId: string, reason: PhoneSession['reason'] = 'cancelled'): Promise<void> {
  const held = await ctx.db.select(idOnly(phoneSessions)).from(phoneSessions).where(and(eq(phoneSessions.jobId, jobId), isNull(phoneSessions.endedAt)));
  await Promise.all(held.map(s => finishPhoneSession(ctx, s.id, reason)));
}

export async function phoneAction(ctx: Ctx, me: PhoneAgent, id: string, operation: PhoneOperation): Promise<PhoneReply> {
  const { phone, session } = await activeSession(ctx, me, id);
  const reply = await phoneRequest(ctx, nodeIdentity(phone.nodeId), { type: 'phone.action', requestId: randomUUID(), sessionId: id, generation: session.generation!, operation });
  await activeSession(ctx, me, id);
  return reply;
}
