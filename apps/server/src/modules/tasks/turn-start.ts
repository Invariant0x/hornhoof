import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { runsDepartment } from '../../auth/departments.js';
import { changedBy, requirePerson } from '../../auth/session.js';
import { companies, departments, turns, TURN_STARTS } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { mayChangeApprovalPolicy } from '../departments/approval-policy.js';
import { newerVersion } from './turn-tags.js';
import { loadQueue, publishLoaded } from './slots.js';
import { refuse, type Tx } from './state.js';

/* How a department's turns start, and when the batch of one is frozen.

   A department that starts its turns by itself (automatic) takes the queue into the turn that opens after a release, as it
   always did. One that starts them on a person's confirmation (manual) opens that turn waiting: nobody is given work from the
   queue until a person starts it, and the department stands. Urgent work, the hotfix lane, goes past both.

   The batch of a turn is frozen from the cut of its release branch, release-X.Y.Z of a version newer than the one the turn
   goes on from, to the tag that releases it: nothing joins it then, a new task waits for the next turn. The cut is the moment,
   whether or not every slot of the turn has landed. */

type Turn = typeof turns.$inferSelect;
type Repo = Parameters<NonNullable<Ctx['readBranches']>>[0];

const lockCompany = (tx: Tx, companyId: string) => tx.select(idOnly(companies)).from(companies).where(eq(companies.id, companyId)).for('no key update');

const RELEASE_BRANCH = /^release-(\d+\.\d+\.\d+)$/;

/* The release branch among a repository's branches that was cut for a version newer than the one the turn goes on from, the
   newest such branch; none when the turn has no base yet, since nothing can be told newer than it. */
export function cutBranchOf(heads: Record<string, string>, baseVersion: string | null): string | null {
  if (!baseVersion) return null;
  const tagOf = (branch: string): string | null => {
    const found = RELEASE_BRANCH.exec(branch);
    return found ? `v${found[1]}` : null;
  };
  const cut = Object.keys(heads).filter(name => {
    const tag = tagOf(name);
    return tag !== null && newerVersion(tag, baseVersion);
  });
  return cut.sort((a, b) => (newerVersion(tagOf(a)!, tagOf(b)!) ? -1 : 1))[0] ?? null;
}

/* Marks the open turn cut when its repository holds a release branch of a newer version: once, with the branch that cut it. */
export async function markCut(ctx: Pick<Ctx, 'db' | 'bus' | 'readBranches'>, turn: Turn, repo: Repo): Promise<void> {
  if (turn.cutAt || !ctx.readBranches) return;
  const read = await ctx.readBranches(repo, 30_000).catch(() => null);
  if (!read || 'problem' in read) return;
  const branch = cutBranchOf(read.heads, turn.baseVersion);
  if (!branch) return;
  const [marked] = await ctx.db.update(turns).set({ cutAt: new Date(), cutBranch: branch }).where(and(eq(turns.id, turn.id), eq(turns.status, 'open'), isNull(turns.cutAt))).returning(idOnly(turns));
  if (marked) ctx.bus.publish(turn.companyId, { type: 'org' });
}

/* Starts a turn that waits for a person: it takes the department's queue in, in order, as many as its slots hold, each to its
   named holder or the head, who is woken for it. */
export async function startTurn(ctx: Pick<Ctx, 'db' | 'bus'>, companyId: string, turnId: string, personId: string | null): Promise<Turn> {
  const started = await ctx.db.transaction(async tx => {
    await lockCompany(tx, companyId);
    const [turn] = await tx.select().from(turns).where(and(eq(turns.id, turnId), eq(turns.companyId, companyId))).for('no key update');
    if (!turn) throw refuse(404, 'turn_unknown', 'This turn does not exist.');
    if (turn.status !== 'open' || turn.confirmedAt !== null) throw refuse(409, 'turn_not_waiting', `Turn ${turn.number} is not waiting for a person to start it.`);
    const [row] = await tx.update(turns).set({ confirmedAt: new Date(), startedBy: personId }).where(eq(turns.id, turn.id)).returning();
    return { turn: row!, queue: await loadQueue(tx, companyId, turn.departmentId) };
  });
  publishLoaded(ctx, started.queue);
  ctx.bus.publish(companyId, { type: 'org' });
  return started.turn;
}

const Params = z.object({ id: z.uuid() });
const ModeBody = z.object({ mode: z.enum(TURN_STARTS) }).strict();

export function turnStartRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  /* A person who runs the department starts its waiting turn: not an agent, and not an assistant. */
  app.post('/api/turns/:id/start', async req => {
    const me = await requirePerson(req, db);
    const { id } = Params.parse(req.params);
    const [turn] = await db.select().from(turns).where(and(eq(turns.id, id), eq(turns.companyId, me.companyId)));
    if (!turn) throw refuse(404, 'turn_unknown', 'This turn does not exist.');
    if (me.via || me.assistant || !(await runsDepartment(db, me, turn.departmentId))) {
      throw new ApiError(403, 'forbidden', 'Only a person who runs this department, the CEO or the CEO delegate starts its next turn.', 'turn_start_not_allowed');
    }
    const started = await startTurn(ctx, me.companyId, id, changedBy(me).personId);
    req.log.info({ turn: started.number, departmentId: started.departmentId, personId: me.id }, 'a waiting turn was started');
    return { turn: { id: started.id, number: started.number, waiting: false } };
  });

  /* The way the department starts its turns, set by whoever sets its other rules. */
  app.put('/api/departments/:id/turn-start', async req => {
    const me = await requirePerson(req, db);
    const { id } = Params.parse(req.params);
    const { mode } = ModeBody.parse(req.body);
    const [dept] = await db.select().from(departments).where(and(eq(departments.id, id), eq(departments.companyId, me.companyId)));
    if (!dept || dept.parentId) throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
    if (!(await mayChangeApprovalPolicy(db, me, dept.id))) {
      throw new ApiError(403, 'forbidden', 'Only the people who run this department, the CEO or the CEO delegate change how it starts its turns.', 'turn_start_not_allowed');
    }
    await db.update(departments).set({ turnStart: mode }).where(eq(departments.id, dept.id));
    /* A turn that waits for a person in a department that now starts its turns by itself starts at once. */
    if (mode === 'automatic') {
      const [waiting] = await db.select(idOnly(turns)).from(turns).where(and(eq(turns.departmentId, dept.id), eq(turns.status, 'open'), isNull(turns.confirmedAt)));
      if (waiting) await startTurn(ctx, me.companyId, waiting.id, null);
    }
    ctx.bus.publish(me.companyId, { type: 'org' });
    req.log.info({ departmentId: dept.id, turnStart: mode, personId: me.id, viaAgent: me.via ?? null }, 'how a department starts its turns changed');
    return { departmentId: dept.id, turnStart: mode };
  });
}
