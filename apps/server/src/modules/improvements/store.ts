import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { agents, departments, FEEDBACK_KINDS, improvements, IMPROVEMENT_SCOPES, IMPROVEMENT_STATUSES, people, taskEvents, tasks, type ImprovementParts } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { deptName } from '../departments/templates.js';
import { fingerprintOfReport } from '../feedback/inbox.js';
import { fateOf } from '../feedback/released.js';
import type { Tx } from '../tasks/engine.js';

export type ImprovementStatus = (typeof IMPROVEMENT_STATUSES)[number];
export type ImprovementScope = (typeof IMPROVEMENT_SCOPES)[number];
/* How many closed ones are listed; every one that waits or is in work is. */
const CLOSED_LISTED = 200;
const ACTIVE: readonly ImprovementStatus[] = ['open', 'taken'];

/* A case as one text, in the order a person reads it: what the orchestrator gets when it is taken into work, and what a
   Hornhoof that goes back to a build before the parts shows. */
export function caseText(p: ImprovementParts): string {
  const list = (lines: string[]) => lines.map(line => `- ${line}`).join('\n');
  return [
    p.problem && `What is wrong: ${p.problem}`,
    p.facts.length && `Facts:\n${list(p.facts.map(f => `${f.text} (${f.source})`))}`,
    p.guesses.length && `Guesses, not checked:\n${list(p.guesses)}`,
    p.why && `Why it matters: ${p.why}`,
    `Change: ${p.change}`,
    p.gain && `What it gives: ${p.gain}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

type Row = typeof improvements.$inferSelect;
type Fate = Pick<Ctx, 'config' | 'released'>;

/* What became of one sent to Hornhoof's developers: when it went, its number in their inbox, its issue as their inbox or a
   release named it, the version that fixed it once this one is it or newer, and how many more rounds found it since they
   last heard of it. */
function sentOf(ctx: Fate, i: Row) {
  if (i.status !== 'sent' || !i.sentAt) return null;
  const fate = fateOf(ctx.released, ctx.config.version, i.reportNumber);
  const issue = i.issueNumber !== null && i.issueUrl ? { number: i.issueNumber, url: i.issueUrl } : fate.issue;
  return { at: i.sentAt.toISOString(), number: i.reportNumber, issue, fixedIn: fate.fixedIn, repeats: Math.max(0, i.seen - (i.reportedSeen ?? i.seen)) };
}

/* Improvements as people and the orchestrator read them, the latest changed first, each with who found it and where. */
export async function listImprovements(ctx: Pick<Ctx, 'db'> & Fate, companyId: string, statuses: readonly ImprovementStatus[] = IMPROVEMENT_STATUSES) {
  const active = statuses.filter(s => ACTIVE.includes(s));
  const closed = statuses.filter(s => !ACTIVE.includes(s));
  const ofCompany = eq(improvements.companyId, companyId);
  const latestClosed = ctx.db.select(idOnly(improvements)).from(improvements).where(and(ofCompany, inArray(improvements.status, closed))).orderBy(desc(improvements.updatedAt)).limit(CLOSED_LISTED);
  /* One read, so one that changes meanwhile is listed once. */
  const rows = await ctx.db
    .select({ i: improvements, agent: { id: agents.id, name: agents.name }, department: departments, decidedBy: people.name })
    .from(improvements)
    .innerJoin(agents, eq(agents.id, improvements.agentId))
    .leftJoin(departments, eq(departments.id, agents.departmentId))
    .leftJoin(people, eq(people.id, improvements.decidedBy))
    .where(and(ofCompany, or(active.length ? inArray(improvements.status, active) : undefined, closed.length ? inArray(improvements.id, latestClosed) : undefined) ?? sql`false`))
    .orderBy(desc(improvements.updatedAt));
  const linked = rows.length
    ? await ctx.db
        .select({ improvement: sql<string>`${taskEvents.data}->>'improvement'`, task: { id: tasks.id, number: tasks.number, title: tasks.title } })
        .from(taskEvents)
        .innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
        .where(and(eq(taskEvents.kind, 'created'), eq(taskEvents.companyId, companyId), eq(tasks.companyId, companyId), inArray(sql`${taskEvents.data}->>'improvement'`, rows.map(r => r.i.id))))
        .orderBy(asc(tasks.number))
    : [];
  const byImprovement = new Map<string, Map<string, { id: string; number: number; title: string }>>();
  for (const { improvement, task } of linked) {
    const found = byImprovement.get(improvement) ?? new Map<string, { id: string; number: number; title: string }>();
    found.set(task.id, task);
    byImprovement.set(improvement, found);
  }
  return rows.map(({ i, agent, department, decidedBy }) => ({
    id: i.id,
    title: i.title,
    text: i.text,
    parts: i.parts ?? null,
    seen: i.seen,
    status: i.status,
    scope: i.scope,
    code: i.code,
    result: i.result,
    at: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
    agent,
    department: department ? { id: department.id, name: deptName(department) } : null,
    decidedBy,
    tasks: [...(byImprovement.get(i.id)?.values() ?? [])],
    sent: sentOf(ctx, i),
  }));
}

/* A finding about Hornhoof itself that its developers have already: one sent to them and not fixed yet, told by the same
   fingerprint their inbox tells repeats by, under whichever kind it went as. One more round found it, so it counts on that
   card instead of a new one, and its developers hear of it once a person reports the repeats. */
export async function countOnSent(ctx: Pick<Ctx, 'db' | 'bus'> & Fate, companyId: string, finding: { title: string; code: string | null }): Promise<{ id: string; number: number | null } | null> {
  const prints = FEEDBACK_KINDS.map(kind => fingerprintOfReport({ kind, title: finding.title, facts: { errorCode: finding.code } }));
  const sent = await ctx.db
    .select()
    .from(improvements)
    .where(and(eq(improvements.companyId, companyId), eq(improvements.scope, 'platform'), eq(improvements.status, 'sent'), inArray(improvements.sentFingerprint, prints)))
    .orderBy(desc(improvements.sentAt));
  const open = sent.find(i => !fateOf(ctx.released, ctx.config.version, i.reportNumber).fixedIn);
  if (!open) return null;
  await ctx.db.update(improvements).set({ seen: sql`${improvements.seen} + 1`, updatedAt: new Date() }).where(eq(improvements.id, open.id));
  improvementsChanged(ctx, companyId);
  return { id: open.id, number: open.reportNumber };
}

/* People who see the whole company hear that the list changed. */
export const improvementsChanged = (ctx: Pick<Ctx, 'bus'>, companyId: string) => ctx.bus.publish(companyId, { type: 'improvements', spot: { departmentId: null } });

/* Moves an improvement inside a caller's transaction, with the same company and source-status guards everywhere. */
export async function moveImprovementTx(db: Db | Tx, companyId: string, id: string, from: ImprovementStatus, to: PgUpdateSetSource<typeof improvements>) {
  const [moved] = await db
    .update(improvements)
    .set({ ...to, updatedAt: new Date() })
    .where(and(eq(improvements.id, id), eq(improvements.companyId, companyId), eq(improvements.status, from)))
    .returning();
  if (!moved) {
    const [there] = await db.select({ status: improvements.status }).from(improvements).where(and(eq(improvements.id, id), eq(improvements.companyId, companyId)));
    if (!there) throw new ApiError(404, 'not_found', 'There is no such improvement.', 'improvement_unknown');
    throw new ApiError(409, 'conflict', `This improvement is ${there.status} already.`, 'improvement_decided');
  }
  return moved;
}

/* Moves an improvement on from one of the statuses it may leave, as one statement, so two people cannot both take it. */
export async function moveImprovement(ctx: Pick<Ctx, 'db' | 'bus'>, companyId: string, id: string, from: ImprovementStatus, to: PgUpdateSetSource<typeof improvements>) {
  const moved = await moveImprovementTx(ctx.db, companyId, id, from, to);
  improvementsChanged(ctx, companyId);
  return moved;
}

/* A finding about Hornhoof itself goes into the work of Hornhoof's own installation alone. Elsewhere a person sends it to
   Hornhoof's developers from Improvements, as no company's work can change Hornhoof. */
export function requireOwnWork(improvement: { scope: ImprovementScope }, home: boolean): void {
  if (improvement.scope === 'platform' && !home)
    throw new ApiError(409, 'conflict', "This is about Hornhoof itself, so it goes to Hornhoof's developers: the CEO sends it from Improvements.", 'improvement_platform_elsewhere');
}

/* Planning may take an open improvement only in the run answering a person. A taken one keeps its original decision.
   home: this is Hornhoof's own installation. */
export async function takeForPlanning(db: Db | Tx, companyId: string, id: string, personId: string | null, home: boolean): Promise<void> {
  const [current] = await db.select({ status: improvements.status, scope: improvements.scope }).from(improvements).where(and(eq(improvements.id, id), eq(improvements.companyId, companyId)));
  if (!current) throw new ApiError(404, 'not_found', 'There is no such improvement.', 'improvement_unknown');
  requireOwnWork(current, home);
  if (current.status === 'taken') return;
  if (current.status !== 'open') throw new ApiError(409, 'conflict', `This improvement is ${current.status} already.`, 'improvement_decided');
  if (!personId) throw new ApiError(403, 'forbidden', "This run has no person's instruction to take an improvement.", 'improvement_not_requested');
  await moveImprovementTx(db, companyId, id, 'open', { status: 'taken', decidedBy: personId, result: null });
}
