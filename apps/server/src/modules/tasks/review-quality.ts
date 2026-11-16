import { EchelonCandidate } from '@hornhoof/protocol/echelons';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { jobs, taskEvents, taskRoutes, tasks, testParts, testRuns } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import type { Tx } from './engine.js';
import { RepoPath, ReviewSha } from './review-schema.js';

type Store = Db | Tx;
const Count = z.number().int().nonnegative();
const STAGES = ['format', 'lint', 'types', 'tests', 'crapper', 'dryer'] as const;
const Stage = z.object({ name: z.enum(STAGES), status: z.enum(['passed', 'failed', 'cancelled', 'unavailable']), exitCode: z.number().int().nullable(), partId: z.string().uuid().nullable() }).strict();
const Tests = z.object({ passed: Count, failed: Count, skipped: Count, total: Count }).strict().refine(v => v.total === v.passed + v.failed + v.skipped);
const Lines = z.object({ covered: Count, total: Count }).strict().refine(v => v.covered <= v.total);
export const AuthorCheckInput = z.object({
  version: z.literal(1), runId: z.string().uuid(), submissionCommit: ReviewSha, checkCommit: ReviewSha,
  /* leftToFullRun: the test files the import graph reaches that the author did not run, which the full run takes. */
  scope: z.object({ kind: z.enum(['changed', 'package']), paths: z.array(RepoPath), leftToFullRun: z.array(RepoPath).max(20_000).optional() }).strict(),
  stages: z.array(Stage).max(STAGES.length).refine(stages => new Set(stages.map(stage => stage.name)).size === stages.length),
  numbers: z.object({ tests: Tests.nullable(), changedLines: Lines.nullable(), worstCrap: z.number().nonnegative().nullable(), dryerFlags: Count.nullable() }).strict(),
}).strict();
export const CheckReceiptPart = z.object({ id: z.string().uuid(), status: z.enum(['queued', 'running', 'passed', 'failed', 'stopped']), commit: ReviewSha.nullable(), exitCode: z.number().int().nullable(), hasError: z.boolean().default(false) }).strict();
const Receipt = z.object({ status: z.enum(['running', 'passed', 'failed', 'stopped']), parts: z.array(CheckReceiptPart) }).strict();
export const AuthorCheckRecord = AuthorCheckInput.extend({ producer: z.literal('author-check-v1'), companyId: z.string().uuid(), taskId: z.string().uuid(), authorId: z.string().uuid(), jobId: z.string().uuid(), receipt: Receipt });
export const QualityEvidence = z.object({ status: z.enum(['passed', 'failed', 'cancelled', 'partial', 'unavailable']), reason: z.string().nullable(), sourceEventId: z.number().int().nullable(), record: AuthorCheckRecord.nullable() });
export type Quality = z.infer<typeof QualityEvidence>;
export const unavailableQuality = (): Quality => ({ status: 'unavailable', reason: 'author-check-record-unavailable', sourceEventId: null, record: null });
export type AuthorCheckResult = z.infer<typeof AuthorCheckInput>;
type Input = AuthorCheckResult;
type Saved = z.infer<typeof AuthorCheckRecord>;
type Binding = { task: typeof tasks.$inferSelect; run: typeof testRuns.$inferSelect; job: typeof jobs.$inferSelect; parts: (typeof testParts.$inferSelect)[] };
const invalid = () => new ApiError(409, 'conflict', 'The author-check record does not match its server-owned task, run and commit.', 'task_invalid');

function assertRun(task: Binding['task'], run: Binding['run']): void {
  const valid = [run.companyId === task.companyId, run.taskId === task.id, run.kind === 'tests', [task.departmentId, task.productId].includes(run.departmentId)];
  if (valid.includes(false)) throw invalid();
}

function assertJob(task: Binding['task'], run: Binding['run'], job: Binding['job']): void {
  if (job.companyId !== task.companyId || job.agentId !== run.agentId || (job.taskId !== null && job.taskId !== task.id)) throw invalid();
}

