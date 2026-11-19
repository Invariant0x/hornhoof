import type { CredKind, ProviderId } from '@hornhoof/protocol';
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { nodes, planCredentials, subscriptions } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { nodeIdentity } from '../nodes/hub.js';
import { liveNode, settlePlans } from '../nodes/nodes.js';
import { keyedNodes } from './lease.js';
import { connectionEnded } from './connecting.js';

/* What a plan's sign-in is on its nodes. Antigravity has none Hornhoof can carry yet. */
export const CRED_KIND: Partial<Record<ProviderId, CredKind>> = { claude: 'claude_token', codex: 'codex_auth', kimi: 'kimi_key', glm: 'glm_key' };

export type Envelope = { nodeId: string; sealed: string };

/* Keeps a plan's sign-in sealed to each of its live nodes the envelopes name; others are dropped. A newer sign-in
   throws out the older ones, including those of nodes it leaves out, which then get it sealed by a node that holds it.
   One older than what the plan has changes nothing. A Codex plan's sign-in comes only from the machine that holds the
   plan: one that held it before has a copy Codex has renewed since. Returns the envelopes it kept. */
export async function storeEnvelopes(db: Db, sub: { id: string; companyId: string }, kind: CredKind, version: number, envelopes: Envelope[], from: string | null = null): Promise<Envelope[]> {
  return db.transaction(async tx => {
    const [plan] = await tx
      .select({ provider: subscriptions.provider, credVersion: subscriptions.credVersion, lease: subscriptions.leaseNodeId })
      .from(subscriptions)
      .where(and(eq(subscriptions.id, sub.id), eq(subscriptions.kind, 'personal'), isNull(subscriptions.removedAt)))
      .for('update');
    if (!plan || CRED_KIND[plan.provider] !== kind || version < plan.credVersion) return [];
    if (kind === 'codex_auth' && from && plan.lease && plan.lease !== from) return [];
    const ids = [...new Set(envelopes.map(e => e.nodeId))];
    const live = ids.length
      ? new Set((await tx.select(idOnly(nodes)).from(nodes).where(and(inArray(nodes.id, ids), eq(nodes.subscriptionId, sub.id), liveNode))).map(n => n.id))
      : new Set<string>();
    const kept = envelopes.filter(e => live.has(e.nodeId));
    if (version > plan.credVersion) {
      await tx.delete(planCredentials).where(and(eq(planCredentials.subscriptionId, sub.id), lt(planCredentials.version, version)));
      await tx.update(subscriptions).set({ credVersion: version }).where(eq(subscriptions.id, sub.id));
    }
    if (kept.length)
      await tx
        .insert(planCredentials)
        .values(kept.map(e => ({ companyId: sub.companyId, subscriptionId: sub.id, nodeId: e.nodeId, kind, version, sealed: e.sealed })))
        .onConflictDoUpdate({ target: [planCredentials.nodeId, planCredentials.kind], set: { version, sealed: sql`excluded.sealed`, subscriptionId: sub.id } });
    return kept;
  });
}

/* Hands each envelope to its node if it is online; an offline one gets it at its next hello. */
export function deliver(ctx: Ctx, kind: CredKind, version: number, envelopes: Envelope[], except: string | null = null): void {
  for (const e of envelopes) if (e.nodeId !== except) ctx.hub.send(nodeIdentity(e.nodeId), { type: 'cred.put', kind, version, sealed: e.sealed });
}

/* On a node's hello: its plan's newest sign-in sealed to it, or, when it has none yet, a word to a node of the plan that
   holds it to seal it for this one. A Codex plan's machine that does not hold the plan's lease is told to give up its
   copy; the holder keeps the one Codex renewed, and is told whom to seal it for, unless it lost it. */
