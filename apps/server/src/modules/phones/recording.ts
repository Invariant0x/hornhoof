import { PHONE_LEASE_MS, type PhoneFrame } from '@hornhoof/protocol';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { canViewAgent, viewerOf } from '../../auth/agent-view.js';
import type { Person } from '../../auth/session.js';
import { agents, attachments, companyPhones, jobs, phoneFrames, phoneSessions, tasks } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { checkRoom, pictureType } from '../tasks/attachments.js';
import { seesTask } from '../tasks/sight.js';
import type { NodeIdentity } from '../nodes/hub.js';
import { finishPhoneSession } from './queue.js';
import { phoneById, phoneDenied, phoneMissing, phoneOwner, type PhoneSession } from './store.js';

const MAX_SESSION_FRAMES = 2000;

/* A frame's generation, node and live job are checked again under the phone lock before anything is stored. */
export async function recordPhoneFrame(ctx: Ctx, node: NodeIdentity, frame: PhoneFrame): Promise<void> {
  if (node.kind !== 'node') return;
  const [known] = await ctx.db.select().from(phoneSessions).where(eq(phoneSessions.id, frame.sessionId));
  if (!known) return;
  let expiresAt: Date | null = null;
  let full = false;
  try {
    await ctx.db.transaction(async tx => {
      const [phone] = await tx.select().from(companyPhones).where(eq(companyPhones.id, known.phoneId)).for('update');
      const [held] = await tx.select({ session: phoneSessions, status: jobs.status, error: jobs.error, task: tasks }).from(phoneSessions).innerJoin(jobs, eq(jobs.id, phoneSessions.jobId)).innerJoin(tasks, eq(tasks.id, phoneSessions.taskId)).where(eq(phoneSessions.id, frame.sessionId));
      if (!phone?.lending || phone.nodeId !== node.nodeId || !held || held.status !== 'running' || held.error === 'cancelled' || held.session.status !== 'active' || held.session.generation !== frame.generation || phone.generation !== frame.generation || !held.session.leaseUntil || held.session.leaseUntil.getTime() <= ctx.clock()) return;
      const [duplicate] = await tx.select({ id: phoneFrames.id }).from(phoneFrames).where(and(eq(phoneFrames.sessionId, frame.sessionId), eq(phoneFrames.sequence, frame.sequence)));
      if (duplicate) return;
      const [amount] = await tx.select({ count: sql<string>`count(*)` }).from(phoneFrames).where(eq(phoneFrames.sessionId, frame.sessionId));
      if (Number(amount!.count) >= MAX_SESSION_FRAMES) { full = true; return; }
      const bytes = frame.capture.png ? Buffer.from(frame.capture.png, 'base64') : null;
      if (bytes && pictureType(bytes) !== 'image/png') return;
      let attachmentId: string | null = null;
      if (bytes) {
        await checkRoom({ db: tx, config: ctx.config }, phone.companyId, held.task, bytes.length);
        const [attachment] = await tx.insert(attachments).values({ companyId: phone.companyId, jobId: held.session.jobId, agentId: held.session.agentId, taskId: held.session.taskId, name: null, bytes, size: bytes.length, mediaType: 'image/png' }).returning({ id: attachments.id });
        attachmentId = attachment!.id;
      }
      const { width, height, elements, masked } = frame.capture;
      const capture = { width, height, elements, masked };
      await tx.insert(phoneFrames).values({ companyId: phone.companyId, sessionId: frame.sessionId, sequence: frame.sequence, at: new Date(frame.at), attachmentId, capture });
      expiresAt = new Date(ctx.clock() + PHONE_LEASE_MS);
      await tx.update(phoneSessions).set({ leaseUntil: expiresAt }).where(eq(phoneSessions.id, frame.sessionId));
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 413) full = true;
    else throw error;
  }
  if (full) await finishPhoneSession(ctx, frame.sessionId, 'recording_limit');
  else if (expiresAt) ctx.hub.send(node, { type: 'phone.renew', sessionId: frame.sessionId, generation: frame.generation, expiresAt: new Date(expiresAt).toISOString() });
}

async function recordingAccess(ctx: Ctx, me: Person, id: string): Promise<PhoneSession> {
  const [found] = await ctx.db.select({ session: phoneSessions, agent: agents, task: tasks }).from(phoneSessions).innerJoin(agents, eq(agents.id, phoneSessions.agentId)).innerJoin(tasks, eq(tasks.id, phoneSessions.taskId)).where(eq(phoneSessions.id, id));
  if (!found) throw phoneMissing();
  if (found.session.companyId !== me.companyId || !seesTask(await viewerOf(ctx.db, me), found.task) || !await canViewAgent(ctx.db, me, found.agent)) throw phoneDenied();
  return found.session;
}

export async function livePhone(ctx: Ctx, me: Person, id: string) {
  const phone = await phoneById(ctx, me.companyId, id);
  phoneOwner(me, phone);
  const [latest] = await ctx.db.select({ frame: phoneFrames, status: phoneSessions.status }).from(phoneFrames).innerJoin(phoneSessions, eq(phoneSessions.id, phoneFrames.sessionId)).where(eq(phoneSessions.phoneId, id)).orderBy(desc(phoneSessions.order), desc(phoneFrames.sequence)).limit(1);
  return { phone, frame: latest ? { sequence: latest.frame.sequence, at: latest.frame.at.toISOString(), masked: latest.frame.capture.masked, width: latest.frame.capture.width, height: latest.frame.capture.height, imageUrl: latest.frame.attachmentId ? `/api/phones/${id}/live/image?v=${latest.frame.sequence}` : null, status: latest.status } : null, attachmentId: latest?.frame.attachmentId ?? null };
}

export async function taskRecordings(ctx: Ctx, me: Person, taskId: string) {
  const [task] = await ctx.db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw phoneMissing();
  if (task.companyId !== me.companyId || !seesTask(await viewerOf(ctx.db, me), task)) throw phoneDenied();
  const sessions = await ctx.db.select({ session: phoneSessions, phone: companyPhones.name, agent: agents }).from(phoneSessions).innerJoin(companyPhones, eq(companyPhones.id, phoneSessions.phoneId)).innerJoin(agents, eq(agents.id, phoneSessions.agentId)).where(and(eq(phoneSessions.taskId, taskId), eq(phoneSessions.companyId, me.companyId))).orderBy(desc(phoneSessions.order));
  const recordings = [];
  for (const { session, phone, agent } of sessions) {
    if (!await canViewAgent(ctx.db, me, agent)) continue;
    const frames = await ctx.db.select().from(phoneFrames).where(eq(phoneFrames.sessionId, session.id)).orderBy(asc(phoneFrames.sequence));
    recordings.push({ id: session.id, phone, agent: agent.name, status: session.status, reason: session.reason, startedAt: session.startedAt?.toISOString() ?? null, endedAt: session.endedAt?.toISOString() ?? null,
      frames: frames.map(f => ({ sequence: f.sequence, at: f.at.toISOString(), masked: f.capture.masked, imageUrl: f.attachmentId ? `/api/phone-sessions/${session.id}/frames/${f.sequence}/image` : null })),
    });
  }
  return { recordings };
}

export async function recordingImage(ctx: Ctx, me: Person, id: string, sequence: number): Promise<string | null> {
  await recordingAccess(ctx, me, id);
  const [frame] = await ctx.db.select({ attachmentId: phoneFrames.attachmentId }).from(phoneFrames).where(and(eq(phoneFrames.sessionId, id), eq(phoneFrames.sequence, sequence)));
  if (!frame) throw phoneMissing();
  return frame.attachmentId;
}

export async function imageBytes(ctx: Ctx, companyId: string, id: string | null): Promise<Buffer> {
  if (!id) throw phoneMissing();
  const [file] = await ctx.db.select({ bytes: attachments.bytes }).from(attachments).where(and(eq(attachments.id, id), eq(attachments.companyId, companyId), isNull(attachments.operatorCaseId)));
  if (!file) throw phoneMissing();
  return Buffer.from(file.bytes);
}
