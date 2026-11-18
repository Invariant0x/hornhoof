import { and, eq, isNull, ne } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { agentState } from '../conversation/state.js';
import { agentParty } from '../events/parties.js';
import { cancelJob } from '../tasks/wake.js';
import { logTurnFact } from '../tasks/turn-log.js';
import { accessRefused, authorizeAccess, masked } from './access.js';
import type { OperatorCaller } from './authorization.js';
import { pictureSecrets } from './pictures.js';

type StopInput = { employee: string; reason: string };
type StopResult = { result: 'stopped'; employee: string; name: string; job: string };

/* Operations end the turn any employee of their company runs, the orchestrator's and every head's too, as Esc in its window
   does, in a turn of their own that no person need answer. The employee stays as it is, and its next turn starts from its
   queue. Who stopped whom, in which turn and why, with secrets masked, goes first into the log of the turn it ended. */
export async function stopEmployeeTurn(ctx: Ctx, caller: OperatorCaller, input: StopInput): Promise<StopResult> {
  const me = await authorizeAccess(ctx, caller);
  /* A person's own assistant is no employee of the company: its owner alone stops it. */
  const [target] = await ctx.db.select().from(agents).where(and(eq(agents.id, input.employee), eq(agents.companyId, me.companyId), ne(agents.kind, 'assistant'), isNull(agents.removedAt)));
  if (!target || target.id === me.id) throw accessRefused();
  const { runningJobId } = await agentState(ctx, target.id);
  const [job] = runningJobId ? await ctx.db.select().from(jobs).where(and(eq(jobs.id, runningJobId), eq(jobs.companyId, me.companyId))) : [];
  if (!job) throw new ApiError(409, 'conflict', 'Nothing is running.', 'nothing_running');
  const reason = masked(input.reason, await pictureSecrets(ctx, me.companyId));
  const actor = await agentParty(ctx, me.companyId, me.id);
  const operatorStop = { actor: { id: me.id, name: me.name, role: me.roleKey }, employee: { id: target.id, name: target.name }, job: job.id, operatorJobId: caller.id, reason, at: new Date().toISOString() };
  await logTurnFact(ctx, job, `${me.name} stopped the turn of ${target.name}. Reason: ${reason}`, { actor, from: 'agent', by: me.id, name: me.name, operatorStop });
  await cancelJob(ctx, job.id);
  return { result: 'stopped', employee: target.id, name: target.name, job: job.id };
}
