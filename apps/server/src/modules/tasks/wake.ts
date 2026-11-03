import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { loggable } from '../../errors.js';
import { agentChanges, agentEvents, agents, jobs, requests, subscriptions, taskEvents, tasks, testRuns } from '../../db/schema.js';
import { agentState, conversationOf, insertTurn, limitUntil, liveSubscription, onAgent, openTypedTurn, orchestratorOf, pump, refusedLimits, UNSENT } from '../conversation/queue.js';
import { deliverLive } from '../conversation/decision-context.js';
import { quote } from '../conversation/prompt.js';
import { appendEvent, publishWorking } from '../events/store.js';
import { identityOf, type NodeIdentity } from '../nodes/hub.js';
import { answerDirectly, brokeDown, CLOSED, GATE_ROUNDS, handOver, lastMove, leaveWork, NOT_A_MOVE, openAfter, published, regateWaiting, reviewWake, silentTurn, taskSpot, wentOn, type Actor, type Task, type Wake, type WakeWhy } from './engine.js';
import { wakeQueued, wakesLeft } from './outbox.js';
import { carriedTasks, continueOnce, doneIfRecorded } from './endings.js';
import { afterRestart } from './restarts.js';
import { clearTurnProgram, failedProgramData } from './silent.js';
import { settle, tell } from './turns.js';

export { SILENT_TURNS, startWork } from './engine.js';

type Agent = typeof agents.$inferSelect;

/* What finishes the task for whoever holds it, and what to do when that cannot happen. */
function nextStep(task: Task, agentId: string): { finish: string; stuck: string } {
  if (task.stage > 0 && task.panel.includes(agentId)) return { finish: 'give your verdict with your reasons', stuck: 'ask a person with ask_person' };
  if (task.merging && task.executorAgentId === agentId) return { finish: "merge your branch into the turn's branch and report it with submit", stuck: 'report what blocks the merge with blocked' };
  if (task.executorAgentId === agentId) return { finish: 'submit it with what you did and the evidence (the commands you ran and what they showed)', stuck: 'say so with blocked' };
  /* Member work that waits with whoever gave it out, while nobody who does or checks it is on. */
  if (task.executorAgentId) return { finish: 'give it to someone who is on with update_task', stuck: 'tell the CEO it waits' };
  return { finish: 'report it', stuck: 'report it as not done, with what stands in the way' };
}

/* Wakes whose text an employee wrote: the reasons of a gate, a report, a block, a cancellation. */
const EMPLOYEES_SAY: WakeWhy[] = ['changes', 'reported', 'blocked', 'cancelled', 'review', 'unblocked'];

/* The turn's prompt: which task, why the agent wakes, and what is expected of it, then what else it should know. Always
   English, like the agents' instructions. */
export function wakePrompt(agent: Pick<Agent, 'kind'>, task: Task, w: Wake): string {
  const prompt = reason(agent, task, w);
  return w.note ? `${prompt}\n\n${w.note}` : prompt;
}

