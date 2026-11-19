import { move, refuseOpenUnder, statusNoted, letStuckGo, comingAfter } from './transitions.js';
import { note, published, lastMove, type Note } from './events.js';
import { CLOSED, SILENT_TURNS, GOING_ON_TURNS, COMMIT, refuse, notYours, loadTask, stillOpen, listed, openAfter, taskSpot, giver, waitsForPerson, liveAgent, workingAgent, requireOwner, mayAsk, requestSubject, type Task, type Request, type Actor, type Wake, type Moved, type Tx, type Live } from './state.js';
import { hideCredentialsIn } from '@hornhoof/protocol/redaction';
import { countOnly, idOnly, only } from '../../db/selections.js';
import { applyTurnCleanup, prepareRouteChange, publishRouteChanges, requireTaskHead } from './echelons-update.js';
import { newTrackerFields, type TrackerFields, type TrackerInput } from '../tracker/task-fields.js';
import { nudgeTrackerKeepers } from '../tracker/nudge.js';
import { writeEdit, type TaskEdit } from '../tracker/edit.js';
import { holdPlace } from '../tracker/pipelines.js';
import { submitAtTests, testsReport, type Verification } from './echelons-tests.js';
import { requireBaseOnLine } from './echelons-main.js';
import { acceptCandidate, type AcceptanceInput } from './echelons-accept.js';
import { architectureReport, coordinationReport } from './echelons-report.js';
import { replayedSubmission, submissionOperation, type Submission } from './echelons-operations.js';
import { checkerFor, checkingIdentity, hasChecker, heldCheckingIdentity, keptFromReview, producerIdentity } from './echelons-assign.js';
import { producedCandidate, currentCandidate, currentHanded, requireRepairHistory } from './echelons-candidates.js';
import { acceptDocument, documentHandIn } from './echelons-document.js';
import { submittedHandoff } from './echelons-handoff.js';
import { echelonVerdict } from './echelons-verdict.js';
import { turnkeyReport, turnkeyWork, wouldGoThroughEchelons, type TurnkeyChecked } from './turnkey.js';
import { sortedUnchecked, type UncheckedItem } from './unchecked.js';
import { openTurnOf } from './turn-department.js';
import { createRoute, departmentStages, documentCheck, skippedData } from './echelons-store.js';
import { routeOf, changeRoute, cancelRoutes, endRoutes, type Route } from './route-records.js';
import { isStaged, type EchelonStage } from '@hornhoof/protocol/echelons';
import type { StageRoute } from '../templates/load.js';
import { lastTaskNumber } from './numbers.js';
import type { ApprovalChannel } from '@hornhoof/protocol';
import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { accessOf, canReach, type Access } from '../../auth/access.js';
import type { Db } from '../../db/client.js';
import { agents, attachments, companies, jobs, people, requests, taskEvents, tasks, type DecisionTopic, type RequestOption } from '../../db/schema.js';
import { ApiError, type ErrorReason } from '../../errors.js';
import { refuseNotUrgent, urgencyOfNew } from './urgency.js';
import { canDecide } from '../../auth/decisions.js';
import { checkDelegation, contextMissing, requireDecider, type Delegation } from '../conversation/decision-context.js';
import { commitProof, proofLine } from '../testruns/commit-proof.js';
import { dropEarlierWakes, keepWakes } from './outbox.js';
import { handOff } from './pulses.js';
import { recordCause } from './notification-cause.js';
import { captureReview } from './review-context.js';
import { refusePaused } from './pause.js';
import { repoAt } from '../departments/repository.js';
import type { ReviewVerdict } from './review-verdict.js';
import { checkIndependent, currentIndependent, type IndependentDeclaration, type IndependentPartInput } from './independent.js';
import type { WaitPlan } from '@hornhoof/protocol/waits';
import { alertGoal, goalColumns, type NewGoal } from './wait-goals.js';
import { bindAfter, bindRequest, endRequest, keepWaitsWithMove, rebindAfter, type AfterPlans } from './wait-producers.js';
import { stuckRecipient } from './stuck-route.js';
import { removedEmployee, notifyUnfilledStages, replaceFutureOwners, type UnfilledStage } from './echelons-future.js';
/* A task that still waits for what it comes after takes no work in for it. */
async function refuseWaiting(db: Db | Tx, task: Task): Promise<void> {
  const open = await openAfter(db, task);
  if (open.length) throw refuse(409, 'task_invalid', `#${task.number} waits for ${listed(open)} first. You are woken once it can start.`);
}

/* A promise stands for one of the tasks it comes after, and for nothing else. */
function checkAfterPlans(after: string[], plans: AfterPlans | undefined): void {
  if (Object.keys(plans ?? {}).some(id => !after.includes(id))) throw refuse(400, 'task_invalid', 'A plan names a task this one does not come after.');
}

/* What a task comes after: tasks of the company, each once and none cancelled. hold: they stay as read until the
   transaction ends, so none is done meanwhile unseen. */
async function checkAfter(db: Db | Tx, companyId: string, ids: string[], hold = false): Promise<Task[]> {
  if (new Set(ids).size !== ids.length) throw refuse(400, 'task_invalid', 'A task it comes after is listed twice.');
  const read = db.select().from(tasks).where(inArray(tasks.id, ids));
  const rows = ids.length ? await (hold ? read.orderBy(asc(tasks.id)).for('share') : read) : [];
  for (const id of ids) {
    const t = rows.find(r => r.id === id);
    if (!t || t.companyId !== companyId) throw refuse(400, 'task_invalid', `There is no task ${id} to come after.`);
    if (t.status === 'cancelled') throw refuse(400, 'task_invalid', `#${t.number} is cancelled, so nothing can come after it.`);
  }
  return rows;
}

/* A task never waits for a task it is part of, however far up: that one is done only once the work under it is. */
async function refuseAbove(db: Db | Tx, parentId: string | null, ids: string[]): Promise<void> {
  for (let id = ids.length ? parentId : null; id; ) {
    const [up] = await db.select({ id: tasks.id, number: tasks.number, parentId: tasks.parentId }).from(tasks).where(eq(tasks.id, id));
    if (!up) return;
    if (ids.includes(up.id)) throw refuse(400, 'task_invalid', `#${up.number} is the task this work is part of, so it cannot come after it: #${up.number} is done only once the work under it is.`);
    id = up.parentId;
  }
}

/* Nor for work under it, however far down: that work is part of it. */
async function refuseBelow(db: Db | Tx, task: Task, ids: string[]): Promise<void> {
  let level = ids.length ? [task.id] : [];
  while (level.length) {
    const rows = await db.select({ id: tasks.id, number: tasks.number }).from(tasks).where(inArray(tasks.parentId, level));
    const under = rows.find(r => ids.includes(r.id));
    if (under) throw refuse(400, 'task_invalid', `#${under.number} is work under #${task.number}, so #${task.number} cannot come after it: the work under a task is part of it.`);
    level = rows.map(r => r.id);
  }
}

/* JSON lists of ids that hold any of these. */
const holdsAny = (list: typeof tasks.after, ids: string[]) => sql`${list} ?| array[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::text[]`;

/* The notes go with the move, and people hear of it once the move is in. */
function stuckGoes(ctx: Live, task: Task): { also: (tx: Tx) => Promise<void>; tell: () => void } {
  let gone = false;
  return {
    also: async tx => {
      gone = await letStuckGo(tx, task.id);
    },
    tell: () => {
      if (gone) ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
    },
  };
}

export type NewTask = {
  resultKind?: 'code' | 'document' | 'coordination';
  title: string;
  brief: string;
  body: string;
  departmentId: string | null;
  productId?: string | null;
  parentId?: string | null;
  assigneeAgentId: string;
  /* Optional distinct employee who prepares the Architecture plan before Development starts with assigneeAgentId. */
  architectAgentId?: string;
  /* Executable work starts with this employee; coordination has no code producer. */
  executor?: boolean;
  reviewerAgentId?: string;
  securityAgentId?: string;
  testsAgentId?: string;
  cleanup?: boolean;
  paths?: string[];
  /* Tasks of the same turn that must be done first. */
  after?: string[];
  /* What the giver promises for each of them, by id, in place of the department's dates. */
  afterPlans?: AfterPlans;
  independentPart?: IndependentPartInput;
  independentNone?: string;
  workKind?: Task['workKind'];
  riskClass?: Task['riskClass'];
  /* Of a task with nothing above it; one under a task is what that task is. */
  urgent?: boolean;
  small?: boolean;
} & TrackerInput;

async function checkIndependentExecutor(db: Db, departmentId: string | null, part: IndependentPartInput): Promise<void> {
  const agent = await workingAgent(db, null, part.executor);
  if (agent.departmentId !== departmentId) throw refuse(403, 'task_not_yours', `${agent.name} does not work in this department.`);
}

