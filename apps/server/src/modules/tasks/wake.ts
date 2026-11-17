import { isStaged } from '@hornhoof/protocol/echelons';
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { forgetPrivateTurn } from '../tools/private-turns.js';
import { countOnly, idOnly, only } from '../../db/selections.js';
import { loggable } from '../../errors.js';
import { agentChanges, agentEvents, agents, jobs, requests, subscriptions, taskEvents, tasks, testRuns } from '../../db/schema.js';
import { agentState, conversationOf, GONE_ALONG, insertTurn, keepLetter, limitUntil, liveSubscription, onAgent, openTypedTurn, orchestratorOf, pump, refusedLimits, turnRefused, type TurnMessage } from '../conversation/queue.js';
import { inboxChanged, mailBack } from '../conversation/inbox.js';
import { deliverLive } from '../conversation/decision-context.js';
import { quote } from '../conversation/prompt.js';
import { appendEvent, publishWorking } from '../events/store.js';
import { waitedForReturn } from '../nodes/connections.js';
import { identityOf, ownBuiltin, type NodeIdentity } from '../nodes/hub.js';
import { goesOutNow, isFree, mayTake, peersOfRole } from './role-peers.js';
import { answerDirectly, brokeDown, CLOSED, handOver, lastMove, leaveWork, NOT_A_MOVE, openAfter, resumeWaitingRoutes, silentTurn, taskSpot, uncountedSinceMove, wentOn, wentOnAfterReturn, type Actor, type Moved, type Task, type Wake, type WakeWhy } from './engine.js';
import { wakeQueued, wakesLeft } from './outbox.js';
import { taskForWake, taskWakeOf, waitingTaskTurn } from './wake-state.js';
import { carriedTasks, continueOnce, doneIfRecorded } from './endings.js';
import { afterRestart, afterRestartOutsideTask } from './restarts.js';
import { clearTurnProgram, failedProgramData, when } from './silent.js';
import { afterFailure } from './failures.js';
import { routeOf, routeSnapshot } from './echelons-store.js';
import { wakeNotice } from './notification.js';
import { notStep } from '../tools/steps.js';
import { releaseJobPhones } from '../phones/queue.js';
import { callEnded, oneShotStageNote } from '../calls/calls.js';

type Agent = typeof agents.$inferSelect;

type RouteKind = ReturnType<typeof routeSnapshot>['resultKind'];

/* What finishes the task for whoever holds it, and what to do when that cannot happen. */
function nextStep(task: Task, agentId: string, kind?: RouteKind): { finish: string; stuck: string } {
  if (task.assigneeAgentId === agentId && kind === 'turnkey') return {
    finish: 'carry its task scope end to end alone on its task branch, checking what you touched with local tests, as the full run happens once at release; it goes through no echelons and nobody else is called onto it; close it with report done true and the evidence',
    stuck: 'use blocked',
  };
  if (task.assigneeAgentId === agentId && kind === 'document') return {
    finish: 'follow task.echelons: hand the result in with submit as a document, its files attached to the task and no commit named; at a checking stage correct it yourself and submit it again, or give verdict naming candidateId',
    stuck: 'use blocked or escalate a wrong goal to the head',
  };
  if (task.assigneeAgentId === agentId) return {
    finish: 'follow task.echelons: report the Architecture plan; submit code and evidence from Development; check and fix in the same branch in Review, optional Cleanup or Security, then give verdict on the exact candidate; in Tests check what the change touched with local tests, as the full run happens once at release, and report the exact candidate; integrate only with the head authorization',
    stuck: 'use blocked or escalate a wrong goal to the head',
  };
  return { finish: 'assign an eligible current owner with update_task, or report the checked coordination result', stuck: 'report what is missing to the head' };
}

/* Wakes whose text an employee wrote: the reasons of a report, a block, a cancellation. */
const EMPLOYEES_SAY: WakeWhy[] = ['reported', 'blocked', 'cancelled', 'review', 'unblocked'];

/* The turn's prompt: which task, why the agent wakes, and what is expected of it, then what else it should know. Always
   English, like the agents' instructions. */
export function wakePrompt(agent: Pick<Agent, 'kind'>, task: Task, w: Wake, kind?: RouteKind): string {
  const prompt = reason(agent, task, w, kind);
  return w.note ? `${prompt}\n\n${w.note}` : prompt;
}

const READ_TASK = 'Read it with the task tool first: its body is the current truth and its log has the rest.';
const LOCAL_TESTS = 'Check what you touched with local tests; the full run happens once at release.';

function assignedPrompt(agent: Pick<Agent, 'kind'>, task: Task, w: Wake, kind?: RouteKind): string {
  const ref = `#${task.number} "${task.title}"`;
  const { finish, stuck } = nextStep(task, w.agentId, kind);
  if (task.executorAgentId) return `${ref} is yours to do. ${READ_TASK} Do the work, then ${finish}. If you cannot go on, ${stuck}; if only a person can answer, use ask_person.`;
  if (agent.kind === 'orchestrator') return `${ref} is yours. ${READ_TASK} Lay the work out as tasks for the departments with add_tasks, and report it when every part is done.`;
  if (agent.kind === 'worker') return `${ref} is yours to do. ${READ_TASK} Do the assigned work and report its concrete checked result. If you cannot go on, use blocked; if only a person can answer, use ask_person.`;
  return `${ref} is your department's. ${READ_TASK} Give each connected block to one generalist developer to finish end to end. Give independent blocks to different members at once with create_task, each under it (parent ${task.number}) with its executor. Every executable result must pass its required Review. Report the checked child results when they are accepted.`;
}

const waitEndedPrompt = (task: Task, text?: string): string =>
  `#${task.number} "${task.title}": the wait for "${text ?? ''}" ended; check and continue.`;

