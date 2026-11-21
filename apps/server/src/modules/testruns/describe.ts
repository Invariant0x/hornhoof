import { MAX_TEST_PARTS, EnvironmentSnapshot, requiredTestRuntimes, runsInClass, runtimeVersionMatches, TestExecution, validateEnvironmentDescription, type EnvironmentDescription, type EnvironmentProblem, type RepositoryScope, type RunKind, type ServerMessage, type TestsDescribed, type UnitFingerprint, type Workspace } from '@hornhoof/protocol';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { hashToken } from '../../crypto/tokens.js';
import { departments, testParts, testRuns, type TestEnvironmentRequest, type TestEnvironmentSelection, type TestRunFileCache } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { hasCode } from '../../db/errors.js';
import { builtinOf, nodeIdentity, ownMachine, sameNode, type NodeIdentity } from '../nodes/hub.js';
import { productPlaces, scopeKey, testCapabilities } from './load.js';
export { noteTestCapabilities, scopeKey, testCapabilities } from './load.js';
import { canReach } from '../../auth/access.js';
import { pausedCompanyIds } from '../org/pause-state.js';
import { refuse } from '../tasks/state.js';
import { computerKey } from './capacity.js';
import { pickMachine } from './pick.js';
import { needOf, partBudget } from './part-budget.js';
import { partSpread, planProductParts, type ProductPlan } from './plan-product.js';
import { unitKey } from './plan-environment.js';
import type { PlanningHistory } from './plan-history.js';
import { measuredHistory } from './plan-measured.js';
import { runPurpose } from './purpose.js';
import { AWAY_MS, TEST_MINUTES, WAIT_MS } from './constants.js';
export { productReceipt } from './receipts.js';
import { reuseFor, runModeOf, type ReuseDecision, type RunMode } from './reuse.js';

type ModeInput = { command?: string; suite?: string; parts?: number };
export type TestRunMode = { mode: 'manual'; command: string; parts: number } | { mode: 'product'; suite?: string };
function manualMode(input: ModeInput & { command: string }): TestRunMode {
  if (input.suite !== undefined) throw refuse(400, 'test_mode_conflict', 'test_mode_conflict: choose a manual command or a product suite.');
  if (!input.command.trim()) throw refuse(400, 'task_invalid', 'A manual run needs a nonempty command.');
  return { mode: 'manual', command: input.command, parts: input.parts ?? 1 };
}
export function testRunMode(input: ModeInput, kind: RunKind): TestRunMode {
  if (input.command !== undefined) return manualMode({ ...input, command: input.command });
  if (kind === 'work' || input.parts !== undefined) throw refuse(400, 'task_invalid', 'Work needs a command; product test parts come from the pinned suite inventory.');
  return { mode: 'product', ...(input.suite === undefined ? {} : { suite: input.suite }) };
}

