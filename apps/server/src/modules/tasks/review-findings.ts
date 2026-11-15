import { createHash, randomUUID } from 'node:crypto';
import { EchelonCandidate, EchelonModel, type EchelonFindingsView } from '@hornhoof/protocol/echelons';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, taskEvents, tasks, turns } from '../../db/schema.js';
import { published, refuse, type Task, type Tx } from './engine.js';
import { routeOf, type Route } from './echelons-store.js';
import { currentCandidate } from './echelons-candidates.js';
import { pathInScope, RepoPath, ReviewSha } from './review-schema.js';

export const IssueInput = z.object({ taskId: z.uuid().optional(), category: z.enum(['security', 'data', 'spec', 'other', 'mechanical']), blocking: z.boolean(), path: RepoPath, line: z.number().int().positive(), harm: z.string().trim().min(1).max(2000) }).strict();
export const FindingRecord = IssueInput.extend({ taskId: z.uuid(), findingId: z.uuid(), revision: z.uuid(), candidateId: z.uuid(), stage: z.enum(['review', 'security', 'cleanup']), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), reviewedCommit: ReviewSha, authorId: z.uuid(), reviewerId: z.uuid(), reviewerVendor: z.string().min(1) });
export type Finding = z.infer<typeof FindingRecord>;
export type NewIssue = z.infer<typeof IssueInput>;
export const ConfirmationInput = z.object({ findingId: z.uuid(), revision: z.uuid(), confirmed: z.boolean(), reason: z.string().trim().min(1).max(2000), fixCommit: ReviewSha.optional() }).strict();
const Confirmation = ConfirmationInput.extend({ actorId: z.uuid(), authority: z.enum(['head', 'author']) });
type Reader = Ctx['db'] | Tx;
type Event = Pick<typeof taskEvents.$inferSelect, 'id' | 'companyId' | 'taskId' | 'agentId' | 'kind' | 'data'>;
export type FindingReport = EchelonFindingsView & { byVendor: { vendor: string; count: number; findingIds: string[] }[] };

export async function reviewEvents(db: Reader, ids: string[]): Promise<Event[]> {
  return ids.length ? db.select({ id: taskEvents.id, companyId: taskEvents.companyId, taskId: taskEvents.taskId, agentId: taskEvents.agentId, kind: taskEvents.kind, data: taskEvents.data }).from(taskEvents).where(inArray(taskEvents.taskId, ids)).orderBy(asc(taskEvents.id)) : [];
}

/* Only candidate-bound checker events create findings. Comments and supplied numeric counts have no authority. */
export function findingsOf(events: Event[]): Finding[] {
  const candidates = submittedCandidates(events);
  const found = new Map<string, Finding>();
  for (const finding of events.flatMap(event => attestedFindings(event, candidates))) {
    found.set(`${finding.findingId}:${finding.stage}:${finding.revision}`, finding);
  }
  return [...found.values()];
}

function submittedCandidates(events: Event[]) {
  return events.flatMap(event => {
    const parsed = EchelonCandidate.safeParse(event.data.candidate);
    return event.kind === 'submitted' && parsed.success ? [{ event, candidate: parsed.data }] : [];
  });
}

function attestedFindings(event: Event, candidates: ReturnType<typeof submittedCandidates>): Finding[] {
  if (event.kind !== 'verdict') return [];
  const checker = EchelonModel.safeParse(event.data.checker);
  const values = z.array(FindingRecord).safeParse(event.data.issues);
  if (!checker.success || checker.data.agentId !== event.agentId || !values.success) return [];
  return values.data.filter(finding => {
    const source = sourceForFinding(finding, event, candidates);
    return source !== undefined && findingMatchesEvent(finding, event, checker.data) && findingMatchesSource(finding, source.candidate);
  });
}

function sourceForFinding(finding: Finding, event: Event, candidates: ReturnType<typeof submittedCandidates>) {
  return candidates.find(value => value.candidate.id === finding.candidateId && value.event.taskId === event.taskId && value.event.companyId === event.companyId);
}

function findingMatchesEvent(finding: Finding, event: Event, checker: EchelonModel): boolean {
  return finding.taskId === event.taskId && finding.reviewerId === event.agentId && finding.reviewerVendor === checker.provider && finding.stage === event.data.stage && finding.candidateId === event.data.candidateId;
}

function findingMatchesSource(finding: Finding, candidate: EchelonCandidate): boolean {
  return finding.authorId === candidate.producedBy.agentId && finding.reviewedCommit === candidate.commit && finding.revision === candidate.id;
}

