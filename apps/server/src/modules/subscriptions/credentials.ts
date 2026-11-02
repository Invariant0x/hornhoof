import type { CredKind, ProviderId } from '@hornhoof/protocol';
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { nodes, planCredentials, subscriptions } from '../../db/schema.js';
import { nodeIdentity } from '../nodes/hub.js';
import { liveNode } from '../nodes/nodes.js';

/* What a plan's sign-in is on its nodes. Antigravity has none Hornhoof can carry yet. */
export const CRED_KIND: Partial<Record<ProviderId, CredKind>> = { claude: 'claude_token', codex: 'codex_auth', kimi: 'kimi_key', glm: 'glm_key' };

export type Envelope = { nodeId: string; sealed: string };

/* Keeps a plan's sign-in sealed to each of its live nodes the envelopes name; others are dropped. A newer sign-in
   throws out the older ones, including those of nodes it leaves out, which then get it sealed by a node that holds it.
   One older than what the plan has changes nothing. Returns the envelopes it kept. */
export async function storeEnvelopes(db: Db, sub: { id: string; companyId: string }, kind: CredKind, version: number, envelopes: Envelope[]): Promise<Envelope[]> {
  return db.transaction(async tx => {
    const [plan] = await tx
      .select({ provider: subscriptions.provider, credVersion: subscriptions.credVersion })
      .from(subscriptions)
      .where(and(eq(subscriptions.id, sub.id), eq(subscriptions.kind, 'personal'), isNull(subscriptions.removedAt)))
      .for('update');
    if (!plan || CRED_KIND[plan.provider] !== kind || version < plan.credVersion) return [];
    const ids = [...new Set(envelopes.map(e => e.nodeId))];
    const live = ids.length
      ? new Set((await tx.select({ id: nodes.id }).from(nodes).where(and(inArray(nodes.id, ids), eq(nodes.subscriptionId, sub.id), liveNode))).map(n => n.id))
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
   holds it to seal it for this one. */
export async function pushCredentials(ctx: Ctx, nodeId: string): Promise<void> {
  const { db } = ctx;
  const [node] = await db
    .select({ plan: subscriptions.id, provider: subscriptions.provider, credVersion: subscriptions.credVersion, publicKey: nodes.publicKey })
    .from(nodes)
    .innerJoin(subscriptions, eq(subscriptions.id, nodes.subscriptionId))
    .where(and(eq(nodes.id, nodeId), liveNode, eq(subscriptions.kind, 'personal'), isNull(subscriptions.removedAt)));
  const kind = node && CRED_KIND[node.provider];
  if (!node || !kind || node.credVersion === 0) return;
  const held = await db
    .select({ nodeId: planCredentials.nodeId, sealed: planCredentials.sealed })
    .from(planCredentials)
    .innerJoin(nodes, eq(nodes.id, planCredentials.nodeId))
    .where(and(eq(planCredentials.subscriptionId, node.plan), eq(planCredentials.kind, kind), eq(planCredentials.version, node.credVersion), liveNode));
  const mine = held.find(h => h.nodeId === nodeId);
  if (mine) return void deliver(ctx, kind, node.credVersion, [mine]);
  if (!node.publicKey) return;
  const peer = held.find(h => ctx.hub.isOnline(nodeIdentity(h.nodeId)));
  if (peer) ctx.hub.send(nodeIdentity(peer.nodeId), { type: 'cred.seal', kind, version: node.credVersion, recipients: [{ nodeId, publicKey: node.publicKey }] });
}
