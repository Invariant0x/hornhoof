import { MAX_TEST_PARTS, EnvironmentSnapshot, TestExecution, TestEnvironmentReceipt, supportsTestProfile, validateEnvironmentDescription, type EnvironmentDescription, type EnvironmentProblem, type RepositoryScope, type RunKind, type RuntimeCapability, type TestsDescribed, type Workspace } from '@hornhoof/protocol';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { hashToken } from '../../crypto/tokens.js';
import { departments, testParts, testRuns, type TestEnvironmentRequest, type TestEnvironmentSelection } from '../../db/schema.js';
import { BUILTIN, nodeIdentity, sameNode, type NodeIdentity } from '../nodes/hub.js';
import { productPlaces, scopeKey, testCapabilities } from './load.js';
export { noteTestCapabilities, scopeKey, testCapabilities } from './load.js';
import { canReach } from '../../auth/access.js';
import { refuse } from '../tasks/engine.js';

type ModeInput = { command?: string; suite?: string; profile?: string; parts?: number };
export type TestRunMode = { mode: 'manual'; command: string; parts: number } | { mode: 'product'; suite?: string; profile?: string };
function manualMode(input: ModeInput & { command: string }): TestRunMode {
  if (input.suite !== undefined || input.profile !== undefined) throw refuse(400, 'test_mode_conflict', 'test_mode_conflict: choose a manual command or product suite/profile.');
  if (!input.command.trim()) throw refuse(400, 'task_invalid', 'A manual run needs a nonempty command.');
  return { mode: 'manual', command: input.command, parts: input.parts ?? 1 };
}
export function testRunMode(input: ModeInput, kind: RunKind): TestRunMode {
  if (input.command !== undefined) return manualMode({ ...input, command: input.command });
  if (kind === 'work' || input.parts !== undefined) throw refuse(400, 'task_invalid', 'Work needs a command; product test parts come from the pinned suite inventory.');
  return { mode: 'product', ...(input.suite === undefined ? {} : { suite: input.suite }), ...(input.profile === undefined ? {} : { profile: input.profile }) };
}