async function insertIndependent(tx: Tx, parent: Task, part: IndependentPartInput, actor: Actor, plan: StageRoute): Promise<{ child: Task; wake: Wake }> {
  await tx.select(idOnly(companies)).from(companies).where(eq(companies.id, parent.companyId)).for('no key update');
  const last = await lastTaskNumber(tx, parent.companyId);
  const [child] = await tx.insert(tasks).values({
    companyId: parent.companyId,
    number: last + 1,
    parentId: parent.id,
    departmentId: parent.departmentId,
    productId: parent.productId,
    title: part.title.trim(),
    brief: part.brief.trim(),
    body: part.body,
    assigneeAgentId: part.executor,
    executorAgentId: part.executor,
    after: [],
    workKind: parent.workKind,
    riskClass: parent.riskClass,
    urgent: parent.urgent,
    /* A part of the same work answers to the same person and serves its whole's goal. */
    responsiblePersonId: parent.responsiblePersonId,
    dueAt: parent.dueAt,
    createdByPersonId: actor.personId ?? null,
    createdByAgentId: actor.agentId ?? null,
    updatedAt: new Date(),
  }).returning();
  /* A part of the same work may touch what its whole may, as the head approved it there. */
  const whole = await routeOf(tx, parent);
  const skipped = await createRoute(tx, child!, { paths: whole.paths, ...(whole.state.resultKind === 'document' ? { resultKind: 'document' } : {}) }, plan);
  const event = await note(tx, child!, { kind: 'created', actor, text: child!.brief, data: { toStatus: child!.status, assignee: child!.assigneeAgentId, after: [], independentPartOf: parent.id, ...skippedData(skipped) } });
  const wake: Wake = { agentId: child!.assigneeAgentId!, taskId: child!.id, why: 'assigned' };
  recordCause([wake], { kind: 'created', actor }, event.id, child!);
  return { child: child!, wake };
}

/* Who a new task gives work to, as urgent as it comes out: a word nobody may say is refused when the task is made. */
function checkNewHolders(ctx: Ctx, actor: Actor, companyId: string, parent: Task | null, input: NewTask, declaration: IndependentDeclaration | null): Promise<void> {
  const urgent = parent ? parent.urgent : input.urgent === true;
  const part = declaration?.kind === 'part' ? [declaration.part.executor] : [];
  const holders = [input.assigneeAgentId, ...(input.architectAgentId ? [input.architectAgentId] : []), ...part];
  return refuseNotUrgent(ctx, actor, companyId, { urgent, productId: input.productId ?? null }, holders);
}

type NewTaskSetup = { assignee: Awaited<ReturnType<typeof workingAgent>>; architect: Awaited<ReturnType<typeof workingAgent>> | null; parent: Task | null; declaration: IndependentDeclaration | null; plan: StageRoute; tracker: TrackerFields };

function checkNewTaskFields(input: NewTask): void {
  if (!input.title.trim()) throw refuse(400, 'task_invalid', 'A task needs a title.');
}

function inNewTaskScope(agent: typeof agents.$inferSelect, input: NewTask): boolean {
  return agent.departmentId === input.departmentId && (!agent.productId || agent.productId === input.productId);
}

async function stagedArchitect(ctx: Ctx, assignee: typeof agents.$inferSelect, architect: typeof agents.$inferSelect): Promise<typeof agents.$inferSelect | null> {
  if (!(await wouldGoThroughEchelons(ctx.db, { companyId: assignee.companyId, holderId: assignee.id }))) return null;
  if (!(await wouldGoThroughEchelons(ctx.db, { companyId: assignee.companyId, holderId: architect.id }))) {
    throw refuse(409, 'task_invalid', 'A member of a turnkey team takes only their own whole result, never a separate Architecture stage.');
  }
  return architect;
}

async function resolveArchitect(ctx: Ctx, assignee: typeof agents.$inferSelect, input: NewTask, plan: StageRoute): Promise<typeof agents.$inferSelect | null> {
  if (!input.architectAgentId) return null;
  const architect = await workingAgent(ctx.db, assignee.companyId, input.architectAgentId);
  if (!inNewTaskScope(architect, input)) throw refuse(400, 'task_invalid', 'Architecture needs an employee in the task scope.');
  const separate = architect.id !== assignee.id && !input.small && input.resultKind !== 'coordination' && plan.stages.some(step => step.stage === 'architecture');
  return separate ? stagedArchitect(ctx, assignee, architect) : null;
}

async function prepareNewTask(ctx: Ctx, actor: Actor, input: NewTask): Promise<NewTaskSetup> {
  const assignee = await workingAgent(ctx.db, null, input.assigneeAgentId);
  checkNewTaskFields(input);
  checkAfterPlans(input.after ?? [], input.afterPlans);
  const declaration = checkIndependent(input.after ?? [], input.independentPart, input.independentNone, null);
  if (declaration?.kind === 'part') await checkIndependentExecutor(ctx.db, input.departmentId, declaration.part);
  await requireNewCleanup(ctx, actor, assignee.companyId, input);
  await requireNewReviewer(ctx, assignee, input);
  const parent = input.parentId ? await loadTask(ctx.db, input.parentId) : null;
  if (parent) stillOpen(parent);
  await checkNewHolders(ctx, actor, assignee.companyId, parent, input, declaration);
  const tracker = await newTrackerFields(ctx, assignee.companyId, taskSpot({ departmentId: input.departmentId, productId: input.productId ?? null }), parent, input, assignee.id);
  const plan = await departmentStages(ctx, input.departmentId, tracker.pipelineId);
  const architect = await resolveArchitect(ctx, assignee, input, plan);
  return { assignee, architect, parent, declaration, plan, tracker };
}

async function requireNewCleanup(ctx: Ctx, actor: Actor, companyId: string, input: NewTask): Promise<void> {
  if (input.cleanup !== undefined) {
    const head = actor.agentId ? await liveAgent(ctx.db, companyId, actor.agentId) : null;
    if (head?.kind !== 'orchestrator' && (head?.kind !== 'head' || head.departmentId !== input.departmentId)) throw refuse(403, 'task_not_yours', 'Only the department head or the orchestrator may request optional Cleanup.');
  }
}

async function requireNewReviewer(ctx: Ctx, assignee: typeof agents.$inferSelect, input: NewTask): Promise<void> {
  if (!input.reviewerAgentId) return;
  const reviewer = await workingAgent(ctx.db, assignee.companyId, input.reviewerAgentId);
  if (reviewer.id === assignee.id || !inNewTaskScope(reviewer, input)) throw refuse(400, 'task_invalid', 'Review needs another employee in the task scope.');
}

async function parentForNewTask(tx: Tx, parent: Task | null): Promise<Task | null> {
  if (!parent) return null;
  const [now] = await tx.select().from(tasks).where(eq(tasks.id, parent.id)).for('no key update');
  stillOpen(now!);
  const route = await routeOf(tx, now!);
  if (isStaged(route.state.resultKind) && !['architecture', 'development'].includes(route.state.stage ?? '')) throw refuse(409, 'task_invalid', 'A checking candidate cannot acquire unfinished child work.');
  const open = await openAfter(tx, now!);
  if (open.length) throw refuse(409, 'task_invalid', `#${now!.number} waits for ${listed(open)} first, so no work goes under it yet. You are woken once it can start.`);
  return now!;
}

function independentData(declaration: IndependentDeclaration | null): Record<string, unknown> {
  if (declaration?.kind === 'part') return { independentPart: declaration.part };
  if (declaration?.kind === 'none') return { independentNone: declaration.reason };
  return {};
}

function newTaskValues(actor: Actor, input: NewTask, { assignee, architect, parent, tracker }: NewTaskSetup, position: { urgent: boolean; number: number }): typeof tasks.$inferInsert {
  const initialOwner = architect ?? assignee;
  return {
        ...tracker,
        companyId: assignee.companyId,
        number: position.number,
        parentId: parent?.id ?? null,
        departmentId: input.departmentId,
        productId: input.productId ?? null,
        title: input.title.trim(),
        brief: input.brief.trim(),
        body: input.body,
        assigneeAgentId: initialOwner.id,
        executorAgentId: input.executor ? assignee.id : null,
        after: input.after ?? [],
        workKind: input.workKind,
        riskClass: input.riskClass,
        urgent: position.urgent,
        small: input.small === true,
        createdByPersonId: actor.personId ?? null,
        createdByAgentId: actor.agentId ?? null,
        updatedAt: new Date(),
      };
}

type CreatedTask = Moved & { independent: Task | null };

async function afterForNewTask(tx: Tx, companyId: string, parent: Task | null, input: NewTask): Promise<Task[]> {
  const after = await checkAfter(tx, companyId, input.after ?? [], true);
  await refuseAbove(tx, parent?.id ?? null, input.after ?? []);
  return after;
}

async function insertNewTask(tx: Tx, actor: Actor, input: NewTask, setup: NewTaskSetup): Promise<CreatedTask> {
  const { assignee, parent, declaration, plan } = setup;
  let independent: Task | null = null;
  const wakes: Wake[] = [];
  /* Numbers go up one by one per company, so creating tasks waits on the company row. */
  await tx.select(idOnly(companies)).from(companies).where(eq(companies.id, assignee.companyId)).for('no key update');
  /* Its pipeline before any task, as a change of the pipeline takes it: a stage taken off it since it was checked is a
     conflict. */
  await holdPlace(tx, setup.tracker);
  /* A parent cancelled meanwhile takes no new work; one cancelled after this waits and cancels the new task with it. */
  const above = await parentForNewTask(tx, parent);
  /* With the company held, so a change of urgency on its way reaches this task, or waits for it. */
  const urgent = await urgencyOfNew(tx, assignee.companyId, actor, above, input.urgent, input.departmentId);
  const last = await lastTaskNumber(tx, assignee.companyId);
  /* One of them done at this moment would not see the new task wait for it, so they are held while it is decided
     whether it waits: that one is done after the task is made, and starts it. */
  const after = await afterForNewTask(tx, assignee.companyId, parent, input);
  const waits = after.some(t => t.status !== 'done');
  const [row] = await tx
    .insert(tasks)
    .values(newTaskValues(actor, input, setup, { urgent, number: last + 1 }))
    .returning();
  const skipped = await createRoute(tx, row!, input, plan);
  const event = await note(tx, row!, { kind: 'created', actor, text: row!.brief, data: {
    toStatus: row!.status,
    assignee: row!.assigneeAgentId,
    after: row!.after,
    ...independentData(declaration),
    ...skippedData(skipped),
  } });
  await bindAfter(tx, row!, after, input.afterPlans, actor);
  if (declaration?.kind === 'part') {
    const made = await insertIndependent(tx, row!, declaration.part, actor, plan);
    independent = made.child;
    wakes.push(made.wake);
  }
  /* One that waits for what it comes after is not given out yet: the move that finishes the last of them wakes its holder. */
  if (!waits) wakes.push({ agentId: row!.assigneeAgentId!, taskId: row!.id, why: 'assigned' });
  recordCause(wakes, { kind: 'created', actor }, event.id, row!);
  await keepWakes(tx, row!.companyId, wakes);
  return { task: row!, wakes, independent };
}

