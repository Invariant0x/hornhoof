import { randomUUID } from 'node:crypto';
import { modelsFor, repoFolder, type Workspace } from '@hornhoof/protocol';
import type { EchelonOneShot, EchelonStage, EchelonsSnapshot } from '@hornhoof/protocol/echelons';
import { and, asc, eq, inArray, TransactionRollbackError } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, oneShotCalls, subscriptions, taskRoutes, tasks, type CallVerdict } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import { quote } from '../conversation/prompt.js';
import { repoAt } from '../departments/repository.js';
import { dispatchJob } from '../jobs/dispatch.js';
import { identityOf, nodeIdentity, ownBuiltin } from '../nodes/hub.js';
import { planNodes } from '../nodes/nodes.js';
import { CLOSED, note, published, refuse, type Task } from '../tasks/engine.js';
import { keepWakes } from '../tasks/outbox.js';
import { cancelJob, wakeAll } from '../tasks/wake.js';
import { taskFor, TEST_MINUTES } from '../testruns/runs.js';
import type { ToolJob } from '../tools/job.js';
import { onTask } from '../tasks/attachments.js';

type Call = typeof oneShotCalls.$inferSelect;
type Job = typeof jobs.$inferSelect;
type Repo = NonNullable<Workspace['repo']>;

/* How much of each answer the caller's wake and the task's history carry; calls gives it whole. */
const SHOWN_CHARS = 6000;

export type CallsInput = { task?: number | string; brief: string; inputs?: string[]; count?: number; branch?: string; verdict?: boolean; judge?: string; minutes?: number; wait?: boolean };

/* Callers that wait in their tool call for their batch to end, by batch. One whose call goes away is woken instead. */
const waiting = new Map<string, (account: string) => void>();

/* Where the calls of a turn run: the caller's own plan, on the machine its turn runs on, or another of that plan's machines
   that is online. */
type Place = { subscriptionId: string; nodeId: string | null; builtinMachine: string | null };

export const NO_MACHINE = 'No machine of your plan is online to run one-shot calls. Start one of its machines, or do the work in your own turn.';

async function placeOf(ctx: Ctx, job: ToolJob): Promise<Place> {
  const [row] = await ctx.db.select({ job: jobs, sub: subscriptions }).from(jobs).innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId)).where(eq(jobs.id, job.id));
  if (!row || row.sub.removedAt) throw refuse(409, 'machine_offline', NO_MACHINE);
  const { sub } = row;
  const at = (nodeId: string | null, builtinMachine: string | null): Place => ({ subscriptionId: sub.id, nodeId, builtinMachine });
  if (sub.kind === 'api_key') {
    const node = identityOf(sub, null, row.job.builtinMachine, ownBuiltin(ctx.config));
    if (!node || !ctx.hub.isOnline(node)) throw refuse(409, 'machine_offline', NO_MACHINE);
    return at(null, row.job.builtinMachine);
  }
  const online = (await planNodes(ctx.db, [sub.id])).filter(n => n.status === 'ready' && ctx.hub.isOnline(nodeIdentity(n.id)));
  const node = online.find(n => n.id === row.job.nodeId) ?? online[0];
  if (!node) throw refuse(409, 'machine_offline', NO_MACHINE);
  return at(node.id, null);
}

/* The stage of the task's echelons it is at now, if any, and how its route runs it as one-shot calls when the caller holds it. */
async function stageOf(ctx: Ctx, task: Task, agentId: string): Promise<{ stage: EchelonStage | null; oneShot: EchelonOneShot | null }> {
  const [route] = await ctx.db.select({ state: taskRoutes.state }).from(taskRoutes).where(eq(taskRoutes.taskId, task.id));
  const stage = route && ['active', 'waiting'].includes(route.state.phase) ? route.state.stage : null;
  return { stage, oneShot: (stage && heldOneShot(route!.state, agentId)) || null };
}

/* The one-shot stage the agent holds now on this route, if it holds one. */
function heldOneShot(state: Pick<EchelonsSnapshot, 'stage' | 'stages' | 'oneShot'>, agentId: string): EchelonOneShot | null {
  const at = state.stage && state.stages.find(step => step.stage === state.stage);
  return at && at.status === 'active' && at.ownerAgentId === agentId ? (state.oneShot?.[at.stage] ?? null) : null;
}