function reason(agent: Pick<Agent, 'kind'>, task: Task, w: Wake): string {
  const ref = `#${task.number} "${task.title}"`;
  const read = 'Read it with the task tool first: its body is the current truth and its log has the rest.';
  /* What an employee wrote is marked as theirs; a person's answer or comment stays as they wrote it. */
  const said = w.text ? `:\n\n${EMPLOYEES_SAY.includes(w.why) ? quote(w.text) : w.text}\n\n` : '. ';
  const { finish, stuck } = nextStep(task, w.agentId);
  /* The orchestrator holds no task of his own: he runs the turn. */
  const own = agent.kind === 'orchestrator' ? 'the turn' : 'your own task';
  switch (w.why) {
    case 'assigned':
      if (task.executorAgentId) return `${ref} is yours to do. ${read} Do the work, then ${finish}. If you cannot go on, ${stuck}; if only a person can answer, use ask_person.`;
      if (agent.kind === 'orchestrator') return `${ref} is yours. ${read} Lay the work out as tasks for the departments with add_tasks or plan_turn, and report it when every part is done.`;
      return `${ref} is your department's. ${read} Give it out in 2-4 large self-contained pieces to different members at once with create_task, each under it (parent ${task.number}) with its executor and no gates for code: the review of the turn checks all of it once the last piece is in. Report it when they are done.`;
    case 'review': {
      /* Its text is what this reviewer sent the work back for in the last round. */
      if (w.text) return `${ref} came back to your gate. You sent it back for${said}Check only the fixes for your own findings, then give your verdict: pass it, or send it back if one of them is still not fixed.`;
      const together = task.panel.length > 1 ? ' Reviewers of other models check the same work at once; give your own verdict.' : '';
      return (
        `${ref} is at your gate. ${read} Check the work yourself, then give your verdict: pass it, with notes for what does not block, or send it back only for blocking findings ` +
        `(a failing test, an unmet requirement, a security hole, data loss), all of them at once with file and line.${together}`
      );
    }
    case 'turn_review': {
      /* Its text names the turn's branch. */
      const branch = w.text ?? "the turn's branch";
      return (
        `${ref} is the review of everything ${branch.replace('-', ' ')} changed in your department, once for the whole turn. ${read} Check it on the turn's branch: git diff <main line>...${branch}. ` +
        'Other reviewers check the same branch at once, each for what their role looks at. Give your verdict: pass it, with notes for what does not block, or send it back for blocking findings ' +
        '(a failing test, an unmet requirement, a security hole, data loss), all of them at once with file and line. Your findings go only in your verdict: write to nobody while you review.'
      );
    }
    case 'reviewed':
      return (
        `The reviewers of ${ref} gave their verdicts, and some of them block:\n\n${quote(w.text ?? '')}\n\n` +
        "Give each blocking finding as a fix task without gates (gates: []) under your department's task, to the member whose change it is, all at once with create_task. " +
        'Each fix starts with a test that fails and then passes; there is no second review. Take a note that does not block into those tasks only when it is cheap. Once the fixes are in, give the final check.'
      );
    case 'review_passed':
      return `Nobody found anything that blocks in the ${task.title.toLowerCase()}:\n\n${quote(w.text ?? '')}\n\nWhere it says someone did not check, decide first whether the turn needs their check, then give the final check.`;
    case 'changes':
      return `${ref} came back to you with changes requested${said}Make them, then submit it again.`;
    case 'merge':
      /* Its text names the turn's branch. */
      return `${ref} passed its gates. Merge your branch into ${w.text ? `${w.text}, the turn's branch,` : "the turn's branch"} and report: submit it with what you merged and the commit. If the merge fails, report what blocks it with blocked.`;
    case 'stuck_at_gate':
      return `${ref}, which you gave out, went back from the same gate ${GATE_ROUNDS} times. Read its log, then step in: rewrite it with update_task, give it another executor or other gates, or cancel it.`;
    case 'done':
      return `${ref}, which you gave out, passed its gates and is done. Read the result with the task tool, then go on with ${own}.`;
    case 'reported':
      return `${ref}, which you gave out, was reported done${said}Go on with ${own}.`;
    case 'blocked':
      /* The orchestrator does not rewrite a department's task: he gives the department a new one. */
      if (agent.kind === 'orchestrator') return `${ref}, which you gave out, cannot go on${said}Cancel it with cancel_task and give the department a task it can do with add_tasks, or tell the CEO what stands in the way.`;
      if (task.executorAgentId) return `${ref}, which you gave out, cannot go on${said}Answer it with comment, which opens it again for its executor. Rewrite it with update_task only when its goal changed, give it to someone else, or cancel it.`;
      return `${ref}, which you gave out, cannot go on${said}Unblock it: rewrite it with update_task, give it to someone else, or cancel it.`;
    case 'cancelled':
      return `${ref}, which you gave out, was cancelled${said}Go on with ${own} without it.`;
    case 'after_cancelled':
      /* Its text names the cancelled tasks. */
      return `${ref} comes after ${w.text ?? 'a task'}, which was cancelled, so it still waits and nobody works on it. ${read} Give it what it waits for from now on with update_task (after, [] to start it now), or cancel it with cancel_task.`;
    case 'answered':
      return `A person answered on ${ref}${said}Go on with it.`;
    case 'unblocked':
      return `Whoever gave you ${ref} answered what blocked it${said}Go on with the work, then ${finish}. If you still cannot go on, ${stuck}.`;
    case 'comment':
      return `A person commented on ${ref}${said}Take it into account and go on.`;
    case 'updated':
      return `${ref} was rewritten. Read it again with the task tool and go on from its new body.`;
    case 'reminder':
      return `You ended your last turn on ${ref} without moving it. Go on with the work, then ${finish}. If you cannot go on, ${stuck}.`;
    case 'go_on':
      return `Your last turn on ${ref} ended before the work did. Go on with the work from where you left off, then ${finish}. If you cannot go on, ${stuck}.`;
    case 'subtasks':
      return `No work under ${ref} is open any more. ${read} Then go on with it and ${finish}.`;
    case 'turn':
      return `${ref} is closed.`;
    case 'switched':
      /* Its text says what to do. */
      return `${ref}, which you gave out, has nobody on to go on with it${w.text ? `:\n\n${w.text}` : '. Give it to someone who is on with update_task, or tell the CEO it waits.'}`;
    case 'tests':
      /* Its text is Hornhoof's account of the run, or who stopped it. */
      return `The tests you ran on ${ref} ended${said}Go on with the work, then ${finish}. If you cannot go on, ${stuck}.`;
    case 'work':
      /* Its text is Hornhoof's account of the run, or who stopped it. */
      return `The work you ran on ${ref} ended${said}Go on with the task, then ${finish}. If you cannot go on, ${stuck}.`;
    case 'explain':
      /* Hornhoof writes this turn itself, from the request. */
      return `${ref} waits for people. See /api/requests and put what is asked into plain words with explain_request.`;
  }
}

