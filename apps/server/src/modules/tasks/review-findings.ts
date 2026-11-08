import { createHash, randomUUID } from 'node:crypto';
import { matchesGlob } from 'node:path';
import { EchelonCandidate, EchelonModel, type EchelonFindingsView } from '@hornhoof/protocol/echelons';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, taskEvents, tasks, turns } from '../../db/schema.js';
import { published, refuse, type Task, type Tx } from './engine.js';
import { routeOf, type Route } from './echelons-store.js';
import { currentCandidate } from './echelons-candidates.js';
import { RepoPath, ReviewSha } from './review-schema.js';

export const IssueInput = z.object({ taskId: z.uuid().optional(), category: z.enum(['security', 'data', 'spec', 'other', 'mechanical']), blocking: z.boolean(), path: RepoPath, line: z.number().int().positive(), harm: z.string().trim().min(1).max(2000) }).strict();
export const FindingRecord = IssueInput.extend({ taskId: z.uuid(), findingId: z.uuid(), revision: z.uuid(), candidateId: z.uuid(), stage: z.enum(['review', 'security', 'cleanup']), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), reviewedCommit: ReviewSha, authorId: z.uuid(), reviewerId: z.uuid(), reviewerVendor: z.string().min(1) });
export type Finding = z.infer<typeof FindingRecord>;
export type NewIssue = z.infer<typeof IssueInput>;
export const ConfirmationInput = z.object({ findingId: z.uuid(), revision: z.uuid(), confirmed: z.boolean(), reason: z.string().trim().min(1).max(2000), fixCommit: ReviewSha.optional() }).strict();
const Confirmation = ConfirmationInput.extend({ actorId: z.uuid(), authority: z.enum(['head', 'author']) });
type Reader = Ctx['db'] | Tx;
type Event = Pick<typeof taskEvents.$inferSelect, 'id' | 'companyId' | 'taskId' | 'agentId' | 'kind' | 'data'>;
export type FindingReport = EchelonFindingsView & { confirmedCount: number; byVendor: { vendor: string; count: number; findingIds: string[] }[] };

export async function reviewEvents(db: Reader, ids: string[]): Promise<Event[]> {
  return ids.length ? db.select({ id: taskEvents.id, companyId: taskEvents.companyId, taskId: taskEvents.taskId, agentId: taskEvents.agentId, kind: taskEvents.kind, data: taskEvents.data }).from(taskEvents).where(inArray(taskEvents.taskId, ids)).orderBy(asc(taskEvents.id)) : [];
}

/* Only candidate-bound checker events create findings. Comments and supplied numeric counts have no authority. */
export function findingsOf(events: Event[]): Finding[] {
  const candidates = events.flatMap(event => {
    const parsed = EchelonCandidate.safeParse(event.data.candidate);
    return event.kind === 'submitted' && parsed.success ? [{ event, candidate: parsed.data }] : [];
  });
  const found = new Map<string, Finding>();
  for (const event of events) {
    if (event.kind !== 'verdict') continue;
    const checker = EchelonModel.safeParse(event.data.checker);
    const values = z.array(FindingRecord).safeParse(event.data.issues);
    if (!checker.success || checker.data.agentId !== event.agentId || !values.success) continue;
    for (const finding of values.data) {
      const source = candidates.find(value => value.candidate.id === finding.candidateId && value.event.taskId === event.taskId && value.event.companyId === event.companyId);
      if (!source || finding.taskId !== event.taskId || finding.reviewerId !== event.agentId || finding.reviewerVendor !== checker.data.provider || finding.authorId !== source.candidate.producedBy.agentId || finding.reviewedCommit !== source.candidate.commit || finding.revision !== source.candidate.id || finding.stage !== event.data.stage || finding.candidateId !== event.data.candidateId) continue;
      found.set(`${finding.findingId}:${finding.stage}:${finding.revision}`, finding);
    }
  }
  return [...found.values()];
}

export async function issuesForEchelon(db: Reader, task: Task, route: Route, candidate: EchelonCandidate, checker: EchelonModel, input: NewIssue[], pass: boolean): Promise<Finding[]> {
  const stage = z.enum(['review', 'security', 'cleanup']).parse(route.state.stage);
  const known = findingsOf(await reviewEvents(db, [task.id]));
  return input.map(value => {
    const issue = IssueInput.parse(value);
    if ((issue.taskId && issue.taskId !== task.id) || !route.paths.some(pattern => matchesGlob(issue.path, pattern))) throw refuse(400, 'task_invalid', 'A finding must belong to this task and its approved paths.');
    if (pass && issue.blocking) throw refuse(400, 'task_invalid', 'A blocking finding cannot certify PASS.');
    const fingerprint = createHash('sha256').update(JSON.stringify([task.id, issue.category, issue.path, issue.line, issue.harm.trim().toLowerCase().replace(/\s+/g, ' ')])).digest('hex');
    return { ...issue, taskId: task.id, findingId: known.find(finding => finding.fingerprint === fingerprint)?.findingId ?? randomUUID(), fingerprint, revision: candidate.id, candidateId: candidate.id, stage, reviewedCommit: candidate.commit, authorId: candidate.producedBy.agentId, reviewerId: checker.agentId, reviewerVendor: checker.provider };
  });
}