/* What the owner of a one-shot stage is told when the stage comes to them. */
export function oneShotStageNote(task: Pick<Task, 'number'>, state: Pick<EchelonsSnapshot, 'stage' | 'stages' | 'oneShot'>, agentId: string): string | null {
  const one = heldOneShot(state, agentId);
  if (!one) return null;
  const calls = `${one.fanOut} ${one.fanOut === 1 ? 'call' : 'calls'}`;
  return one.judge
    ? `This stage of #${task.number} is one-shot: start_calls runs it as ${calls} of your plan on your brief, then a judge call that reads every answer. Write a brief that holds everything a call needs, the branch to check included, and decide the stage once you have read the judge's verdict.`
    : `This stage of #${task.number} is one-shot: start_calls runs it as ${calls} of your plan on your brief. Write a brief that holds everything a call needs, the branch to check included, and decide the stage once you have read their answers.`;
}

const VERDICT_ASK = 'End your answer with one line of its own: VERDICT: {"pass": true or false, "reason": "<one sentence>"}';

/* What a call is sent: who it is and how it works, the brief, its own input, and the verdict when one is asked for. */
export function callPrompt(c: Pick<Call, 'brief' | 'input' | 'wantsVerdict'>, repo: Pick<Repo, 'url' | 'branch'> | null): string {
  const parts = [
    'You are a one-shot worker: you get one brief, do it in this run and answer once. Nobody answers questions while you work, and nothing of this run is kept for a next one, so decide on your own and say in your answer what you assumed.',
    ...(repo ? [`Your folder holds a fresh clone of ${repo.url} at branch ${repo.branch}, in ./${repoFolder(repo.url)}. Commit and push there only when the brief asks for it.`] : []),
    `Brief:\n${c.brief}`,
    ...(c.input ? [`Input of this call:\n${c.input}`] : []),
    ...(c.wantsVerdict ? [VERDICT_ASK] : []),
  ];
  return parts.join('\n\n');
}

/* What the judge of a batch is sent: the brief of the others, its own, and every answer. */
function judgePrompt(judge: string, brief: string, done: { call: Call; job: Job }[]): string {
  const answers = done.map(({ call, job }) => `Call ${call.number}${call.input ? ` (input: ${call.input})` : ''} ${job.status === 'done' ? 'answered' : 'failed'}:\n${quote(answerOf(job) || '(nothing)')}`);
  return [
    `You are the judge of ${done.length} one-shot ${done.length === 1 ? 'call' : 'calls'} that ran on one brief. Read their answers and decide; nobody answers questions while you work.`,
    `Their brief:\n${brief}`,
    `Your brief:\n${judge}`,
    ...answers,
    VERDICT_ASK,
  ].join('\n\n');
}

/* The verdict on the last line of an answer that has one. */
export function verdictOf(text: string | null): CallVerdict | null {
  const line = (text ?? '').trimEnd().split('\n').reverse().find(l => l.trim());
  const found = line && /^\s*VERDICT:\s*(\{.*\})\s*$/.exec(line);
  if (!found) return null;
  try {
    const parsed = JSON.parse(found[1]!) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as CallVerdict).pass === 'boolean') return { pass: (parsed as CallVerdict).pass, reason: String((parsed as CallVerdict).reason ?? '') };
  } catch {
    /* Not a verdict. */
  }
  return null;
}

const answerOf = (job: Pick<Job, 'status' | 'result' | 'tail'>) => (job.status === 'done' ? job.result ?? '' : job.result || job.tail);
const ended = (job: Pick<Job, 'status'>) => job.status !== 'queued' && job.status !== 'running';
const cut = (text: string, max = SHOWN_CHARS) => (text.length > max ? `${text.slice(0, max)}\n[cut here; calls gives it whole]` : text);

/* The caller's model, when its plan runs it; else the program's own default. */
async function modelOf(ctx: Ctx, agentId: string, subscriptionId: string): Promise<string | null> {
  const [row] = await ctx.db.select({ model: agents.model, provider: subscriptions.provider, models: subscriptions.models }).from(agents).innerJoin(subscriptions, eq(subscriptions.id, subscriptionId)).where(eq(agents.id, agentId));
  return row?.model && modelsFor(row.provider, row.models).some(m => m.id === row.model) ? row.model : null;
}