function reason(agent: Pick<Agent, 'kind'>, task: Task, w: Wake, kind?: RouteKind): string {
  const ref = `#${task.number} "${task.title}"`;
  const read = READ_TASK;
  /* What an employee wrote is marked as theirs; a person's answer or comment stays as they wrote it. */
  const said = w.text ? `:\n\n${EMPLOYEES_SAY.includes(w.why) ? quote(w.text) : w.text}\n\n` : '. ';
  const { finish, stuck } = nextStep(task, w.agentId, kind);
  /* The orchestrator holds no task of his own: he runs the turn. */
  const own = agent.kind === 'orchestrator' ? 'the turn' : 'your own task';
  switch (w.why) {
    case 'assigned':
      return assignedPrompt(agent, task, w, kind);
    case 'wait_ended':
      return waitEndedPrompt(task, w.text);
    case 'review':
      if (kind === 'document') return `${ref} is with you at its current checking stage. ${read} It is handed in as a document: read the hand-in in its log and fetch the files it names. Check it against the task and correct what is wrong yourself. Submit the corrected document, or give verdict naming candidateId from task.echelons when it meets the goal. Escalate a wrong goal to the head.`;
      return `${ref} is with you at its current checking stage. ${read} ${LOCAL_TESTS} Check the candidate, record findings with their provenance and fix them yourself in the same branch within the assigned paths. Submit a changed candidate with affected proof; give verdict on its exact commit when it meets the goal. Escalate a wrong goal to the head.`;
    case 'reviewed':
      if (kind === 'document') return `${ref} passed every stage of its route. ${read} Read the checked document and record acceptance with report done true. Do not request another version from the author.`;
      return `${ref} passed the last stage of its route on its final candidate. ${read} Verify the exact candidate, then integrate only within your authority and record acceptance. Do not request another implementation from the author.`;
    case 'done':
      return `${ref}, which you gave out, has an accepted result and is done. Read the result with the task tool, then go on with ${own}.`;
    case 'reported':
      return `${ref}, which you gave out, was reported done${said}Go on with ${own}.`;
    case 'blocked':
      /* The orchestrator does not rewrite a department's task: he gives the department a new one. */
      if (agent.kind === 'orchestrator') return `${ref}, which you gave out, cannot go on${said}Cancel it with cancel_task and give the department a task it can do with add_tasks, or tell the CEO what stands in the way.`;
      if (task.executorAgentId && task.assigneeAgentId === null) return `${ref} needs your decision${said}Read task.echelons, decide the goal and current stage owner, and record that decision with update_task, or cancel it. Keep the current candidate and its findings with the task.`;
      if (task.executorAgentId) return `${ref}, which you gave out, cannot go on${said}Answer it with comment, which opens it again for its executor once; comment only with the answer. If it comes back blocked after a comment, write the answer into the task with update_task, which opens it again. Give it to someone else or cancel it when nobody can answer.`;
      return `${ref}, which you gave out, cannot go on${said}Unblock it: rewrite it with update_task, give it to someone else, or cancel it.`;
    case 'cancelled':
      return `${ref}, which you gave out, was cancelled${said}Go on with ${own} without it.`;
    case 'after_cancelled':
      /* Its text names the cancelled tasks. */
      return `${ref} comes after ${w.text ?? 'a task'}, which was cancelled, so it still waits and nobody works on it. ${read} Give it what it waits for from now on with update_task (after, [] to start it now), or cancel it with cancel_task.`;
    case 'answered':
      return `An answer arrived on ${ref}${said}Go on with it.`;
    case 'unblocked':
      return `Whoever gave you ${ref} answered what blocked it${said}Go on with the work. If you still cannot go on, ${stuck}.`;
    case 'comment':
      return `A person commented on ${ref}${said}Take it into account and go on.`;
    case 'updated':
      return `${ref} was rewritten. Read it again with the task tool and go on from its new body.`;
    case 'reminder':
      return `You ended your last turn on ${ref} without moving it. Go on with the work. If you cannot go on, ${stuck}.`;
    case 'go_on':
      return `Your last turn on ${ref} ended before the work did. Go on with the work from where you left off. If you cannot go on, ${stuck}.`;
    case 'subtasks':
      return `No work under ${ref} is open any more. ${read} Then go on with it and ${finish}.`;
    case 'turn':
      return `${ref} is closed.`;
    case 'switched':
      /* Its text says what to do. */
      return `${ref}, which you gave out, has nobody on to go on with it${w.text ? `:\n\n${w.text}` : '. Give it to someone who is on with update_task, or tell the CEO it waits.'}`;
    case 'tests':
      /* Its text is Hornhoof's account of the run, or who stopped it. */
      return `The tests you ran on ${ref} ended${said}Go on with the work. If you cannot go on, ${stuck}.`;
    case 'work':
      /* Its text is Hornhoof's account of the run, or who stopped it. */
      return `The work you ran on ${ref} ended${said}Go on with the task. If you cannot go on, ${stuck}.`;
    case 'calls':
      /* Its text is Hornhoof's account of the batch: the judge's verdict and every answer. */
      return `The one-shot calls you started on ${ref} ended${said}Go on with the task. If you cannot go on, ${stuck}.`;
    case 'explain':
      /* Hornhoof writes this turn itself, from the request. */
      return `${ref} waits for people. See /api/requests and put what is asked into plain words with explain_request.`;
  }
}

/* A switched-off agent with no turn running hands its work back; the person who switched it off moved it. */
export async function leaveIfOff(ctx: Ctx, agentId: string): Promise<void> {
  const [agent] = await ctx.db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent?.switchedOffAt || agent.kind === 'orchestrator') return;
  const [running] = await ctx.db.select(idOnly(jobs)).from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.status, 'running'), notStep)).limit(1);
  if (running) return;
  const [change] = await ctx.db
    .select({ personId: agentChanges.personId, byOrchestrator: agentChanges.byOrchestrator })
    .from(agentChanges)
    .where(and(eq(agentChanges.agentId, agentId), eq(agentChanges.field, 'switch')))
    .orderBy(desc(agentChanges.createdAt))
    .limit(1);
  const orchestrator = change?.byOrchestrator ? await orchestratorOf(ctx, agent.companyId) : null;
  const actor = change?.personId ? { personId: change.personId } : { agentId: orchestrator?.id ?? agentId };
  const left = await leaveWork(ctx, actor, agent);
  const { handed } = left;
  /* Another eligible checker may become available; the required stage is never skipped. */
  const resumed = await resumeWaitingRoutes(ctx, actor, agent, `${agent.name} was switched off.`);
  const wakes = [...left.wakes, ...resumed.wakes];
  /* Turns it would have taken on work it no longer holds would only confuse it once it is on again. */
  if (handed.length) {
    await ctx.db
      .update(jobs)
      .set({ status: 'failed', error: 'switched_off', finishedAt: new Date() })
      .where(and(eq(jobs.agentId, agentId), eq(jobs.status, 'queued'), inArray(jobs.taskId, handed)));
  }
  await wakeAll(ctx, wakes);
}