/* Whether work of a department with no repository goes through its stages as a document: from an employee outside the
   turnkey teams, where the route of the department has a check and somebody else there carries its skill. Anywhere else such
   work is done as before, by its holder alone. */
async function handsInDocument(ctx: Ctx, input: NewTask): Promise<boolean> {
  const check = documentCheck(await departmentStages(ctx, input.departmentId));
  if (!check) return false;
  const author = await workingAgent(ctx.db, null, input.assigneeAgentId);
  if (!(await hasChecker(ctx.db, author, check))) return false;
  return wouldGoThroughEchelons(ctx.db, { companyId: author.companyId, holderId: author.id });
}

async function executorResult(ctx: Ctx, input: NewTask): Promise<NonNullable<NewTask['resultKind']>> {
  if (await repoAt(ctx, [input.productId ?? null, input.departmentId])) return 'code';
  return await handsInDocument(ctx, input) ? 'document' : 'coordination';
}

export async function createTask(ctx: Ctx, actor: Actor, input: NewTask): Promise<Moved> {
  input = hideCredentialsIn(input);
  if (input.resultKind === undefined && input.executor) {
    const resultKind = await executorResult(ctx, input);
    input = { ...input, resultKind, executor: resultKind !== 'coordination' };
  }
  const setup = await prepareNewTask(ctx, actor, input);
  const { task, wakes, independent } = await ctx.db.transaction(tx => insertNewTask(tx, actor, input, setup));
  published(ctx, task);
  await nudgeTrackerKeepers(ctx, task, actor.agentId);
  if (independent) published(ctx, independent);
  await handOff(ctx, actor, task);
  if (independent) await handOff(ctx, actor, independent);
  return { task, wakes };
}

export async function submissionTask(ctx: Live, agentId: string, taskId: string): Promise<Task> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  const kind = (await routeOf(ctx.db, task)).state.resultKind;
  if (kind === 'turnkey') throw turnkeyWork(task);
  if (!isStaged(kind)) throw refuse(400, 'task_invalid', `#${task.number} has a coordination result. Report its checked child results.`);
  if (task.assigneeAgentId !== agentId) throw notYours(task, 'is not waiting for your work');
  refusePaused(task);
  if (task.status === 'waiting' && (await waitsForPerson(ctx.db, task.id))) throw refuse(409, 'task_invalid', `#${task.number} waits for a person's answer first.`);
  await refuseWaiting(ctx.db, task);
  await refuseOpenUnder(ctx.db, task);
  return task;
}

/* The current producing owner records an immutable candidate and hands it forward. */
export async function submit(ctx: Live, agentId: string, taskId: string, r: Submission): Promise<Moved> {
  const before = await loadTask(ctx.db, taskId);
  await liveAgent(ctx.db, before.companyId, agentId);
  const operation = submissionOperation(r);
  const replay = await replayedSubmission(ctx.db, before, agentId, operation);
  if (replay) return replay;
  try {
    return await submitCandidate(ctx, agentId, taskId, r, operation);
  } catch (error) {
    if (operation && error instanceof ApiError && [403, 409].includes(error.status)) {
      const repeated = await replayedSubmission(ctx.db, await loadTask(ctx.db, taskId), agentId, operation);
      if (repeated) return repeated;
    }
    throw error;
  }
}

function requireSubmissionStage(task: Task, route: Route): void {
  if (route.state.resultKind === 'coordination') throw refuse(400, 'task_invalid', 'A coordination result has no code candidate. Report its checked child results.');
  if (!['development', 'review', 'security', 'cleanup', 'tests'].includes(route.state.stage ?? '') || route.state.phase !== 'active') throw notYours(task, 'is not waiting for code from your current stage');
}

/* The commit as it is handed in: read from the repository, inside the paths the head approved, and on top of what the
   stage received. Development names the base every later stage keeps, so it starts on a line its department releases. */
async function commitHandIn(ctx: Live, agentId: string, task: Task, route: Route, r: Submission) {
  const prior = route.state.candidateId ? await currentCandidate(ctx.db, task, route) : null;
  const checkerStage = route.state.stage !== 'development';
  const review = await captureReview(ctx, { ...task, executorAgentId: agentId }, r.review, prior?.branch);
  const producer = await producerIdentity(ctx.db, task, agentId);
  if (prior && checkerStage) await checkingIdentity(ctx, task, route, prior);
  const candidate = producedCandidate(route, producer, review);
  if (prior) await requireRepairHistory(ctx, task, prior, candidate);
  if (!checkerStage) await requireBaseOnLine(ctx, task, candidate.baseCommit);
  return { input: checkerStage ? prior : null, candidate, review };
}

async function submitCandidate(ctx: Live, agentId: string, taskId: string, r: Submission, operation: ReturnType<typeof submissionOperation>): Promise<Moved> {
  const task = await submissionTask(ctx, agentId, taskId);
  const route = await routeOf(ctx.db, task);
  requireSubmissionStage(task, route);
  if (route.state.stage === 'tests') return submitAtTests(ctx, agentId, task, route, r, operation);
  const { input, candidate, review } = route.state.resultKind === 'document' ? await documentHandIn(ctx, agentId, task, route, r) : await commitHandIn(ctx, agentId, task, route, r);
  const next = await submittedHandoff(ctx, task, route, candidate);
  const unstuck = stuckGoes(ctx, task);
  const row = await move(ctx, task, next.set, {
    kind: 'submitted', actor: { agentId }, text: r.summary, returned: true,
    data: { evidence: r.evidence, candidate, ...(operation ? { operation } : {}), routeRevision: route.revision, ...(review ? { review } : {}), ...(next.authorCheckSkip ? { authorCheckSkip: next.authorCheckSkip } : {}), ...skippedData(next.skipped) },
  }, async tx => {
    if (input) await heldCheckingIdentity(tx, task, route, input);
    await changeRoute(tx, route, next.state);
    await unstuck.also(tx);
  }, next.wakes);
  unstuck.tell();
  return { task: row, wakes: next.wakes };
}

type Verdict = ReviewVerdict & { comment: string };

/* One current checker owns both its verdict and its fixes. */
export async function verdict(ctx: Live, agentId: string, taskId: string, v: Verdict): Promise<Moved> {
  return echelonVerdict(ctx, agentId, taskId, v);
}

function requireReporter(task: Task, agentId: string): void {
  requireOwner(task, agentId, 'is not yours to report');
}

async function reportToResolver(ctx: Live, agentId: string, task: Task, summary: string, n: Note): Promise<Moved> {
  /* A person gave it, so an internal resolver has to unblock it. */
  const [asker] = await ctx.db.select().from(agents).where(eq(agents.id, agentId));
  const recipient = asker ? await stuckRecipient(ctx.db, asker, task) : null;
  let wakes: Wake[] = [];
  const row = await move(ctx, task, { status: 'waiting' }, n, async tx => {
    await letStuckGo(tx, task.id);
    const [note] = await tx.insert(requests).values({ companyId: task.companyId, taskId: task.id, agentId, kind: 'stuck', text: summary, decisionTopic: 'task', audience: 'internal', triageAgentId: recipient?.id ?? null }).returning();
    await bindRequest(tx, task, note!, { agentId });
    wakes = recipient ? [{ agentId: recipient.id, taskId: task.id, why: 'explain', text: note!.id }] : [];
    await keepWakes(tx, task.companyId, wakes);
  });
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  return { task: row, wakes };
}

type ReportInput = { done: boolean; summary: string; verification?: Verification; acceptance?: AcceptanceInput; turnkey?: TurnkeyChecked };
type ReportStage = 'acceptance' | 'tests' | 'architecture' | 'coordination' | 'turnkey';

function reportedStage(route: Route, done: boolean): ReportStage | null {
  if (route.state.resultKind === 'turnkey') return done ? 'turnkey' : null;
  if (done && route.state.phase === 'ready') return 'acceptance';
  if (route.state.stage === 'tests' && route.state.phase === 'active') return 'tests';
  if (done && route.state.stage === 'architecture') return 'architecture';
  if (done && route.state.resultKind === 'coordination') return 'coordination';
  return null;
}

async function reportStage(ctx: Live, task: Task, route: Route, agentId: string, input: ReportInput, stage: ReportStage): Promise<Moved> {
  stillOpen(task);
  await refuseWaiting(ctx.db, task);
  switch (stage) {
    case 'acceptance': return route.state.resultKind === 'document' ? acceptDocument(ctx, task, route, agentId, input.summary) : acceptCandidate(ctx, task, route, agentId, input.summary, input.acceptance);
    case 'tests': return testsReport(ctx, task, route, agentId, input.summary, input.verification, input.done);
    case 'architecture': return architectureReport(ctx, task, route, agentId, input.summary);
    case 'coordination': return coordinationReport(ctx, task, route, agentId, input.summary);
    case 'turnkey':
      if (input.verification || input.acceptance) throw turnkeyWork(task);
      return turnkeyReport(ctx, task, route, agentId, input.summary, input.turnkey);
  }
}

