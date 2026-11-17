import type { Ctx } from '../../app.js';
import { seesAgentId, viewerOf } from '../../auth/agent-view.js';
import type { Person } from '../../auth/session.js';
import { orchestratorOf } from '../conversation/queue.js';
import { canViewComputer, type AccessView } from './access.js';

/* What this person sees of the machines' computer access: every machine that is theirs to open or close, and all of
   them for who sees the whole company. What the orchestrator asked a machine for goes only to its owner and to people
   who see him. A head acting for anyone sees none. */
export async function seenAccess(ctx: Ctx, me: Person): Promise<AccessView[]> {
  if (me.viaHead) return [];
  const orchestrator = await orchestratorOf(ctx, me.companyId);
  const seesHim = seesAgentId(await viewerOf(ctx.db, me), orchestrator?.id);
  return (await ctx.computer.views(me))
    .filter(view => view.canOpen || view.canClose || canViewComputer(me))
    .map(view => (view.canOpen || seesHim ? view : { ...view, asked: null }));
}
