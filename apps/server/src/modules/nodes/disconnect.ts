import { and, inArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, machines, nodes, testParts } from '../../db/schema.js';
import { pump } from '../conversation/queue.js';
import { loseParts } from '../testruns/runs.js';
import { failOpenJobs } from './messages.js';
import { liveNode, settlePlans } from './nodes.js';

/* Stops these machines' nodes: open jobs fail, the parts of test runs they ran wait for another machine, sockets close,
   the agents on them pick another machine of their plan at their next turn, and a plan left with no machine waits for
   one again. A turn that waited for one of these machines goes out on another one now. */
export async function disconnectMachines(ctx: Ctx, machineIds: string[]): Promise<void> {
  if (machineIds.length === 0) return;
  const { ids, moved } = await ctx.db.transaction(async tx => {
    await tx.update(machines).set({ revokedAt: new Date() }).where(inArray(machines.id, machineIds));
    const gone = await tx
      .update(nodes)
      .set({ keyHash: null })
      .where(and(inArray(nodes.machineId, machineIds), liveNode))
      .returning({ id: nodes.id, subscriptionId: nodes.subscriptionId });
    await settlePlans(tx, gone.map(n => n.subscriptionId));
    const moved = gone.length ? await tx.update(agents).set({ nodeId: null }).where(inArray(agents.nodeId, gone.map(n => n.id))).returning({ id: agents.id }) : [];
    return { ids: gone.map(n => n.id), moved: moved.map(a => a.id) };
  });
  /* The nodes lose their keys first, so the turns that end here send no next turn to the leaving ones. */
  for (const id of ids) ctx.hub.close(id, 4001);
  if (ids.length) await failOpenJobs(ctx, inArray(jobs.nodeId, ids), 'machine_disconnected');
  await loseParts(ctx, inArray(testParts.machineId, machineIds), 'machine_disconnected');
  for (const id of moved) await pump(ctx, id);
}