export async function report(ctx: Live, agentId: string, taskId: string, r: ReportInput): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  refusePaused(task);
  const route = await routeOf(ctx.db, task);
  const stage = reportedStage(route, r.done);
  if (r.turnkey && stage !== 'turnkey') throw refuse(400, 'task_invalid', `turnkey names what the holder of turnkey work checked as it closes it, and #${task.number} is no such report.`);
  if (stage) return reportStage(ctx, task, route, agentId, r, stage);
  if (isStaged(route.state.resultKind)) throw refuse(400, 'task_invalid', 'Use the current executable stage command, or blocked when work cannot continue. A report cannot bypass Review and Tests.');
  requireReporter(task, agentId);
  await refuseWaiting(ctx.db, task);
  const n: Note = { kind: 'report', actor: { agentId }, text: r.summary, data: { done: r.done }, returned: true };
  const unstuck = stuckGoes(ctx, task);
  if (task.createdByAgentId) {
    const wakes = giver(task, 'blocked', agentId, r.summary);
    const row = await move(ctx, task, { status: 'blocked' }, n, unstuck.also, wakes);
    unstuck.tell();
    return { task: row, wakes };
  }
  return reportToResolver(ctx, agentId, task, r.summary, n);
}

/* The executor cannot go on without its head. */
export async function blocked(ctx: Live, agentId: string, taskId: string, why: string): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  if (task.assigneeAgentId !== agentId) throw notYours(task, 'is not with you');
  if (task.status === 'blocked') throw refuse(409, 'task_invalid', `#${task.number} is blocked already, and whoever gave it out was told. Go on if what you read lets you, else end this turn.`);
  refusePaused(task);
  await refuseWaiting(ctx.db, task);
  const wakes = giver(task, 'blocked', agentId, why);
  const row = await move(ctx, task, { status: 'blocked' }, { kind: 'blocked', actor: { agentId }, text: why, returned: true }, undefined, wakes);
  return { task: row, wakes };
}

/* Open tasks that come after any of the cancelled ones keep waiting, and whoever made each hears so: its agent, or the
   orchestrator for a person's. waiting: those whose maker cancelled, who hears it in the answer instead. */
async function afterCancelled(tx: Tx, actor: Actor, cancelled: Task[]): Promise<{ wakes: Wake[]; waiting: Task[] }> {
  if (!cancelled.length) return { wakes: [], waiting: [] };
  const left = await tx.select().from(tasks).where(comingAfter(cancelled, holdsAny(tasks.after, cancelled.map(t => t.id)))).orderBy(asc(tasks.number));
  const [orchestrator] = left.some(t => !t.createdByAgentId)
    ? await tx.select(idOnly(agents)).from(agents).where(and(eq(agents.companyId, cancelled[0]!.companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt)))
    : [];
  const wakes: Wake[] = [];
  const waiting: Task[] = [];
  for (const t of left) {
    const maker = t.createdByAgentId ?? orchestrator?.id;
    if (!maker) continue;
    if (maker === actor.agentId) waiting.push(t);
    else wakes.push({ agentId: maker, taskId: t.id, why: 'after_cancelled', text: listed(cancelled.filter(c => t.after.includes(c.id))) });
  }
  return { wakes, waiting };
}

/* Cancels every open task under the task, level by level, each saying why in its log; questions waiting on the task and
   on them are withdrawn. The cancelled tasks, in the order they ended. */
async function endUnder(tx: Tx, task: Task, actor: Actor, why: string): Promise<Task[]> {
  const ended: Task[] = [];
  let level = [task.id];
  while (level.length) {
    const was = new Map((await tx.select({ id: tasks.id, status: tasks.status }).from(tasks).where(and(inArray(tasks.parentId, level), notInArray(tasks.status, [...CLOSED]))).for('update')).map(t => [t.id, t.status]));
    const below = await tx
      .update(tasks)
      .set({ status: 'cancelled', closedAt: new Date(), assigneeAgentId: null, externalWait: null, paused: null, updatedAt: new Date(), version: sql`${tasks.version} + 1` })
      .where(and(inArray(tasks.parentId, level), notInArray(tasks.status, [...CLOSED])))
      .returning();
    for (const t of below) {
      const event = await note(tx, t, statusNoted({ kind: 'cancelled', actor, text: why }, was.get(t.id) ?? t.status, t.status));
      await keepWaitsWithMove(tx, t, t, { kind: 'cancelled', actor, eventId: event.id });
      /* Work cancelled with the task above it needs none of the turns kept for it. */
      await dropEarlierWakes(tx, t.id);
    }
    ended.push(...below);
    level = below.map(t => t.id);
  }
  await tx
    .update(requests)
    .set({ status: 'withdrawn', answeredAt: new Date() })
    .where(and(inArray(requests.taskId, [task.id, ...ended.map(t => t.id)]), eq(requests.status, 'open')));
  await cancelRoutes(tx, task.companyId, ended.map(t => t.id));
  return ended;
}

/* What follows a close for the work cancelled under it: each of them shown again, and the trackers of other departments told. */
async function endedUnder(ctx: Live, task: Task, actor: Actor, ended: Task[]): Promise<void> {
  for (const t of ended) published(ctx, t);
  /* The task's own department heard of it with the move; work under it elsewhere is heard of in its own. */
  for (const departmentId of new Set(ended.map(t => t.departmentId).filter(d => d !== task.departmentId))) await nudgeTrackerKeepers(ctx, { companyId: task.companyId, departmentId }, actor.agentId);
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
}

type Closed = Moved & { closed: string[]; waiting: Task[] };

/* Ends the task and every open task under it; questions waiting on them are withdrawn. Whoever gave it out hears why.
   closed names every task that ended, for their turns to stop; waiting the open tasks that came after them, which the
   one who cancelled made. */
export async function cancel(ctx: Live, actor: Actor, taskId: string, why: string): Promise<Closed> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  const ended: Task[] = [];
  let waiting: Task[] = [];
  const wakes = giver(task, 'cancelled', actor.agentId, why.trim());
  const row = await move(ctx, task, { status: 'cancelled', closedAt: new Date(), assigneeAgentId: null }, { kind: 'cancelled', actor, text: why }, async (tx, row) => {
    ended.push(...(await endUnder(tx, task, actor, `#${task.number} was cancelled.`)));
    await cancelRoutes(tx, task.companyId, [taskId]);
    const after = await afterCancelled(tx, actor, [row, ...ended]);
    wakes.push(...after.wakes);
    waiting = after.waiting;
  }, wakes);
  await endedUnder(ctx, task, actor, ended);
  return { task: row, wakes, closed: [taskId, ...ended.map(t => t.id)], waiting };
}

/* The orchestrator closes a task in any state it stands in, past its route: done or cancelled, with its reason in the log as
   its own act. Done closes the record and nothing else: the work nobody finished under it is cancelled with it, its result
   is accepted by nobody and joins no turn, so no release or main takes it on this. Questions and waits on it end with it. */
export async function closeTask(ctx: Live, actor: Actor, taskId: string, close: { status: 'done' | 'cancelled'; why: string }): Promise<Closed> {
  const task = await loadTask(ctx.db, taskId);
  const why = close.why.trim();
  const [closer] = actor.agentId ? await ctx.db.select(only(agents, 'kind')).from(agents).where(and(eq(agents.id, actor.agentId), eq(agents.companyId, task.companyId), isNull(agents.removedAt))) : [];
  if (closer?.kind !== 'orchestrator') throw notYours(task, 'is closed past its route only by the orchestrator: close it through its own moves, or cancel it');
  stillOpen(task);
  if (!why) throw refuse(400, 'task_invalid', `Say why #${task.number} closes.`);
  if (close.status === 'cancelled') return cancel(ctx, actor, taskId, why);
  const ended: Task[] = [];
  let waiting: Task[] = [];
  const wakes = giver(task, 'reported', actor.agentId, `The orchestrator closed it: ${why}`);
  const row = await move(ctx, task, { status: 'done', closedAt: new Date(), assigneeAgentId: null, silent: 0 }, { kind: 'done', actor, text: why, data: { byOrchestrator: true }, endsWorkUnder: true }, async (tx, row) => {
    ended.push(...(await endUnder(tx, row, actor, `#${task.number} was closed by the orchestrator.`)));
    await endRoutes(tx, task.companyId, [taskId], 'done');
    const after = await afterCancelled(tx, actor, ended);
    wakes.push(...after.wakes);
    waiting = after.waiting;
  }, wakes);
  await endedUnder(ctx, task, actor, ended);
  return { task: row, wakes, closed: [taskId, ...ended.map(t => t.id)], waiting };
}

export type TaskChange = { echelonStage?: EchelonStage; ownerAgentId?: string; cleanup?: boolean; cleanupForTurn?: boolean; paths?: string[]; title?: string; brief?: string; body?: string; executor?: string; after?: string[]; afterPlans?: AfterPlans; independentPart?: IndependentPartInput; independentNone?: string; workKind?: NonNullable<Task['workKind']>; riskClass?: NonNullable<Task['riskClass']>; small?: boolean };

/* Retrying a task CAS never bypasses its current route or owner checks. */
async function onFresh<T>(ctx: Live, task: Task, fn: (task: Task) => Promise<T>): Promise<T | null> {
  for (let tries = 0; tries < 3; tries++) {
    try { return await fn(task); } catch (error) {
      if (!(error instanceof ApiError) || error.reason !== 'task_changed') throw error;
      task = await loadTask(ctx.db, task.id);
    }
  }
  return null;
}