/* An unanswered request is replayed on reconnect or after a minute, under the same id. */
const DESCRIPTION_RETRY_MS = 60_000;
type DescriptionAttempt = { requestId: string; at: number };
const sent = new WeakMap<Ctx, Map<string, DescriptionAttempt>>();
export function repositoryScope(companyId: string, ownerId: string, url: string): RepositoryScope {
  return { companyId, repositoryOwnerId: ownerId, repoUrlHash: hashToken(url) };
}
type Run = typeof testRuns.$inferSelect;
type Place = import('./runs.js').Place;
type Target = { department: typeof departments.$inferSelect | null; repo: NonNullable<Workspace['repo']> | null } | null;
type PlanningSources = { open: (companyId: string) => Promise<Place[]>; target: (run: Run) => Promise<Target> };
type PlanningTransaction = Parameters<Parameters<Ctx['db']['transaction']>[0]>[0];
/* The canonical repository/history and durable reason store are private integration ports, not cache-owner aliases. */
type ProductPlanningPorts = {
  history?: (run: Readonly<Run>, snapshot: EnvironmentSnapshot) => Promise<PlanningHistory | null>;
  record?: (tx: PlanningTransaction, run: Readonly<Run>, plan: ProductPlan) => Promise<void>;
};
const planningSources = new WeakMap<Ctx, PlanningSources>(), planningPorts = new WeakMap<Ctx, ProductPlanningPorts>();
export function setProductPlanningPorts(ctx: Ctx, ports: ProductPlanningPorts): void { planningPorts.set(ctx, ports); }
const requestNode = (ctx: Ctx, request: TestEnvironmentRequest): NodeIdentity | null => request.builtin ? builtinOf(request.builtinMachine ?? ownMachine(ctx.config)) : request.nodeId ? nodeIdentity(request.nodeId) : null;
export function cancelDescription(ctx: Ctx, request: TestEnvironmentRequest | null): void {
  const node = request && requestNode(ctx, request);
  if (node && request?.requestId) ctx.hub.send(node, { type: 'tests.describe.cancel', requestId: request.requestId });
}
export function newEnvironmentRequest(scope: RepositoryScope, mode: Extract<TestRunMode, { mode: 'product' }>, minutes?: number): TestEnvironmentRequest {
  return { version: 1, repositoryScope: scope, ...('suite' in mode ? { suite: mode.suite } : {}), ...(minutes === undefined ? {} : { minutes }), requestId: null, nodeId: null, builtin: false, sentAt: null, attempts: 0, problem: null };
}
/* A release runs the profile of the manifest's full run, which runs everything; a manifest without one runs its default profile. */
function snapshotFor(description: EnvironmentDescription): EnvironmentSnapshot {
  const { manifest } = description;
  return EnvironmentSnapshot.parse({ description, profile: manifest.execution?.fullRun?.profile ?? manifest.defaultProfile });
}
function requestedSuiteIds(snapshot: EnvironmentSnapshot, requested?: string): string[] {
  return requested ? [requested] : snapshot.description.manifest.profiles.find(profile => profile.id === snapshot.profile)!.requiredSuiteIds;
}
function productLeaves(snapshot: EnvironmentSnapshot, requested: string | undefined, history: PlanningHistory | null): TestEnvironmentSelection[] {
  const { manifest } = snapshot.description;
  const inventory = requestedUnits(snapshot, requested);
  const ids = requestedSuiteIds(snapshot, requested);
  const budget = suiteEstimate(history);
  const leaves: TestEnvironmentSelection[] = [];
  for (const suiteId of ids) {
    const selection = { kind: 'suite' as const, suiteId, files: inventory.filter(unit => unit.suiteId === suiteId).map(unit => unit.file) };
    TestExecution.parse({ snapshot, selection });
    leaves.push({ selection, after: [], ...budget(suiteId, selection.files) });
    if (manifest.suites.find(suite => suite.id === suiteId)!.finalChecks?.length) leaves.push({ selection: { kind: 'final', suiteId, files: [] }, after: [leaves.length] });
  }
  if (leaves.length > MAX_TEST_PARTS) throw new Error('The product plan exceeds the supported part count.');
  return leaves;
}
function suiteEstimate(history: PlanningHistory | null) {
  const { durations, costs, unknownFileMs } = planningCosts(history);
  const known = new Map(durations.map(time => [unitKey(time), time.ms]));
  return (suiteId: string, files: string[]): { estimatedMs?: number } => {
    const times = files.map(file => known.get(unitKey({ suiteId, file })));
    if (times.every(ms => ms === undefined)) return {};
    return { estimatedMs: times.reduce<number>((total, ms) => total + (ms ?? unknownFileMs), costs.setupMs + costs.collectMs) };
  };
}
/* The computers free now that may run a part of the run. */
async function freeProductMachines(ctx: Ctx, run: Run, snapshot: EnvironmentSnapshot): Promise<string[]> {
  const sources = planningSources.get(ctx);
  if (!sources) return [];
  const target = await sources.target(run), need = partBudget(needOf(run, target?.department ?? null));
  const places = await productPlaces(ctx, await sources.open(run.companyId), { ...run, environmentSnapshot: snapshot }, need.memoryBytes);
  const free = places.filter(place => pickMachine([{ ...place, reaches: descriptionEligible(ctx, place, target) }], need, ctx.config.runsPerHost) !== null);
  return [...new Set(free.map(computerKey))].sort();
}
function requestedUnits(snapshot: EnvironmentSnapshot, requested?: string): EnvironmentDescription['inventory'] {
  const ids = requestedSuiteIds(snapshot, requested);
  const units = snapshot.description.inventory.filter(unit => ids.includes(unit.suiteId));
  if (ids.some(id => !units.some(unit => unit.suiteId === id))) throw new Error('A requested suite has no canonical files.');
  return units;
}
function planningCosts(history: PlanningHistory | null | undefined) {
  return { durations: history?.durations ?? [], costs: history?.costs ?? { setupMs: 10_000, collectMs: 1000 }, unknownFileMs: history?.unknownFileMs ?? 30_000,
    ...(history?.preparationMs ? { preparationMs: history.preparationMs } : {}) };
}
/* Keep release batches at a planned size and let the node renew the quiet budget while its part makes progress. */
function spreadFor(run: Run, mode: RunMode): ReturnType<typeof partSpread> {
  const full = mode?.mode === 'full';
  return partSpread(full, run.timeoutMs || (full ? 60 : TEST_MINUTES) * 60_000);
}
async function plannedLeaves(ctx: Ctx, run: Run, snapshot: EnvironmentSnapshot, reuse: ReuseDecision, mode: RunMode): Promise<{ leaves: TestEnvironmentSelection[]; plan: ProductPlan | null }> {
  const requested = run.environmentRequest!.suite;
  const history = await (planningPorts.get(ctx)?.history ?? measuredHistory(ctx))(run, snapshot);
  if (!snapshot.description.manifest.execution) return { leaves: productLeaves(snapshot, requested, history), plan: null };
  const units = requestedUnits(snapshot, requested);
  const free = await freeProductMachines(ctx, run, snapshot);
  const plan = await planProductParts({ snapshot, expectedCommitSha: run.commitSha!, purpose: runPurpose(snapshot, requested), units, reuse,
    ...planningCosts(history), ...spreadFor(run, mode),
    availableMachines: free.length, machines: free.map(key => ({ key, pace: history?.paces?.get(key) ?? 1 })) });
  if (!history) plan.reason += ' Historical storage is not bound; setup and collection costs are fallback estimates.';
  return { leaves: plan.leaves, plan };
}
const pendingDescription = (id: string) => and(eq(testRuns.id, id), eq(testRuns.status, 'running'), isNull(testRuns.environmentSnapshot));
const requestMatches = (id: string, requestId: string) => and(pendingDescription(id), sql`${testRuns.environmentRequest}->>'requestId' = ${requestId}`);
class DescriptionMismatch extends Error {}