// Metadata stays bound to the authenticated connection identity; it is never a repository claim.
const sent = new WeakMap<Ctx, Map<string, string>>();
export function repositoryScope(companyId: string, ownerId: string, url: string): RepositoryScope {
  return { companyId, repositoryOwnerId: ownerId, repoUrlHash: hashToken(url) };
}
type Run = typeof testRuns.$inferSelect;
type Place = import('./runs.js').Place;
type Target = { department: typeof departments.$inferSelect | null; repo: NonNullable<Workspace['repo']> | null } | null;
const requestNode = (request: TestEnvironmentRequest): NodeIdentity | null => request.builtin ? BUILTIN : request.nodeId ? nodeIdentity(request.nodeId) : null;
export function cancelDescription(ctx: Ctx, request: TestEnvironmentRequest | null): void {
  const node = request && requestNode(request);
  if (node && request?.requestId) ctx.hub.send(node, { type: 'tests.describe.cancel', requestId: request.requestId });
}
export function newEnvironmentRequest(scope: RepositoryScope, mode: Extract<TestRunMode, { mode: 'product' }>): TestEnvironmentRequest {
  return { version: 1, repositoryScope: scope, ...('suite' in mode ? { suite: mode.suite } : {}), ...('profile' in mode ? { profile: mode.profile } : {}), requestId: null, nodeId: null, builtin: false, sentAt: null, attempts: 0, problem: null };
}
function snapshotFor(description: EnvironmentDescription, request: TestEnvironmentRequest): EnvironmentSnapshot {
  const profile = request.profile ?? description.manifest.defaultProfile;
  const snapshot = EnvironmentSnapshot.parse({ description, profile });
  return snapshot;
}
function productLeaves(snapshot: EnvironmentSnapshot, requested?: string): TestEnvironmentSelection[] {
  const { manifest, inventory } = snapshot.description;
  const ids = requested ? [requested] : manifest.profiles.find(profile => profile.id === snapshot.profile)!.requiredSuiteIds;
  const leaves: TestEnvironmentSelection[] = [];
  for (const suiteId of ids) {
    const selection = { kind: 'suite' as const, suiteId, files: inventory.filter(unit => unit.suiteId === suiteId).map(unit => unit.file) };
    TestExecution.parse({ snapshot, selection });
    leaves.push({ selection, after: [] });
    if (manifest.suites.find(suite => suite.id === suiteId)!.finalChecks?.length) leaves.push({ selection: { kind: 'final', suiteId, files: [] }, after: [leaves.length] });
  }
  if (leaves.length > MAX_TEST_PARTS) throw new Error('The product plan exceeds the supported part count.');
  return leaves;
}
const pendingDescription = (id: string) => and(eq(testRuns.id, id), eq(testRuns.status, 'running'), isNull(testRuns.environmentSnapshot));
const requestMatches = (id: string, requestId: string) => and(pendingDescription(id), sql`${testRuns.environmentRequest}->>'requestId' = ${requestId}`);
async function assignedDescription(ctx: Ctx, id: NodeIdentity, message: TestsDescribed): Promise<Run | undefined> {
  const [run] = await ctx.db.select().from(testRuns).where(and(eq(testRuns.status, 'running'), isNull(testRuns.environmentSnapshot), sql`${testRuns.environmentRequest}->>'requestId' = ${message.requestId}`));
  const request = run?.environmentRequest, assigned = request && requestNode(request);
  if (!run || !request || !assigned || !sameNode(id, assigned) || run.commitSha !== message.commitSha || request.problem) return;
  return run;
}
async function descriptionProblem(ctx: Ctx, run: Run, message: TestsDescribed, problem: EnvironmentProblem): Promise<void> {
  await ctx.db.update(testRuns).set({ environmentRequest: { ...run.environmentRequest!, problem } }).where(requestMatches(run.id, message.requestId));
}
async function saveDescription(ctx: Ctx, run: Run, message: TestsDescribed, value: EnvironmentDescription): Promise<void> {
  const request = run.environmentRequest!, description = await validateEnvironmentDescription(value);
  if (scopeKey(description.repositoryScope) !== scopeKey(request.repositoryScope)) throw new Error('The repository scope differs.');
  const snapshot = snapshotFor(description, request), leaves = productLeaves(snapshot, request.suite);
  await ctx.db.transaction(async tx => {
    const [locked] = await tx.select().from(testRuns).where(requestMatches(run.id, message.requestId)).for('update');
    if (!locked || locked.environmentRequest?.problem) return;
    await tx.update(testRuns).set({ environmentSnapshot: snapshot, environmentHash: description.manifestHash, parts: leaves.length }).where(eq(testRuns.id, run.id));
    await tx.insert(testParts).values(leaves.map((environmentSelection, index) => ({ companyId: run.companyId, runId: run.id, part: index + 1, environmentSelection })));
  });
}
export async function acceptDescription(ctx: Ctx, id: NodeIdentity, message: TestsDescribed): Promise<void> {
  const run = await assignedDescription(ctx, id, message);
  if (!run) return;
  if (message.result.status === 'error') {
    if (await retryDescription(ctx, run, message, message.result.problem)) return;
    return descriptionProblem(ctx, run, message, message.result.problem);
  }
  try { await saveDescription(ctx, run, message, message.result.description); }
  catch { await descriptionProblem(ctx, run, message, { code: 'description_mismatch', detail: 'The node returned invalid or incompatible pinned environment evidence.' }); }
}
async function descriptionFailure(ctx: Ctx, run: Run, problem: EnvironmentProblem): Promise<void> {
  await ctx.db.transaction(async tx => {
    const [locked] = await tx.select().from(testRuns).where(pendingDescription(run.id)).for('update');
    if (!locked) return;
    const [existing] = await tx.select({ id: testParts.id }).from(testParts).where(eq(testParts.runId, run.id));
    if (existing) return;
    await tx.update(testRuns).set({ parts: 1, environmentRequest: { ...locked.environmentRequest!, problem } }).where(eq(testRuns.id, run.id));
    await tx.insert(testParts).values({ companyId: run.companyId, runId: run.id, part: 1, status: 'failed', error: problem.code, tail: problem.detail, finishedAt: new Date() });
  });
}
function descriptionEligible(ctx: Ctx, place: Place, target: Target): boolean {
  return place.lent && (place.access === null || (target?.department ? canReach(place.access, { departmentId: target.department.id, parentId: target.department.parentId }) : place.access.whole)) && testCapabilities(ctx, place.node).testEnvironmentVersion === 1;
}
function availableDescription(ctx: Ctx, open: Place[], target: Target): Place | undefined {
  return open.find(place => descriptionEligible(ctx, place, target));
}
function waitingForReconnect(ctx: Ctx, node: NodeIdentity | null): boolean {
  const away = node && ctx.hub.awaySince(node);
  return Boolean(away && away + 3 * 60_000 > Date.now());
}
async function assignDescription(ctx: Ctx, run: Run, open: Place[], target: Target): Promise<TestEnvironmentRequest | null> {
  const request = run.environmentRequest!, place = availableDescription(ctx, open, target);
  if (!place) return null;
  if (request.attempts >= 3) { await descriptionFailure(ctx, run, { code: 'commit_unavailable', detail: 'The metadata node was lost repeatedly.' }); return null; }
  cancelDescription(ctx, request);
  const assigned = { ...request, requestId: randomUUID(), nodeId: place.nodeId, builtin: place.builtin, sentAt: new Date().toISOString(), attempts: request.attempts + 1 };
  await ctx.db.update(testRuns).set({ environmentRequest: assigned }).where(pendingDescription(run.id)); return assigned;
}
async function currentDescriptionAssignment(ctx: Ctx, run: Run, open: Place[], target: Target): Promise<TestEnvironmentRequest> {
  const request = run.environmentRequest!, assigned = requestNode(request);
  if (!assigned || !ctx.hub.isOnline(assigned)) return request;
  if (open.some(place => sameNode(place.node, assigned) && descriptionEligible(ctx, place, target))) return request;
  cancelDescription(ctx, request);
  const cleared = { ...request, requestId: null, nodeId: null, builtin: false, sentAt: null };
  await ctx.db.update(testRuns).set({ environmentRequest: cleared }).where(requestMatches(run.id, request.requestId!));
  return cleared;
}
async function dispatchDescription(ctx: Ctx, run: Run, open: Place[], target: Target): Promise<void> {
  let request: TestEnvironmentRequest | null = await currentDescriptionAssignment(ctx, run, open, target);
  const assigned = requestNode(request);
  if (waitingForReconnect(ctx, assigned)) return;
  if (!assigned || !ctx.hub.isOnline(assigned)) request = await assignDescription(ctx, { ...run, environmentRequest: request }, open, target);
  if (request) publishDescription(ctx, run, request, target?.repo ?? null);
}
function publishDescription(ctx: Ctx, run: Run, request: TestEnvironmentRequest, repo: NonNullable<Target>['repo']): void {
  if (!request.requestId || !repo) return;
  const node = requestNode(request)!, delivered = sent.get(ctx) ?? new Map<string, string>(); sent.set(ctx, delivered);
  if (delivered.get(run.id) === request.requestId) return;
  if (ctx.hub.send(node, { type: 'tests.describe', requestId: request.requestId, repositoryScope: request.repositoryScope, commitSha: run.commitSha!, repo: { url: repo.url, token: repo.token } })) delivered.set(run.id, request.requestId);
}