type Sending = { call: Call; job: Job; place: Pick<Place, 'subscriptionId' | 'nodeId' | 'builtinMachine'>; repo: Repo | null };

/* Each call goes to its node; one that cannot go out ends at once, and its batch hears of it as of any end. */
async function send(ctx: Ctx, { call, job, place, repo }: Sending): Promise<void> {
  const sent = await dispatchJob(ctx, {
    id: job.id,
    ...place,
    prompt: job.prompt,
    sessionId: null,
    model: await modelOf(ctx, call.callerAgentId, place.subscriptionId),
    timeoutMs: job.timeoutMs,
    instructions: null,
    toolToken: null,
    call: true,
    ...(repo ? { workspace: { key: job.id, repo } } : {}),
  });
  if (sent) return;
  await ctx.db.update(jobs).set({ status: 'failed', error: 'machine_offline', tail: NO_MACHINE, finishedAt: new Date() }).where(and(eq(jobs.id, job.id), eq(jobs.status, 'queued')));
  await callEnded(ctx, call.jobId);
}

/* Starts the calls on the caller's own plan and machine, one per input or count copies of the brief. */
export async function startCalls(ctx: Ctx, job: ToolJob, input: CallsInput, signal?: AbortSignal): Promise<string> {
  const task = await taskFor(ctx, job, input.task, 'work');
  if (CLOSED.includes(task.status)) throw refuse(409, 'task_invalid', `#${task.number} is closed.`);
  const place = await placeOf(ctx, job);
  const found = input.branch ? await repoAt(ctx, [task.productId, task.departmentId]) : null;
  if (input.branch && !found) throw refuse(409, 'repo_invalid', `#${task.number} has no repository to clone ${input.branch} from: its department has none set. Leave out branch to run in an empty folder.`);
  const repo = found && input.branch ? { ...found.repo, branch: input.branch } : null;
  /* At a one-shot stage its owner holds, the route says how many calls run it and what the judge reads them for. */
  const { stage, oneShot } = await stageOf(ctx, task, job.agentId);
  const judgeBrief = input.judge ?? oneShot?.judge ?? null;
  const inputs: (string | null)[] = input.inputs?.length ? input.inputs : Array.from({ length: input.count ?? oneShot?.fanOut ?? 1 }, () => null);
  const batch = randomUUID();
  const timeoutMs = (input.minutes ?? TEST_MINUTES) * 60_000;
  const made = await ctx.db.transaction(async tx => {
    const out: Sending[] = [];
    for (const [i, text] of inputs.entries()) {
      const values = { brief: input.brief, input: text, wantsVerdict: input.verdict === true };
      const [row] = await tx
        .insert(jobs)
        .values({ companyId: job.companyId, subscriptionId: place.subscriptionId, nodeId: place.nodeId, builtinMachine: place.builtinMachine, kind: 'call', prompt: callPrompt(values, repo), timeoutMs })
        .returning();
      const [call] = await tx
        .insert(oneShotCalls)
        .values({ companyId: job.companyId, batch, number: i + 1, jobId: row!.id, callerAgentId: job.agentId, callerJobId: job.id, taskId: task.id, departmentId: task.productId ?? task.departmentId, stage, ...values, judgeBrief })
        .returning();
      out.push({ call: call!, job: row!, place, repo });
    }
    return out;
  });
  ctx.bus.publish(job.companyId, { type: 'org' });
  const answered = input.wait ? waitFor(batch, signal) : null;
  for (const one of made) await send(ctx, one);
  if (answered) return answered;
  const n = made.length;
  const judged = judgeBrief ? ' Once they have all ended, a judge call reads every answer and gives its verdict.' : '';
  return `Started ${n} one-shot ${n === 1 ? 'call' : 'calls'} on #${task.number} in batch ${batch}. Each runs once on your plan's machine, as its check queue lets it, and answers.${judged} When the whole batch has ended you are woken on #${task.number} with every answer; calls with batch ${batch} shows how they go before that.`;
}

