import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, subscriptions } from '../../db/schema.js';
import { agentState } from '../conversation/queue.js';
import type { Task } from './state.js';

/* What decides who else may take a piece of work. */
export type Work = Pick<Task, 'productId'>;
type Member = { id: string; departmentId: string; roleKey: string };
type State = Awaited<ReturnType<typeof agentState>>;

/* Its turn would go out now: signed in, on a machine that is on, and with plan left for tasks. */
export const goesOutNow = (state: State): boolean => state.ready && !state.limitUntil && !state.budgetUntil && !state.machineDrain;

export const mayTake = (work: Work, peer: { id: string; productId: string | null }): boolean => (!peer.productId || peer.productId === work.productId);

/* Nothing runs or waits for it, and its turn would go out now. */
export async function isFree(ctx: Ctx, agentId: string): Promise<boolean> {
  const state = await agentState(ctx, agentId);
  return goesOutNow(state) && !state.busy && state.queued === 0;
}

/* The others of a member's role in its department who are on and have a plan. Sub-unit employees work outside the pipeline. */
export function peersOfRole(ctx: Pick<Ctx, 'db'>, member: Member, otherThanProvider?: (typeof subscriptions.$inferSelect)['provider']) {
  return ctx.db
    .select({ id: agents.id, name: agents.name, productId: agents.productId, provider: subscriptions.provider })
    .from(agents)
    .innerJoin(subscriptions, and(eq(subscriptions.id, agents.subscriptionId), isNull(subscriptions.removedAt)))
    .where(
      and(
        eq(agents.departmentId, member.departmentId),
        eq(agents.roleKey, member.roleKey),
        eq(agents.kind, 'worker'),
        isNull(agents.removedAt),
        isNull(agents.switchedOffAt),
        isNull(agents.teamId),
        ne(agents.id, member.id),
        otherThanProvider ? ne(subscriptions.provider, otherThanProvider) : undefined,
      ),
    )
    .orderBy(asc(agents.createdAt));
}

/* Those of a member's role who could take this work at once. */
export async function freePeers(ctx: Ctx, member: Member, work: Work): Promise<{ id: string; name: string }[]> {
  const free: { id: string; name: string }[] = [];
  for (const peer of await peersOfRole(ctx, member)) if (mayTake(work, peer) && (await isFree(ctx, peer.id))) free.push({ id: peer.id, name: peer.name });
  return free;
}
