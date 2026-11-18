import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { agents, jobs, machines, nodes, testParts } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { clearNodeWords, pump } from '../conversation/queue.js';
import { afterLeave, cutReplication, holdsSecrets } from '../copies/scope.js';
import { ApiError } from '../../errors.js';
import { revokeMachineRows, visitorKeyOf } from '../network/join.js';
import { findThisMachine } from '../network/store.js';
import { nodeIdentity } from './hub.js';
import { loseParts } from '../testruns/runs.js';
import { failOpenJobs } from './messages.js';
import { liveNode, settlePlans } from './nodes.js';

/* The machine that leads does not leave the company: the server moves to another machine first. Asked where a person
   takes machines out, before anything is changed. */
export async function refuseLeader(db: Db, config: Config, machineIds: string[]): Promise<void> {
  const leader = machineIds.length > 0 ? await findThisMachine(db, config) : null;
  if (!leader || !machineIds.includes(leader.id)) return;
  const [row] = await db.select(only(machines, 'hostname')).from(machines).where(eq(machines.id, leader.id));
  throw new ApiError(409, 'conflict', `${row?.hostname || 'This machine'} runs the company server. Move the server to another machine first.`, 'leader', { host: row?.hostname ?? '' });
}

/* Stops these machines' nodes: open jobs fail, the parts of test runs they ran wait for another machine, sockets close,
   the agents on them pick another machine of their plan at their next turn, and a plan left with no machine waits for
   one again. A turn that waited for one of these machines goes out on another one now. A machine of the network is cut
   off for good: its certificates, tickets and commands end in the same transaction that marks its row. One that held the
   company's data, or still owes what it held, is cut from the server's changes first, and leaves holding nothing that
   opens the company's link: the link's key changes too. */
export async function disconnectMachines(ctx: Ctx, machineIds: string[]): Promise<void> {
  if (machineIds.length === 0) return;
  const copies = await ctx.db.select({ id: machines.id, networkId: machines.networkId }).from(machines).where(and(inArray(machines.id, machineIds), holdsSecrets, isNull(machines.revokedAt)));
  await cutReplication(ctx.replication, copies);
  const { ids, moved, cored } = await ctx.db.transaction(async tx => {
    const now = new Date();
    await tx.update(machines).set({ revokedAt: now }).where(inArray(machines.id, machineIds));
    if (copies.length > 0) {
      await tx.update(machines).set({ dataLeftAt: now, serverOrder: null, serverWhy: null }).where(inArray(machines.id, copies.map(copy => copy.id)));
      await ctx.links.startKey(tx);
    }
    const cored = await revokeMachineRows(tx, machineIds, now);
    const gone = await tx
      .update(nodes)
      .set({ keyHash: null, status: 'needs_login' })
      .where(and(inArray(nodes.machineId, machineIds), liveNode))
      .returning({ id: nodes.id, subscriptionId: nodes.subscriptionId });
    await settlePlans(tx, gone.map(n => n.subscriptionId));
    const moved = gone.length ? await tx.update(agents).set({ nodeId: null }).where(inArray(agents.nodeId, gone.map(n => n.id))).returning({ id: agents.id }) : [];
    return { ids: gone.map(n => n.id), moved: moved.map(a => a.id), cored };
  });
  /* A machine that had the core holds the link's visitor key. The relay ends it when it gives a new one, so that is
     asked for now and not waited for; a relay that does not answer is asked again with the next view a keeper reads. */
  if (copies.length > 0) void afterLeave(ctx);
  else if (cored) void visitorKeyOf(ctx, { force: true });
  await finishDisconnect(ctx, machineIds, ids);
  for (const id of moved) await pump(ctx, id);
}

async function finishDisconnect(ctx: Ctx, machineIds: string[], ids: string[]): Promise<void> {
  /* The nodes lose their keys first, so the turns that end here send no next turn to the leaving ones. */
  for (const id of ids) { clearNodeWords(ctx, nodeIdentity(id)); ctx.hub.close(id, 4001); }
  if (ids.length) await failOpenJobs(ctx, inArray(jobs.nodeId, ids), 'machine_disconnected');
  await loseParts(ctx, inArray(testParts.machineId, machineIds), 'machine_disconnected');
}

/* Finish work left after the machine and its nodes had already lost access. */
export async function finishDisconnectedMachines(ctx: Ctx, machineIds: string[]): Promise<void> {
  const known = await ctx.db.select(only(nodes, 'id')).from(nodes).where(inArray(nodes.machineId, machineIds));
  await finishDisconnect(ctx, machineIds, known.map(node => node.id));
}