/* The account of the batch, once it has ended; or, when the caller's tool call goes away first, word that it is woken. */
function waitFor(batch: string, signal: AbortSignal | undefined): Promise<string> {
  return new Promise(resolve => {
    const done = (text: string) => {
      waiting.delete(batch);
      signal?.removeEventListener('abort', gone);
      resolve(text);
    };
    const gone = () => done(`You stopped waiting for batch ${batch}; you are woken on the task with every answer once it has ended.`);
    waiting.set(batch, done);
    if (signal?.aborted) gone();
    else signal?.addEventListener('abort', gone, { once: true });
  });
}

/* The judge of a batch whose calls have all ended: it runs where they ran, once. */
async function startJudge(ctx: Ctx, calls: { call: Call; job: Job }[]): Promise<boolean> {
  const [first] = calls;
  if (!first?.call.judgeBrief) return false;
  const judgeBrief = first.call.judgeBrief;
  const prompt = judgePrompt(judgeBrief, first.call.brief, calls);
  const made = await ctx.db.transaction(async tx => {
    const [row] = await tx
      .insert(jobs)
      .values({ companyId: first.job.companyId, subscriptionId: first.job.subscriptionId, nodeId: first.job.nodeId, builtinMachine: first.job.builtinMachine, kind: 'call', prompt, timeoutMs: first.job.timeoutMs })
      .returning();
    const [call] = await tx
      .insert(oneShotCalls)
      .values({ ...pick(first.call), number: calls.length + 1, judge: true, jobId: row!.id, brief: judgeBrief, input: null, wantsVerdict: true, judgeBrief })
      .onConflictDoNothing()
      .returning();
    if (!call) tx.rollback();
    return { call: call!, job: row! };
  }).catch((err: unknown) => {
    /* Another end of the same batch started it first. */
    if (err instanceof TransactionRollbackError) return null;
    throw err;
  });
  if (!made) return true;
  ctx.bus.publish(first.job.companyId, { type: 'org' });
  await send(ctx, { ...made, place: { subscriptionId: first.job.subscriptionId, nodeId: first.job.nodeId, builtinMachine: first.job.builtinMachine }, repo: null });
  return true;
}

const pick = (c: Call) => ({ companyId: c.companyId, batch: c.batch, callerAgentId: c.callerAgentId, callerJobId: c.callerJobId, taskId: c.taskId, departmentId: c.departmentId, stage: c.stage });

const took = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
};
const verdictWords = (v: CallVerdict) => `${v.pass ? 'passed' : 'did not pass'}${v.reason ? `: ${v.reason}` : ''}`;

/* One call in the caller's account of its batch. */
function callLine({ call, job }: { call: Call; job: Job }): string {
  const how = job.status === 'done' ? 'is done' : `failed${job.error ? ` (${job.error})` : ''}`;
  const verdict = call.verdict ? `, verdict: ${verdictWords(call.verdict)}` : call.wantsVerdict && job.status === 'done' ? ', with no verdict line' : '';
  const time = job.startedAt && job.finishedAt ? ` in ${took(job.finishedAt.getTime() - job.startedAt.getTime())}` : '';
  const what = call.input ? ` Its input: ${call.input}` : '';
  return `Call ${call.number} ${how}${verdict}.${time ? ` It ran${time}.` : ''}${what}\n\n${quote(cut(answerOf(job)) || '(nothing)')}`;
}

/* Hornhoof's account of a batch that ended: the judge first, then each call. */
function account(calls: { call: Call; job: Job }[]): string {
  const judge = calls.find(c => c.call.judge);
  const others = calls.filter(c => !c.call.judge);
  const done = others.filter(c => c.job.status === 'done').length;
  const start = Math.min(...calls.map(c => c.call.createdAt.getTime()));
  const end = Math.max(...calls.map(c => (c.job.finishedAt ?? new Date()).getTime()));
  const lines = [`They took ${took(end - start)}, and ${done} of ${others.length} ${others.length === 1 ? 'is' : 'are'} done.`];
  if (judge) {
    const verdict = judge.call.verdict ? `The judge's verdict: ${verdictWords(judge.call.verdict)}.` : judge.job.status === 'done' ? 'The judge gave no verdict line.' : `The judge failed${judge.job.error ? ` (${judge.job.error})` : ''}.`;
    lines.push('', verdict, '', quote(cut(answerOf(judge.job)) || '(nothing)'));
  }
  for (const c of others) lines.push('', callLine(c));
  lines.push('', `calls with batch ${calls[0]!.call.batch} gives every answer whole.`);
  return lines.join('\n');
}