type Leaver = { id: string; name: string; companyId: string };

function releasedRoute(route: Route, agentId: string, current: boolean): Route['state'] {
  return { ...route.state, ...(current ? { phase: 'waiting', assignment: null } : {}), stages: route.state.stages.map(step => {
    if (step.ownerAgentId !== agentId || ['complete', 'skipped'].includes(step.status)) return step;
    return { ...step, ownerAgentId: null, status: 'pending', reason: 'eligible_owner_required' };
  }) };
}

/* Leaving an assignment never skips the stage or erases an immutable candidate. */
export async function leaveWork(ctx: Ctx, actor: Actor, agent: Leaver): Promise<{ wakes: Wake[]; handed: string[] }> {
  const rows = await ctx.db.select().from(tasks).where(and(eq(tasks.companyId, agent.companyId), notInArray(tasks.status, [...CLOSED]))).orderBy(asc(tasks.id));
  const wakes: Wake[] = [], handed: string[] = [];
  const missing: UnfilledStage[] = [];
  const leaving = await removedEmployee(ctx, agent.companyId, agent.id);
  for (const row of rows) await onFresh(ctx, row, async task => {
    const route = await routeOf(ctx.db, task);
    const current = task.assigneeAgentId === agent.id;
    const future = route.state.stages.some(step => step.status === 'pending' && step.ownerAgentId === agent.id);
    if (!current && !future) return null;
    const replacements = leaving ? await replaceFutureOwners(ctx, task, route, leaving) : { state: route.state, set: {}, missing: [] };
    const state = releasedRoute({ ...route, state: replacements.state }, agent.id, current);
    const due = current ? giver(task, 'switched', agent.id, `${agent.name} is no longer available. Assign the current stage to an eligible employee.`) : [];
    await move(ctx, task, { ...replacements.set, ...(current ? { assigneeAgentId: null, status: 'waiting' as const } : {}) }, { kind: 'updated', actor, text: `${agent.name} left the assignment.`, data: { fields: ['owner'] } }, tx => changeRoute(tx, route, state), due);
    handed.push(task.id); wakes.push(...due); missing.push(...replacements.missing);
    return task;
  });
  if (leaving) await notifyUnfilledStages(ctx, leaving, missing);
  return { wakes, handed };
}

async function waitingRouteChecker(ctx: Live, task: Task, route: Route) {
  if (route.state.phase !== 'waiting' || !route.state.candidateId || !route.state.stage) return null;
  const ability = route.state.abilities[route.state.stage];
  if (!ability) return null;
  const handed = await currentHanded(ctx.db, task, route);
  return checkerFor(ctx, task, handed.producedBy, ability, null, undefined, await keptFromReview(ctx.db, task, route.state.stage, handed));
}

export async function resumeWaitingRoutes(ctx: Live, actor: Actor, agent: Leaver, text: string): Promise<{ wakes: Wake[] }> {
  const rows = await ctx.db.select().from(tasks).where(and(eq(tasks.companyId, agent.companyId), eq(tasks.status, 'waiting'), isNull(tasks.assigneeAgentId))).orderBy(asc(tasks.id));
  const wakes: Wake[] = [];
  for (const row of rows) await onFresh(ctx, row, async task => {
    const route = await routeOf(ctx.db, task);
    const owner = await waitingRouteChecker(ctx, task, route);
    if (!owner) return null;
    const state = { ...route.state, phase: 'active' as const, assignment: owner, stages: route.state.stages.map(step => step.stage === route.state.stage ? { ...step, ownerAgentId: owner.agentId, status: 'active' as const, reason: null } : step) };
    /* An owner given a checking stage ran nothing yet: Tests is open work of its owner, the others are reviews. */
    const due: Wake[] = [{ agentId: owner.agentId, taskId: task.id, why: route.state.stage === 'tests' ? 'assigned' : 'review' }];
    await move(ctx, task, { assigneeAgentId: owner.agentId, status: route.state.stage === 'tests' ? 'open' : 'review' }, { kind: 'updated', actor, text, data: { fields: ['owner'] } }, tx => changeRoute(tx, route, state), due);
    wakes.push(...due);
    return task;
  });
  return { wakes };
}

/* The work kind is metadata. Changing it leaves active waits and queued task versions intact. */
async function relabelWorkKind(ctx: Live, agentId: string, task: Task, workKind: NonNullable<Task['workKind']>): Promise<Moved> {
  const row = await ctx.db.transaction(async tx => {
    const [fresh] = await tx.select().from(tasks).where(eq(tasks.id, task.id)).for('update');
    stillOpen(fresh!);
    if (fresh!.workKind === workKind) return fresh!;
    const [changed] = await tx.update(tasks).set({ workKind, updatedAt: new Date() }).where(eq(tasks.id, task.id)).returning();
    await note(tx, changed!, { kind: 'updated', actor: { agentId }, data: { fields: ['workKind'] } });
    return changed!;
  });
  published(ctx, row);
  return { task: row, wakes: [] };
}

/* Head revisions preserve the current stage and its immutable candidate. */
function requireTurnCleanupDecision(change: TaskChange): void {
  if (change.cleanupForTurn && change.cleanup === undefined) throw refuse(400, 'task_invalid', 'A turn Cleanup decision needs an open turn and an explicit option.');
}

/* The turn a head's Cleanup decision for the department holds in: its open turn, until its next release. */
async function cleanupTurn(db: Db, task: Task): Promise<string> {
  const turn = await openTurnOf(db, task.companyId, task.departmentId);
  if (!turn) throw refuse(400, 'task_invalid', 'A turn Cleanup decision needs an open turn and an explicit option.');
  return turn.id;
}

/* tracker: an edit of what the tracker keeps that goes with the change, written in the same move or not at all. */
export async function updateTask(ctx: Ctx, agentId: string, taskId: string, c: TaskChange, tracker?: TaskEdit): Promise<Moved> {
  c = hideCredentialsIn(c);
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  await requireTaskHead(ctx, task, agentId);
  requireTurnCleanupDecision(c);
  const route = await routeOf(ctx.db, task);
  if (!tracker && c.workKind !== undefined && Object.keys(c).every(key => key === 'workKind')) return relabelWorkKind(ctx, agentId, task, c.workKind);
  const revised = await prepareRouteChange(ctx, task, route, agentId, c);
  const set = revised.set;
  copyChangedFields(c, set);
  reopenRewrittenTask(task, revised.state, c, set);
  await changePrerequisites(ctx, task, route, c, set);
  const independentChange = await prepareIndependentChange(ctx, task, c);
  const { declaration } = independentChange;
  await requireChangeUrgency(ctx, agentId, task, set, independentChange.partOwner);
  let independent: Task | null = null;
  let changed: Task[] = [];
  const holder = set.assigneeAgentId ?? task.assigneeAgentId;
  const wakes: Wake[] = [];
  const policy = c.cleanupForTurn ? { turnId: await cleanupTurn(ctx.db, task), departmentId: task.departmentId, enabled: c.cleanup } : undefined;
  let edited: Task | null = null;
  const row = await move(ctx, task, set, { kind: 'updated', actor: { agentId }, data: { fields: Object.keys(c), ...independentData(declaration), ...(policy ? { turnCleanup: policy } : {}) } }, async (tx, row) => {
    if (policy) changed = await applyTurnCleanup(tx, task, policy.turnId, agentId, c.cleanup!, wakes);
    await changeRoute(tx, route, revised.state, revised.paths);
    if (set.after) await rebindAfter(tx, row, await checkAfter(tx, task.companyId, set.after), c.afterPlans, { agentId });
    independent = await insertIndependentChange(tx, row, agentId, independentChange, wakes);
    await wakeUpdatedHolder(tx, task, row, set, holder, wakes, c);
    await endFormerOwnerTurns(tx, task, set);
    if (tracker) edited = await writeEdit(tx, { agentId }, row, tracker);
  }, wakes, tracker ? [task.pipelineId, tracker.pipelineId ?? null] : []);
  if (independent) published(ctx, independent);
  publishRouteChanges(ctx, changed);
  return { task: edited ?? row, wakes };
}

function futureAssignmentOnly(change: TaskChange): boolean {
  return change.echelonStage !== undefined && Object.keys(change).every(key => ['echelonStage', 'ownerAgentId'].includes(key));
}

function copyChangedFields(change: TaskChange, set: Partial<Task>): void {
  for (const key of ['title', 'brief', 'body', 'workKind', 'riskClass', 'small'] as const) if (change[key] !== undefined) Object.assign(set, { [key]: change[key] });
}

function rewrittenText(task: Task, change: TaskChange): boolean {
  return (['title', 'brief', 'body'] as const).some(key => change[key] !== undefined && change[key] !== task[key]);
}

function reopenRewrittenTask(task: Task, state: Route['state'], change: TaskChange, set: Partial<Task>): void {
  if (rewrittenText(task, change) && task.status === 'blocked' && task.assigneeAgentId && state.phase === 'active') {
    Object.assign(set, { status: ['review', 'cleanup', 'security'].includes(state.stage ?? '') ? 'review' : 'open', silent: 0 });
  }
}

async function changePrerequisites(ctx: Ctx, task: Task, route: Route, change: TaskChange, set: Partial<Task>): Promise<void> {
  if (change.after === undefined) return;
  if (isStaged(route.state.resultKind) && !['architecture', 'development'].includes(route.state.stage ?? '')) throw refuse(409, 'task_invalid', 'A checking result cannot acquire unfinished prerequisites.');
  checkAfterPlans(change.after, change.afterPlans);
  await checkAfter(ctx.db, task.companyId, change.after);
  await refuseAbove(ctx.db, task.parentId, change.after);
  await refuseBelow(ctx.db, task, change.after);
  set.after = change.after;
}