export async function issuesForEchelon(db: Reader, task: Task, route: Route, candidate: EchelonCandidate, checker: EchelonModel, input: NewIssue[], pass: boolean): Promise<Finding[]> {
  const stage = z.enum(['review', 'security', 'cleanup']).parse(route.state.stage);
  const known = findingsOf(await reviewEvents(db, [task.id]));
  return input.map(value => {
    const issue = IssueInput.parse(value);
    if ((issue.taskId && issue.taskId !== task.id) || !pathInScope(issue.path, route.paths)) throw refuse(400, 'task_invalid', 'A finding must belong to this task and its approved paths.');
    if (pass && issue.blocking) throw refuse(400, 'task_invalid', 'A blocking finding cannot certify PASS.');
    const fingerprint = createHash('sha256').update(JSON.stringify([task.id, issue.category, issue.path, issue.line, issue.harm.trim().toLowerCase().replace(/\s+/g, ' ')])).digest('hex');
    return { ...issue, taskId: task.id, findingId: known.find(finding => finding.fingerprint === fingerprint)?.findingId ?? randomUUID(), fingerprint, revision: candidate.id, candidateId: candidate.id, stage, reviewedCommit: candidate.commit, authorId: candidate.producedBy.agentId, reviewerId: checker.agentId, reviewerVendor: checker.provider };
  });
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
  }).filter(item => item.count > 0);
  return { uniqueReported: unique(issues), uniqueConfirmed: confirmed.size, review: counts('review'), security: counts('security'), cleanup: counts('cleanup'), byVendor, issues: issues.map(issue => ({ ...issue, confirmed: confirmed.has(issue.findingId) })) };
}

export async function findingReport(db: Reader, ids: string[]): Promise<FindingReport> {
  return countedFindings(await reviewEvents(db, ids));
}
export type TurnFindingReport = (FindingReport & { status: 'recorded'; reason: null }) | {
  status: 'unavailable'; reason: 'finding-provenance-unavailable'; uniqueReported: null; uniqueConfirmed: null;
  review: null; security: null; cleanup: null; byVendor: []; issues: [];
};

function hasUnattestedVerdict(events: Event[]): boolean {
  return events.some(event => {
    if (event.kind !== 'verdict') return false;
    const checker = EchelonModel.safeParse(event.data.checker);
    const issues = z.array(FindingRecord).safeParse(event.data.issues);
    const source = events.find(value => submittedForVerdict(value, event));
    return !checker.success || checker.data.agentId !== event.agentId || !issues.success || !source;
  });
}

function submittedForVerdict(source: Event, verdict: Event): boolean {
  if (source.kind !== 'submitted' || source.companyId !== verdict.companyId || source.taskId !== verdict.taskId) return false;
  const candidate = EchelonCandidate.safeParse(source.data.candidate);
  return candidate.success && candidate.data.id === verdict.data.candidateId;
}

export async function findingTurnReport(db: Reader, companyId: string, number: number): Promise<TurnFindingReport> {
  const rows = await db.select({ id: tasks.id }).from(tasks).innerJoin(turns, eq(turns.id, tasks.turnId)).where(and(eq(tasks.companyId, companyId), eq(turns.number, number)));
  const events = await reviewEvents(db, rows.map(row => row.id));
  if (hasUnattestedVerdict(events)) return { status: 'unavailable', reason: 'finding-provenance-unavailable', uniqueReported: null, uniqueConfirmed: null, review: null, security: null, cleanup: null, byVendor: [], issues: [] };
  return { ...countedFindings(events), status: 'recorded', reason: null };
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
    const authority = await confirmationAuthority(tx, current, actorId, issue, input);
    if (sameConfirmation(events, input)) return null;
    const [row] = await tx.update(tasks).set({ version: current.version + 1, updatedAt: new Date() }).where(eq(tasks.id, task.id)).returning();
    await tx.insert(taskEvents).values({ companyId: current.companyId, taskId: task.id, agentId: actorId, kind: 'comment', text: input.reason, data: { findingConfirmation: { ...input, actorId, authority } } });
    return row!;
  });
  if (changed) published(ctx, changed);
}

async function confirmationAuthority(tx: Tx, current: Task, actorId: string, issue: Finding, input: z.infer<typeof ConfirmationInput>): Promise<'head' | 'author'> {
  const [actor] = await tx.select().from(agents).where(and(eq(agents.id, actorId), eq(agents.companyId, current.companyId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  if (!actor || actor.id === issue.reviewerId) throw refuse(403, 'task_not_yours', 'A checker cannot confirm its own finding.');
  if (actor.kind === 'head' && actor.departmentId === current.departmentId) return 'head';
  await requireAuthorFix(tx, current, actor.id, issue, input);
  return 'author';
}

async function requireAuthorFix(tx: Tx, task: Task, actorId: string, issue: Finding, input: z.infer<typeof ConfirmationInput>): Promise<void> {
  if (actorId !== issue.authorId) throw refuse(403, 'task_not_yours', 'Only the affected producer or its head can confirm a finding.');
  const candidate = await currentCandidate(tx, task, await routeOf(tx, task));
  if (!input.fixCommit || input.fixCommit !== candidate.commit || input.fixCommit === issue.reviewedCommit) throw refuse(409, 'task_changed', 'The producer needs an exact current fix candidate.');
}

function sameConfirmation(events: Event[], input: z.infer<typeof ConfirmationInput>): boolean {
  const previous = events.map(event => Confirmation.safeParse(event.data.findingConfirmation)).filter(result => result.success && result.data.findingId === input.findingId).at(-1);
  return previous?.success === true && previous.data.confirmed === input.confirmed && previous.data.fixCommit === input.fixCommit;
}