async function batchOf(ctx: Ctx, batch: string): Promise<{ call: Call; job: Job }[]> {
  return ctx.db.select({ call: oneShotCalls, job: jobs }).from(oneShotCalls).innerJoin(jobs, eq(jobs.id, oneShotCalls.jobId)).where(eq(oneShotCalls.batch, batch)).orderBy(asc(oneShotCalls.number));
}

/* What the history of the task keeps of a call that ended: its brief, input, answer, verdict and times. */
async function keepInHistory(ctx: Ctx, task: Task, { call, job }: { call: Call; job: Job }): Promise<void> {
  const answer = answerOf(job);
  const text = `${call.judge ? 'The judge call' : `One-shot call ${call.number}`} of batch ${call.batch} ${job.status === 'done' ? 'answered' : 'failed'}: ${cut(answer, 2000)}`;
  await note(ctx.db, task, {
    kind: 'call',
    actor: { agentId: call.callerAgentId },
    text,
    data: {
      batch: call.batch, number: call.number, judge: call.judge, brief: call.brief, input: call.input, stage: call.stage,
      status: job.status, error: job.error, result: cut(answer), verdict: call.verdict,
      startedAt: job.startedAt?.toISOString() ?? null, finishedAt: job.finishedAt?.toISOString() ?? null,
    },
  });
  published(ctx, task);
}

/* A call whose job ended: its verdict is read, the task's history keeps it, and once its whole batch, judge and all, has
   ended, the caller hears how it went, once. */
export async function callEnded(ctx: Ctx, jobId: string): Promise<void> {
  try {
    const [row] = await ctx.db.select({ call: oneShotCalls, job: jobs, task: tasks }).from(oneShotCalls).innerJoin(jobs, eq(jobs.id, oneShotCalls.jobId)).innerJoin(tasks, eq(tasks.id, oneShotCalls.taskId)).where(eq(oneShotCalls.jobId, jobId));
    if (!row || !ended(row.job)) return;
    const verdict = row.call.wantsVerdict && row.job.status === 'done' ? verdictOf(row.job.result) : null;
    if (verdict) await ctx.db.update(oneShotCalls).set({ verdict }).where(eq(oneShotCalls.id, row.call.id));
    await keepInHistory(ctx, row.task, { call: { ...row.call, verdict }, job: row.job });
    ctx.bus.publish(row.call.companyId, { type: 'org' });
    await batchEnded(ctx, row.call.batch, row.task);
  } catch (err) {
    ctx.log.error({ error: loggable(err), jobId }, 'A one-shot call could not be recorded as ended.');
  }
}

async function batchEnded(ctx: Ctx, batch: string, task: Task): Promise<void> {
  const calls = await batchOf(ctx, batch);
  if (calls.some(c => !ended(c.job))) return;
  if (!calls.some(c => c.call.judge) && (await startJudge(ctx, calls))) return;
  const claimed = await ctx.db.update(oneShotCalls).set({ told: true }).where(and(eq(oneShotCalls.batch, batch), eq(oneShotCalls.told, false))).returning({ id: oneShotCalls.id });
  if (!claimed.length) return;
  const caller = calls[0]!.call.callerAgentId;
  const waiter = waiting.get(batch);
  if (waiter) return waiter(account(calls));
  if (CLOSED.includes(task.status)) return;
  const wakes = [{ agentId: caller, taskId: task.id, why: 'calls' as const, text: account(calls) }];
  await keepWakes(ctx.db, task.companyId, wakes);
  await wakeAll(ctx, wakes);
}