/* A switched-off agent with no turn running hands its work back; the person who switched it off moved it. */
export async function leaveIfOff(ctx: Ctx, agentId: string): Promise<void> {
  const [agent] = await ctx.db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent?.switchedOffAt || agent.kind === 'orchestrator') return;
  const [running] = await ctx.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.status, 'running'))).limit(1);
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
  /* With it the last of its role may be off, which takes that role's gates out of the way of the work waiting at them. */
  const regated = await regateWaiting(ctx, actor, agent, `${agent.name} was switched off.`);
  const wakes = [...left.wakes, ...regated.wakes];
  const closed = [...left.closed, ...regated.closed];
  /* Turns it would have taken on work it no longer holds would only confuse it once it is on again. */
  if (handed.length) {
    await ctx.db
      .update(jobs)
      .set({ status: 'failed', error: 'switched_off', finishedAt: new Date() })
      .where(and(eq(jobs.agentId, agentId), eq(jobs.status, 'queued'), inArray(jobs.taskId, handed)));
  }
  await wakeAll(ctx, await settled(ctx, agent.companyId, wakes, closed));
}

/* A gate an agent left or that went out of the way may have finished the last task of the open turn. */
async function settled(ctx: Ctx, companyId: string, wakes: Wake[], closed: Task[]): Promise<Wake[]> {
  let all = wakes;
  for (const task of closed) {
    const done = await settle(ctx, task);
    if (done) all = tell(all, done, (await orchestratorOf(ctx, companyId))?.id ?? null, task.id);
  }
  return all;
}

/* An agent switched on again picks up the gates that waited for someone of its role, and the turns it missed go out. */
export async function backOn(ctx: Ctx, actor: Actor, agentId: string): Promise<void> {
  const [agent] = await ctx.db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent || agent.switchedOffAt) return;
  const regated = await regateWaiting(ctx, actor, agent, `${agent.name} was switched on.`);
  await wakeAll(ctx, await settled(ctx, agent.companyId, regated.wakes, regated.closed));
  await pump(ctx, agentId);
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
      const key = `${w.agentId}:${w.taskId}`;
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

/* An employee waits for people: the orchestrator finds out what it needs and puts it into plain words for them, which
   people read above their answer. Typed into the orchestrator's turn when it works, else its own turn, one per request. */