export async function pushCredentials(ctx: Ctx, nodeId: string, loggedIn = false): Promise<void> {
  const { db } = ctx;
  const [node] = await db
    .select({ plan: subscriptions.id, provider: subscriptions.provider, credVersion: subscriptions.credVersion, publicKey: nodes.publicKey, lease: subscriptions.leaseNodeId })
    .from(nodes)
    .innerJoin(subscriptions, eq(subscriptions.id, nodes.subscriptionId))
    .where(and(eq(nodes.id, nodeId), liveNode, eq(subscriptions.kind, 'personal'), isNull(subscriptions.removedAt)));
  const kind = node && CRED_KIND[node.provider];
  if (!node || !kind) return;
  const me = nodeIdentity(nodeId);
  const held = node.credVersion > 0
    ? await db
        .select({ nodeId: planCredentials.nodeId, sealed: planCredentials.sealed })
        .from(planCredentials)
        .innerJoin(nodes, eq(nodes.id, planCredentials.nodeId))
        .where(and(eq(planCredentials.subscriptionId, node.plan), eq(planCredentials.kind, kind), eq(planCredentials.version, node.credVersion), liveNode))
    : [];
  const mine = held.find(h => h.nodeId === nodeId);
  const sealFor = (peer: string) => node.publicKey && ctx.hub.send(nodeIdentity(peer), { type: 'cred.seal', kind, version: node.credVersion, recipients: [{ nodeId, publicKey: node.publicKey }] });
  if (kind === 'codex_auth' && node.lease) {
    /* Another machine keeps an envelope to take over with; the holder seals one for it when it has none. */
    if (node.lease !== nodeId) {
      ctx.hub.send(me, { type: 'cred.lease', hold: false });
      if (held.length && !mine && ctx.hub.isOnline(nodeIdentity(node.lease))) sealFor(node.lease);
      return;
    }
    if (!loggedIn) {
      ctx.hub.send(me, { type: 'cred.lease', hold: true });
      if (mine) deliver(ctx, kind, node.credVersion, [mine]);
    }
    /* The holder learns whom to seal a renewed sign-in for. */
    const recipients = node.credVersion > 0 ? await keyedNodes(db, node.plan) : [];
    if ((loggedIn || mine) && recipients.length) ctx.hub.send(me, { type: 'cred.seal', kind, version: node.credVersion, recipients });
    return;
  }
  if (mine) {
    deliver(ctx, kind, node.credVersion, [mine]);
    /* A node of the plan that came while no holder was online still waits for its copy. This holder seals it one now,
       after it has opened its own: a node takes its messages in the order they come. */
    const holders = new Set(held.map(h => h.nodeId));
    const waiting = (await keyedNodes(db, node.plan)).filter(recipient => !holders.has(recipient.nodeId));
    if (waiting.length) ctx.hub.send(me, { type: 'cred.seal', kind, version: node.credVersion, recipients: waiting });
    return;
  }
  const peer = held.find(h => ctx.hub.isOnline(nodeIdentity(h.nodeId)));
  if (peer) sealFor(peer.nodeId);
}

/* The agentKey of a node's sign-in terminal: only the plan's owner opens it, and types into it. */
export const LOGIN_KEY = 'login';

/* A sign-in on a node of a plan ended. Its owner hears how; on success the node seals the new sign-in, under the plan's
   next number, for each of the plan's nodes that has a key, itself too, so a node that joins later can get it from any
   of them. A Codex plan then runs on that machine. A sign-in whose program ended early says its code and the last line
   it said, as the node masked it. */
export async function signedIn(ctx: Ctx, nodeId: string, ok: boolean, error: string | null, early: { code: number | null; line: string | null } = { code: null, line: null }): Promise<void> {
  const { db } = ctx;
  const [node] = await db
    .select({ plan: subscriptions.id, provider: subscriptions.provider, credVersion: subscriptions.credVersion, owner: subscriptions.ownerPersonId, companyId: subscriptions.companyId })
    .from(nodes)
    .innerJoin(subscriptions, eq(subscriptions.id, nodes.subscriptionId))
    .where(and(eq(nodes.id, nodeId), liveNode, eq(subscriptions.kind, 'personal'), isNull(subscriptions.removedAt)));
  if (!node) return;
  const kind = CRED_KIND[node.provider];
  if (ok && kind) {
    const recipients = await keyedNodes(db, node.plan);
    if (kind === 'codex_auth') {
      await db.update(subscriptions).set({ leaseNodeId: nodeId }).where(eq(subscriptions.id, node.plan));
      /* The plan runs on this machine now; the others give up their copies. */
      const others = await db.select(idOnly(nodes)).from(nodes).where(and(eq(nodes.subscriptionId, node.plan), liveNode));
      for (const other of others) if (other.id !== nodeId) ctx.hub.send(nodeIdentity(other.id), { type: 'cred.lease', hold: false });
    }
    if (recipients.length) ctx.hub.send(nodeIdentity(nodeId), { type: 'cred.seal', kind, version: node.credVersion + 1, recipients });
  }
  await settlePlans(db, [node.plan]);
  ctx.bus.publish(node.companyId, { type: 'subscription.signin', subscriptionId: node.plan, nodeId, ok, error, code: early.code, line: early.line, owner: node.owner });
  ctx.bus.publish(node.companyId, { type: 'org' });
  await connectionEnded(ctx, nodeId, ok, error, early);
}