/* How a batch goes, or every batch on a task, for the agent who started it or anyone on the task. */
export async function callsView(ctx: Ctx, job: ToolJob, input: { batch?: string; task?: number | string }): Promise<object> {
  const [named] = input.batch ? await ctx.db.select({ task: tasks }).from(oneShotCalls).innerJoin(tasks, eq(tasks.id, oneShotCalls.taskId)).where(and(eq(oneShotCalls.batch, input.batch), eq(oneShotCalls.companyId, job.companyId))).limit(1) : [];
  if (input.batch && (!named || !onTask(job, named.task))) throw refuse(404, 'task_unknown', `There is no batch ${input.batch} on a task you work on.`);
  const task = named?.task ?? (await taskFor(ctx, job, input.task, 'work'));
  const rows = await ctx.db
    .select({ call: oneShotCalls, job: jobs })
    .from(oneShotCalls)
    .innerJoin(jobs, eq(jobs.id, oneShotCalls.jobId))
    .where(and(eq(oneShotCalls.taskId, task.id), ...(input.batch ? [eq(oneShotCalls.batch, input.batch)] : [])))
    .orderBy(asc(oneShotCalls.createdAt), asc(oneShotCalls.number));
  const shown = (c: { call: Call; job: Job }) => ({
    number: c.call.number, judge: c.call.judge, input: c.call.input, status: c.job.status, result: ended(c.job) ? answerOf(c.job) : null, verdict: c.call.verdict,
    error: c.job.error, startedAt: c.job.startedAt?.toISOString() ?? null, finishedAt: c.job.finishedAt?.toISOString() ?? null,
  });
  const batches = [...new Set(rows.map(r => r.call.batch))].map(batch => {
    const of = rows.filter(r => r.call.batch === batch);
    return { batch, task: task.number, brief: of[0]!.call.brief, judgeBrief: of[0]!.call.judgeBrief, calls: of.map(shown) };
  });
  return input.batch ? batches[0]! : { task: task.number, batches };
}

/* A call its node has not started yet: the node is told to drop it, and it ends here at once. */
async function stopUnstarted(ctx: Ctx, job: Job): Promise<void> {
  const [sub] = await ctx.db.select().from(subscriptions).where(eq(subscriptions.id, job.subscriptionId));
  const node = sub ? identityOf(sub, job.nodeId, job.builtinMachine, ownBuiltin(ctx.config)) : null;
  if (node) ctx.hub.send(node, { type: 'job.cancel', jobId: job.id });
  const [stopped] = await ctx.db.update(jobs).set({ status: 'failed', error: 'cancelled', result: 'Stopped.', finishedAt: new Date() }).where(and(eq(jobs.id, job.id), eq(jobs.status, 'queued'))).returning({ id: jobs.id });
  /* One that started meanwhile is stopped as any running one is. */
  if (stopped) await callEnded(ctx, job.id);
  else await cancelJob(ctx, job.id);
}

/* Stops every call of a batch that waits or runs. */
export async function stopCalls(ctx: Ctx, job: ToolJob, batch: string): Promise<string> {
  const rows = await ctx.db.select({ call: oneShotCalls, job: jobs }).from(oneShotCalls).innerJoin(jobs, eq(jobs.id, oneShotCalls.jobId)).where(and(eq(oneShotCalls.batch, batch), eq(oneShotCalls.companyId, job.companyId)));
  if (!rows.length) throw refuse(404, 'task_unknown', `There is no batch ${batch}.`);
  const open = rows.filter(r => !ended(r.job));
  for (const r of open) await (r.job.status === 'running' ? cancelJob(ctx, r.job.id) : stopUnstarted(ctx, r.job));
  return open.length ? `Stopping ${open.length} ${open.length === 1 ? 'call' : 'calls'} of batch ${batch}.` : `Every call of batch ${batch} has ended already.`;
}

/* The calls that wait or run now in each department, for the map. */
export async function runningCalls(ctx: Pick<Ctx, 'db'>, companyId: string): Promise<{ departmentId: string | null; id: string; number: number; judge: boolean; task: number; by: string; stage: string | null; startedAt: string | null }[]> {
  const rows = await ctx.db
    .select({ call: oneShotCalls, startedAt: jobs.startedAt, task: tasks.number })
    .from(oneShotCalls)
    .innerJoin(jobs, eq(jobs.id, oneShotCalls.jobId))
    .innerJoin(tasks, eq(tasks.id, oneShotCalls.taskId))
    .where(and(eq(oneShotCalls.companyId, companyId), inArray(jobs.status, ['queued', 'running'])))
    .orderBy(asc(oneShotCalls.createdAt), asc(oneShotCalls.number));
  return rows.map(r => ({ departmentId: r.call.departmentId, id: r.call.id, number: r.call.number, judge: r.call.judge, task: r.task, by: r.call.callerAgentId, stage: r.call.stage, startedAt: r.startedAt?.toISOString() ?? null }));
}
