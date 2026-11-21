import { and, eq, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { wholeCompany } from '../../auth/assistant.js';
import { personColumns, requirePerson, viaOrchestrator, type Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import {
  agents,
  companies,
  jobs,
  pendingWakes,
  people,
  programOperatorCases,
  tasks,
  taskWaits,
  testParts,
  testRuns,
  type CompanyPause,
} from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { pumpWaiting } from '../conversation/queue.js';
import { answeredWords, wordsForTurn } from '../conversation/turn-words.js';
import { workingCount } from '../events/store.js';
import { CLOSED } from '../tasks/state.js';
import { wakeLeftBehind } from '../tasks/wake.js';
import { pumpTests } from '../testruns/runs.js';
import { companyPause } from './pause-state.js';

export { companyPause, isCompanyPaused, openCaseForRunningTurn, pausedCompanyIds } from './pause-state.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type CompanyPauseView = { paused: CompanyPause | null; finishingTurns: number };

const shiftIso = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();
const shiftDate = (d: Date | null, ms: number): Date | null => (d ? new Date(d.getTime() + ms) : null);

export async function pauseView(db: Db, companyId: string): Promise<CompanyPauseView> {
  const [paused, finishingTurns] = await Promise.all([
    companyPause(db, companyId),
    workingCount(db, companyId, undefined, true),
  ]);
  return { paused, finishingTurns };
}

function effectiveWaitPauseMs(since: string, pausedAt: Date, now: Date, pauseMs: number): number {
  const sinceMs = Date.parse(since);
  return Number.isFinite(sinceMs) && sinceMs > pausedAt.getTime() ? Math.max(0, now.getTime() - sinceMs) : pauseMs;
}

async function shiftExternalWaits(tx: Tx, companyId: string, pauseMs: number, pausedAt: Date, now: Date): Promise<void> {
  const openTasks = await tx
    .select({ id: tasks.id, externalWait: tasks.externalWait })
    .from(tasks)
    .where(and(eq(tasks.companyId, companyId), isNotNull(tasks.externalWait), notInArray(tasks.status, [...CLOSED])));
  for (const row of openTasks) {
    if (!row.externalWait || !Number.isFinite(Date.parse(row.externalWait.until))) continue;
    const ms = effectiveWaitPauseMs(row.externalWait.since, pausedAt, now, pauseMs);
    if (ms <= 0) continue;
    await tx.update(tasks).set({ externalWait: { ...row.externalWait, until: shiftIso(row.externalWait.until, ms) } }).where(eq(tasks.id, row.id));
  }
}

function shiftWaitPlan(plan: typeof taskWaits.$inferSelect['plan'], pauseMs: number) {
  if (!plan) return null;
  return {
    ...plan,
    ownerDueAt: shiftIso(plan.ownerDueAt, pauseMs),
    headDueAt: shiftIso(plan.headDueAt, pauseMs),
    decisionDueAt: shiftIso(plan.decisionDueAt, pauseMs),
    finalReview: { ...plan.finalReview, anchorAt: shiftIso(plan.finalReview.anchorAt, pauseMs) },
  };
}

async function shiftTaskWaits(tx: Tx, companyId: string, pauseMs: number): Promise<void> {
  const activeWaits = await tx
    .select()
    .from(taskWaits)
    .where(and(eq(taskWaits.companyId, companyId), eq(taskWaits.state, 'active')));
  for (const wait of activeWaits) {
    await tx
      .update(taskWaits)
      .set({
        ownerDueAt: shiftDate(wait.ownerDueAt, pauseMs),
        headDueAt: shiftDate(wait.headDueAt, pauseMs),
        decisionDueAt: shiftDate(wait.decisionDueAt, pauseMs),
        nextActionAt: shiftDate(wait.nextActionAt, pauseMs),
        nextReviewAt: shiftDate(wait.nextReviewAt, pauseMs),
        plan: shiftWaitPlan(wait.plan, pauseMs),
      })
      .where(eq(taskWaits.id, wait.id));
  }
}

/* Shift every pending deadline in the company later by the length of the pause, so nothing due during the pause fires at once. */
async function shiftPendingDeadlines(tx: Tx, companyId: string, pauseMs: number, pausedAt: Date, now: Date): Promise<void> {
  await shiftExternalWaits(tx, companyId, pauseMs, pausedAt, now);
  await shiftTaskWaits(tx, companyId, pauseMs);

  const delta = sql`make_interval(secs => ${pauseMs / 1000})`;
  const resumeAt = sql`${now.toISOString()}::timestamptz`;

  await tx
    .update(jobs)
    .set({ notBefore: sql`${jobs.notBefore} + ${delta}` })
    .where(and(eq(jobs.companyId, companyId), eq(jobs.status, 'queued'), isNotNull(jobs.notBefore)));

  await tx
    .update(agents)
    .set({
      timerAt: sql`case when ${agents.timerAt} is not null then least(${resumeAt}, ${agents.timerAt} + ${delta}) else null end`,
      timerNudgedAt: sql`case when ${agents.timerNudgedAt} is not null then ${agents.timerNudgedAt} + ${delta} else null end`,
    })
    .where(and(eq(agents.companyId, companyId), isNull(agents.removedAt), isNotNull(agents.timerMinutes)));

  await tx
    .update(testParts)
    .set({ queuedAt: sql`least(${resumeAt}, ${testParts.queuedAt} + ${delta})` })
    .where(and(eq(testParts.companyId, companyId), eq(testParts.status, 'queued')));

  await tx
    .update(testRuns)
    .set({ createdAt: sql`least(${resumeAt}, ${testRuns.createdAt} + ${delta})` })
    .where(and(eq(testRuns.companyId, companyId), eq(testRuns.status, 'running'), isNull(testRuns.environmentSnapshot), sql`${testRuns.environmentRequest} is not null`));

  await tx
    .update(programOperatorCases)
    .set({ deadlineAt: sql`${programOperatorCases.deadlineAt} + ${delta}` })
    .where(and(eq(programOperatorCases.companyId, companyId), eq(programOperatorCases.status, 'open')));

  await tx
    .update(pendingWakes)
    .set({ createdAt: sql`least(${resumeAt}, ${pendingWakes.createdAt} + ${delta})` })
    .where(eq(pendingWakes.companyId, companyId));
}

export async function pauseCompany(ctx: Ctx, companyId: string, actor: { id: string; name: string }, now = new Date(ctx.clock())): Promise<CompanyPauseView> {
  const { paused, changed } = await ctx.db.transaction(async tx => {
    const [row] = await tx.select({ id: companies.id, paused: companies.paused }).from(companies).where(eq(companies.id, companyId)).for('update');
    if (!row) throw new ApiError(404, 'not_found', 'Company not found.');
    if (row.paused) return { paused: row.paused, changed: false };
    const record: CompanyPause = { by: actor.id, byName: actor.name, at: now.toISOString() };
    await tx.update(companies).set({ paused: record }).where(eq(companies.id, companyId));
    return { paused: record, changed: true };
  });
  if (changed) ctx.bus.publish(companyId, { type: 'org' });
  return { paused, finishingTurns: await workingCount(ctx.db, companyId, undefined, true) };
}

export async function resumeCompany(ctx: Ctx, companyId: string, now = new Date(ctx.clock())): Promise<CompanyPauseView> {
  const changed = await ctx.db.transaction(async tx => {
    const [row] = await tx.select({ id: companies.id, paused: companies.paused }).from(companies).where(eq(companies.id, companyId)).for('update');
    if (!row?.paused) return false;
    const pausedAt = new Date(Date.parse(row.paused.at));
    const pauseMs = Math.max(0, now.getTime() - pausedAt.getTime());
    await tx.update(companies).set({ paused: null, resumedAt: now }).where(eq(companies.id, companyId));
    if (pauseMs > 0) await shiftPendingDeadlines(tx, companyId, pauseMs, pausedAt, now);
    return true;
  });
  if (changed) {
    ctx.bus.publish(companyId, { type: 'org' });
    await wakeLeftBehind(ctx, new Date(now.getTime() + 60_000));
    await pumpWaiting(ctx);
    await pumpTests(ctx);
    ctx.assistants.collect(companyId);
  }
  return pauseView(ctx.db, companyId);
}

/* The orchestrator may lift a pause only inside a turn carrying the words of an active whole-company person. */
async function canOrchestratorResume(ctx: Ctx, me: Person): Promise<boolean> {
  if (!viaOrchestrator(me) || !me.via || !me.decision?.jobId) return false;
  const [job] = await ctx.db
    .select({ id: jobs.id, createdBy: jobs.createdBy, decisionInputPending: jobs.decisionInputPending })
    .from(jobs)
    .where(and(
      eq(jobs.id, me.decision.jobId),
      eq(jobs.agentId, me.via),
      eq(jobs.companyId, me.companyId),
      eq(jobs.kind, 'conversation'),
      eq(jobs.status, 'running'),
      sql`${jobs.error} is distinct from 'cancelled'`,
    ));
  if (!job || job.decisionInputPending) return false;
  const said = await wordsForTurn(ctx, me.via, job.id);
  const principal = answeredWords(job.createdBy, said);
  if (!principal) return false;
  const [speaker] = await ctx.db
    .select(personColumns)
    .from(people)
    .where(and(eq(people.id, principal.personId), eq(people.companyId, me.companyId), eq(people.status, 'active')));
  return Boolean(speaker && wholeCompany(speaker));
}

export function companyPauseRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/company/pause', async req => {
    const me = await requirePerson(req, ctx.db);
    return pauseView(ctx.db, me.companyId);
  });

  app.post('/api/company/pause', async req => {
    const me = await requirePerson(req, ctx.db);
    if (me.via) throw new ApiError(403, 'forbidden', 'The orchestrator cannot pause the company on its own.', 'company_pause_forbidden');
    if (!wholeCompany(me)) throw new ApiError(403, 'forbidden', 'Only a person who sees the whole company can pause it.', 'company_pause_forbidden');
    return pauseCompany(ctx, me.companyId, { id: me.id, name: me.name });
  });

  app.post('/api/company/resume', async req => {
    const me = await requirePerson(req, ctx.db);
    if (me.via) {
      if (!(await canOrchestratorResume(ctx, me))) {
        throw new ApiError(403, 'forbidden', 'The orchestrator can resume the company only in a turn carrying the words of a person who sees the whole company.', 'company_resume_forbidden');
      }
    } else if (!wholeCompany(me)) {
      throw new ApiError(403, 'forbidden', 'Only a person who sees the whole company can resume it.', 'company_resume_forbidden');
    }
    return resumeCompany(ctx, me.companyId);
  });
}