/* Only validating the node's evidence can call it incompatible. Planning and storage failures belong to the server. */
async function checkedSnapshot(run: Run, value: EnvironmentDescription): Promise<EnvironmentSnapshot> {
  try {
    const description = await validateEnvironmentDescription(value);
    if (description.commitSha !== run.commitSha || scopeKey(description.repositoryScope) !== scopeKey(run.environmentRequest!.repositoryScope)) throw new Error('The pinned source or repository scope differs.');
    const snapshot = snapshotFor(description);
    requestedUnits(snapshot, run.environmentRequest!.suite);
    return snapshot;
  } catch (cause) {
    throw new DescriptionMismatch('The node returned invalid or incompatible pinned environment evidence.', { cause });
  }
}

function descriptionError(error: unknown): EnvironmentProblem {
  if (error instanceof DescriptionMismatch) return { code: 'description_mismatch', detail: error.message };
  if (hasCode(error, '25P04')) return { code: 'transaction_timeout', detail: 'The database ended the environment description lookup or save at its 5 s transaction limit.' };
  return { code: 'save_failed', detail: 'The server could not prepare or save the environment description.' };
}
async function assignedDescription(ctx: Ctx, id: NodeIdentity, message: TestsDescribed): Promise<Run | undefined> {
  const [run] = await ctx.db.select().from(testRuns).where(and(eq(testRuns.status, 'running'), isNull(testRuns.environmentSnapshot), sql`${testRuns.environmentRequest}->>'requestId' = ${message.requestId}`));
  const request = run?.environmentRequest, assigned = request && requestNode(ctx, request);
  if (!run || !request || !assigned || !sameNode(id, assigned) || run.commitSha !== message.commitSha || request.problem) return;
  return run;
}
async function descriptionProblem(ctx: Ctx, run: Run, message: TestsDescribed, problem: EnvironmentProblem): Promise<void> {
  await ctx.db.update(testRuns).set({ environmentRequest: { ...run.environmentRequest!, problem } }).where(requestMatches(run.id, message.requestId));
}
/* A run whose every file was reused has no part to add. */
async function addParts(tx: Pick<Ctx['db'], 'insert'>, run: Run, leaves: TestEnvironmentSelection[]): Promise<void> {
  if (leaves.length) await tx.insert(testParts).values(leaves.map((environmentSelection, index) => ({ companyId: run.companyId, runId: run.id, part: index + 1, environmentSelection })));
}
async function storeDescription(ctx: Ctx, run: Run, message: TestsDescribed, snapshot: EnvironmentSnapshot, leaves: TestEnvironmentSelection[], plan: ProductPlan | null, fileCache: TestRunFileCache | null): Promise<boolean> {
  const description = snapshot.description;
  return ctx.db.transaction(async tx => {
    const [locked] = await tx.select().from(testRuns).where(requestMatches(run.id, message.requestId)).for('update');
    if (!locked || locked.environmentRequest?.problem) return false;
    if (locked.commitSha !== description.commitSha || scopeKey(locked.environmentRequest!.repositoryScope) !== scopeKey(description.repositoryScope)) throw new DescriptionMismatch('The locked run differs from the planned source.');
    if (plan) await planningPorts.get(ctx)?.record?.(tx, locked, plan);
    await tx.update(testRuns).set({ environmentSnapshot: snapshot, environmentHash: description.manifestHash, parts: leaves.length, fileCache }).where(eq(testRuns.id, run.id));
    await addParts(tx, run, leaves);
    return true;
  });
}
/* A part runs only on runtimes of the class that described its run, so a run its describing node could not run itself runs nowhere:
   it ends now with what it lacks, not at its queue deadline. */
