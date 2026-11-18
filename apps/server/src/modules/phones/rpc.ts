import type { PhoneReply, PhoneServerMessage, NodeMessage } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import { keyOf, type NodeIdentity } from '../nodes/hub.js';
import { hasCurrentKey } from '../nodes/nodes.js';
import { machines, nodes } from '../../db/schema.js';
import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import { idOnly } from '../../db/selections.js';

type Request = Exclude<PhoneServerMessage, { type: 'phone.renew' }>;
type Pending = { node: string; done(reply: PhoneReply): void; timer: ReturnType<typeof setTimeout> };
type State = { capable: Map<string, NodeIdentity>; lists: Set<string>; baseline: Set<string>; pending: Map<string, Pending> };
const states = new WeakMap<Ctx, State>();
function state(ctx: Ctx): State {
  let found = states.get(ctx);
  if (!found) states.set(ctx, (found = { capable: new Map(), lists: new Set(), baseline: new Set(), pending: new Map() }));
  return found;
}
export const phoneCapable = (ctx: Ctx, node: NodeIdentity): boolean => ctx.hub.isOnline(node) && state(ctx).capable.has(keyOf(node));
/* The node answers phone.list with what its adb lists now. */
export const phoneListCapable = (ctx: Ctx, node: NodeIdentity): boolean => phoneCapable(ctx, node) && state(ctx).lists.has(keyOf(node));
export const phoneBaselineCapable = (ctx: Ctx, node: NodeIdentity): boolean => phoneCapable(ctx, node) && state(ctx).baseline.has(keyOf(node));

export async function phoneRequest(ctx: Ctx, node: NodeIdentity, message: Request): Promise<PhoneReply> {
  const failed = (): PhoneReply => ({ type: 'phone.reply', requestId: message.requestId, status: 'failed' });
  if (!phoneCapable(ctx, node)) return failed();
  const authenticated = state(ctx).capable.get(keyOf(node));
  if (!authenticated || !await hasCurrentKey(ctx, authenticated) || authenticated.kind !== 'node') return failed();
  const [live] = await ctx.db.select(idOnly(nodes)).from(nodes).innerJoin(machines, eq(machines.id, nodes.machineId)).where(and(eq(nodes.id, authenticated.nodeId), isNotNull(nodes.keyHash), isNull(machines.revokedAt)));
  if (!live) return failed();
  return new Promise(resolve => {
    const timer = setTimeout(() => { state(ctx).pending.delete(message.requestId); resolve(failed()); }, 20_000);
    timer.unref();
    state(ctx).pending.set(message.requestId, { node: keyOf(node), timer, done: resolve });
    if (!ctx.hub.send(node, message)) {
      clearTimeout(timer);
      state(ctx).pending.delete(message.requestId);
      resolve(failed());
    }
  });
}

export function phoneNodeMessage(ctx: Ctx, node: NodeIdentity, message: NodeMessage): boolean {
  if (message.type === 'hello') {
    const phones = state(ctx);
    const key = keyOf(node);
    if (message.phones) phones.capable.set(key, node);
    else phones.capable.delete(key);
    if (message.phones && message.phoneList) phones.lists.add(key);
    else phones.lists.delete(key);
    if (message.phones && message.phoneBaseline) phones.baseline.add(key);
    else phones.baseline.delete(key);
    return false;
  }
  if (message.type !== 'phone.reply') return false;
  const pending = state(ctx).pending.get(message.requestId);
  if (pending?.node === keyOf(node)) {
    state(ctx).pending.delete(message.requestId);
    clearTimeout(pending.timer);
    pending.done(message);
  }
  return true;
}

export function phoneNodeGone(ctx: Ctx, node: NodeIdentity): void {
  if (ctx.hub.isOnline(node)) return;
  state(ctx).capable.delete(keyOf(node));
  state(ctx).lists.delete(keyOf(node));
  state(ctx).baseline.delete(keyOf(node));
  for (const [id, pending] of state(ctx).pending) if (pending.node === keyOf(node)) {
    clearTimeout(pending.timer);
    state(ctx).pending.delete(id);
    pending.done({ type: 'phone.reply', requestId: id, status: 'failed' });
  }
}

export function closePhoneRequests(ctx: Ctx): void {
  state(ctx).capable.clear();
  state(ctx).lists.clear();
  state(ctx).baseline.clear();
  for (const [id, pending] of state(ctx).pending) { clearTimeout(pending.timer); pending.done({ type: 'phone.reply', requestId: id, status: 'failed' }); }
  state(ctx).pending.clear();
}