/* A newly available checker can resume the same required stage and candidate. */
export async function backOn(ctx: Ctx, actor: Actor, agentId: string): Promise<void> {
  const [agent] = await ctx.db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent || agent.switchedOffAt) return;
  const resumed = await resumeWaitingRoutes(ctx, actor, agent, `${agent.name} was switched on.`);
  await wakeAll(ctx, resumed.wakes);
  await pump(ctx, agentId);
}

/* An employee moved out of scope leaves its current assignment, not the route's required stage. */
export async function leaveForTeam(ctx: Ctx, actor: Actor, agent: { id: string; name: string; companyId: string }): Promise<void> {
  const left = await leaveWork(ctx, actor, agent);
  const resumed = await resumeWaitingRoutes(ctx, actor, agent, `${agent.name} moved to a sub-unit.`);
  const wakes = [...left.wakes, ...resumed.wakes];
  if (left.handed.length) {
    await ctx.db
      .update(jobs)
      .set({ status: 'failed', error: 'switched_off', finishedAt: new Date() })
      .where(and(eq(jobs.agentId, agent.id), eq(jobs.status, 'queued'), inArray(jobs.taskId, left.handed)));
  }
  await wakeAll(ctx, wakes);
}

/* Queues a turn for every agent a task move needs, one per agent and task: a turn already waiting reads the task as it is
   when it runs. Removed agents and agents without a subscription are left out. */
export async function wakeAll(ctx: Ctx, wakes: Wake[]): Promise<void> {
  const seen = new Set<string>();
  for (const w of wakes) {
    try {
      if (w.why === 'explain') {
        await explainRequest(ctx, w);
        await wakeQueued(ctx.db, w);
        continue;
      }
      const key = `${w.agentId}:${w.taskId}:${w.why}:${w.cause?.eventId ?? ""}`;
      const queued = !seen.has(key) && (await queueWake(ctx, w));
      seen.add(key);
      await wakeQueued(ctx.db, w);
      /* A queued turn that does not go out now goes when its machine is ready. */
      if (queued) await pump(ctx, w.agentId);
    } catch (err) {
      /* One that breaks keeps the others going, and its kept wake is tried again a minute later. */
      ctx.log.error({ error: loggable(err) }, 'A turn for a task could not be queued and is tried again in a minute.');
    }
  }
}

/* How long a move's caller has to queue its turns before Hornhoof takes them as left behind. */
const LEFT_BEHIND_MS = 30_000;

/* A sweep still running, so the next one does not queue its turns a second time. */
const sweeping = new WeakSet<Ctx>();

/* Queues the turns that moves kept and nobody queued, as after a server stopped between the two. */
export async function wakeLeftBehind(ctx: Ctx, now = new Date()): Promise<number> {
  if (sweeping.has(ctx)) return 0;
  sweeping.add(ctx);
  try {
    const left = await wakesLeft(ctx.db, new Date(now.getTime() - LEFT_BEHIND_MS));
    await wakeAll(ctx, left);
    return left.length;
  } finally {
    sweeping.delete(ctx);
  }
}

/* Requests reach their current addressee: a person through the orchestrator's plain words, or an internal stuck resolver
   directly. Typed into its turn when it works, else its own turn, one per request. */
async function explanationText(ctx: Ctx, w: Wake, request: typeof requests.$inferSelect, asker: string, task: Task): Promise<string | null> {
  const ref = `#${task.number} "${task.title}"`;
  let text: string;
  if (request.kind === 'stuck' && request.audience === 'internal') {
    if (request.triageAgentId !== w.agentId) return null;
    const [recipient] = await ctx.db.select(only(agents, 'kind')).from(agents).where(eq(agents.id, w.agentId));
    const action = recipient?.kind === 'orchestrator'
      ? `Read the task, then close this request yourself with "answer_request" and request ${request.id}, with answer or retry true. Do not ask a person.`
      : `Read the task, then answer it with "comment" on #${task.number}. Do not ask a person.`;
    text = `Hornhoof stopped waking ${asker} on ${ref} (internal stuck request ${request.id}). Hornhoof noted: ${request.text}\n\n${action}`;
  } else {
    const what = request.kind === 'stuck'
      ? `Hornhoof stopped waking ${asker} on ${ref} and waits for people to say how it goes on (request ${request.id}). Hornhoof noted: ${request.text}`
      : `${asker} asks people on ${ref} (request ${request.id}, a ${request.kind}):\n\n${quote(request.text)}`;
    text = `${what}\n\nBefore a person answers, find out what it needs: read the task with "task", and ask ${asker} with "message_employee" when its words are not enough. ` +
      `Then call "explain_request" with request ${request.id} and a few lines for the person, in the CEO's language and plain words without IT terms: ` +
      'which task and what for, what is needed from them and why, and the ways to go with what each leads to. Do not answer it yourself unless the CEO told you how.';
  }
  return text;
}

async function explainRequest(ctx: Ctx, w: Wake): Promise<void> {
  const [found] = await ctx.db
    .select({ request: requests, asker: agents.name, task: tasks })
    .from(requests)
    .innerJoin(agents, eq(agents.id, requests.agentId))
    .innerJoin(tasks, eq(tasks.id, requests.taskId))
    .where(eq(requests.id, w.text ?? ''));
  if (!found || found.request.status !== 'open' || !(await liveSubscription(ctx, w.agentId))) return;
  const { request, asker, task } = found;
  const text = await explanationText(ctx, w, request, asker, task);
  if (text === null) return;
  const cause = request.kind === 'stuck' ? w.cause : { actor: { agentId: request.agentId }, action: 'asked people', task: { id: task.id, number: task.number } };
  const notice = await wakeNotice(ctx, task, { ...w, cause });
  const message = { personId: null, text, task: { id: task.id, number: task.number }, request: request.id, ...notice };
  /* The request names the turn that explains it, so people see the orchestrator is on it. */
  const into = await deliverLive(ctx, w.agentId, text, { source: { data: message } }, (jobId, kept) =>
    appendEvent(ctx, { companyId: task.companyId, agentId: w.agentId, jobId, kind: 'message', data: message }, kept).then(() => {}),
  );
  const turn = { companyId: task.companyId, agentId: w.agentId, prompt: text, createdBy: null, message };
  if (into) await keepLetter(ctx, turn, into, 'read');
  else await insertTurn(ctx, turn);
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  if (!into) await pump(ctx, w.agentId);
}