function changesIndependence(change: TaskChange): boolean {
  return change.after !== undefined || change.independentPart !== undefined || change.independentNone !== undefined;
}

type IndependentChange = { declaration: IndependentDeclaration | null; createsIndependent: boolean; partOwner: string | null; plan: StageRoute | null };

function independentAddition(declaration: IndependentDeclaration | null, existing: IndependentDeclaration | null): Omit<IndependentChange, 'declaration' | 'plan'> {
  if (declaration?.kind !== 'part' || existing?.kind === 'part') return { createsIndependent: false, partOwner: null };
  return { createsIndependent: true, partOwner: declaration.part.executor };
}

async function prepareIndependentChange(ctx: Ctx, task: Task, change: TaskChange): Promise<IndependentChange> {
  if (!changesIndependence(change)) return { declaration: null, createsIndependent: false, partOwner: null, plan: null };
  const existing = await currentIndependent(ctx.db, task.id);
  const declaration = checkIndependent(change.after ?? task.after, change.independentPart, change.independentNone, existing);
  if (declaration?.kind === 'part') await checkIndependentExecutor(ctx.db, task.departmentId, declaration.part);
  return { declaration, ...independentAddition(declaration, existing), plan: await departmentStages(ctx, task.departmentId, task.pipelineId) };
}

async function requireChangeUrgency(ctx: Ctx, agentId: string, task: Task, set: Partial<Task>, partOwner: string | null): Promise<void> {
  const newOwner = set.assigneeAgentId === task.assigneeAgentId ? null : set.assigneeAgentId;
  await refuseNotUrgent(ctx, { agentId }, task.companyId, task, [newOwner, partOwner].filter((id): id is string => Boolean(id)));
}

async function insertIndependentChange(tx: Tx, row: Task, agentId: string, change: IndependentChange, wakes: Wake[]): Promise<Task | null> {
  if (!change.createsIndependent || change.declaration?.kind !== 'part' || !change.plan) return null;
  const made = await insertIndependent(tx, row, change.declaration.part, { agentId }, change.plan);
  wakes.push(made.wake);
  return made.child;
}

async function wakeUpdatedHolder(tx: Tx, task: Task, row: Task, set: Partial<Task>, holder: string | null, wakes: Wake[], change: TaskChange): Promise<void> {
  if (futureAssignmentOnly(change)) return;
  if (!(await openAfter(tx, row)).length && holder) wakes.push({ agentId: holder, taskId: task.id, why: set.assigneeAgentId ? (row.status === 'review' ? 'review' : 'assigned') : 'updated' });
}

async function endFormerOwnerTurns(tx: Tx, task: Task, set: Partial<Task>): Promise<void> {
  if (set.assigneeAgentId && set.assigneeAgentId !== task.assigneeAgentId) {
    await tx.update(jobs).set({ status: 'failed', error: 'handed_on', finishedAt: new Date() }).where(and(eq(jobs.taskId, task.id), eq(jobs.agentId, task.assigneeAgentId!), eq(jobs.status, 'queued')));
    await letStuckGo(tx, task.id);
  }
}

/* What an agent asks: words, an approval of an exact commit, or a pick of one of 2 to 4 ways. images: pictures it sent
   with hh-attach, link: where to see the work, topic: what it is about, which says whose decision it is. */
export type Ask = {
  kind: 'question' | 'approval' | 'choice';
  text: string;
  commit?: string;
  /* What an approval a department's policy asks for is about, in place of a commit. */
  approval?: { channel: ApprovalChannel; kind: string; amount: number | null };
  images?: string[];
  options?: RequestOption[];
  link?: string | null;
  topic?: DecisionTopic;
  recipientPersonId?: string;
  /* Who answers by when, if someone promised dates. */
  plan?: WaitPlan;
  /* A goal in danger, as someone who may say so said it. */
  goal?: NewGoal;
  /* The server's own: what must be kept in the step that makes the request. No tool passes it. */
  onCreated?: (tx: Tx, request: Request) => Promise<void>;
  /* The server's own, on the approval of a release commit: what that release brings that no check covers, as Hornhoof read it
     as the card was asked. No tool input passes it; people see it next to Approve. */
  unchecked?: UncheckedItem[];
};

/* An approval of a commit lets it into the release, whatever the agent says it is about. */
const topicOf = (q: Ask): DecisionTopic | null => (q.commit ? 'release' : (q.topic ?? null));

/* An approval says what it approves: an exact commit, or what a department's policy asks it about. */
const namesItsWork = (q: Ask): boolean => q.approval !== undefined || COMMIT.test(q.commit ?? '');

/* What a release brings that no check covers, kept only on the approval of its commit, in one order. */
const uncheckedOf = (q: Ask): UncheckedItem[] | null => (q.unchecked?.length && q.kind === 'approval' && q.commit ? sortedUnchecked(q.unchecked) : null);

const approvalColumns = (a: Ask['approval']) => ({ approvalChannel: a?.channel ?? null, approvalKind: a?.kind ?? null, approvalAmount: a?.amount ?? null });

/* The current task owner asks a person and the task waits for the answer. */
export async function ask(ctx: Live, agentId: string, taskId: string, q: Ask): Promise<Moved & { request: Request }> {
  const task = await loadTask(ctx.db, taskId);
  mayAsk(task, agentId);
  refusePaused(task);
  if (!q.text.trim()) throw refuse(400, 'task_invalid', 'Say what you need.');
  if (q.kind === 'approval' && !namesItsWork(q)) throw refuse(400, 'task_invalid', 'An approval names the full 40-character commit.');
  if (q.kind !== 'approval' && q.commit) throw refuse(400, 'task_invalid', 'Only an approval names a commit; ask for an approval instead.');
  const options = q.kind === 'choice' ? (q.options ?? []) : [];
  if (q.kind === 'choice' && (options.length < 2 || options.length > 4)) throw refuse(400, 'task_invalid', 'A choice offers 2 to 4 ways.');
  if (q.kind !== 'choice' && q.options?.length) throw refuse(400, 'task_invalid', 'Ways to pick from make a choice; a choice names no commit.');
  const unchecked = uncheckedOf(q);
  const pictures = [...(q.images ?? []), ...options.flatMap(o => (o.image ? [o.image] : []))];
  await checkPictures(ctx.db, task.companyId, agentId, pictures);
  let request: Request | undefined;
  let wakes: Wake[] = [];
  const row = await move(ctx, task, { status: 'waiting', silent: 0 }, { kind: 'asked', actor: { agentId }, text: q.text.trim(), data: { kind: q.kind, commit: q.commit ?? null } }, async tx => {
    [request] = await tx
      .insert(requests)
      .values({
        companyId: task.companyId,
        taskId,
        agentId,
        kind: q.kind,
        text: q.text.trim(),
        commit: q.commit ?? null,
        unchecked,
        options,
        link: q.link ?? null,
        decisionTopic: topicOf(q),
        recipientPersonId: q.recipientPersonId,
        ...approvalColumns(q.approval),
        ...goalColumns(q.goal),
      })
      .returning();
    const wait = await bindRequest(tx, task, request!, { agentId }, q.plan);
    if (q.goal) await alertGoal(tx, task, request!, wait);
    await q.onCreated?.(tx, request!);
    wakes = await explaining(tx, task, agentId, request!.id);
    await keepWakes(tx, task.companyId, wakes);
    if (!pictures.length) return;
    const shown = await tx
      .update(attachments)
      .set({ requestId: request!.id })
      .where(and(inArray(attachments.id, pictures), eq(attachments.agentId, agentId), isNull(attachments.requestId), isNull(attachments.operatorCaseId)))
      .returning({ id: attachments.id });
    if (shown.length !== pictures.length) throw refuse(409, 'task_changed', 'A picture was shown meanwhile. Send it again with hh-attach.');
  });
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  return { task: row, request: request!, wakes };
}

/* What an employee asks people reaches the orchestrator first, to put into plain words for them; not what it asks itself. */
async function explaining(db: Db | Tx, task: Task, agentId: string, requestId: string): Promise<Wake[]> {
  const [orchestrator] = await db
    .select(idOnly(agents))
    .from(agents)
    .where(and(eq(agents.companyId, task.companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt)));
  return orchestrator && orchestrator.id !== agentId ? [{ agentId: orchestrator.id, taskId: task.id, why: 'explain', text: requestId }] : [];
}

/* The agent holding the task ended a turn without moving it: a reminder, and from SILENT_TURNS its head is asked. */
export async function silentTurn(ctx: Live, agentId: string, task: Task): Promise<Moved> {
  if (task.externalWait || task.paused) return { task, wakes: [] };
  return remindOnSilence(ctx, agentId, task);
}

async function remindOnSilence(ctx: Live, agentId: string, task: Task): Promise<Moved> {
  const silent = task.silent + 1;
  if (silent < SILENT_TURNS) {
    const wakes: Wake[] = [{ agentId, taskId: task.id, why: 'reminder' }];
    const row = await move(ctx, task, { silent }, { kind: 'reminded', actor: { agentId }, data: { silent } }, undefined, wakes);
    return { task: row, wakes };
  }
  return askAboutStill(ctx, agentId, task, silent, `Ended ${silent} turns in a row on #${task.number} without moving it. Tell it how to go on, or cancel the task.`);
}

/* Hornhoof gives member work its executor has not handed in to another executor, as when the executor's plan is at its
   limit: one note in the task says why, and the turns that waited for the one who did it are over. */
