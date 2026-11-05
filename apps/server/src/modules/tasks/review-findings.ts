import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, taskEvents, tasks, turns } from '../../db/schema.js';
import { repoAt } from '../departments/repository.js';
import { published, refuse, type Task, type Tx } from './engine.js';
import { authorVendor, exactComparison, reviewContext, ReviewRecord, ReviewSha, type Review } from './review-context.js';
import type { Plan } from './review-plan.js';
import { RepoPath } from './review-schema.js';

export const IssueInput = z.object({ taskId: z.string().uuid().optional(), category: z.enum(['security', 'data', 'spec', 'other', 'mechanical']), blocking: z.boolean(), path: RepoPath, line: z.number().int().positive(), harm: z.string().trim().min(1).max(2000) }).strict();
export const FindingRecord = IssueInput.extend({ taskId: z.string().uuid(), findingId: z.string().uuid(), revision: z.string().uuid(), reviewedCommit: ReviewSha, authorId: z.string().uuid(), reviewerId: z.string().uuid(), reviewerVendor: z.string().min(1) });
export type Finding = z.infer<typeof FindingRecord>;
export type NewIssue = z.infer<typeof IssueInput>;
export type FindingReport = { confirmedCount: number; byVendor: { vendor: string; count: number; findingIds: string[] }[]; issues: (Finding & { confirmation: z.infer<typeof Confirmation> | null })[]; legacyUncounted: number };
export const ConfirmationInput = z.object({ findingId: z.string().uuid(), revision: z.string().uuid(), confirmed: z.boolean(), reason: z.string().trim().min(1).max(2000), fixCommit: ReviewSha.optional() }).strict();
type ConfirmInput = z.infer<typeof ConfirmationInput>;
const Range = z.object({ revision: z.string().uuid(), version: z.number().int().nonnegative(), base: ReviewSha, head: ReviewSha, paths: z.array(z.string()) });
const Confirmation = ConfirmationInput.extend({ fixCommit: ReviewSha.nullable(), actorId: z.string().uuid(), authority: z.enum(['head', 'author']), reviewedCommit: ReviewSha, range: Range.optional() });
type Event = Pick<typeof taskEvents.$inferSelect, 'id' | 'taskId' | 'agentId' | 'kind' | 'data'>;
type Reader = Ctx['db'] | Tx;

export function mechanicalVerdict(data: Record<string, unknown>): boolean {
  const issues = z.array(FindingRecord).safeParse(data.issues);
  return issues.success && issues.data.length > 0 && !data.unresolvedFindingIds && issues.data.some(issue => issue.blocking) && issues.data.every(issue => issue.category === 'mechanical');
}

export async function assertReviewVendor(db: Reader, agentId: string, review: Review | null, plan: Plan | null): Promise<void> {
  if (!review) return;
  const vendor = await authorVendor(db, agentId);
  const own = plan ? plan.assignments.filter(a => a.reviewerId === agentId || plan.integrationReviewerId === agentId).some(a => a.authorVendor === vendor) : review.authorVendor === vendor;
  if (!vendor || own) throw refuse(403, 'task_not_yours', 'An independent reviewer vendor is required for this area.');
}

function issueArea(task: Task, agentId: string, plan: Plan | null, issue: NewIssue): Plan['assignments'][number] | undefined {
  const taskId = issue.taskId ?? task.id;
  const area = plan?.assignments.find(a => a.taskId === taskId && (a.reviewerId === agentId || plan.integrationReviewerId === agentId));
  if (plan && !area) throw refuse(400, 'task_invalid', 'Name a task area assigned to this reviewer.');
  if (!plan && taskId !== task.id) throw refuse(400, 'task_invalid', 'This finding belongs to another task area.');
  return area;
}

function assertIssuePath(area: Plan['assignments'][number] | undefined, plan: Plan | null, agentId: string, path: string): void {
  const paths = area?.paths ?? [];
  if (paths.length && !paths.includes(path) && plan?.integrationReviewerId !== agentId) throw refuse(400, 'task_invalid', 'This path is outside the assigned source range.');
}

function scopedIssue(task: Task, agentId: string, review: Review, plan: Plan | null, reviewerVendor: string, issue: NewIssue): Finding {
  const area = issueArea(task, agentId, plan, issue);
  assertIssuePath(area, plan, agentId, issue.path);
  return { ...issue, taskId: issue.taskId ?? task.id, findingId: randomUUID(), revision: review.revision, reviewedCommit: review.commit!, authorId: area ? area.authorId : review.authorId, reviewerId: agentId, reviewerVendor };
}

function assertFindingReview(review: Review | null, pass: boolean, input: NewIssue[]): asserts review is Review & { commit: string } {
  if (!review?.commit) throw refuse(400, 'task_invalid', 'A structured finding needs a pinned review commit.');
  if (pass && input.some(issue => issue.blocking)) throw refuse(400, 'task_invalid', 'A blocking finding cannot accompany PASS.');
}