/* A request turn ended: its readers see again that nobody is on it, whether or not it did its work. */
export async function explainEnded(ctx: Ctx, jobId: string): Promise<void> {
  const asked = sql<string>`${agentEvents.data}->>'request'`;
  const ended = await ctx.db
    .select({ task: tasks })
    .from(agentEvents)
    .innerJoin(requests, eq(sql`${requests.id}::text`, asked))
    .innerJoin(tasks, eq(tasks.id, requests.taskId))
    .where(and(eq(agentEvents.jobId, jobId), eq(agentEvents.kind, 'message')));
  const told = new Set<string>();
  for (const { task } of ended) {
    if (told.has(task.id)) continue;
    told.add(task.id);
    ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  }
}

/* An agent back on a subscription: the wakes it missed without one were left out, so every task waiting on it gets a turn,
   also each one it checks at a stage. */
export async function resumeAgent(ctx: Ctx, agentId: string): Promise<void> {
  const held = await ctx.db.select().from(tasks).where(and(eq(tasks.assigneeAgentId, agentId), inArray(tasks.status, ['open', 'working', 'review'])));
  const wakes: Wake[] = held.map(task => ({ agentId, taskId: task.id, why: task.status === 'review' ? 'review' : 'assigned' }));
  await wakeAll(ctx, wakes);
}

/* Turns on cancelled tasks end: a waiting one at once, a running one through its node. The agent that cancelled keeps its own. */
export async function stopTurns(ctx: Ctx, taskIds: string[], keep?: string): Promise<void> {
  if (taskIds.length) await stopJobs(ctx, inArray(jobs.taskId, taskIds), keep);
}

/* These turns end: a waiting one at once, a running one through its node. The agent named keeps its own. */
export async function stopJobs(ctx: Ctx, scope: SQL, keep?: string): Promise<void> {
  const open = await ctx.db
    .select({ id: jobs.id, status: jobs.status, agentId: jobs.agentId })
    .from(jobs)
    .where(and(scope, inArray(jobs.status, ['queued', 'running'])));
  for (const job of open) {
    if (keep && job.agentId === keep) continue;
    if (job.status === 'running') {
      await cancelJob(ctx, job.id);
      continue;
    }
    const [ended] = await ctx.db
      .update(jobs)
      .set({ status: 'failed', error: 'cancelled', result: 'Stopped.', finishedAt: new Date() })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, 'queued')))
      .returning({ id: jobs.id });
    if (ended) await afterJob(ctx, ended.id);
  }
}

/* Wakes that bring the agent new words on its task, which a turn on that task takes in while it runs. */
const LIVE_WAKES: WakeWhy[] = ['comment', 'unblocked', 'answered', 'updated', 'tests', 'work', 'calls'];
/* Wakes that would set the holder to work on its task, held back while the task waits for the tasks it comes after. */
const TO_WORK: WakeWhy[] = ['assigned', 'updated', 'comment', 'answered', 'unblocked', 'reminder', 'go_on', 'subtasks'];

/* What a wake says, kept as the message of its turn. */
async function wakeMessage(ctx: Ctx, agent: typeof agents.$inferSelect, task: Task, w: Wake) {
  const notice = await wakeNotice(ctx, task, w);
  const route = routeSnapshot(await routeOf(ctx.db, task), task.assigneeAgentId);
  /* The owner of a one-shot stage hears how the route runs it. */
  const stageCalls = w.why === 'review' || w.why === 'assigned' ? oneShotStageNote(task, route, w.agentId) : null;
  const prompt = notice.action + wakePrompt(agent, task, w, route.resultKind) + (stageCalls ? ` ${stageCalls}` : '') + (notice.report && w.text?.trim() !== notice.report ? `\n\n${quote(notice.report)}` : '');
  const reportContext = notice.report ? notice.action + wakePrompt(agent, task, { ...w, ...(w.text?.trim() === notice.report ? { text: undefined } : {}) }, route.resultKind) : undefined;
  return { text: prompt, task: { id: task.id, number: task.number }, taskWake: taskWakeOf(task, w, route), ...notice, reportContext };
}

async function waitsForBefore(db: Ctx['db'], task: Task, w: Wake): Promise<boolean> {
  return TO_WORK.includes(w.why) && w.agentId === task.assigneeAgentId && (await openAfter(db, task)).length > 0;
}

async function queueWake(ctx: Ctx, w: Wake): Promise<boolean> {
  const { db } = ctx;
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, w.agentId), isNull(agents.removedAt)));
  if (!agent || !(await liveSubscription(ctx, agent.id))) return false;
  const task = await taskForWake(db, w);
  if (!task) return false;
  if (await waitsForBefore(db, task, w)) return false;
  const handed = await handQueuedToFree(ctx, agent, task, w);
  if (handed) {
    await wakeAll(ctx, handed.wakes);
    return false;
  }
  const data = await wakeMessage(ctx, agent, task, w);
  /* New words on the task the agent works on right now go into that turn. */
  if (LIVE_WAKES.includes(w.why)) {
    const into = await deliverLive(ctx, agent.id, data.text, { taskId: task.id, source: { data } }, (jobId, kept) =>
      appendEvent(ctx, { companyId: agent.companyId, agentId: agent.id, jobId, kind: 'message', data }, kept).then(() => {}),
    );
    if (into) {
      await keepLetter(ctx, wakeTurn(agent, task, data), into, 'read');
      return false;
    }
  }
  /* One at a time per agent, so two moves at once still queue one turn. */
  return onAgent(ctx, agent.id, async () => {
    return keepTaskWake(ctx, agent, task, w, data);
  });
}

async function keepTaskWake(ctx: Ctx, agent: typeof agents.$inferSelect, task: Task, w: Wake, data: Omit<TurnMessage, 'personId'>): Promise<boolean> {
  const { db } = ctx;
  const waiting = data.report ? null : await waitingTaskTurn(db, agent.id, task.id);
  if (waiting) {
    /* Keep new words and their provenance with the turn that already waits. */
    if (LIVE_WAKES.includes(w.why) || w.cause?.actor) {
      await db.update(jobs).set({ prompt: sql`${jobs.prompt} || ${`\n\n${data.text}`}` }).where(eq(jobs.id, waiting.id));
      await appendEvent(ctx, { companyId: agent.companyId, agentId: agent.id, jobId: waiting.id, kind: 'message', data });
      await keepLetter(ctx, wakeTurn(agent, task, data), waiting.id, 'unread');
    }
    return true;
  }
  await insertTurn(ctx, wakeTurn(agent, task, data));
  return true;
}

/* The turn a wake's words make on its task, and the letter they are in the inbox wherever they went. */
const wakeTurn = (agent: typeof agents.$inferSelect, task: Task, data: Omit<TurnMessage, 'personId'>) =>
  ({ companyId: agent.companyId, agentId: agent.id, prompt: data.text, createdBy: null, taskId: task.id, message: { personId: null, ...data } });