export async function pumpDescriptions(ctx: Ctx, open: (companyId: string) => Promise<Place[]>, target: (run: Run) => Promise<Target>, finish: (id: string) => Promise<void>): Promise<void> {
  const pending = await ctx.db.select().from(testRuns).where(and(eq(testRuns.status, 'running'), isNull(testRuns.environmentSnapshot), sql`${testRuns.environmentRequest} is not null`));
  for (const run of pending) {
    const request = run.environmentRequest!, problem = request.problem ?? (Date.now() - run.createdAt.getTime() > 2 * 3_600_000 ? { code: 'timeout' as const, detail: 'No product environment was described within the queue deadline.' } : null);
    if (problem) { cancelDescription(ctx, request); await descriptionFailure(ctx, run, problem); await finish(run.id); continue; }
    const found = await target(run);
    if (!found?.repo || hashToken(found.repo.url) !== request.repositoryScope.repoUrlHash) {
      await descriptionFailure(ctx, run, { code: 'commit_unavailable', detail: 'The pinned repository is no longer configured.' }); await finish(run.id); continue;
    }
    await dispatchDescription(ctx, run, await productPlaces(ctx, await open(run.companyId), run), found);
  }
}



function receiptIdentity(snapshot: EnvironmentSnapshot, receipt: TestEnvironmentReceipt): boolean {
  return receipt.commitSha === snapshot.description.commitSha && receipt.manifestHash === snapshot.description.manifestHash;
}
function receiptSelection(snapshot: EnvironmentSnapshot, selection: TestEnvironmentSelection, receipt: TestEnvironmentReceipt): boolean {
  if (receipt.version === 1) {
    const assigned = selection.selection;
    return 'files' in assigned && receipt.kind === assigned.kind && receipt.suiteId === assigned.suiteId && JSON.stringify(receipt.files) === JSON.stringify(assigned.files);
  }
  const assigned = TestExecution.safeParse({ snapshot, selection: selection.selection }), reported = TestExecution.safeParse({ snapshot, selection: receipt.selection });
  return receipt.profile === snapshot.profile && assigned.success && reported.success && JSON.stringify(assigned.data.selection) === JSON.stringify(reported.data.selection);
}
function receiptOutcomes(snapshot: EnvironmentSnapshot, receipt: TestEnvironmentReceipt, message: Extract<import('@hornhoof/protocol').NodeMessage, { type: 'tests.done' }>): boolean {
  if (receipt.version === 1) return true;
  const preparation = snapshot.description.manifest.execution?.oncePreparation;
  const count = receipt.selection.kind === 'batch' ? receipt.selection.selections.length : (preparation?.suiteIds.length ?? 0) + (preparation?.commands.length ?? 0);
  if (message.commit !== receipt.commitSha || receipt.outcomes.length !== count) return false;
  return !message.ok || (message.exitCode === 0 && message.error === null && receipt.outcomes.every(outcome => outcome.status === 'passed'));
}
function receiptRuntimes(snapshot: EnvironmentSnapshot, receipt: TestEnvironmentReceipt, known: RuntimeCapability[]): boolean {
  return supportsTestProfile(snapshot, receipt.runtimes) && receipt.runtimes.every(actual => known.some(runtime => runtime.id === actual.id && runtime.fingerprint === actual.fingerprint && runtime.version === actual.version));
}
export function productReceipt(snapshot: EnvironmentSnapshot | null, selection: TestEnvironmentSelection | null, message: Extract<import('@hornhoof/protocol').NodeMessage, { type: 'tests.done' }>, known: RuntimeCapability[]): TestEnvironmentReceipt | null {
  const parsed = TestEnvironmentReceipt.safeParse(message.environmentReceipt);
  if (!snapshot || !selection || !parsed.success) return null;
  const receipt = parsed.data;
  return receiptIdentity(snapshot, receipt) && receiptSelection(snapshot, selection, receipt) && receiptOutcomes(snapshot, receipt, message) && receiptRuntimes(snapshot, receipt, known) ? receipt : null;
}
export function resetDescriptionDelivery(ctx: Ctx): void { sent.get(ctx)?.clear(); }

async function retryDescription(ctx: Ctx, run: Run, message: TestsDescribed, problem: EnvironmentProblem): Promise<boolean> {
  const request = run.environmentRequest!;
  if (!['cancelled', 'timeout', 'commit_unavailable'].includes(problem.code) || request.attempts >= 3) return false;
  await ctx.db.update(testRuns).set({ environmentRequest: { ...request, requestId: null, nodeId: null, builtin: false, sentAt: null, problem: null } }).where(requestMatches(run.id, message.requestId));
  return true;
}
