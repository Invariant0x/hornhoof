import type { Ctx } from '../../app.js';
import type { Person } from '../../auth/session.js';
import { canViewComputer, type AccessView } from './access.js';

export async function seenAccess(ctx: Ctx, me: Person): Promise<AccessView[]> {
  if (me.viaHead) return [];
  return (await ctx.computer.views(me)).filter(view => view.canOpen || canViewComputer(me));
}