/* The open task the agent holds after a turn about this one: the task itself, or the task it gave this one out from. */
async function heldTask(ctx: Ctx, agentId: string, taskId: string): Promise<Task | null> {
  const holds = (t: Task | undefined) => (t && t.assigneeAgentId === agentId && !CLOSED.includes(t.status) ? t : null);
  const [task] = await ctx.db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) return null;
  if (holds(task)) return task;
  if (!task.parentId) return null;
  const [parent] = await ctx.db.select().from(tasks).where(eq(tasks.id, task.parentId));
  return holds(parent);
}

async function programWorked(ctx: Ctx, jobId: string): Promise<boolean> {
  const [fact] = await ctx.db
    .select(idOnly(agentEvents))
    .from(agentEvents)
    .where(and(eq(agentEvents.jobId, jobId), or(inArray(agentEvents.kind, ['tool', 'tool_result', 'todo']), and(eq(agentEvents.kind, 'program'), sql`${agentEvents.data}->'program'->>'state' <> 'gone'`))))
    .limit(1);
  return Boolean(fact);
}

async function programWorkedOnTask(ctx: Ctx, jobId: string, taskId: string): Promise<boolean> {
  const [fact] = await ctx.db
    .select(idOnly(agentEvents))
    .from(agentEvents)
    .where(and(eq(agentEvents.jobId, jobId), inArray(agentEvents.kind, ['tool', 'tool_result', 'todo']), sql`${agentEvents.data}->'task'->>'id' = ${taskId}`))
    .limit(1);
  return Boolean(fact);
}

function livenessJob(job: typeof jobs.$inferSelect | undefined): job is HeldJob & { taskId: string } {
  return !(!job?.taskId || !job.agentId || !job.startedAt || job.error === 'cancelled' || job.result === GONE_ALONG);
}

async function livenessTasks(ctx: Ctx, job: HeldJob & { taskId: string }, carried: string[], carriedOnly: boolean) {
  const own = carriedOnly ? await heldTask(ctx, job.agentId, job.taskId) : null;
  const held = new Map<string, { task: Task; sourceId: string }>();
  for (const taskId of carriedOnly ? carried : [job.taskId, ...carried]) {
    const task = await heldTask(ctx, job.agentId, taskId);
    if (task && task.id !== own?.id && !held.has(task.id)) held.set(task.id, { task, sourceId: taskId });
  }
  return held;
}

/* After a turn on a task: an agent that went idle holding the task without moving it is reminded, and after
   SILENT_TURNS such turns its head is asked. Its own task needs a durable program or tool fact. A task carried inside that
   turn needs a tool fact naming it, so a coalesced backlog alone never advances a counter.
   Nothing is checked while the agent has another turn waiting on the task, or while the task waits on its subtasks, on the
   tasks it comes after or on people. */
export async function checkLiveness(ctx: Ctx, jobId: string, carried: string[] = [], { carriedOnly = false } = {}): Promise<void> {
  const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!livenessJob(job)) return;
  const held = await livenessTasks(ctx, job, carried, carriedOnly);
  for (const { task, sourceId } of held.values()) {
    const worked = sourceId === job.taskId ? await programWorked(ctx, jobId) : await programWorkedOnTask(ctx, jobId, sourceId);
    await checkHeld(ctx, { ...job, agentId: job.agentId, startedAt: job.startedAt }, task, worked);
  }
}

/* Turns that broke this soon after they started, this many in a row on one task, stop Hornhoof waking the agent there. */
export const QUICK_CRASH_MS = 3 * 60_000;
export const QUICK_CRASHES = 3;

type Ended = Pick<typeof jobs.$inferSelect, 'status' | 'error' | 'startedAt' | 'finishedAt' | 'result' | 'tail' | 'failure'>;

/* Turns that failed, this many in a row on one task and however long each ran, stop it too: going on did not help. */
export const FAILED_TURNS = 5;

/* A turn that failed by itself: not one stopped on purpose or out of time, nor one the plan refused for its limit. */
const failedByItself = (j: Ended) =>
  j.status === 'failed' &&
  !['timeout', 'cancelled', 'removed', 'switched_off', 'handed_on', 'waiting'].includes(j.error ?? '') &&
  !refusedLimits(`${j.result ?? ''}\n${j.tail}`, null);

/* A turn that broke as it started. */
const crashed = (j: Ended) =>
  failedByItself(j) &&
  (!j.failure || j.failure.kind === 'crash') &&
  !!j.startedAt &&
  !!j.finishedAt &&
  j.finishedAt.getTime() - j.startedAt.getTime() < QUICK_CRASH_MS;

/* A machine that started again has a retry of its own, so its turns do not count here. */
const failedAgain = (j: Ended) => failedByItself(j) && j.error !== 'machine_restarted';

/* A turn its plan refused for its limit as it started: it did no work. */
const refusedAtStart = (j: Ended) =>
  !!j.startedAt && !!j.finishedAt && j.finishedAt.getTime() - j.startedAt.getTime() < QUICK_CRASH_MS && !!refusedLimits(`${j.result ?? ''}\n${j.tail}`, null);

/* How many of the agent's last turns on the task broke that way, in a row, of those that ended since the task last moved. */
async function inRow(ctx: Ctx, agentId: string, task: Task, most: number, broke: (j: Ended) => boolean): Promise<number> {
  const moved = await lastMove(ctx.db, task.id);
  const rows = await ctx.db
    .select({ status: jobs.status, error: jobs.error, startedAt: jobs.startedAt, finishedAt: jobs.finishedAt, result: jobs.result, tail: jobs.tail, failure: jobs.failure })
    .from(jobs)
    .where(and(conversationOf(agentId), eq(jobs.taskId, task.id), isNotNull(jobs.startedAt), inArray(jobs.status, ['done', 'failed']), moved ? gt(jobs.finishedAt, moved.createdAt) : undefined))
    .orderBy(desc(jobs.startedAt))
    .limit(most);
  const n = rows.findIndex(j => !broke(j));
  return n === -1 ? rows.length : n;
}

/* Whether this turn was the last of QUICK_CRASHES in a row that broke as they started, or of FAILED_TURNS that failed. */
async function keptBreaking(ctx: Ctx, agentId: string, task: Task, job: Ended): Promise<'at_once' | 'again' | null> {
  if (crashed(job) && (await inRow(ctx, agentId, task, QUICK_CRASHES, crashed)) >= QUICK_CRASHES) return 'at_once';
  return failedAgain(job) && (await inRow(ctx, agentId, task, FAILED_TURNS, failedAgain)) >= FAILED_TURNS ? 'again' : null;
}