export async function handOver(ctx: Live, task: Task, to: string, text: string): Promise<Moved> {
  const route = await routeOf(ctx.db, task);
  requireUnsubmittedWork(task, route);
  const owner = await workingAgent(ctx.db, task.companyId, to);
  if (owner.departmentId !== task.departmentId || (owner.productId && owner.productId !== task.productId)) throw refuse(403, 'task_not_yours', 'The replacement is outside the task scope.');
  const state = { ...route.state, assignment: null, stages: route.state.stages.map(step => step.stage === route.state.stage ? { ...step, ownerAgentId: to } : step) };
  const from = task.executorAgentId!;
  const wakes: Wake[] = [{ agentId: to, taskId: task.id, why: 'assigned' }];
  const row = await move(
    ctx,
    task,
    { executorAgentId: to, assigneeAgentId: to, status: 'open', silent: 0 },
    { kind: 'assigned', actor: { agentId: from }, text, data: { assignee: to }, automatic: 'limit' },
    async tx => {
      await changeRoute(tx, route, state);
      await tx.update(jobs).set({ status: 'failed', error: 'handed_on', finishedAt: new Date() }).where(and(eq(jobs.agentId, from), eq(jobs.taskId, task.id), eq(jobs.status, 'queued')));
    },
    wakes,
  );
  return { task: row, wakes };
}

function requireUnsubmittedWork(task: Task, route: Route): void {
  if (!isStaged(route.state.resultKind) || route.state.candidateId || !['architecture', 'development'].includes(route.state.stage ?? '') || task.assigneeAgentId !== task.executorAgentId) throw refuse(409, 'task_invalid', 'Only unsubmitted work can change executor automatically.');
}

/* Repeated startup failures stop task turns and notify the giver, or ask a person when there is no other giver. */
export async function brokeDown(ctx: Live, agentId: string, task: Task, text: string): Promise<Moved> {
  if (task.createdByAgentId && task.createdByAgentId !== agentId) {
    const wakes = giver(task, 'blocked', agentId, text);
    return { task: await move(ctx, task, { status: 'blocked', silent: 0 }, { kind: 'blocked', actor: { agentId }, text, automatic: 'failure' }, undefined, wakes), wakes };
  }
  return askAboutStill(ctx, agentId, task, task.silent, text);
}

/* Hornhoof stops waking the agent on the task and asks its head, or the orchestrator about a head. */
async function askAboutStill(ctx: Live, agentId: string, task: Task, silent: number, text: string): Promise<Moved> {
  const [asker] = await ctx.db.select().from(agents).where(eq(agents.id, agentId));
  const recipient = asker ? await stuckRecipient(ctx.db, asker, task) : null;
  let wakes: Wake[] = [];
  const row = await move(ctx, task, { silent, status: 'waiting' }, { kind: 'stuck', actor: { agentId }, text }, async tx => {
    const [note] = await tx.insert(requests).values({
      companyId: task.companyId,
      taskId: task.id,
      agentId,
      kind: 'stuck',
      text,
      decisionTopic: 'task',
      audience: 'internal',
      triageAgentId: recipient?.id ?? null,
      sourceKey: `stuck:${task.id}:${task.version}`,
    }).returning();
    wakes = recipient ? [{ agentId: recipient.id, taskId: task.id, why: 'explain', text: note!.id }] : [];
    await keepWakes(tx, task.companyId, wakes);
  });
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  return { task: row, wakes };
}

/* How many turns the agent went on through on the task since it last moved, as the stuck counter counts them: a turn that
   waited in line until its node came back is not one. */
async function turnsGoneOn(db: Db, agentId: string, task: Task): Promise<number> {
  const last = await lastMove(db, task.id);
  const [before] = await db
    .select(countOnly())
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.agentId, agentId), eq(taskEvents.kind, 'continued'), sql`${taskEvents.data}->>'afterReturn' is distinct from 'true'`, last ? gt(taskEvents.createdAt, last.createdAt) : undefined));
  return Number(before?.n ?? 0);
}

async function goOn(ctx: Live, agentId: string, task: Task, set: Partial<Task>, data: Record<string, unknown>): Promise<Moved> {
  const wakes: Wake[] = [{ agentId, taskId: task.id, why: 'go_on' }];
  const row = await move(ctx, task, set, { kind: 'continued', actor: { agentId }, data }, undefined, wakes);
  return { task: row, wakes };
}

/* The agent holding the task worked through a turn without handing anything in, but said in the task how far it got or
   worked until its time ran out: it goes on in another turn, from GOING_ON_TURNS such turns in a row its head is asked. */
export async function wentOn(ctx: Live, agentId: string, task: Task): Promise<Moved> {
  const turns = (await turnsGoneOn(ctx.db, agentId, task)) + 1;
  if (turns >= GOING_ON_TURNS) return askAboutStill(ctx, agentId, task, 0, `Went on for ${turns} turns in a row on #${task.number} without handing anything in. Tell it how to go on, or cancel the task.`);
  return goOn(ctx, agentId, task, { silent: 0 }, { turns });
}

/* A turn that waited in line until the agent's node came back worked and goes on too, but a machine coming back says nothing
   of the agent standing still: it counts for neither stuck counter. */
export async function wentOnAfterReturn(ctx: Live, agentId: string, task: Task): Promise<Moved> {
  return goOn(ctx, agentId, task, {}, { turns: await turnsGoneOn(ctx.db, agentId, task), afterReturn: true });
}

/* pick: the way a person took, from 0, in a choice. */
export type Answer = { answer?: string; approve?: boolean; retry?: boolean; pick?: number };

const sentByAgent = (picture: { companyId: string; agentId: string | null; personId: string | null }, companyId: string, agentId: string): boolean =>
  picture.companyId === companyId && picture.agentId === agentId && !picture.personId;

/* Pictures are the agent's own, from hh-attach, each shown once. A file put on a task is no picture, whatever it holds, and
   one a person sent the agent stays in that conversation. */
async function checkPictures(db: Db, companyId: string, agentId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  if (new Set(ids).size !== ids.length) throw refuse(400, 'task_invalid', 'A picture is listed twice.');
  const rows = await db
    .select({ id: attachments.id, companyId: attachments.companyId, agentId: attachments.agentId, personId: attachments.personId, requestId: attachments.requestId, taskId: attachments.taskId, name: attachments.name })
    .from(attachments)
    .where(and(inArray(attachments.id, ids), isNull(attachments.operatorCaseId)));
  for (const id of ids) {
    const problem = notAPicture(id, rows.find(r => r.id === id), companyId, agentId);
    if (problem) throw refuse(400, 'task_invalid', problem);
  }
}

type PictureRow = { companyId: string; agentId: string | null; personId: string | null; requestId: string | null; taskId: string | null; name: string | null };

/* Why an attachment is no picture this agent may show in a request, or null when it is one. */
function notAPicture(id: string, found: PictureRow | undefined, companyId: string, agentId: string): string | null {
  if (!found || !sentByAgent(found, companyId, agentId)) return `${id} is not a picture you sent. Send it with hh-attach and use the id it prints.`;
  if (found.taskId) return `${id} is a file on a task, not a picture. Send the picture with hh-attach FILE, without --task.`;
  if (found.name !== null) return `${id} is a chat file, not a picture. Send the picture with hh-attach FILE, without --chat.`;
  if (found.requestId) return `${id} is shown in another request already. Send it again with hh-attach.`;
  return null;
}

/* Who answers, as the request is kept: a person with the right to take it, or the orchestrator for one, in a turn that
   still answers that person. */
async function mayAnswer(tx: Tx, actor: Actor, found: Request, task: Task, on?: Delegation): Promise<string> {
  if (on) await checkDelegation(tx, on);
  const personId = on?.personId ?? actor.personId;
  if (!personId) throw contextMissing();
  await requireDecider(tx, found.companyId, personId, requestSubject(found, task));
  return personId;
}

/* What the request and its log keep of the orchestrator's answer for a person: which turn, on whose words. */
function auditOf(on: Delegation | undefined) {
  if (!on) return { audit: {}, forWhom: {} };
  return {
    audit: { answeredByAgentId: on.agentId, answerJobId: on.jobId, answerSourceSeq: on.sourceSeq },
    forWhom: { onBehalfOfPersonId: on.personId, jobId: on.jobId, sourceSeq: on.sourceSeq },
  };
}

/* The answers someone else took first, or a right that went meanwhile: the words still reach the agent. */
const PASSED_OVER = new Set<ErrorReason | undefined>(['request_closed', 'decision_not_allowed']);

/* The person whose answer it is, also when the orchestrator passed it on. */
const answerer = (personId: string | null, actor: Actor): Actor => (personId ? { personId } : actor);

/* What an approval let through or stopped: its commit, or the channel and kind a department's policy asked it for. */
const approvedWhat = (r: Pick<Request, 'commit' | 'approvalChannel' | 'approvalKind'>) => r.commit ?? `${r.approvalChannel}, ${r.approvalKind}`;
const approveOrDecline = (r: Pick<Request, 'commit'>) => (r.commit ? 'Approve or decline this commit.' : 'Approve or decline this.');
/* What the note on an answer says it let through: only an approval has one. */
const answeredWork = (r: Pick<Request, 'kind' | 'commit' | 'approvalChannel' | 'approvalKind'>) => (r.kind === 'approval' ? approvedWhat(r) : r.commit);
/* The test run that proves an approved commit, as the release rests on that commit. */
const proofWords = async (db: Db, task: Task, found: Request, a: Answer) => (a.approve && found.commit ? ` ${proofLine(await commitProof(db, task, found.commit))}` : '');

