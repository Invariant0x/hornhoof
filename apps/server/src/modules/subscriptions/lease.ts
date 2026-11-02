import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { nodes, planCredentials, subscriptions } from '../../db/schema.js';
import { nodeIdentity } from '../nodes/hub.js';
import { liveNode } from '../nodes/nodes.js';

/* Codex renews its sign-in as it runs and the old one stops working, so a Codex plan runs on one machine at a time: the
   one that holds the plan's lease. A holder away this long gives it to another machine of the plan that is online. */
export const LEASE_MOVE_MS = 10 * 60_000;

export type Recipient = { nodeId: string; publicKey: string };

/* The plan's machines that have a key, which its sign-in is sealed for. */
export async function keyedNodes(db: Db, plan: string): Promise<Recipient[]> {
  const keyed = await db
    .select({ nodeId: nodes.id, publicKey: nodes.publicKey })
    .from(nodes)
    .where(and(eq(nodes.subscriptionId, plan), liveNode, isNotNull(nodes.publicKey)));
  return keyed.slice(0, 20).map(k => ({ nodeId: k.nodeId, publicKey: k.publicKey! }));
}

/* Each Codex plan whose holder has been away LEASE_MOVE_MS goes to a machine of the plan that is online and has the
   plan's newest sign-in sealed to it. That machine is told it holds the plan, gets its envelope, and learns whom to
   seal a renewed sign-in for. The old holder gives up its copy at its next hello. */
export async function moveLeases(ctx: Ctx, now: Date): Promise<void> {
  const { db } = ctx;
  const held = await db
    .select({ id: subscriptions.id, holder: subscriptions.leaseNodeId, version: subscriptions.credVersion, companyId: subscriptions.companyId })
    .from(subscriptions)
    .where(and(eq(subscriptions.provider, 'codex'), eq(subscriptions.kind, 'personal'), isNull(subscriptions.removedAt), isNotNull(subscriptions.leaseNodeId)));
  for (const plan of held) {
    const holder = plan.holder!;
    const away = ctx.hub.awaySince(nodeIdentity(holder));
    if (away === null || now.getTime() - away < LEASE_MOVE_MS) continue;
    const envelopes = await db
      .select({ nodeId: planCredentials.nodeId, sealed: planCredentials.sealed })
      .from(planCredentials)
      .innerJoin(nodes, eq(nodes.id, planCredentials.nodeId))
      .where(and(eq(planCredentials.subscriptionId, plan.id), eq(planCredentials.kind, 'codex_auth'), eq(planCredentials.version, plan.version), ne(planCredentials.nodeId, holder), eq(nodes.subscriptionId, plan.id), liveNode));
    const next = envelopes.find(e => ctx.hub.isReady(nodeIdentity(e.nodeId)));
    if (!next) continue;
    const [moved] = await db
      .update(subscriptions)
      .set({ leaseNodeId: next.nodeId })
      .where(and(eq(subscriptions.id, plan.id), eq(subscriptions.leaseNodeId, holder)))
      .returning({ id: subscriptions.id });
    if (!moved) continue;
    const to = nodeIdentity(next.nodeId);
    ctx.hub.send(to, { type: 'cred.lease', hold: true });
    ctx.hub.send(to, { type: 'cred.put', kind: 'codex_auth', version: plan.version, sealed: next.sealed });
    const recipients = await keyedNodes(db, plan.id);
    if (recipients.length) ctx.hub.send(to, { type: 'cred.seal', kind: 'codex_auth', version: plan.version, recipients });
    ctx.bus.publish(plan.companyId, { type: 'org' });
  }
}