async function explainRequest(ctx: Ctx, w: Wake): Promise<void> {
  const [found] = await ctx.db
    .select({ request: requests, asker: agents.name, task: tasks })
    .from(requests)
    .innerJoin(agents, eq(agents.id, requests.agentId))
    .innerJoin(tasks, eq(tasks.id, requests.taskId))
    .where(eq(requests.id, w.text ?? ''));
  if (!found || found.request.status !== 'open' || !(await liveSubscription(ctx, w.agentId))) return;
  const { request, asker, task } = found;
  const ref = `#${task.number} "${task.title}"`;
  const what =
    request.kind === 'stuck'
      ? `Hornhoof stopped waking ${asker} on ${ref} and waits for people to say how it goes on (request ${request.id}). Hornhoof noted: ${request.text}`
      : `${asker} asks people on ${ref} (request ${request.id}, a ${request.kind}):\n\n${quote(request.text)}`;
  const text =
    `${what}\n\nBefore a person answers, find out what it needs: read the task with "task", and ask ${asker} with "message_employee" when its words are not enough. ` +
    `Then call "explain_request" with request ${request.id} and a few lines for the person, in the CEO's language and plain words without IT terms: ` +
    'which task and what for, what is needed from them and why, and the ways to go with what each leads to. Do not answer it yourself unless the CEO told you how.';
  const message = { personId: null, text, task: { id: task.id, number: task.number }, request: request.id };
  /* The request names the turn that explains it, so people see the orchestrator is on it. */
  const into = await deliverLive(ctx, w.agentId, text, {}, (jobId, kept) =>
    appendEvent(ctx, { companyId: task.companyId, agentId: w.agentId, jobId, kind: 'message', data: { text, task: { id: task.id, number: task.number }, request: request.id } }, kept).then(() => {}),
  );
  if (!into) await insertTurn(ctx, { companyId: task.companyId, agentId: w.agentId, prompt: text, createdBy: null, message });
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  if (!into) await pump(ctx, w.agentId);
}

/* A turn that was to put requests into words ended: people see again that nobody is on them, whether or not it did. */
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
   also each one it checks at a gate. */
export async function resumeAgent(ctx: Ctx, agentId: string): Promise<void> {
  const checks = and(eq(tasks.status, 'review'), sql`${tasks.panel} @> ${JSON.stringify([agentId])}::jsonb`);
  const held = await ctx.db.select().from(tasks).where(or(and(eq(tasks.assigneeAgentId, agentId), inArray(tasks.status, ['open', 'working', 'review'])), checks));
  const wakes: Wake[] = [];
  for (const t of held) wakes.push({ agentId, taskId: t.id, ...(t.panel.includes(agentId) ? await reviewWake(ctx.db, t) : { why: t.status === 'review' ? 'review' : 'assigned' }) });
  await wakeAll(ctx, wakes);
}

