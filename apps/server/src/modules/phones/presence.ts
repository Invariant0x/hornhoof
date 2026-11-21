import { randomUUID } from 'node:crypto';
import type { PhoneReply } from '@hornhoof/protocol';
import { and, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { companyPhones } from '../../db/schema.js';
import { keyOf, nodeIdentity } from '../nodes/hub.js';
import { phoneCapable, phoneListCapable, phoneRequest } from './rpc.js';
import type { CompanyPhone } from './store.js';

/* ready: its computer is online and the adb of its node lists it as a connected device. not_connected: the node answered
   phone.list and its adb does not list the phone ready (missing, unauthorized or offline). computer_offline: its computer is
   offline or phone.list failed or timed out. A node that cannot say what its adb lists keeps its phones as its computer is,
   ready while it is online, as before. */
export type PhoneConnection = 'ready' | 'not_connected' | 'computer_offline';

/* One list request to a node at a time: whoever needs it while one is on its way waits for that same answer, if it asks
   about the same phones. Nothing is kept once the answer is in, so the next look asks adb again. */
type Listing = { serials: Set<string>; states: Promise<Map<string, PhoneConnection>> };
const listings = new WeakMap<Ctx, Map<string, Listing>>();
const LIST_MAX = 100;

function recordBatch(found: Map<string, PhoneConnection>, batch: string[], reply: PhoneReply): void {
  if (reply.status !== 'ok') {
    for (const serial of batch) found.set(serial, 'computer_offline');
    return;
  }
  const ready = new Set((reply.devices ?? []).filter(device => device.status === 'device').map(device => device.serial));
  for (const serial of batch) found.set(serial, ready.has(serial) ? 'ready' : 'not_connected');
}

async function connectionsOn(ctx: Ctx, nodeId: string, serials: string[]): Promise<Map<string, PhoneConnection>> {
  const node = nodeIdentity(nodeId);
  const onNode = await ctx.db.select({ serial: companyPhones.serial }).from(companyPhones).where(and(eq(companyPhones.nodeId, nodeId), isNull(companyPhones.removedAt)));
  const asked = [...new Set([...serials, ...onNode.map(row => row.serial)])];
  const found = new Map<string, PhoneConnection>();
  for (let at = 0; at < asked.length; at += LIST_MAX) {
    const batch = asked.slice(at, at + LIST_MAX);
    const reply = await phoneRequest(ctx, node, { type: 'phone.list', requestId: randomUUID(), serials: batch });
    recordBatch(found, batch, reply);
  }
  return found;
}

function listed(ctx: Ctx, nodeId: string, serials: string[]): Promise<Map<string, PhoneConnection>> {
  const found = listings.get(ctx) ?? new Map<string, Listing>();
  listings.set(ctx, found);
  const key = keyOf(nodeIdentity(nodeId));
  const current = found.get(key);
  if (current && serials.every(serial => current.serials.has(serial))) return current.states;
  const listing: Listing = { serials: new Set(serials), states: connectionsOn(ctx, nodeId, serials) };
  found.set(key, listing);
  void listing.states.finally(() => { if (found.get(key) === listing) found.delete(key); }).catch(() => {});
  return listing.states;
}

export async function phoneConnections(ctx: Ctx, phones: CompanyPhone[]): Promise<Map<string, PhoneConnection>> {
  const byNode = new Map<string, CompanyPhone[]>();
  for (const phone of phones) byNode.set(phone.nodeId, [...(byNode.get(phone.nodeId) ?? []), phone]);
  const connections = new Map<string, PhoneConnection>();
  await Promise.all([...byNode].map(async ([nodeId, onNode]) => {
    const node = nodeIdentity(nodeId);
    if (!phoneCapable(ctx, node)) { for (const phone of onNode) connections.set(phone.id, 'computer_offline'); return; }
    if (!phoneListCapable(ctx, node)) { for (const phone of onNode) connections.set(phone.id, 'ready'); return; }
    const states = await listed(ctx, nodeId, onNode.map(phone => phone.serial));
    for (const phone of onNode) connections.set(phone.id, states.get(phone.serial) ?? 'computer_offline');
  }));
  return connections;
}

export async function phoneConnection(ctx: Ctx, phone: CompanyPhone): Promise<PhoneConnection> {
  return (await phoneConnections(ctx, [phone])).get(phone.id)!;
}