export function mechanicalVerdict(data: Record<string, unknown>): boolean {
  const issues = z.array(FindingRecord).safeParse(data.issues);
  return issues.success && issues.data.some(issue => issue.blocking) && issues.data.every(issue => issue.category === 'mechanical');
}

function confirmedIds(events: Event[], issues: Finding[]): Set<string> {
  const states = new Map<string, boolean>();
  for (const event of events) {
    const parsed = Confirmation.safeParse(event.data.findingConfirmation);
    if (!parsed.success || event.agentId !== parsed.data.actorId) continue;
    if (issues.some(issue => issue.findingId === parsed.data.findingId && issue.revision === parsed.data.revision)) states.set(parsed.data.findingId, parsed.data.confirmed);
  }
  return new Set([...states].filter(([, confirmed]) => confirmed).map(([id]) => id));
}

export function countedFindings(events: Event[]): FindingReport {
  const issues = findingsOf(events), confirmed = confirmedIds(events, issues);
  const unique = (values: Finding[]) => new Set(values.map(issue => issue.findingId)).size;
  const counts = (stage: Finding['stage']) => ({ reported: unique(issues.filter(issue => issue.stage === stage)), confirmed: unique(issues.filter(issue => issue.stage === stage && confirmed.has(issue.findingId))) });
  const byVendor = [...new Set(issues.map(issue => issue.reviewerVendor))].sort().map(vendor => {
    const ids = [...new Set(issues.filter(issue => issue.reviewerVendor === vendor && confirmed.has(issue.findingId)).map(issue => issue.findingId))];
    return { vendor, count: ids.length, findingIds: ids };
  });
  return { uniqueReported: unique(issues), uniqueConfirmed: confirmed.size, confirmedCount: confirmed.size, review: counts('review'), security: counts('security'), cleanup: counts('cleanup'), byVendor, issues: issues.map(issue => ({ ...issue, confirmed: confirmed.has(issue.findingId) })) };
}

export async function findingReport(db: Reader, ids: string[]): Promise<FindingReport> {
  return countedFindings(await reviewEvents(db, ids));
}
export type TurnFindingReport = FindingReport & { status: 'recorded'; reason: null };
export async function findingTurnReport(db: Reader, companyId: string, number: number): Promise<TurnFindingReport> {
  const rows = await db.select({ id: tasks.id }).from(tasks).innerJoin(turns, eq(turns.id, tasks.turnId)).where(and(eq(tasks.companyId, companyId), eq(turns.number, number)));
  return { ...await findingReport(db, rows.map(row => row.id)), status: 'recorded', reason: null };
}

/* Confirmation records existence, not resolution or permission to skip a stage. A checker never confirms itself. */
export async function confirmFinding(ctx: Pick<Ctx, 'db' | 'bus'>, actorId: string, task: Task, value: z.infer<typeof ConfirmationInput>): Promise<void> {
  const input = ConfirmationInput.parse(value);
  const changed = await ctx.db.transaction(async tx => {
    const [current] = await tx.select().from(tasks).where(and(eq(tasks.id, task.id), eq(tasks.companyId, task.companyId))).for('update');
    if (!current) throw refuse(404, 'task_unknown', 'This task is unavailable.');
    const events = await reviewEvents(tx, [task.id]);
    const issue = findingsOf(events).find(finding => finding.findingId === input.findingId && finding.revision === input.revision);
    if (!issue) throw refuse(409, 'task_invalid', 'The finding or candidate revision is unknown.');
    const [actor] = await tx.select().from(agents).where(and(eq(agents.id, actorId), eq(agents.companyId, current.companyId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
    if (!actor || actor.id === issue.reviewerId) throw refuse(403, 'task_not_yours', 'A checker cannot confirm its own finding.');
    const head = actor.kind === 'head' && actor.departmentId === current.departmentId;
    if (!head) {
      if (actor.id !== issue.authorId) throw refuse(403, 'task_not_yours', 'Only the affected producer or its head can confirm a finding.');
      const candidate = await currentCandidate(tx, current, await routeOf(tx, current));
      if (!input.fixCommit || input.fixCommit !== candidate.commit || input.fixCommit === issue.reviewedCommit) throw refuse(409, 'task_changed', 'The producer needs an exact current fix candidate.');
    }
    const previous = events.map(event => Confirmation.safeParse(event.data.findingConfirmation)).filter(result => result.success && result.data.findingId === input.findingId).at(-1);
    if (previous?.success && previous.data.confirmed === input.confirmed && previous.data.fixCommit === input.fixCommit) return null;
    const [row] = await tx.update(tasks).set({ version: current.version + 1, updatedAt: new Date() }).where(eq(tasks.id, task.id)).returning();
    await tx.insert(taskEvents).values({ companyId: current.companyId, taskId: task.id, agentId: actorId, kind: 'comment', text: input.reason, data: { findingConfirmation: { ...input, actorId, authority: head ? 'head' : 'author' } } });
    return row!;
  });
  if (changed) published(ctx, changed);
}