function unrunnable(snapshot: EnvironmentSnapshot): EnvironmentProblem | null {
  const own = snapshot.description.runtimeCapabilities;
  if (runsInClass(snapshot, own)) return null;
  const lacks = requiredTestRuntimes(snapshot.description.manifest, snapshot.profile).filter(needed => !own.some(actual => actual.id === needed.id && runtimeVersionMatches(needed.version, actual.version)));
  const detail = `The node that described this run lacks ${lacks.map(runtime => `${runtime.id} ${runtime.version}`).join(', ')}, which profile ${snapshot.profile} needs. A part runs only on runtimes of the class that described its run, so no node can run it.`;
  return { code: 'runtime_missing', detail: detail.slice(0, 2000) };
}
async function saveDescription(ctx: Ctx, run: Run, message: TestsDescribed, value: EnvironmentDescription, prints: UnitFingerprint[]): Promise<EnvironmentProblem | null> {
  const request = run.environmentRequest!, snapshot = await checkedSnapshot(run, value), { description } = snapshot;
  const mode = await runModeOf(ctx, run, description.manifest, description.repositoryScope, prints.length > 0);
  const problem = unrunnable(snapshot);
  if (problem) return problem;
  const reuse = await reuseFor(ctx, mode, snapshot, mode ? requestedUnits(snapshot, request.suite) : [], prints);
  const { leaves, plan } = await plannedLeaves(ctx, run, snapshot, reuse.decision, mode);
  const saved = await storeDescription(ctx, run, message, snapshot, leaves, plan, reuse.fileCache);
  if (saved && plan) ctx.log.info({ runId: run.id, commitSha: description.commitSha, parts: leaves.length, reason: plan.reason, durableReason: planningPorts.get(ctx)?.record !== undefined }, 'Product test part plan');
  return null;
}
export async function acceptDescription(ctx: Ctx, id: NodeIdentity, message: TestsDescribed): Promise<void> {
  const run = await assignedDescription(ctx, id, message);
  if (!run) return;
  if (message.result.status === 'error') {
    if (await retryDescription(ctx, run, message, message.result.problem)) return;
    return descriptionProblem(ctx, run, message, message.result.problem);
  }
  const problem = await saveDescription(ctx, run, message, message.result.description, message.result.fingerprints ?? [])
    .catch(descriptionError);
  if (problem) await descriptionProblem(ctx, run, message, problem);
}
async function descriptionFailure(ctx: Ctx, run: Run, problem: EnvironmentProblem): Promise<void> {
  await ctx.db.transaction(async tx => {
    const [locked] = await tx.select().from(testRuns).where(pendingDescription(run.id)).for('update');
    if (!locked) return;
    const [existing] = await tx.select(idOnly(testParts)).from(testParts).where(eq(testParts.runId, run.id));
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
  return Boolean(away && away + AWAY_MS > Date.now());
}
async function assignDescription(ctx: Ctx, run: Run, open: Place[], target: Target): Promise<TestEnvironmentRequest | null> {
  const request = run.environmentRequest!, place = availableDescription(ctx, open, target);
  if (!place) return null;
  if (request.attempts >= 3) { await descriptionFailure(ctx, run, { code: 'commit_unavailable', detail: 'The metadata node was lost repeatedly.' }); return null; }
  cancelDescription(ctx, request);
  const assigned = { ...request, requestId: randomUUID(), nodeId: place.nodeId, builtin: place.builtin, builtinMachine: place.builtin ? place.builtinMachine : null, sentAt: new Date().toISOString(), attempts: request.attempts + 1 };
  await ctx.db.update(testRuns).set({ environmentRequest: assigned }).where(pendingDescription(run.id)); return assigned;
}
async function currentDescriptionAssignment(ctx: Ctx, run: Run, open: Place[], target: Target): Promise<TestEnvironmentRequest> {
  const request = run.environmentRequest!, assigned = requestNode(ctx, request);
  if (!assigned || !ctx.hub.isOnline(assigned)) return request;
  if (open.some(place => sameNode(place.node, assigned) && descriptionEligible(ctx, place, target))) return request;
  cancelDescription(ctx, request);
  const cleared = { ...request, requestId: null, nodeId: null, builtin: false, sentAt: null };
  await ctx.db.update(testRuns).set({ environmentRequest: cleared }).where(requestMatches(run.id, request.requestId!));
  return cleared;
}
async function dispatchDescription(ctx: Ctx, run: Run, open: Place[], target: Target): Promise<void> {
  let request: TestEnvironmentRequest | null = await currentDescriptionAssignment(ctx, run, open, target);
  const assigned = requestNode(ctx, request);
  if (waitingForReconnect(ctx, assigned)) return;
  if (!assigned || !ctx.hub.isOnline(assigned)) request = await assignDescription(ctx, { ...run, environmentRequest: request }, open, target);
  if (request) publishDescription(ctx, run, request, target?.repo ?? null);
}
function sendDescription(ctx: Ctx, node: NodeIdentity, message: Extract<ServerMessage, { type: 'tests.describe' }>, failed: () => void): void {
  try {
    if (!ctx.hub.send(node, message, error => { if (error) failed(); })) failed();
  } catch { failed(); }
}
function publishDescription(ctx: Ctx, run: Run, request: TestEnvironmentRequest, repo: NonNullable<Target>['repo']): void {
  if (!request.requestId || !repo) return;
  const node = requestNode(ctx, request)!, attempts = sent.get(ctx) ?? new Map<string, DescriptionAttempt>(); sent.set(ctx, attempts);
  const previous = attempts.get(run.id), now = Date.now();
  if (previous?.requestId === request.requestId && now - previous.at < DESCRIPTION_RETRY_MS) return;
  const attempt = { requestId: request.requestId, at: now };
  attempts.set(run.id, attempt);
  const failed = () => { if (attempts.get(run.id) === attempt) attempts.delete(run.id); };
  sendDescription(ctx, node, { type: 'tests.describe', requestId: request.requestId, repositoryScope: request.repositoryScope, commitSha: run.commitSha!, repo: { url: repo.url, token: repo.token } }, failed);
}

export async function pumpDescriptions(ctx: Ctx, open: (companyId: string) => Promise<Place[]>, target: (run: Run) => Promise<Target>, finish: (id: string) => Promise<void>): Promise<void> {
  planningSources.set(ctx, { open, target });
  const paused = await pausedCompanyIds(ctx.db);
  const pending = await ctx.db.select().from(testRuns).where(and(eq(testRuns.status, 'running'), isNull(testRuns.environmentSnapshot), sql`${testRuns.environmentRequest} is not null`));
  for (const run of pending) {
    if (paused.has(run.companyId)) continue;
    const request = run.environmentRequest!, problem = request.problem ?? (Date.now() - run.createdAt.getTime() > WAIT_MS ? { code: 'timeout' as const, detail: 'No product environment was described within the queue deadline.' } : null);
    if (problem) { cancelDescription(ctx, request); await descriptionFailure(ctx, run, problem); await finish(run.id); continue; }
    const found = await target(run);
    if (!found?.repo || hashToken(found.repo.url) !== request.repositoryScope.repoUrlHash) {
      await descriptionFailure(ctx, run, { code: 'commit_unavailable', detail: 'The pinned repository is no longer configured.' }); await finish(run.id); continue;
    }
    await dispatchDescription(ctx, run, await productPlaces(ctx, await open(run.companyId), run), found);
  }
}



export function resetDescriptionDelivery(ctx: Ctx): void { sent.get(ctx)?.clear(); }

async function retryDescription(ctx: Ctx, run: Run, message: TestsDescribed, problem: EnvironmentProblem): Promise<boolean> {
  const request = run.environmentRequest!;
  if (!['cancelled', 'timeout', 'commit_unavailable'].includes(problem.code) || request.attempts >= 3) return false;
  await ctx.db.update(testRuns).set({ environmentRequest: { ...request, requestId: null, nodeId: null, builtin: false, sentAt: null, problem: null } }).where(requestMatches(run.id, message.requestId));
  return true;
}