export async function issuesForVerdict(db: Reader, task: Task, agentId: string, review: Review | null, plan: Plan | null, input: NewIssue[], pass: boolean): Promise<Finding[]> {
  if (!input.length) return [];
  assertFindingReview(review, pass, input);
  const vendor = await authorVendor(db, agentId);
  if (!vendor) throw refuse(400, 'task_invalid', 'A structured finding needs a known reviewer vendor.');
  return input.map(issue => scopedIssue(task, agentId, review, plan, vendor, issue));
}

export async function reviewEvents(db: Reader, taskIds: string[]): Promise<Event[]> {
  if (!taskIds.length) return [];
  return db.select({ id: taskEvents.id, taskId: taskEvents.taskId, agentId: taskEvents.agentId, kind: taskEvents.kind, data: taskEvents.data })
    .from(taskEvents).where(inArray(taskEvents.taskId, taskIds)).orderBy(asc(taskEvents.id));
}

/* Only server-bound verdict records are sources; legacy counts and comments cannot create finding identities. */
function sourceIssues(event: Event): Finding[] {
  const review = ReviewRecord.safeParse(event.data.review);
  const issues = z.array(FindingRecord).safeParse(event.data.issues);
  if (event.kind !== 'verdict' || !review.success || !issues.success) return [];
  return issues.data.filter(issue => event.agentId === issue.reviewerId && review.data.revision === issue.revision && review.data.commit === issue.reviewedCommit);
}

export function findingsOf(events: Event[]): Finding[] {
  const found = new Map<string, Finding>();
  for (const event of events) for (const issue of sourceIssues(event)) if (!found.has(issue.findingId)) found.set(issue.findingId, issue);
  return [...found.values()];
}

function confirmationStates(events: Event[], issues: Finding[]): Map<string, z.infer<typeof Confirmation>> {
  const known = new Map(issues.map(issue => [issue.findingId, issue]));
  const states = new Map<string, z.infer<typeof Confirmation>>();
  for (const event of events) {
    const parsed = Confirmation.safeParse(event.data.findingConfirmation);
    if (!parsed.success) continue;
    const value = parsed.data;
    const issue = known.get(value.findingId);
    if (event.agentId === value.actorId && issue?.revision === value.revision && issue.reviewedCommit === value.reviewedCommit) states.set(value.findingId, value);
  }
  return states;
}

function vendorCounts(confirmed: Finding[]): FindingReport['byVendor'] {
  const vendors = [...new Set(confirmed.map(issue => issue.reviewerVendor))].sort();
  return vendors.map(vendor => {
    const own = confirmed.filter(issue => issue.reviewerVendor === vendor);
    return { vendor, count: own.length, findingIds: own.map(issue => issue.findingId) };
  });
}

export function countedFindings(events: Event[]): FindingReport {
  const issues = findingsOf(events);
  const states = confirmationStates(events, issues);
  const confirmed = issues.filter(issue => states.get(issue.findingId)?.confirmed === true);
  const legacy = events.filter(event => event.kind === 'verdict' && typeof event.data.findings === 'number' && !Array.isArray(event.data.issues));
  return { confirmedCount: confirmed.length, byVendor: vendorCounts(confirmed), issues: issues.map(issue => ({ ...issue, confirmation: states.get(issue.findingId) ?? null })), legacyUncounted: legacy.length };
}

export async function findingReport(db: Reader, taskIds: string[]): Promise<FindingReport> {
  return countedFindings(await reviewEvents(db, taskIds));
}

/* A legacy turn cannot be retrospectively assigned a measured confirmed-finding count. */
export type TurnFindingReport = Omit<FindingReport, 'confirmedCount'> & { confirmedCount: number | null; status: 'recorded' | 'partial' | 'unavailable'; reason: string | null };

export async function findingTurnReport(db: Reader, companyId: string, number: number): Promise<TurnFindingReport> {
  const rows = await db.select({ id: tasks.id }).from(tasks).innerJoin(turns, eq(turns.id, tasks.turnId)).where(and(eq(tasks.companyId, companyId), eq(turns.number, number)));
  const events = await reviewEvents(db, rows.map(row => row.id));
  const report = countedFindings(events);
  const legacy = events.some(event => event.kind === 'verdict' && event.data.reviewPolicyVersion !== 1);
  const status = legacy ? report.issues.length ? 'partial' : 'unavailable' : 'recorded';
  return { ...report, confirmedCount: status === 'unavailable' ? null : report.confirmedCount, status, reason: legacy ? 'legacy-verdicts-have-no-confirmation-provenance' : null };
}

type Live = Pick<Ctx, 'db' | 'bus' | 'config' | 'readCompare'>;
type FixProof = { revision: string; version: number; base: string; head: string; paths: string[] };

async function currentFixReview(db: Reader, area: Task, issue: Finding, fixCommit: string): Promise<Review> {
  const review = await reviewContext(db, area.id);
  if (review?.commit !== fixCommit || review.authorId !== issue.authorId || fixCommit === issue.reviewedCommit) throw refuse(409, 'task_invalid', 'The fix SHA is stale or belongs to another author revision.');
  return review;
}