/* What Hornhoof notes on a task whose turns kept breaking: how, and the end of what the program said last. */
function crashNote(job: Ended & { agentName: string }, task: Task, quick: boolean): string {
  const said = (job.tail || job.result || '').trim().slice(-600);
  const how = quick ? `${QUICK_CRASHES} turns of ${job.agentName} in a row on #${task.number} broke within ${QUICK_CRASH_MS / 60_000} minutes of starting` : `${FAILED_TURNS} turns of ${job.agentName} in a row on #${task.number} failed`;
  return `${how}, so Hornhoof stopped waking it there. The last one ended with ${job.error ?? 'an error'}${said ? `:\n\n${said}` : '.'}`;
}

const PROVIDER_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi', glm: 'GLM', anthropic_api: 'an Anthropic key', openai_api: 'an OpenAI key' };

/* Who takes member work over while its executor's plan is at its limit: another employee of its role and department who
   is on, for the task's product or for none, on a plan of another provider that is not at its limit, and not in a
   sub-unit. Only an employee's work moves: a head and the orchestrator keep theirs and wait for the reset. */
async function rolePeers(ctx: Ctx, agentId: string, anotherProvider: boolean) {
  const [me] = await ctx.db
    .select({ agent: agents, provider: subscriptions.provider })
    .from(agents)
    .innerJoin(subscriptions, eq(subscriptions.id, agents.subscriptionId))
    .where(and(eq(agents.id, agentId), isNull(agents.teamId)));
  if (!me || me.agent.kind !== 'worker' || !me.agent.roleKey || !me.agent.departmentId) return null;
  const member = { id: agentId, departmentId: me.agent.departmentId, roleKey: me.agent.roleKey };
  return { me, peers: await peersOfRole(ctx, member, anotherProvider ? me.provider : undefined) };
}

async function transferableWork(ctx: Ctx, task: Task): Promise<boolean> {
  const route = await routeOf(ctx.db, task);
  return isStaged(route.state.resultKind) && !route.state.candidateId && ['architecture', 'development'].includes(route.state.stage ?? '');
}

async function standIn(ctx: Ctx, agentId: string, task: Task): Promise<{ id: string; name: string; provider: string } | null> {
  if (task.executorAgentId !== agentId || task.assigneeAgentId !== agentId || !await transferableWork(ctx, task) || !['open', 'working'].includes(task.status)) return null;
  /* What its turns did so far is in its folder on its machine and maybe not pushed, so only work none of them did
     anything on goes to another. */
  const ran = await ctx.db
    .select({ status: jobs.status, error: jobs.error, startedAt: jobs.startedAt, finishedAt: jobs.finishedAt, result: jobs.result, tail: jobs.tail, failure: jobs.failure })
    .from(jobs)
    .where(and(eq(jobs.agentId, agentId), eq(jobs.taskId, task.id), isNotNull(jobs.startedAt)));
  if (ran.some(j => !refusedAtStart(j))) return null;
  const found = await rolePeers(ctx, agentId, true);
  if (!found) return null;
  /* Only one whose turn would go out now: signed in, on a machine that is on, and with plan left for tasks. Anyone else
     would only wait in the agent's place. */
  for (const p of found.peers) {
    if (!mayTake(task, p)) continue;
    if (goesOutNow(await agentState(ctx, p.id))) return { id: p.id, name: p.name, provider: p.provider };
  }
  return null;
}

const isUnstartedMemberWork = (task: Task, agentId: string): boolean => task.executorAgentId === agentId && task.assigneeAgentId === agentId && task.status === 'open';

async function freeForQueued(ctx: Ctx, agentId: string, task: Task): Promise<{ id: string; name: string } | null> {
  if (!isUnstartedMemberWork(task, agentId) || !await transferableWork(ctx, task)) return null;
  const [started] = await ctx.db.select(idOnly(jobs)).from(jobs).where(and(eq(jobs.taskId, task.id), isNotNull(jobs.startedAt))).limit(1);
  if (started) return null;
  const found = await rolePeers(ctx, agentId, false);
  if (!found) return null;
  for (const p of found.peers) {
    if (!mayTake(task, p)) continue;
    if (await isFree(ctx, p.id)) return { id: p.id, name: p.name };
  }
  return null;
}

async function handQueuedToFree(ctx: Ctx, agent: Agent, task: Task, w: Wake): Promise<Moved | null> {
  if (w.why !== 'assigned') return null;
  const [running] = await ctx.db.select(idOnly(jobs)).from(jobs).where(and(conversationOf(agent.id), eq(jobs.status, 'running'))).limit(1);
  if (!running) return null;
  const other = await freeForQueued(ctx, agent.id, task);
  return other ? handOver(ctx, task, other.id, `${agent.name} is busy with another turn, so ${other.name} takes the unstarted work.`) : null;
}

const mayCheckTask = (task: Task): boolean => ['open', 'working', 'review'].includes(task.status) && !task.externalWait && !task.paused;

async function planLimitUntil(db: Ctx['db'], subscriptionId: string | null): Promise<string | null> {
  if (!subscriptionId) return null;
  const [sub] = await db.select({ limits: subscriptions.limits, limitsUpdatedAt: subscriptions.limitsUpdatedAt }).from(subscriptions).where(eq(subscriptions.id, subscriptionId));
  return sub ? limitUntil(sub.limits, sub.limitsUpdatedAt) : null;
}

async function hasOpenTaskWork(db: Ctx['db'], task: Task): Promise<boolean> {
  const [subtasks] = await db.select(countOnly()).from(tasks).where(and(eq(tasks.parentId, task.id), notInArray(tasks.status, [...CLOSED])));
  const [asked] = await db.select(countOnly()).from(requests).where(and(eq(requests.taskId, task.id), eq(requests.status, 'open')));
  return Boolean(Number(subtasks?.n ?? 0) || Number(asked?.n ?? 0) || (await openAfter(db, task)).length);
}

