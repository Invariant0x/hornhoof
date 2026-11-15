import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { Ctx } from '../../app.js';
import { agents, teams } from '../../db/schema.js';
import { hasRecordedAutoApproval } from './autonomous-release.js';
import { confirmMainApprovalInTx, humanMainApproval, verifyMainIntegrationApproval } from './echelons-accept.js';
import { changeRoute, type Route } from './echelons-store.js';
import { giver, move, refuse, type Moved, type Task, type Tx } from './engine.js';
import { branchHolds, headOf, integrationTarget, requireInTurn, requireSameTurn, type IntegrationTarget } from './turn-integration.js';

/* A turnkey team: each member does a task end to end alone on its task branch with local changed-area checks (never
   per-task run_tests), never enters the echelons and calls no other member of the department onto its work. The mark is
   data on the team, never read from a name or from a task's text. */
export async function turnkeyTeamOf(db: Db | Tx, companyId: string, agentId: string | null): Promise<{ id: string; name: string } | null> {
  if (!agentId) return null;
  const [team] = await db.select({ id: teams.id, name: teams.name }).from(agents)
    .innerJoin(teams, and(eq(teams.id, agents.teamId), eq(teams.companyId, companyId), eq(teams.turnkey, true)))
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.removedAt)));
  return team ?? null;
}

/* Whether work goes through the echelons, decided once as its task is made and never changed after, by the team of who
   holds it: a member of a turnkey team does it end to end alone, everybody else's goes through the route of its department.
   Every rule of which work skips them belongs here. */
export async function echelonsFor(db: Db | Tx, at: { companyId: string; holderId: string | null }): Promise<boolean> {
  return !(await turnkeyTeamOf(db, at.companyId, at.holderId));
}

/* The same asked while it is still decided what kind of task to make. */
export const wouldGoThroughEchelons = echelonsFor;

export const throughEchelons = (db: Db | Tx, task: Pick<Task, 'companyId' | 'executorAgentId' | 'assigneeAgentId'>) =>
  echelonsFor(db, { companyId: task.companyId, holderId: task.executorAgentId ?? task.assigneeAgentId });

export const turnkeyWork = (task: Pick<Task, 'number'>) =>
  refuse(409, 'task_invalid', `#${task.number} is turnkey work: its holder does it end to end alone and closes it with report, so no echelon takes it.`);

type Reader = Parameters<typeof move>[0] & Partial<Pick<Ctx, 'config' | 'readCommit' | 'readCompare'>>;

async function readOwnTaskBranch(ctx: Reader, target: IntegrationTarget, taskNumber: number): Promise<{ branch: string; commitSha: string } | null> {
  if (!ctx.readCommit) return null;
  let own: Awaited<ReturnType<Ctx['readCommit']>>;
  try {
    own = await ctx.readCommit(target.repo, { task: taskNumber }, 5_000);
  } catch {
    throw refuse(409, 'task_changed', `The branch of #${taskNumber} could not be read. Try again.`);
  }
  return 'problem' in own ? null : own;
}

async function turnkeyMainIntegration(ctx: Reader, task: Task, target: IntegrationTarget, own: { branch: string; commitSha: string }) {
  const mainHead = await headOf(ctx, target.repo, target.repo.branch);
  if (!mainHead || !(await branchHolds(ctx, target.repo, mainHead, own.commitSha))) {
    throw refuse(409, 'task_changed', `${target.repo.branch} does not hold ${own.commitSha}: approve and fast-forward ${target.repo.branch} to ${own.branch} first, then report done.`);
  }
  const { humanApproval, autoProof } = await verifyMainIntegrationApproval(ctx, task, own.commitSha);
  return {
    turn: null,
    autoProof,
    integration: { branch: target.repo.branch, commit: own.commitSha, from: own.branch, approval: humanApproval, observedAt: new Date().toISOString() },
  };
}

async function goesDirectlyToTopMain(
  ctx: Reader,
  task: Task,
  target: IntegrationTarget & { turn: NonNullable<IntegrationTarget['turn']> },
  commit: string,
): Promise<boolean> {
  const mainHead = await headOf(ctx, target.repo, target.repo.branch);
  if (!mainHead || !(await branchHolds(ctx, target.repo, mainHead, commit))) return false;
  if ((await humanMainApproval(ctx.db, task, commit)) || (await hasRecordedAutoApproval(ctx.db, task, commit))) return true;
  const existingTurnHead = await headOf(ctx, target.repo, target.branch);
  return Boolean(existingTurnHead && !(await branchHolds(ctx, target.repo, existingTurnHead, commit)));
}

/* Where turnkey work of a department with a repository integrates: into its open turn by fast-forward, or directly into main
   when the repository has no turn or the patch was approved for main outside release_turn. Work with no branch of its own
   changed no code and joins no release. */
async function turnkeyIntegration(ctx: Reader, task: Task) {
  const target = await integrationTarget(ctx, task);
  if (!target) return null;
  const own = await readOwnTaskBranch(ctx, target, task.number);
  if (!own) return null;
  if (!target.turn || (await goesDirectlyToTopMain(ctx, task, { ...target, turn: target.turn }, own.commitSha))) {
    return turnkeyMainIntegration(ctx, task, target, own);
  }
  await requireInTurn(ctx, { ...target, turn: target.turn }, own.commitSha, `fast-forward ${target.branch} to ${own.branch} first, so the release takes it, then report done.`);
  return { turn: target.turn, autoProof: null, integration: { branch: target.branch, commit: own.commitSha, from: own.branch, observedAt: new Date().toISOString() } };
}

async function confirmTurnkeyIntegrationInTx(
  tx: Tx,
  task: Task,
  joined: Awaited<ReturnType<typeof turnkeyIntegration>>,
): Promise<void> {
  if (!joined) return;
  if (joined.turn) await requireSameTurn(tx, task, joined.turn, joined.integration.commit);
  else await confirmMainApprovalInTx(tx, task, joined.integration.commit, joined.autoProof);
}

/* Its holder closes turnkey work alone: nobody checks it after, and whoever gave it hears that it is done. */
export async function turnkeyReport(ctx: Reader, task: Task, route: Route, agentId: string, summary: string): Promise<Moved> {
  if (task.assigneeAgentId !== agentId) throw refuse(403, 'task_not_yours', `#${task.number} is not yours to report.`);
  const text = summary.trim();
  if (!text) throw refuse(400, 'task_invalid', 'Say what was done and how it was checked.');
  const joined = await turnkeyIntegration(ctx, task);
  const wakes = giver(task, 'done', agentId, text);
  const turnPatch = joined?.turn ? { turnId: joined.turn.id } : {};
  const eventData = joined ? { done: true, integration: joined.integration } : { done: true };
  const row = await move(ctx, task, { status: 'done', closedAt: new Date(), assigneeAgentId: null, silent: 0, ...turnPatch }, {
    kind: 'report', actor: { agentId }, text, data: eventData, returned: true,
  }, async tx => {
    await confirmTurnkeyIntegrationInTx(tx, task, joined);
    await changeRoute(tx, route, { ...route.state, phase: 'done' });
  }, wakes);
  return { task: row, wakes };
}