async function proofForFix(ctx: Live, area: Task, issue: Finding, fixCommit: string | undefined): Promise<FixProof | null> {
  if (!fixCommit) return null;
  const review = await currentFixReview(ctx.db, area, issue, fixCommit);
  const found = await repoAt(ctx, [area.productId, area.departmentId]);
  if (!found || !ctx.readCompare) throw refuse(409, 'task_invalid', 'The fix repository is unavailable.');
  try {
    const compared = await ctx.readCompare(found.repo, { base: issue.reviewedCommit, head: fixCommit }, 10_000);
    if (exactComparison(compared, issue.reviewedCommit, fixCommit)) return { revision: review.revision, version: area.version, base: compared.baseSha, head: compared.headSha, paths: compared.paths };
  } catch { /* Never expose a repository token through remote errors. */ }
  throw refuse(409, 'task_invalid', 'The immutable fix range could not be verified.');
}

async function confirmationActor(db: Tx, actorId: string, task: Task, area: Task, issue: Finding): Promise<'head' | 'author'> {
  const [actor] = await db.select().from(agents).where(and(eq(agents.id, actorId), eq(agents.companyId, task.companyId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  if (!actor || actor.id === issue.reviewerId) throw refuse(403, 'task_not_yours', 'A reviewer cannot confirm its own finding.');
  if (actor.kind === 'head' && actor.departmentId === area.departmentId) return 'head';
  if (actor.id === area.executorAgentId && actor.id === issue.authorId) return 'author';
  throw refuse(403, 'task_not_yours', 'Only the actual area author or its head can confirm this finding.');
}

function assertCurrentProof(area: Task, current: Review | null, issue: Finding, proof: FixProof | null): void {
  if (area.executorAgentId !== issue.authorId) throw refuse(409, 'task_changed', 'The area author changed. Read its ownership again.');
  if (!proof) return;
  if (area.version !== proof.version || current?.revision !== proof.revision || current.commit !== proof.head) throw refuse(409, 'task_changed', 'The area or its fix revision changed. Read it again.');
}

async function recordConfirmation(tx: Tx, task: Task, actorId: string, issue: Finding, input: ConfirmInput, proof: FixProof | null, authority: 'head' | 'author'): Promise<Task> {
  const [updated] = await tx.update(tasks).set({ version: task.version + 1, updatedAt: new Date() }).where(and(eq(tasks.id, task.id), eq(tasks.version, task.version))).returning();
  if (!updated) throw refuse(409, 'task_changed', 'The task changed during confirmation.');
  const value = { ...input, actorId, authority, fixCommit: input.fixCommit ?? null, reviewedCommit: issue.reviewedCommit, ...(proof ? { range: proof } : {}) };
  await tx.insert(taskEvents).values({ companyId: task.companyId, taskId: task.id, agentId: actorId, kind: 'comment', text: input.reason, data: { findingConfirmation: value } });
  return updated;
}

async function confirmLocked(tx: Tx, task: Task, area: Task, actorId: string, issue: Finding, input: ConfirmInput, proof: FixProof | null): Promise<Task | null> {
  const locked = await tx.select().from(tasks).where(inArray(tasks.id, [...new Set([task.id, area.id])])).orderBy(asc(tasks.id)).for('update');
  const currentTask = locked.find(row => row.id === task.id)!;
  const currentArea = locked.find(row => row.id === area.id)!;
  const authority = await confirmationActor(tx, actorId, currentTask, currentArea, issue);
  if (authority === 'author' && !proof) throw refuse(400, 'task_invalid', 'The author must name an exact current fix SHA.');
  assertCurrentProof(currentArea, await reviewContext(tx, area.id), issue, proof);
  const previous = (await reviewEvents(tx, [task.id])).map(e => Confirmation.safeParse(e.data.findingConfirmation)).filter(p => p.success && p.data.findingId === issue.findingId).at(-1);
  if (previous?.success && previous.data.confirmed === input.confirmed && previous.data.fixCommit === (input.fixCommit ?? null)) return null;
  return recordConfirmation(tx, currentTask, actorId, issue, input, proof, authority);
}

/* Confirming existence never moves a gate or marks the issue fixed. History and task CAS commit together. */
export async function confirmFinding(ctx: Live, actorId: string, task: Task, input: ConfirmInput): Promise<void> {
  const issue = findingsOf(await reviewEvents(ctx.db, [task.id])).find(f => f.findingId === input.findingId);
  if (!issue || issue.revision !== input.revision) throw refuse(409, 'task_invalid', 'The finding ID or revision is unknown.');
  const [area] = await ctx.db.select().from(tasks).where(and(eq(tasks.id, issue.taskId), eq(tasks.companyId, task.companyId)));
  if (!area) throw refuse(404, 'task_unknown', 'The finding area is unavailable.');
  const proof = await proofForFix(ctx, area, issue, input.fixCommit);
  const changed = await ctx.db.transaction(tx => confirmLocked(tx, task, area, actorId, issue, input, proof));
  if (changed) published(ctx, changed);
}