/* Turns on cancelled tasks end: a waiting one at once, a running one through its node. The agent that cancelled keeps its own. */
export async function stopTurns(ctx: Ctx, taskIds: string[], keep?: string): Promise<void> {
  if (!taskIds.length) return;
  const open = await ctx.db
    .select({ id: jobs.id, status: jobs.status, agentId: jobs.agentId })
    .from(jobs)
    .where(and(inArray(jobs.taskId, taskIds), inArray(jobs.status, ['queued', 'running'])));
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
const LIVE_WAKES: WakeWhy[] = ['comment', 'answered', 'updated', 'tests', 'work'];
/* Wakes that would set the holder to work on its task, held back while the task waits for the tasks it comes after. */
const TO_WORK: WakeWhy[] = ['assigned', 'updated', 'comment', 'answered', 'unblocked', 'reminder', 'go_on', 'subtasks'];

async function queueWake(ctx: Ctx, w: Wake): Promise<boolean> {
  const { db } = ctx;
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, w.agentId), isNull(agents.removedAt)));
  if (!agent || !(await liveSubscription(ctx, agent.id))) return false;
  const [task] = await db.select().from(tasks).where(eq(tasks.id, w.taskId));
  if (!task) return false;
  if (TO_WORK.includes(w.why) && w.agentId === task.assigneeAgentId && (await openAfter(db, task)).length) return false;
  /* New words on the task the agent works on right now go into that turn. */
  if (LIVE_WAKES.includes(w.why)) {
    const text = wakePrompt(agent, task, w);
    const into = await deliverLive(ctx, agent.id, text, { taskId: task.id }, (jobId, kept) =>
      appendEvent(ctx, { companyId: agent.companyId, agentId: agent.id, jobId, kind: 'message', data: { text, task: { id: task.id, number: task.number } } }, kept).then(() => {}),
    );
    if (into) return false;
  }
  /* One at a time per agent, so two moves at once still queue one turn. */
  return onAgent(ctx, agent.id, async () => {
    const [waiting] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.agentId, agent.id), eq(jobs.taskId, task.id), eq(jobs.status, 'queued')))
      .limit(1);
    if (waiting) {
      /* A run's result is not in the task, so the turn that waits carries it along. */
      if (w.why === 'tests' || w.why === 'work') {
        const text = wakePrompt(agent, task, w);
        await db.update(jobs).set({ prompt: sql`${jobs.prompt} || ${`\n\n${text}`}` }).where(eq(jobs.id, waiting.id));
        await appendEvent(ctx, { companyId: agent.companyId, agentId: agent.id, jobId: waiting.id, kind: 'message', data: { text, task: { id: task.id, number: task.number } } });
      }
      return false;
    }
    const prompt = wakePrompt(agent, task, w);
    await insertTurn(ctx, { companyId: agent.companyId, agentId: agent.id, prompt, createdBy: null, taskId: task.id, message: { personId: null, text: prompt, task: { id: task.id, number: task.number } } });
    return true;
  });
}

/* The open task the agent holds after a turn about this one: the task itself, or the task it gave this one out from. */
async function heldTask(ctx: Ctx, agentId: string, taskId: string): Promise<Task | null> {
  const holds = (t: Task | undefined) => (t && (t.assigneeAgentId === agentId || t.panel.includes(agentId)) && !CLOSED.includes(t.status) ? t : null);
  const [task] = await ctx.db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) return null;
  if (holds(task)) return task;
  if (!task.parentId) return null;
  const [parent] = await ctx.db.select().from(tasks).where(eq(tasks.id, task.parentId));
  return holds(parent);
}

/* After a turn on a task: an agent that went idle holding the task without moving it is reminded, and after
   SILENT_TURNS such turns a person is asked. Only a turn that ran and said nothing counts so: one that broke, worked until
   its time ran out or said in the task how far it got goes on, up to GOING_ON_TURNS in a row, and one a person stopped
   does not count.
   Nothing is checked while the agent has another turn waiting on the task, or while the task waits on its subtasks, on the
   tasks it comes after or on people.
   A turn that carried other tasks' turns along is checked on each of those tasks too, and a task the agent holds once,
   however many of them lead to it. */
export async function checkLiveness(ctx: Ctx, jobId: string, carried: string[] = []): Promise<void> {
  const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job?.taskId || !job.agentId || !job.startedAt || job.error === 'cancelled') return;
  const held = new Map<string, Task>();
  for (const taskId of [job.taskId, ...carried]) {
    const task = await heldTask(ctx, job.agentId, taskId);
    if (task && !held.has(task.id)) held.set(task.id, task);
  }
  for (const task of held.values()) await checkHeld(ctx, { ...job, agentId: job.agentId, startedAt: job.startedAt }, task);
}

/* Turns that broke this soon after they started, this many in a row on one task, stop Hornhoof waking the agent there. */
export const QUICK_CRASH_MS = 3 * 60_000;
export const QUICK_CRASHES = 3;

type Ended = Pick<typeof jobs.$inferSelect, 'status' | 'error' | 'startedAt' | 'finishedAt' | 'result' | 'tail'>;

/* A turn that broke as it started: not one stopped on purpose or out of time, nor one the plan refused for its limit. */
const crashed = (j: Ended) =>
  j.status === 'failed' &&
  !['timeout', 'cancelled', 'removed', 'switched_off', 'handed_on', 'waiting'].includes(j.error ?? '') &&
  !!j.startedAt &&
  !!j.finishedAt &&
  j.finishedAt.getTime() - j.startedAt.getTime() < QUICK_CRASH_MS &&
  !refusedLimits(`${j.result ?? ''}\n${j.tail}`, null);

