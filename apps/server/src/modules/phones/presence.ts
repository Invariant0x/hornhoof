import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { companyPhones } from '../../db/schema.js';
import { keyOf, nodeIdentity } from '../nodes/hub.js';
import { phoneCapable, phoneListCapable, phoneRequest } from './rpc.js';
import type { CompanyPhone } from './store.js';

/* ready: its computer is online and the adb of its node lists it as a connected device. not_connected: adb there does not
   list it, or lists it unauthorized or offline. A node that cannot say what its adb lists keeps its phones as its computer
   is, ready while it is online, as before. */
export type PhoneConnection = 'ready' | 'not_connected' | 'computer_offline';

/* One list request to a node at a time: whoever needs it while one is on its way waits for that same answer, if it asks
   about the same phones. Nothing is kept once the answer is in, so the next look asks adb again. */
type Listing = { serials: Set<string>; ready: Promise<Set<string>> };
const listings = new WeakMap<Ctx, Map<string, Listing>>();
const LIST_MAX = 100;

async function readyOn(ctx: Ctx, nodeId: string, serials: string[]): Promise<Set<string>> {
  const node = nodeIdentity(nodeId);
  const onNode = await ctx.db.select({ serial: companyPhones.serial }).from(companyPhones).where(and(eq(companyPhones.nodeId, nodeId), isNull(companyPhones.removedAt)));
  const asked = [...new Set([...serials, ...onNode.map(row => row.serial)])];
  const ready = new Set<string>();
  for (let at = 0; at < asked.length; at += LIST_MAX) {
    const reply = await phoneRequest(ctx, node, { type: 'phone.list', requestId: randomUUID(), serials: asked.slice(at, at + LIST_MAX) });
    if (reply.status === 'ok') for (const device of reply.devices ?? []) if (device.status === 'device') ready.add(device.serial);
  }
  return ready;
}

function listed(ctx: Ctx, nodeId: string, serials: string[]): Promise<Set<string>> {
  const found = listings.get(ctx) ?? new Map<string, Listing>();
  listings.set(ctx, found);
  const key = keyOf(nodeIdentity(nodeId));
  const current = found.get(key);
  if (current && serials.every(serial => current.serials.has(serial))) return current.ready;
  const listing: Listing = { serials: new Set(serials), ready: readyOn(ctx, nodeId, serials) };
  found.set(key, listing);
  void listing.ready.finally(() => { if (found.get(key) === listing) found.delete(key); }).catch(() => {});
  return listing.ready;
}

export async function phoneConnections(ctx: Ctx, phones: CompanyPhone[]): Promise<Map<string, PhoneConnection>> {
  const byNode = new Map<string, CompanyPhone[]>();
  for (const phone of phones) byNode.set(phone.nodeId, [...(byNode.get(phone.nodeId) ?? []), phone]);
  const connections = new Map<string, PhoneConnection>();
  await Promise.all([...byNode].map(async ([nodeId, onNode]) => {
    const node = nodeIdentity(nodeId);
    if (!phoneCapable(ctx, node)) { for (const phone of onNode) connections.set(phone.id, 'computer_offline'); return; }
    if (!phoneListCapable(ctx, node)) { for (const phone of onNode) connections.set(phone.id, 'ready'); return; }
    const ready = await listed(ctx, nodeId, onNode.map(phone => phone.serial));
    for (const phone of onNode) connections.set(phone.id, ready.has(phone.serial) ? 'ready' : 'not_connected');
  }));
  return connections;
}

export async function phoneConnection(ctx: Ctx, phone: CompanyPhone): Promise<PhoneConnection> {
  return (await phoneConnections(ctx, [phone])).get(phone.id)!;
}
