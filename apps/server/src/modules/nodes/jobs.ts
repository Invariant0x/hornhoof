import { and, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { jobs, subscriptions } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { ownMachine, type NodeIdentity } from './hub.js';
/* A node may only touch the jobs sent to it; a machine's built-in node those of API keys that went out to it. A job
   from before machines' built-in nodes were told apart names none, and is the one of this server's own. */
export function jobsOf(id: NodeIdentity, ctx: Ctx): SQL {
  if (id.kind === 'node') return eq(jobs.nodeId, id.nodeId);
  const ofKeys = inArray(jobs.subscriptionId, ctx.db.select(idOnly(subscriptions)).from(subscriptions).where(eq(subscriptions.kind, 'api_key')));
  const here = id.machine === ownMachine(ctx.config) ? or(eq(jobs.builtinMachine, id.machine), isNull(jobs.builtinMachine)) : eq(jobs.builtinMachine, id.machine);
  return and(ofKeys, here)!;
}