/* A turn its plan refused for its limit as it started: it did no work. */
const refusedAtStart = (j: Ended) =>
  !!j.startedAt && !!j.finishedAt && j.finishedAt.getTime() - j.startedAt.getTime() < QUICK_CRASH_MS && !!refusedLimits(`${j.result ?? ''}\n${j.tail}`, null);

/* How many of the agent's last turns on the task broke as they started, in a row, of those that ended since the task last moved. */
async function crashesInRow(ctx: Ctx, agentId: string, task: Task): Promise<number> {
  const moved = await lastMove(ctx.db, task.id);
  const rows = await ctx.db
    .select({ status: jobs.status, error: jobs.error, startedAt: jobs.startedAt, finishedAt: jobs.finishedAt, result: jobs.result, tail: jobs.tail })
    .from(jobs)
    .where(and(conversationOf(agentId), eq(jobs.taskId, task.id), isNotNull(jobs.startedAt), inArray(jobs.status, ['done', 'failed']), moved ? gt(jobs.finishedAt, moved.createdAt) : undefined))
    .orderBy(desc(jobs.startedAt))
    .limit(QUICK_CRASHES);
  const n = rows.findIndex(j => !crashed(j));
  return n === -1 ? rows.length : n;
}

/* What Hornhoof notes on a task whose turns kept breaking: how, and the end of what the program said last. */
function crashNote(job: Ended & { agentName: string }, task: Task): string {
  const said = (job.tail || job.result || '').trim().slice(-600);
  return `${QUICK_CRASHES} turns of ${job.agentName} in a row on #${task.number} broke within ${QUICK_CRASH_MS / 60_000} minutes of starting, so Hornhoof stopped waking it there. The last one ended with ${job.error ?? 'an error'}${said ? `:\n\n${said}` : '.'}`;
}

const PROVIDER_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi', glm: 'GLM', anthropic_api: 'an Anthropic key', openai_api: 'an OpenAI key' };

/* Who takes member work over while its executor's plan is at its limit: another employee of its role and department who
   is on, for the task's product or for none, on a plan of another provider that is not at its limit, and not one of the
   task's gates. Only an employee's work moves: a head and the orchestrator keep theirs and wait for the reset. */
async function standIn(ctx: Ctx, agentId: string, task: Task): Promise<{ id: string; name: string; provider: string } | null> {
  if (task.executorAgentId !== agentId || task.assigneeAgentId !== agentId || task.stage !== 0 || !['open', 'working'].includes(task.status)) return null;
  const [me] = await ctx.db.select({ agent: agents, provider: subscriptions.provider }).from(agents).innerJoin(subscriptions, eq(subscriptions.id, agents.subscriptionId)).where(eq(agents.id, agentId));
  if (!me || me.agent.kind !== 'worker' || !me.agent.roleKey || !me.agent.departmentId) return null;
  /* What its turns did so far is in its folder on its machine and maybe not pushed, so only work none of them did
     anything on goes to another. */
  const ran = await ctx.db
    .select({ status: jobs.status, error: jobs.error, startedAt: jobs.startedAt, finishedAt: jobs.finishedAt, result: jobs.result, tail: jobs.tail })
    .from(jobs)
    .where(and(eq(jobs.agentId, agentId), eq(jobs.taskId, task.id), isNotNull(jobs.startedAt)));
  if (ran.some(j => !refusedAtStart(j))) return null;
  const peers = await ctx.db
    .select({ id: agents.id, name: agents.name, productId: agents.productId, provider: subscriptions.provider })
    .from(agents)
    .innerJoin(subscriptions, and(eq(subscriptions.id, agents.subscriptionId), isNull(subscriptions.removedAt)))
    .where(and(eq(agents.departmentId, me.agent.departmentId), eq(agents.roleKey, me.agent.roleKey), eq(agents.kind, 'worker'), isNull(agents.removedAt), isNull(agents.switchedOffAt), ne(agents.id, agentId), ne(subscriptions.provider, me.provider)))
    .orderBy(asc(agents.createdAt));
  /* Only one whose turn would go out now: signed in, on a machine that is on, and with plan left for tasks. Anyone else
     would only wait in the agent's place. */
  for (const p of peers) {
    if ((p.productId && p.productId !== task.productId) || task.gates.includes(p.id)) continue;
    const state = await agentState(ctx, p.id);
    if (state.ready && !state.limitUntil && !state.budgetUntil) return { id: p.id, name: p.name, provider: p.provider };
  }
  return null;
}