/* The producing owner, or its immutable submission, owns a quality receipt. */
async function assertProducer(db: Store, task: Binding['task'], run: Binding['run']): Promise<void> {
  const [route] = await db.select(only(taskRoutes, 'state')).from(taskRoutes).where(and(eq(taskRoutes.taskId, task.id), eq(taskRoutes.companyId, task.companyId)));
  if (activeProducer(task, run, route?.state)) return;
  const events = await db.select().from(taskEvents).where(and(eq(taskEvents.companyId, task.companyId), eq(taskEvents.taskId, task.id), eq(taskEvents.agentId, run.agentId)));
  if (events.some(event => submittedProducer(event, run))) return;
  throw invalid();
}

function activeProducer(task: Binding['task'], run: Binding['run'], state: typeof taskRoutes.$inferSelect.state | undefined): boolean {
  return task.assigneeAgentId === run.agentId && state?.resultKind === 'code' && state.phase === 'active' && ['development', 'review', 'security', 'cleanup'].includes(state.stage ?? '');
}

function submittedProducer(event: typeof taskEvents.$inferSelect, run: Binding['run']): boolean {
  const candidate = EchelonCandidate.safeParse(event.data.candidate);
  return event.kind === 'submitted' && candidate.success && candidate.data.producedBy.agentId === run.agentId && candidate.data.commit === run.commitSha;
}

async function binding(db: Store, taskId: string, runId: string): Promise<Binding> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  const [run] = await db.select().from(testRuns).where(eq(testRuns.id, runId));
  if (!task || !run) throw invalid();
  assertRun(task, run);
  const [job] = await db.select().from(jobs).where(eq(jobs.id, run.jobId));
  if (!job) throw invalid();
  assertJob(task, run, job);
  await assertProducer(db, task, run);
  const parts = await db.select().from(testParts).where(eq(testParts.runId, run.id)).orderBy(asc(testParts.id));
  if (parts.some(part => part.companyId !== task.companyId)) throw invalid();
  return { task, run, job, parts };
}

export function checkReceiptPart(part: typeof testParts.$inferSelect): z.infer<typeof CheckReceiptPart> {
  return { id: part.id, status: part.status, commit: part.commit, exitCode: part.exitCode, hasError: part.error !== null };
}

function receiptOf(source: Binding): Saved['receipt'] {
  return { status: source.run.status, parts: source.parts.map(checkReceiptPart) };
}

function assertInput(input: Input, source: Binding): void {
  if (input.submissionCommit !== input.checkCommit || input.checkCommit !== source.run.commitSha) throw invalid();
  const ids = new Set(source.parts.map(part => part.id));
  if (input.stages.some(stage => stage.partId !== null && !ids.has(stage.partId))) throw invalid();
}

function assertSaved(record: Saved, source: Binding): void {
  assertInput(record, source);
  if (record.companyId !== source.task.companyId || record.authorId !== source.run.agentId || record.jobId !== source.job.id) throw invalid();
  const actual = receiptOf(source);
  const stored = { ...record.receipt, parts: record.receipt.parts.toSorted((a, b) => a.id.localeCompare(b.id)) };
  if (JSON.stringify(stored) !== JSON.stringify(actual)) throw invalid();
}

function completeReceipt(record: Saved, source: Binding): boolean {
  return record.receipt.status === 'passed' && record.receipt.parts.length === source.run.parts && record.receipt.parts.every(part => part.status === 'passed' && part.commit === record.checkCommit && part.exitCode === 0 && !part.hasError);
}

function failedNumbers(numbers: Saved['numbers']): boolean {
  return (numbers.tests !== null && numbers.tests.failed > 0) || (numbers.worstCrap !== null && numbers.worstCrap >= 10);
}

function failedStage(stage: Saved['stages'][number]): boolean {
  return stage.status === 'failed' || (stage.exitCode !== null && stage.exitCode !== 0);
}

function completeNumbers(numbers: Saved['numbers']): boolean {
  return numbers.tests !== null && numbers.changedLines !== null && numbers.worstCrap !== null && numbers.dryerFlags !== null;
}

