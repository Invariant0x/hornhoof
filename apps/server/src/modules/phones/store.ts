import { randomUUID } from 'node:crypto';
import { PhoneEndpoint, PhonePairing, type PhoneDevice } from '@hornhoof/protocol';
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { viaOrchestrator, type Person } from '../../auth/session.js';
import { companies, companyPhones, machines, nodes, people, phoneSessions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { nodeIdentity } from '../nodes/hub.js';
import { phoneCapable, phoneRequest } from './rpc.js';
import { idOnly } from '../../db/selections.js';
import { phoneReadiness } from './readiness.js';

export type CompanyPhone = typeof companyPhones.$inferSelect;
export type PhoneSession = typeof phoneSessions.$inferSelect;
export const phoneDenied = () => new ApiError(403, 'forbidden', 'This phone is not available to you.', 'phone_not_allowed');
export const phoneMissing = () => new ApiError(404, 'not_found', 'There is no such phone.', 'phone_unknown');
export const phoneOffline = () => new ApiError(503, 'unavailable', 'The phone does not answer. Check its connection and the approval on its screen.', 'phone_unavailable');
export const phoneGone = () => new ApiError(409, 'conflict', 'You do not hold an active session on this phone.', 'phone_session_gone');
export const phoneInvalid = () => new ApiError(400, 'validation', 'Check the phone name, computer and address.', 'phone_invalid');
const alreadyHeld = () => new ApiError(409, 'conflict', 'This phone is already registered and busy. End its session before changing its connection.', 'phone_busy');

export const ProbePhone = z.strictObject({ machineId: z.uuid(), endpoint: PhoneEndpoint, pairing: PhonePairing.optional() });
export const NewPhone = ProbePhone.extend({ name: z.string().trim().min(1).max(100) });

export async function phoneById(ctx: Ctx, companyId: string, id: string): Promise<CompanyPhone> {
  const [phone] = await ctx.db.select().from(companyPhones).where(and(eq(companyPhones.id, id), isNull(companyPhones.removedAt)));
  if (!phone) throw phoneMissing();
  if (phone.companyId !== companyId) throw phoneDenied();
  return phone;
}

/* The phone's owner stops and resumes it, and the orchestrator acting for the CEO; never a head. */
export function phoneOwner(me: Person, phone: CompanyPhone): void {
  if (me.companyId !== phone.companyId || (!viaOrchestrator(me) && (me.via || me.id !== phone.personId))) throw phoneDenied();
}

export async function nodeForPhone(ctx: Ctx, companyId: string, machineId: string): Promise<string> {
  const [machine] = await ctx.db.select().from(machines).where(eq(machines.id, machineId));
  if (!machine || machine.companyId !== companyId) throw phoneDenied();
  if (machine.revokedAt) throw phoneOffline();
  const found = await ctx.db.select(idOnly(nodes)).from(nodes).where(and(eq(nodes.machineId, machineId), eq(nodes.companyId, companyId), isNotNull(nodes.keyHash))).orderBy(asc(nodes.createdAt), asc(nodes.id));
  const node = found.find(row => phoneCapable(ctx, nodeIdentity(row.id)));
  if (!node) throw phoneOffline();
  return node.id;
}

export async function probePhone(ctx: Ctx, me: Person, input: z.infer<typeof ProbePhone>): Promise<{ nodeId: string; devices: PhoneDevice[] }> {
  if (me.viaHead) throw phoneDenied();
  const nodeId = await nodeForPhone(ctx, me.companyId, input.machineId);
  const result = await phoneRequest(ctx, nodeIdentity(nodeId), { type: 'phone.probe', requestId: randomUUID(), endpoint: input.endpoint, ...(input.pairing ? { pairing: input.pairing } : {}) });
  if (result.status !== 'ok') throw phoneOffline();
  return { nodeId, devices: result.devices ?? [] };
}

export async function phoneView(ctx: Ctx, phone: CompanyPhone, me?: Person) {
  const [owner] = await ctx.db.select({ id: people.id, name: people.name }).from(people).where(eq(people.id, phone.personId));
  const sessions = await ctx.db.select({ state: phoneSessions.status }).from(phoneSessions).where(and(eq(phoneSessions.phoneId, phone.id), isNull(phoneSessions.endedAt))).orderBy(asc(phoneSessions.order));
  const active = sessions.find(s => s.state !== 'queued');
  return {
    id: phone.id, name: phone.name, owner: owner!, machineId: phone.machineId, lending: phone.lending, stopping: active?.state === 'revoking',
    online: phoneCapable(ctx, nodeIdentity(phone.nodeId)), state: !phone.lending ? 'owner' : active ? 'busy' : 'available', queued: sessions.filter(s => s.state === 'queued').length,
    readiness: phoneReadiness(ctx, phone),
    ...(me?.id === phone.personId ? { endpoint: phone.serial } : {}),
  };
}

export async function addPhone(ctx: Ctx, me: Person, input: z.infer<typeof NewPhone>): Promise<CompanyPhone> {
  const { nodeId, devices } = await probePhone(ctx, me, input);
  const hardwareKey = devices.find(d => d.serial === input.endpoint && d.status === 'device')?.hardwareKey;
  if (!hardwareKey) throw phoneOffline();
  return ctx.db.transaction(async tx => {
    await tx.select(idOnly(companies)).from(companies).where(eq(companies.id, me.companyId)).for('update');
    const [machine] = await tx.select().from(machines).where(eq(machines.id, input.machineId)).for('update');
    if (!machine || machine.companyId !== me.companyId || machine.revokedAt) throw phoneDenied();
    const [physical] = await tx.select().from(companyPhones).where(and(eq(companyPhones.hardwareKey, hardwareKey), isNull(companyPhones.removedAt))).for('update');
    const [onSerial] = await tx.select().from(companyPhones).where(and(eq(companyPhones.machineId, input.machineId), eq(companyPhones.serial, input.endpoint), isNull(companyPhones.removedAt)));
    const existing = physical ?? onSerial;
    if (existing) {
      phoneOwner(me, existing);
      if (existing.hardwareKey !== hardwareKey) throw alreadyHeld();
      const same = existing.machineId === input.machineId && existing.nodeId === nodeId && existing.serial === input.endpoint;
      if (same) return existing;
      const [held] = await tx.select(idOnly(phoneSessions)).from(phoneSessions).where(and(eq(phoneSessions.phoneId, existing.id), inArray(phoneSessions.status, ['queued', 'starting', 'active', 'revoking']))).limit(1);
      if (held) throw alreadyHeld();
      const [changed] = await tx.update(companyPhones).set({ machineId: input.machineId, nodeId, serial: input.endpoint, name: input.name, generation: existing.generation + 1 }).where(eq(companyPhones.id, existing.id)).returning();
      return changed!;
    }
    const [phone] = await tx.insert(companyPhones).values({ companyId: me.companyId, personId: me.id, nodeId, machineId: input.machineId, serial: input.endpoint, name: input.name, hardwareKey }).onConflictDoNothing().returning();
    if (!phone) throw phoneDenied();
    return phone!;
  });
}