/* An answer in words, for the one who asked and the log. */
async function answerWords(db: Db, task: Task, found: Request, a: Answer, text: string, option: RequestOption | undefined): Promise<string> {
  const more = text ? ` ${text}` : '';
  if (found.kind === 'approval') return `${a.approve ? 'Approved' : 'Declined'} ${approvedWhat(found)}.${await proofWords(db, task, found, a)}${more}`;
  return option ? `Picked ${a.pick! + 1}: ${option.label}.${more}` : text || 'Try again.';
}

/* Words are a neutral answer; an explicit pick must still name a valid option. */
function checkChoiceAnswer(found: Pick<Request, 'options'>, a: Answer, text: string, option: RequestOption | undefined): void {
  if (a.approve !== undefined) throw refuse(400, 'task_invalid', 'Only a commit is approved; answer in words.');
  if (a.pick !== undefined && !option) throw refuse(400, 'task_invalid', `Pick one of the ${found.options.length} ways.`);
  if (!option && !text) throw refuse(400, 'task_invalid', 'Write an answer.');
}

/* The status of a code task at each checking stage of its route: Tests is open work of its owner, the others are reviews. */
const STATUS_AT_STAGE: Partial<Record<string, Task['status']>> = { tests: 'open', review: 'review', security: 'review', cleanup: 'review' };

/* What a task that waited on a person goes back to once nothing more is asked of anyone: the status of the stage its route is
   at. One whose route waits for an owner stays waiting, where the next eligible owner is looked for. Null leaves it as it is. */
async function statusAfterWait(tx: Tx, task: Task, was: Task['status'] | undefined): Promise<Task['status'] | null> {
  if (was !== 'waiting') return null;
  const [left] = await tx.select(countOnly()).from(requests).where(and(eq(requests.taskId, task.id), eq(requests.status, 'open')));
  if (Number(left!.n)) return null;
  const route = await routeOf(tx, task);
  if (!isStaged(route.state.resultKind)) return 'working';
  if (route.state.phase === 'waiting') return null;
  return STATUS_AT_STAGE[route.state.stage ?? 'development'] ?? 'working';
}

/* A person answers: the request closes, the task goes on where it stood, and the agent that asked wakes with the answer.
   on: the orchestrator answers for the person its turn answers, under that agent's input lock. */
/* How an answer came: inline in words the window already delivered, from the person's assistant, or from the orchestrator
   of its own as the owner's, each recorded with it. */
type AnswerWay = { inlineText?: true; assistant?: string; orchestrator?: string };

export async function answer(ctx: Live, actor: Actor, requestId: string, a: Answer, on?: Delegation, { inlineText, assistant, orchestrator }: AnswerWay = {}): Promise<{ request: Request; task: Task; wakes: Wake[] }> {
  const [found] = await ctx.db.select().from(requests).where(eq(requests.id, requestId));
  if (!found) throw refuse(404, 'request_unknown', 'There is no such request.');
  if (found.status !== 'open') throw refuse(409, 'request_closed', 'This request is answered already.');
  const text = a.answer?.trim() ?? '';
  let status: Request['status'];
  const option = found.kind === 'choice' && a.pick !== undefined ? found.options[a.pick] : undefined;
  if (found.kind !== 'choice' && a.pick !== undefined) throw refuse(400, 'task_invalid', 'Only a choice is answered with a pick.');
  if (found.kind === 'approval') {
    if (a.approve === undefined) throw refuse(400, 'task_invalid', approveOrDecline(found));
    status = a.approve ? 'approved' : 'declined';
  } else if (found.kind === 'choice') {
    checkChoiceAnswer(found, a, text, option);
    status = 'answered';
  } else {
    if (a.approve !== undefined) throw refuse(400, 'task_invalid', 'Only a commit is approved; answer in words.');
    if (!text && !(found.kind === 'stuck' && a.retry)) throw refuse(400, 'task_invalid', 'Write an answer.');
    status = 'answered';
  }
  const task = await loadTask(ctx.db, found.taskId);
  const said = await answerWords(ctx.db, task, found, a, text, option);
  let wakes: Wake[] = [];
  const row = await ctx.db.transaction(async tx => {
    /* The task first and then its request, in the order a cancel takes them, so the two never wait on each other. As the task
       is now, not as it was read before: one closed meanwhile stays closed. */
    const [current] = await tx.select(only(tasks, 'status')).from(tasks).where(eq(tasks.id, task.id)).for('update');
    const answeredBy = await mayAnswer(tx, actor, found, task, on);
    const { audit, forWhom } = auditOf(on);
    const [request] = await tx
      .update(requests)
      .set({ status, answer: text || null, picked: option ? a.pick! : null, answeredBy, ...audit, ...(orchestrator ? { answeredByAgentId: orchestrator } : {}), answeredByAssistantId: assistant ?? null, answeredAt: new Date() })
      .where(and(eq(requests.id, requestId), eq(requests.status, 'open')))
      .returning();
    if (!request) throw refuse(409, 'request_closed', 'This request is answered already.');
    await endRequest(tx, request, status, answerer(answeredBy, actor));
    await tx.update(tasks).set({ externalWait: null, silent: 0, version: sql`${tasks.version} + 1`, updatedAt: new Date() })
      .where(and(eq(tasks.id, task.id), isNotNull(tasks.externalWait)));
    const back = await statusAfterWait(tx, task, current?.status);
    const answered: Note = { kind: 'answered', actor, text: said, data: { requestId, kind: found.kind, status, ...forWhom, ...(assistant ? { assistantId: assistant } : {}), ...(orchestrator ? { byOrchestrator: true } : {}) }, inlineText };
    const event = await note(tx, task, back ? statusNoted(answered, 'waiting', back) : answered, ctx.config);
    if (back) {
      await tx
        .update(tasks)
        .set({ status: back, silent: 0, version: sql`${tasks.version} + 1`, updatedAt: new Date() })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, 'waiting')));
    }
    const [after] = await tx.select().from(tasks).where(eq(tasks.id, task.id));
    /* A task that stood still goes on with whoever holds it now. */
    const goesOn = after!.assigneeAgentId;
    wakes = CLOSED.includes(after!.status) || !goesOn ? [] : [{ agentId: goesOn, taskId: task.id, why: 'answered', text: said }];
    recordCause(wakes, { kind: 'answered', actor: answerer(answeredBy, actor), text: said, data: { status, commit: answeredWork(found) } }, event.id, task);
    await keepWakes(tx, task.companyId, wakes);
    return request;
  });
  const now = await loadTask(ctx.db, task.id);
  published(ctx, now);
  if (now.status !== task.status) await nudgeTrackerKeepers(ctx, now, actor.agentId);
  await handOff(ctx, actor, now);
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  return { request: row, task: now, wakes };
}

/* Whether a person's words take this open request: they reach its task and may take its decision. */
function takes(person: Parameters<typeof canDecide>[1], access: Access, r: Parameters<typeof requestSubject>[0] & Parameters<typeof requestSubject>[1] & { companyId: string }): boolean {
  return (r.recipientPersonId === person.id || canReach(access, taskSpot(r))) && canDecide(requestSubject(r, r), person, access, r.companyId);
}

/* A person spoke to the agent directly, in its window or its terminal: what they said answers the questions it asked people
   and tells it how to go on where it was stuck, on the tasks that person reaches. A commit to approve and a choice wait for
   their own answer. The task's own turn still follows, which watches that the task moves. */
export async function answerDirectly(ctx: Live, personId: string, agentId: string, text: string, { assistant }: { assistant?: string } = {}): Promise<Wake[]> {
  const said = text.trim();
  if (!said) return [];
  const [person] = await ctx.db
    .select({ id: people.id, companyId: people.companyId, status: people.status, scopeKind: people.scopeKind, isOwner: people.isOwner, isCeoDelegate: people.isCeoDelegate })
    .from(people)
    .where(eq(people.id, personId));
  if (!person) return [];
  const access = await accessOf(ctx.db, person);
  const open = await ctx.db
    .select({ id: requests.id, companyId: requests.companyId, kind: requests.kind, decisionTopic: requests.decisionTopic, recipientPersonId: requests.recipientPersonId, departmentId: tasks.departmentId, productId: tasks.productId })
    .from(requests)
    .innerJoin(tasks, eq(tasks.id, requests.taskId))
    .where(and(eq(requests.agentId, agentId), eq(requests.status, 'open'), inArray(requests.kind, ['question', 'stuck']), or(ne(requests.kind, 'stuck'), eq(requests.audience, 'human'))))
    .orderBy(asc(requests.createdAt));
  const wakes: Wake[] = [];
  for (const r of open) {
    /* Only what this person may take: the words still reach the agent, and someone else's question stays open. */
    if (!takes({ ...person, assistant }, access, r)) continue;
    try {
      /* The window already delivered these words; its complete mirror must not introduce a later file-quota failure. */
      wakes.push(...(await answer(ctx, { personId }, r.id, { answer: said }, undefined, { inlineText: true, assistant })).wakes);
    } catch (err) {
      /* Someone answered it in the task meanwhile, or the person's right went meanwhile. */
      if (!(err instanceof ApiError && PASSED_OVER.has(err.reason))) throw err;
    }
  }
  return wakes;
}
export { CLOSED, SILENT_TURNS, GOING_ON_TURNS, refuse, loadTask, listed, openAfter, taskSpot, giver, waitsForPerson, liveAgent, mayAsk, requestSubject } from './state.js';
export type { Task, Request, Actor, WakeWhy, Wake, Moved, Tx } from './state.js';
export { note, ownNote, published, NOT_A_MOVE, lastMove, uncountedSinceMove } from './events.js';

export { move } from './transitions.js';
export { startWork } from './progress.js';
export { comment } from './comments.js';
