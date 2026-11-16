import { randomUUID } from 'node:crypto';
import { PhoneEndpoint, PhoneSerial, type PhoneDevice } from '@hornhoof/protocol';
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import type { Person } from '../../auth/session.js';
import { companyPhones, machines, nodes, people, phoneSessions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { nodeIdentity } from '../nodes/hub.js';
import { phoneCapable, phoneRequest } from './rpc.js';

export type CompanyPhone = typeof companyPhones.$inferSelect;
export type PhoneSession = typeof phoneSessions.$inferSelect;
export const phoneDenied = () => new ApiError(403, 'forbidden', 'This phone is not available to you.', 'phone_not_allowed');
export const phoneMissing = () => new ApiError(404, 'not_found', 'There is no such phone.', 'phone_unknown');
export const phoneOffline = () => new ApiError(503, 'unavailable', 'The phone does not answer. Check its connection and the approval on its screen.', 'phone_unavailable');
export const phoneGone = () => new ApiError(409, 'conflict', 'You do not hold an active session on this phone.', 'phone_session_gone');
export const phoneInvalid = () => new ApiError(400, 'validation', 'Check the phone name, computer and connection.', 'phone_invalid');

export const ProbePhone = z.strictObject({ machineId: z.uuid(), transport: z.enum(['network', 'usb']), endpoint: PhoneEndpoint.nullable() });
export const NewPhone = ProbePhone.extend({ serial: PhoneSerial, name: z.string().trim().min(1).max(100) });

export async function phoneById(ctx: Ctx, companyId: string, id: string): Promise<CompanyPhone> {
  const [phone] = await ctx.db.select().from(companyPhones).where(and(eq(companyPhones.id, id), isNull(companyPhones.removedAt)));
  if (!phone) throw phoneMissing();
  if (phone.companyId !== companyId) throw phoneDenied();
  return phone;
}

export function phoneOwner(me: Person, phone: CompanyPhone): void {
  if (me.via || me.id !== phone.personId || me.companyId !== phone.companyId) throw phoneDenied();
}

export async function nodeForPhone(ctx: Ctx, companyId: string, machineId: string): Promise<string> {
  const [machine] = await ctx.db.select().from(machines).where(eq(machines.id, machineId));
  if (!machine || machine.companyId !== companyId) throw phoneDenied();
  if (machine.revokedAt) throw phoneOffline();
  const found = await ctx.db.select({ id: nodes.id }).from(nodes).where(and(eq(nodes.machineId, machineId), eq(nodes.companyId, companyId), isNotNull(nodes.keyHash))).orderBy(asc(nodes.createdAt), asc(nodes.id));
  const node = found.find(row => phoneCapable(ctx, nodeIdentity(row.id)));
  if (!node) throw phoneOffline();
  return node.id;
}

export async function probePhone(ctx: Ctx, me: Person, input: z.infer<typeof ProbePhone>): Promise<{ nodeId: string; devices: PhoneDevice[] }> {
  if (me.via) throw phoneDenied();
  if ((input.transport === 'network') !== (input.endpoint !== null)) throw phoneInvalid();
  const nodeId = await nodeForPhone(ctx, me.companyId, input.machineId);
  const result = await phoneRequest(ctx, nodeIdentity(nodeId), { type: 'phone.probe', requestId: randomUUID(), transport: input.transport, endpoint: input.endpoint });
  if (result.status !== 'ok') throw phoneOffline();
  return { nodeId, devices: result.devices ?? [] };
}

export async function phoneView(ctx: Ctx, phone: CompanyPhone, me?: Person) {
  const [owner] = await ctx.db.select({ id: people.id, name: people.name }).from(people).where(eq(people.id, phone.personId));
  const sessions = await ctx.db.select({ id: phoneSessions.id, state: phoneSessions.status, agentId: phoneSessions.agentId }).from(phoneSessions).where(and(eq(phoneSessions.phoneId, phone.id), isNull(phoneSessions.endedAt))).orderBy(asc(phoneSessions.order));
  const active = sessions.find(s => s.state !== 'queued');
  return {
    id: phone.id, name: phone.name, owner: owner!, machineId: phone.machineId, lending: phone.lending,
    online: phoneCapable(ctx, nodeIdentity(phone.nodeId)), state: !phone.lending ? 'owner' : active ? 'busy' : 'available', queued: sessions.filter(s => s.state === 'queued').length,
    ...(me?.id === phone.personId ? { serial: phone.serial, transport: phone.transport, endpoint: phone.endpoint } : {}),
  };
}

export async function addPhone(ctx: Ctx, me: Person, input: z.infer<typeof NewPhone>): Promise<CompanyPhone> {
  const { nodeId, devices } = await probePhone(ctx, me, input);
  if (!devices.some(d => d.serial === input.serial && d.status === 'device')) throw phoneOffline();
  if (input.transport === 'network' && input.serial !== input.endpoint) throw phoneInvalid();
  return ctx.db.transaction(async tx => {
    await tx.select({ id: machines.id }).from(machines).where(eq(machines.id, input.machineId)).for('update');
    const [existing] = await tx.select().from(companyPhones).where(and(eq(companyPhones.machineId, input.machineId), eq(companyPhones.serial, input.serial), isNull(companyPhones.removedAt)));
    if (existing) {
      phoneOwner(me, existing);
      return existing;
    }
    const [phone] = await tx.insert(companyPhones).values({ companyId: me.companyId, personId: me.id, nodeId, ...input }).returning();
    return phone!;
  });
}