async function checkHeld(ctx: Ctx, job: typeof jobs.$inferSelect & { agentId: string; startedAt: Date }, task: Task): Promise<void> {
  const { db } = ctx;
  const { agentId } = job;
  if (!['open', 'working', 'review'].includes(task.status)) return;
  /* A turn already waiting on this task, or on one it gave out, comes back to it anyway. */
  const [next] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(tasks, eq(tasks.id, jobs.taskId))
    .where(and(eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'queued'), or(eq(tasks.id, task.id), eq(tasks.parentId, task.id))))
    .limit(1);
  if (next) return;
  /* Its test run's result wakes it on the task. */
  const [testing] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(and(eq(testRuns.taskId, task.id), eq(testRuns.agentId, agentId), eq(testRuns.status, 'running')))
    .limit(1);
  if (testing) return;
  const [subtasks] = await db.select({ n: count() }).from(tasks).where(and(eq(tasks.parentId, task.id), notInArray(tasks.status, [...CLOSED])));
  const [asked] = await db.select({ n: count() }).from(requests).where(and(eq(requests.taskId, task.id), eq(requests.status, 'open')));
  if (Number(subtasks?.n ?? 0) || Number(asked?.n ?? 0) || (await openAfter(db, task)).length) return;
  const [moves] = await db
    .select({ n: count() })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.agentId, agentId), gte(taskEvents.createdAt, job.startedAt), notInArray(taskEvents.kind, [...NOT_A_MOVE])));
  if (Number(moves?.n ?? 0)) {
    if (task.silent) await db.update(tasks).set({ silent: 0 }).where(eq(tasks.id, task.id));
    return;
  }
  /* A turn that ended at the plan's limit did not stand still: another of its role on another plan takes the work over,
     or the agent goes on once the limit starts over. */
  const [sub] = job.subscriptionId ? await db.select({ limits: subscriptions.limits }).from(subscriptions).where(eq(subscriptions.id, job.subscriptionId)) : [];
  const until = limitUntil(sub?.limits ?? null);
  if (until) {
    const other = await standIn(ctx, agentId, task);
    const [me] = other ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)) : [];
    const at = `${until.slice(0, 16).replace('T', ' ')} UTC`;
    const over = other
      ? await handOver(ctx, task, other.id, `${me?.name ?? 'Its executor'}'s plan is at its limit until ${at}, so ${other.name} takes the work over on ${PROVIDER_NAMES[other.provider] ?? other.provider}.`).catch((err: { reason?: string }) => {
          if (err.reason === 'task_changed') return null;
          throw err;
        })
      : null;
    return wakeAll(ctx, over ? over.wakes : [{ agentId, taskId: task.id, why: 'go_on' }]);
  }
  /* A turn that broke, worked until its time ran out, or said in the task how far it got did not stand still. */
  const [told] = await db
    .select({ n: count() })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.agentId, agentId), gte(taskEvents.createdAt, job.startedAt), eq(taskEvents.kind, 'comment')));
  const working = job.status === 'failed' || Number(told?.n ?? 0) > 0;
  /* Turns that keep breaking as they start would only break again: whoever gave the task out hears of it, once. So does a
     turn that did not go out for the length of its instructions, at once, as every next one would not either. */
  const unsent = UNSENT.includes(job.error ?? '');
  const broke = unsent || (crashed(job) && (await crashesInRow(ctx, agentId, task)) >= QUICK_CRASHES);
  const [me] = broke && !unsent ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)) : [];
  const note = () => (unsent ? (job.result ?? job.error!) : crashNote({ ...job, agentName: me?.name ?? 'the agent' }, task));
  const step = broke ? () => brokeDown(ctx, agentId, task, note()) : () => (working ? wentOn : silentTurn)(ctx, agentId, task);
  const moved = await step().catch((err: { reason?: string }) => {
    /* Someone moved the task meanwhile: that answers the question. */
    if (err.reason === 'task_changed') return null;
    throw err;
  });
  if (moved) await wakeAll(ctx, moved.wakes);
}

