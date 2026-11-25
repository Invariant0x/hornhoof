import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { companies, departments, tasks, turns } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { loggable } from '../../errors.js';
import { repoAt } from '../departments/repository.js';
import { withRepoCompany } from '../testruns/github-limit.js';
import { CLOSED, type Tx } from './engine.js';
import { keepSnapshot } from './pipeline-report.js';
import { releasesWork } from './turn-department.js';
import { branchHolds, BranchProofUnavailable, type BranchProofReader } from './turn-integration.js';

/* A turn ends on the tag of its release (releases.ts). One that holds nothing for a release could never end that way: no
   result was accepted into it, every task of its department is done or cancelled, and its branch holds nothing main lacks,
   or it has none, as a department that keeps no repository has. Hornhoof closes such a turn by itself, with no version, and
   its record says who closed it and why. A turn that holds an accepted result closes only by its release: main may hold that
   result already, moved by hand, and only a release recorded before main moved releases it. Nothing opens a turn in its
   place: the next result accepted into the department opens one, and a department without a repository never gets one. */

type Reader = BranchProofReader & Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'config' | 'readBranches' | 'log' | 'files'>>;
type Turn = typeof turns.$inferSelect;
type Department = typeof departments.$inferSelect;

const lockCompany = (tx: Tx, companyId: string) => tx.select(idOnly(companies)).from(companies).where(eq(companies.id, companyId)).for('no key update');

const ENDED = 'Hornhoof closed it by itself: every task of its department was done or cancelled, no result was accepted into it, and';

/* Every minute: each open turn that holds nothing for a release closes. One turn's trouble keeps no other from it. */
export async function closeIdleTurns(ctx: Reader): Promise<void> {
  const open = await ctx.db.select({ turn: turns, department: departments }).from(turns).innerJoin(departments, eq(departments.id, turns.departmentId)).where(eq(turns.status, 'open'));
  for (const { turn, department } of open) {
    try {
      await closeIfIdle(ctx, turn, department);
    } catch (err) {
      if (err instanceof BranchProofUnavailable) continue;
      ctx.log?.error({ error: loggable(err), companyId: turn.companyId, turn: turn.number }, 'Closing a turn that holds nothing for a release failed.');
    }
  }
}

async function closeIfIdle(ctx: Reader, turn: Turn, department: Department): Promise<void> {
  const places = await placesOf(ctx.db, department);
  if (await holdsWork(ctx.db, turn, places)) return;
  const because = await nothingToMerge(ctx, turn, department);
  if (!because) return;
  /* Under the company row, as a result joins a turn: one accepted meanwhile keeps it open. */
  const closed = await ctx.db.transaction(async tx => {
    await lockCompany(tx, turn.companyId);
    const [open] = await tx.select(idOnly(turns)).from(turns).where(and(eq(turns.id, turn.id), eq(turns.status, 'open')));
    if (!open || (await holdsWork(tx, turn, places))) return null;
    const [done] = await tx.update(turns).set({ status: 'closed', closedAt: new Date(), closedBecause: because }).where(eq(turns.id, turn.id)).returning();
    await keepSnapshot(tx, done!, ctx.log, ctx.files);
    return done!;
  });
  if (!closed) return;
  ctx.bus.publish(turn.companyId, { type: 'org' });
  ctx.log?.info({ companyId: turn.companyId, turn: turn.number }, `Turn ${turn.number} closed with no version. ${because}`);
}

/* The department and every product and part inside it, however deep: their tasks are its work. */
async function placesOf(db: Reader['db'], department: Department): Promise<string[]> {
  const places = [department.id];
  for (let i = 0; i < places.length; i++) {
    const inside = await db.select(idOnly(departments)).from(departments).where(and(eq(departments.companyId, department.companyId), eq(departments.parentId, places[i]!)));
    places.push(...inside.map(d => d.id).filter(id => !places.includes(id)));
  }
  return places;
}

/* A result accepted into the turn, which only its release closes, or work of its department still going on outside every turn,
   which joins it as it is accepted. */
async function holdsWork(db: Reader['db'] | Tx, turn: Turn, places: string[]): Promise<boolean> {
  const [accepted] = await db.select(idOnly(tasks)).from(tasks).where(and(eq(tasks.companyId, turn.companyId), eq(tasks.turnId, turn.id))).limit(1);
  if (accepted) return true;
  const [going] = await db.select(idOnly(tasks)).from(tasks).where(and(eq(tasks.companyId, turn.companyId), isNull(tasks.turnId), inArray(tasks.departmentId, places), notInArray(tasks.status, [...CLOSED]))).limit(1);
  return !!going;
}

/* Why the turn has nothing left to merge, as the repository says it now: its department keeps none, its branch is not there, or
   main holds the branch's head. None while the repository cannot say. */
async function nothingToMerge(ctx: Reader, turn: Turn, department: Department): Promise<string | null> {
  if (!releasesWork(department)) return `${ENDED} its department keeps no repository, so it had nothing to release.`;
  if (!ctx.config || !ctx.readBranches) return null;
  const found = await repoAt({ db: ctx.db, config: ctx.config }, [department.id]);
  if (!found) return null;
  const repo = withRepoCompany(found.repo, department.companyId);
  const read = await ctx.readBranches(repo, 5_000).catch(() => null);
  if (!read || 'problem' in read) return null;
  const branch = `turn-${turn.number}`, head = read.heads[branch], main = read.heads[repo.branch];
  if (!head) return `${ENDED} ${branch} is not in the repository, so it had nothing to release.`;
  if (!main || !(await branchHolds(ctx, repo, main, head))) return null;
  return `${ENDED} ${repo.branch} holds everything ${branch} holds, so it had nothing to release.`;
}