async function waitingOnTask(ctx: Ctx, agentId: string, task: Task): Promise<boolean> {
  const { db } = ctx;
  /* A turn already waiting on this task, or on one it gave out, comes back to it anyway. */
  const [next] = await db
    .select(idOnly(jobs))
    .from(jobs)
    .innerJoin(tasks, eq(tasks.id, jobs.taskId))
    .where(and(eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'queued'), or(eq(tasks.id, task.id), eq(tasks.parentId, task.id))))
    .limit(1);
  if (next) return true;
  /* Its test run's result wakes it on the task. */
  const [testing] = await db
    .select(idOnly(testRuns))
    .from(testRuns)
    .where(and(eq(testRuns.taskId, task.id), eq(testRuns.agentId, agentId), eq(testRuns.status, 'running')))
    .limit(1);
  if (testing) return true;
  return hasOpenTaskWork(db, task);
}

async function taskMovedInTurn(db: Ctx['db'], agentId: string, task: Task, startedAt: Date) {
  const [moves] = await db
    .select(countOnly())
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.agentId, agentId), gte(taskEvents.createdAt, startedAt), notInArray(taskEvents.kind, [...NOT_A_MOVE])));
  if (Number(moves?.n ?? 0)) {
    if (task.silent) await db.update(tasks).set({ silent: 0 }).where(eq(tasks.id, task.id));
    return true;
  }
  return false;
}

type PlanStandIn = NonNullable<Awaited<ReturnType<typeof standIn>>>;

const changedWhileResuming = (error: { reason?: string }) => error.reason === 'task_changed' ? null : Promise.reject(error);

function planHandoffText(name: string | undefined, other: PlanStandIn, until: string): string {
  return `${name ?? 'Its executor'}'s plan is at its limit until ${when(until)}, so ${other.name} takes the work over on ${PROVIDER_NAMES[other.provider] ?? other.provider}.`;
}

async function handOverAtPlanLimit(ctx: Ctx, agentId: string, task: Task, until: string, other: PlanStandIn): Promise<Moved | null> {
  const [me] = await ctx.db.select(only(agents, 'name')).from(agents).where(eq(agents.id, agentId));
  return handOver(ctx, task, other.id, planHandoffText(me?.name, other, until)).catch(changedWhileResuming);
}

async function resumeAtPlanLimit(ctx: Ctx, agentId: string, task: Task, until: string) {
  const other = await standIn(ctx, agentId, task);
  const over = other ? await handOverAtPlanLimit(ctx, agentId, task, until, other) : null;
  return wakeAll(ctx, over ? over.wakes : [{ agentId, taskId: task.id, why: 'go_on' }]);
}

type HeldJob = typeof jobs.$inferSelect & { agentId: string; startedAt: Date };

async function commentsInTurn(db: Ctx['db'], agentId: string, task: Task, startedAt: Date): Promise<number> {
  const [told] = await db
    .select(countOnly())
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.agentId, agentId), gte(taskEvents.createdAt, startedAt), eq(taskEvents.kind, 'comment')));
  return Number(told?.n ?? 0);
}

/* A timeout or a comment says the program worked and continues under the other counter. The first turn since the task last
   moved that waited in line until its node came back counts under neither. */
async function continuationOf(ctx: Ctx, agentId: string, task: Task, job: HeldJob) {
  if ((await waitedForReturn(ctx.db, job)) && !(await uncountedSinceMove(ctx.db, agentId, task))) return wentOnAfterReturn;
  return job.error === 'timeout' || (await commentsInTurn(ctx.db, agentId, task, job.startedAt)) > 0 ? wentOn : silentTurn;
}

async function continueWorkedTurn(ctx: Ctx, agentId: string, task: Task, job: HeldJob) {
  const advance = await continuationOf(ctx, agentId, task, job);
  const moved = await advance(ctx, agentId, task).catch(changedWhileResuming);
  if (moved) await wakeAll(ctx, moved.wakes);
}

async function wakeBrokenTurn(ctx: Ctx, job: HeldJob, task: Task): Promise<boolean> {
  const { agentId } = job;
  /* Jobs from older builds can still carry these dispatch errors. */
  const unsent = job.error === 'instructions_too_long' || job.error === 'node_too_old';
  const how = unsent ? null : await keptBreaking(ctx, agentId, task, job);
  if (!unsent && !how) return false;
  const text = unsent ? job.result ?? job.error! : await brokenTurnText(ctx, job, task, how === 'at_once');
  const moved = await brokeDown(ctx, agentId, task, text).catch((err: { reason?: string }) => err.reason === 'task_changed' ? null : Promise.reject(err));
  if (moved) await wakeAll(ctx, moved.wakes);
  return true;
}

async function brokenTurnText(ctx: Ctx, job: HeldJob, task: Task, quick: boolean): Promise<string> {
  const [me] = await ctx.db.select(only(agents, 'name')).from(agents).where(eq(agents.id, job.agentId));
  return crashNote({ ...job, agentName: me?.name ?? 'the agent' }, task, quick);
}

async function checkHeld(ctx: Ctx, job: HeldJob, task: Task, worked: boolean): Promise<void> {
  const { db } = ctx;
  const { agentId } = job;
  if (!mayCheckTask(task)) return;
  if (await waitingOnTask(ctx, agentId, task)) return;
  if (await taskMovedInTurn(db, agentId, task, job.startedAt)) return;
  /* A turn that ended at the plan's limit did not stand still: another of its role on another plan takes the work over,
     or the agent goes on once the limit starts over. */
  const until = await planLimitUntil(db, job.subscriptionId);
  if (until) return resumeAtPlanLimit(ctx, agentId, task, until);
  /* Turns that keep breaking as they start would only break again, and so would turns that keep failing later on: whoever
     gave the task out hears of it, once. So does a turn that did not go out for the length of its instructions, at once,
     as every next one would not either. */
  if (await wakeBrokenTurn(ctx, job, task)) return;
  /* A failure before that still goes on where the existing failure path says so, and advances neither stuck counter. */
  if (job.status === 'failed' && job.error !== 'timeout') return wakeAll(ctx, [{ agentId, taskId: task.id, why: 'go_on' }]);
  if (!worked) return;
  await continueWorkedTurn(ctx, agentId, task, job);
}

/* A finished turn: a failure or a stop goes into the conversation, a turn a node restart cut off on a task runs once more
   or calls Operations, a turn that left a task it carried where it was is caught, then the next turn goes out. */