/* A finished turn: a failure or a stop goes into the conversation, a turn a node restart cut off on a task runs once more
   or calls Operations, a turn that left a task it carried where it was is caught, then the next turn goes out. */
export async function afterJob(ctx: Ctx, jobId: string): Promise<void> {
  const program = clearTurnProgram(ctx, jobId);
  const [job] = await ctx.db
    .select({ companyId: jobs.companyId, agentId: jobs.agentId, kind: jobs.kind, status: jobs.status, error: jobs.error, taskId: jobs.taskId, startedAt: jobs.startedAt, finishedAt: jobs.finishedAt })
    .from(jobs)
    .where(eq(jobs.id, jobId));
  if (!job?.agentId || job.kind !== 'conversation') return;
  if (job.status === 'failed') await recordFailedTurn(ctx, jobId, { ...job, agentId: job.agentId }, program);
  if (job.taskId) await afterTaskTurn(ctx, jobId, { ...job, agentId: job.agentId, taskId: job.taskId });
  await explainEnded(ctx, jobId);
  await leaveIfOff(ctx, job.agentId);
  await pump(ctx, job.agentId);
}

async function recordFailedTurn(
  ctx: Ctx,
  jobId: string,
  job: Parameters<typeof doneIfRecorded>[2] & { companyId: string; agentId: string },
  program: ReturnType<typeof clearTurnProgram>,
): Promise<void> {
  if (await doneIfRecorded(ctx, jobId, job)) return;
  const stopped = job.error === 'cancelled';
  await appendEvent(ctx, {
    companyId: job.companyId,
    agentId: job.agentId,
    jobId,
    kind: stopped ? 'stopped' : 'failed',
    data: stopped ? {} : failedProgramData(job.error, program),
  });
}

/* A turn on a task a node restart cut off gets its retry waiting on the task before the task is checked, and one that
   failed without recording its work its continuation, so nothing else runs it again; a retry cut off too runs no more. */
async function afterTaskTurn(ctx: Ctx, jobId: string, job: Parameters<typeof carriedTasks>[1] & { error: string | null }): Promise<void> {
  const ended = job.error === 'machine_restarted' ? await afterRestart(ctx, jobId) : (await keepsBreaking(ctx, jobId)) ? null : await continueOnce(ctx, jobId);
  if (ended !== 'called') await checkLiveness(ctx, jobId, await carriedTasks(ctx, job));
}

/* The turn broke as it started, the last of QUICK_CRASHES in a row on its task: going on would only break again, so the
   task stops for whoever gave it out instead. */
async function keepsBreaking(ctx: Ctx, jobId: string): Promise<boolean> {
  const [row] = await ctx.db.select({ job: jobs, task: tasks }).from(jobs).innerJoin(tasks, eq(tasks.id, jobs.taskId)).where(eq(jobs.id, jobId));
  return Boolean(row?.job.agentId && crashed(row.job) && (await crashesInRow(ctx, row.job.agentId, row.task)) >= QUICK_CRASHES);
}

/* The node stops the program and reports the job as cancelled. A node that is away cannot, so the job ends here. */
export async function cancelJob(ctx: Ctx, jobId: string): Promise<void> {
  const job = await requestCancellation(ctx, jobId);
  if (!job) return;
  const node = identityOf(job.sub, job.job.nodeId);
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
export async function typedTurn(ctx: Ctx, node: NodeIdentity, agentId: string, text: string, personId: string | null): Promise<{ jobId: string; token: string } | null> {
  const opened = await openTypedTurn(ctx, node, agentId, text, personId);
  if (opened && personId) await wakeAll(ctx, await answerDirectly(ctx, personId, agentId, text));
  return opened;
}