function completeStages(record: Saved): boolean {
  return record.scope.paths.length > 0 && record.stages.length === STAGES.length && record.stages.every(stage => stage.status === 'passed' && stage.exitCode === 0 && stage.partId !== null);
}

function qualityStatus(record: Saved, source: Binding): Quality['status'] {
  if (record.receipt.status === 'stopped' || record.stages.some(stage => stage.status === 'cancelled')) return 'cancelled';
  if (record.receipt.status === 'failed' || record.stages.some(failedStage) || failedNumbers(record.numbers)) return 'failed';
  return completeReceipt(record, source) && completeStages(record) && completeNumbers(record.numbers) ? 'passed' : 'partial';
}

type SourceEvent = Pick<typeof taskEvents.$inferSelect, 'id' | 'companyId' | 'data'>;

function recordAt(event: SourceEvent, taskId: string, commit: string, producerId?: string): Saved | null {
  const parsed = AuthorCheckRecord.safeParse(event.data.authorCheck);
  if (!parsed.success) return null;
  const record = parsed.data;
  return record.taskId === taskId && record.checkCommit === commit && record.companyId === event.companyId && (producerId === undefined || record.authorId === producerId) ? record : null;
}

async function evidenceAt(db: Store, event: SourceEvent, taskId: string, commit: string, producerId?: string): Promise<Quality | null> {
  const record = recordAt(event, taskId, commit, producerId);
  if (!record) return null;
  const source = await binding(db, taskId, record.runId);
  assertSaved(record, source);
  const status = qualityStatus(record, source);
  return { status, reason: status === 'passed' ? null : `author-check-${status}`, record, sourceEventId: event.id };
}

/* Only system events are candidates; comments and client JSON cannot manufacture a producer record. */
export async function authorQuality(db: Store, taskId: string, commit: string | null, producerId?: string): Promise<Quality> {
  if (!commit) return { ...unavailableQuality(), reason: 'commit-unavailable' };
  const events = await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.kind, 'comment'), isNull(taskEvents.agentId), isNull(taskEvents.personId))).orderBy(desc(taskEvents.id));
  for (const event of events) {
    try {
      const evidence = await evidenceAt(db, event, taskId, commit, producerId);
      if (evidence) return evidence;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return { ...unavailableQuality(), reason: 'author-check-provenance-changed', sourceEventId: event.id };
    }
  }
  return unavailableQuality();
}

/* Backend port for producer 325. Authority and receipts come from protected server records, never client fields. */
export async function recordAuthorCheck(db: Db, taskId: string, value: Input, validate?: (tx: Tx) => Promise<void>): Promise<number> {
  const input = AuthorCheckInput.parse(value);
  return db.transaction(async tx => {
    await tx.select(idOnly(tasks)).from(tasks).where(eq(tasks.id, taskId)).for('update');
    await validate?.(tx);
    const bound = await binding(tx, taskId, input.runId);
    assertInput(input, bound);
    const record: Saved = { ...input, producer: 'author-check-v1', companyId: bound.task.companyId, taskId, authorId: bound.run.agentId, jobId: bound.job.id, receipt: receiptOf(bound) };
    const digest = createHash('sha256').update(JSON.stringify(record)).digest('hex');
    const records = await tx.select({ id: taskEvents.id, data: taskEvents.data }).from(taskEvents).where(and(eq(taskEvents.taskId, taskId), isNull(taskEvents.agentId), isNull(taskEvents.personId)));
    const same = records.find(event => event.data.authorCheckDigest === digest);
    if (same) return same.id;
    const status = qualityStatus(record, bound);
    const [kept] = await tx.insert(taskEvents).values({ companyId: bound.task.companyId, taskId, kind: 'comment', text: `Author check: ${status} on ${record.checkCommit}.`, data: { authorCheck: record, authorCheckDigest: digest } }).returning({ id: taskEvents.id });
    return kept!.id;
  });
}