export async function afterJob(ctx: Ctx, jobId: string): Promise<void> {
  const program = clearTurnProgram(ctx, jobId);
  const [job] = await ctx.db
    .select({ companyId: jobs.companyId, agentId: jobs.agentId, kind: jobs.kind, status: jobs.status, error: jobs.error, taskId: jobs.taskId, startedAt: jobs.startedAt, finishedAt: jobs.finishedAt, failure: jobs.failure, inboxWake: jobs.inboxWake })
    .from(jobs)
    .where(eq(jobs.id, jobId));
  forgetEndedTurn(ctx, jobId, job);
  await releaseJobPhones(ctx, jobId, job?.status === 'done' ? 'completed' : job?.error === 'cancelled' ? 'cancelled' : 'lost');
  if (job?.kind === 'call') return callEnded(ctx, jobId);
  if (!job?.agentId || job.kind !== 'conversation') return;
  if (job.status === 'failed') await recordFailedTurn(ctx, jobId, { ...job, agentId: job.agentId }, program);
  if (job.status === 'failed') await restoreUnheardInbox(ctx, jobId, { agentId: job.agentId, inboxWake: job.inboxWake });
  const handled = await afterFailure(ctx, jobId);
  if (job.taskId) {
    const taskTurn = { ...job, agentId: job.agentId, taskId: job.taskId };
    if (handled) await checkLiveness(ctx, jobId, await carriedTasks(ctx, taskTurn), { carriedOnly: true });
    else await afterTaskTurn(ctx, jobId, taskTurn);
  } else if (!handled && job.error === 'machine_restarted') await afterRestartOutsideTask(ctx, jobId);
  await explainEnded(ctx, jobId);
  await leaveIfOff(ctx, job.agentId);
  await pump(ctx, job.agentId);
}

/* What the program itself says in a turn: only that shows it got the turn's prompt. A typed mark is a person's Enter or
   words shown again, and proves nothing of it. */
const PROGRAM_SAID = ['text', 'todo', 'tool', 'tool_result'] as const;

/* Inbox wakes keep their retry policy. An ordinary turn can carry the same summary: until its program answered it, its
   failed delivery must not consume those letters. Once it answered, they stay read, so they are not given twice. */
async function restoreUnheardInbox(ctx: Ctx, jobId: string, job: { agentId: string; inboxWake: boolean }): Promise<void> {
  if (!job.inboxWake) {
    const [said] = await ctx.db.select(idOnly(agentEvents)).from(agentEvents)
      .where(and(eq(agentEvents.jobId, jobId), inArray(agentEvents.kind, [...PROGRAM_SAID]))).limit(1);
    if (said) return;
  }
  if (await mailBack(ctx.db, job.agentId, jobId)) await inboxChanged(ctx, job.agentId);
}

async function recordFailedTurn(
  ctx: Ctx,
  jobId: string,
  job: Parameters<typeof doneIfRecorded>[2] & { companyId: string; agentId: string; failure: typeof jobs.$inferSelect['failure'] },
  program: ReturnType<typeof clearTurnProgram>,
): Promise<void> {
  if (await doneIfRecorded(ctx, jobId, job)) return;
  const stopped = job.error === 'cancelled';
  await appendEvent(ctx, {
    companyId: job.companyId,
    agentId: job.agentId,
    jobId,
    kind: stopped ? 'stopped' : 'failed',
    data: stopped ? {} : { ...failedProgramData(job.error, program), ...(job.failure ? { failure: job.failure } : {}) },
  });
}

/* A turn on a task a node restart cut off gets its retry waiting on the task before the task is checked, and one that
   failed without recording its work its continuation, so nothing else runs it again; a retry cut off too runs no more. */
async function afterTaskTurn(ctx: Ctx, jobId: string, job: Parameters<typeof carriedTasks>[1] & { error: string | null }): Promise<void> {
  const ended = job.error === 'machine_restarted' ? await afterRestart(ctx, jobId) : (await keepsBreaking(ctx, jobId)) ? null : await continueOnce(ctx, jobId);
  if (ended !== 'called') await checkLiveness(ctx, jobId, await carriedTasks(ctx, job));
}

/* The turn broke as it started, the last of QUICK_CRASHES in a row on its task, or failed as the last of FAILED_TURNS:
   going on would only break again, so the task stops for whoever gave it out instead. */
async function keepsBreaking(ctx: Ctx, jobId: string): Promise<boolean> {
  const [row] = await ctx.db.select({ job: jobs, task: tasks }).from(jobs).innerJoin(tasks, eq(tasks.id, jobs.taskId)).where(eq(jobs.id, jobId));
  return Boolean(row?.job.agentId && await keptBreaking(ctx, row.job.agentId, row.task, row.job));
}

/* The node stops the program and reports the job as cancelled. A node that is away cannot, so the job ends here. */
export async function cancelJob(ctx: Ctx, jobId: string): Promise<void> {
  const job = await requestCancellation(ctx, jobId);
  if (!job) return;
  await releaseJobPhones(ctx, jobId);
  const node = identityOf(job.sub, job.job.nodeId, job.job.builtinMachine, ownBuiltin(ctx.config));
  if (node && ctx.hub.send(node, { type: 'job.cancel', jobId })) return;
  const [ended] = await ctx.db
    .update(jobs)
    .set({ status: 'failed', error: 'cancelled', result: 'Stopped.', finishedAt: new Date() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')))
    .returning({ id: jobs.id });
  if (!ended) return;
  await publishWorking(ctx, job.job.companyId);
  await afterJob(ctx, jobId);
}

/* Keep Stop before contacting the node: a delayed stream or completion must not undo the person's request. */
async function requestCancellation(ctx: Ctx, jobId: string) {
  const [job] = await ctx.db.update(jobs).set({ error: 'cancelled' }).where(and(eq(jobs.id, jobId), eq(jobs.status, 'running'))).returning();
  if (!job) return null;
  const [sub] = await ctx.db.select().from(subscriptions).where(eq(subscriptions.id, job.subscriptionId));
  return sub ? { job, sub } : null;
}

/* A person typed into the agent's terminal: the turn opens, and what they typed answers what the agent asked them, out of
   the agent's line, which the pump of its task's turn waits on. */
export async function typedTurn(ctx: Ctx, node: NodeIdentity, agentId: string, text: string, personId: string | null, queuedFrom?: string): Promise<{ jobId: string; token: string } | null> {
  const opened = await openTypedTurn(ctx, node, agentId, text, personId, queuedFrom);
  if (!opened) await turnRefused(ctx, node, agentId, text, queuedFrom);
  else if (opened.typedBy) await wakeAll(ctx, await answerDirectly(ctx, opened.typedBy, agentId, text));
  return opened;
}

function forgetEndedTurn(ctx: Ctx, jobId: string, job: { status: string } | undefined): void {
  if (job && (job.status === 'done' || job.status === 'failed')) forgetPrivateTurn(ctx.db, jobId);
}
