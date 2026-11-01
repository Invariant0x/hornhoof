import type { NodeLoad, NodeMessage, RunKind, Workspace } from '@hornhoof/protocol';
import { and, asc, count, eq, inArray, isNull, like, max, notInArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf, canReach, type Access } from '../../auth/access.js';
import { agents, attachments, companies, departments, jobs, machines, nodes, people, subscriptions, tasks, testParts, testRuns, type LostRun } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import { quote } from '../conversation/prompt.js';
import { repoAt, TEST_MEMORY_GB } from '../departments/repository.js';
import { BUILTIN, nodeIdentity, type NodeIdentity } from '../nodes/hub.js';
import { liveNode } from '../nodes/nodes.js';
import { onTask } from '../tasks/attachments.js';
import { CLOSED, refuse, type Task, type Wake } from '../tasks/engine.js';
import { keepWakes } from '../tasks/outbox.js';
import { taskByRef } from '../tasks/views.js';
import { wakeAll } from '../tasks/wake.js';
import type { ToolJob } from '../tools/job.js';
import { together } from './load.js';
import { pickMachine } from './pick.js';

type Run = typeof testRuns.$inferSelect;
type Part = typeof testParts.$inferSelect;
type Department = typeof departments.$inferSelect;
type Repo = NonNullable<Workspace['repo']>;
type TestsDone = Extract<NodeMessage, { type: 'tests.done' }>;

/* The free memory a part of work needs unless its agent says. */
export const WORK_MEMORY_GB = 2;
/* The time a run gets by default, and at most. */
export const TEST_MINUTES = 30;
export const TEST_MINUTES_MAX = 120;
/* Runs of one agent that may go on at once. */
export const OPEN_RUNS = 3;
/* A part that found no free machine this long ends, so its agent hears of it instead of waiting on. */
export const WAIT_MS = 2 * 3_600_000;
/* A machine that said nothing of a part this long past its time limit has lost it. */
const LATE_MS = 2 * 60_000;
/* A part whose machine is away this long runs again on another, and a part runs again at most this many times. */
export const AWAY_MS = 3 * 60_000;
export const RERUNS = 2;
/* What a part keeps of its log's end for the result: its last lines. */
const TAIL_LINES = 20;
const TAIL_CHARS = 2000;
/* Failed parts whose ends the result shows; the others' are in their logs. */
const SHOWN_FAILURES = 3;
const GIB = 1024 ** 3;

const BUILTIN_NAME = 'the built-in node';
const isId = (s: string) => z.uuid().safeParse(s).success;

/* The node a part went to. */
const nodeOf = (p: Pick<Part, 'builtin' | 'nodeId'>): NodeIdentity | null => (p.builtin ? BUILTIN : p.nodeId ? nodeIdentity(p.nodeId) : null);
const ofNode = (id: NodeIdentity): SQL => (id.kind === 'builtin' ? eq(testParts.builtin, true) : eq(testParts.nodeId, id.nodeId));

/* What a run is called where agents read of it, and its state there: a run of work that passed is done. */
const named = (run: Pick<Run, 'kind' | 'number'>) => `${run.kind === 'work' ? 'Work run' : 'Test run'} ${run.number}`;
const stateOf = (run: Pick<Run, 'kind'>, status: string) => (run.kind === 'work' && status === 'passed' ? 'done' : status);
const toolsOf = (kind: RunKind) => (kind === 'work' ? { state: 'work_run', stop: 'stop_work' } : { state: 'test_run', stop: 'stop_tests' });

/* The files of a run on its task: each part's log, and what a part of work made. */
export const logName = (run: Pick<Run, 'kind' | 'number'>, part: number) => `${run.kind}-${run.number}-${part}.log`;
export const madeName = (run: Pick<Run, 'number'>, part: number, name: string) => `work-${run.number}-${part}-${name}`;
const filesOf = (run: Pick<Run, 'kind' | 'number'>) => like(attachments.name, `${run.kind}-${run.number}-%`);
export const commandFor = (run: Pick<Run, 'command' | 'parts'>, part: number) => run.command.replaceAll('{parts}', String(run.parts)).replaceAll('{part}', String(part));

/* The last lines of a log. */
export function tailOf(log: string): string {
  const lines = log.replace(/\s+$/, '').split('\n').slice(-TAIL_LINES).join('\n');
  return lines.length > TAIL_CHARS ? lines.slice(-TAIL_CHARS) : lines;
}

const took = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
};

/* Why a part ended other than by its command passing or failing. */
function endedBy(run: Pick<Run, 'timeoutMs' | 'kind' | 'repeatable'>, p: Part): string {
  const kept = mayStillRun(p.error ?? '') && !mayRepeat(run, p.error ?? '') ? ', and it did not run again elsewhere, as it may still run there and run_work did not say it is repeatable' : '';
  return lostHow(run, p) + kept;
}

function lostHow(run: Pick<Run, 'timeoutMs'>, p: Part): string {
  switch (p.error) {
    case 'timeout':
      return `it did not end within ${took(run.timeoutMs)}`;
    case 'clone_failed':
      return 'the branch could not be cloned';
    case 'files_failed':
      return "the task's files could not be fetched onto its machine";
    case 'cancelled':
      return 'it was stopped on its machine';
    case 'machine_restarted':
      return 'its machine restarted and lost it';
    case 'machine_offline':
      return 'its machine went offline';
    case 'machine_disconnected':
      return 'its machine was disconnected from the company';
    case 'subscription_removed':
      return 'its machine lost the plan its node ran for';
    case 'no_machine':
      return `no machine was free for it within ${took(WAIT_MS)}`;
    case 'no_repository':
      return 'the repository is no longer set';
    default:
      return p.exitCode !== null ? `exit code ${p.exitCode}` : 'it failed';
  }
}

/* How a machine lost a part, after its name. */
const LOST_HOW: Record<string, string> = {
  machine_restarted: 'restarted and lost it',
  machine_offline: 'went offline',
  machine_disconnected: 'was disconnected from the company',
  subscription_removed: 'lost the plan its node ran for',
};
/* A part lost in any way but a restart its node reported may still run on its machine. */
const mayStillRun = (why: string) => why in LOST_HOW && why !== 'machine_restarted';
/* A part of a test run runs again wherever it was lost; a part of work, which may publish, deploy or send something, only
   when it cannot still run, or when its agent said it may run twice. */
const mayRepeat = (run: Pick<Run, 'kind' | 'repeatable'>, why: string) => run.kind === 'tests' || run.repeatable || !mayStillRun(why);
export const lostLine = (l: LostRun) => `${l.machine} ${LOST_HOW[l.why] ?? 'lost it'}`;

/* What a part that ran again went through before. */
const ranAgain = (lost: LostRun[]) => (lost.length ? ` It ran again after ${lost.map(lostLine).join(', and again after ')}.` : '');

/* Hornhoof's account of a run that ended: each part, where it ran and how long, the end of what failed, and the files
   on the task. */
function account(run: Run, task: Pick<Task, 'number'>, parts: Part[], files: Set<string>): string {
  const lines = [`${named(run)} ${run.kind === 'work' && run.status === 'passed' ? 'is done' : run.status} after ${took((run.finishedAt ?? new Date()).getTime() - run.createdAt.getTime())}.`];
  for (const p of parts) {
    const where = p.machineName ? ` on ${p.machineName}` : '';
    const time = p.startedAt && p.finishedAt ? ` in ${took(p.finishedAt.getTime() - p.startedAt.getTime())}` : '';
    const at = p.commit ? `, at ${p.commit.slice(0, 12)}` : '';
    const why = p.status === 'passed' ? '' : `: ${endedBy(run, p)}`;
    lines.push(`Part ${p.part} of ${run.parts} ${p.status === 'passed' ? stateOf(run, 'passed') : 'failed'}${where}${time}${at}${why}.${ranAgain(p.lost)}`);
  }
  const failed = parts.filter(p => p.status !== 'passed' && p.tail);
  for (const p of failed.slice(0, SHOWN_FAILURES)) lines.push('', `The end of part ${p.part}:`, '', quote(p.tail));
  const logs = parts.map(p => logName(run, p.part)).filter(n => files.has(n));
  const made = [...files].filter(n => !logs.includes(n)).sort();
  if (made.length) lines.push('', `What it made is on #${task.number}: ${made.join(', ')}. Get a file with hh-fetch ${task.number} <name>.`);
  if (logs.length) lines.push('', `Each part's full log is on #${task.number}: hh-fetch ${task.number} ${logs[0]}${logs.length > 1 ? `, and so on up to ${logs.at(-1)}` : ''}.`);
  return lines.join('\n');
}

/* A place a part can run: a computer of the company through one of its nodes, or the built-in node. access: what the
   machine's owner reaches; the built-in node reaches every repository. works: its node runs parts of any work, not only
   of test runs. */
export type Place = { key: string; node: NodeIdentity; name: string; machineId: string | null; nodeId: string | null; builtin: boolean; lent: boolean; busy: boolean; load: NodeLoad | null; access: Access | null; works: boolean };

export async function placesOf(ctx: Ctx, companyId: string): Promise<Place[]> {
  const { db, hub } = ctx;
  const running = await db.select({ machineId: testParts.machineId, builtin: testParts.builtin }).from(testParts).where(eq(testParts.status, 'running'));
  const rows = await db
    .select({ machine: machines, owner: people })
    .from(machines)
    .innerJoin(people, eq(people.id, machines.personId))
    .where(and(eq(machines.companyId, companyId), eq(machines.kind, 'computer'), isNull(machines.revokedAt)))
    .orderBy(asc(machines.createdAt));
  /* A machine's own node and its plans' nodes; a removed plan's node is on its way out. */
  const live = await db
    .select({ id: nodes.id, machineId: nodes.machineId })
    .from(nodes)
    .leftJoin(subscriptions, eq(subscriptions.id, nodes.subscriptionId))
    .where(and(eq(nodes.companyId, companyId), liveNode, isNull(subscriptions.removedAt)))
    .orderBy(asc(nodes.createdAt), asc(nodes.id));
  const places: Place[] = [];
  for (const { machine, owner } of rows) {
    /* Only nodes that say how busy they are know test runs. */
    const ready = live.filter(n => n.machineId === machine.id && hub.isReady(nodeIdentity(n.id)) && hub.loadOf(nodeIdentity(n.id)) !== null).map(n => n.id);
    if (!ready.length) continue;
    /* A node that runs work takes test runs too. */
    const node = ready.find(id => hub.runsWork(nodeIdentity(id))) ?? ready[0]!;
    places.push({
      key: machine.id,
      node: nodeIdentity(node),
      name: machine.hostname || 'a machine',
      machineId: machine.id,
      nodeId: node,
      builtin: false,
      lent: machine.lendsTests,
      busy: running.some(r => r.machineId === machine.id),
      load: together(ready.map(id => hub.loadOf(nodeIdentity(id)))),
      access: await accessOf(db, owner),
      works: hub.runsWork(nodeIdentity(node)),
    });
  }
  if (hub.isReady(BUILTIN) && hub.loadOf(BUILTIN)) {
    places.push({ key: 'builtin', node: BUILTIN, name: BUILTIN_NAME, machineId: null, nodeId: null, builtin: true, lent: true, busy: running.some(r => r.builtin), load: together([hub.loadOf(BUILTIN)]), access: null, works: hub.runsWork(BUILTIN) });
  }
  return places;
}

/* The machine's owner reaches the department a run is for; a run for no department only someone who sees the whole
   company. */
export const reaches = (place: Pick<Place, 'access'>, d: Department | null) =>
  place.access === null || (d ? canReach(place.access, { departmentId: d.id, parentId: d.parentId }) : place.access.whole);

/* Whether a place may take a part of this run at all, busy or not. */
const mayTake = (place: Place, run: Pick<Run, 'kind'>, d: Department | null) => place.lent && reaches(place, d) && (run.kind !== 'work' || place.works);

/* What a run's parts need: the repository they clone, if any, and the department whose people's machines may take
   them. None when the repository is gone. */
export async function targetOf(ctx: Ctx, run: Pick<Run, 'kind' | 'branch' | 'departmentId'>): Promise<{ department: Department | null; repo: Repo | null } | null> {
  if (run.kind === 'tests' || run.branch) return repoAt(ctx, [run.departmentId]);
  const [department] = run.departmentId ? await ctx.db.select().from(departments).where(eq(departments.id, run.departmentId)) : [];
  return { department: department ?? null, repo: null };
}

/* Gives every waiting part, oldest run first, to the freest machine that may take it, one part per machine at a time. */
async function giveOut(ctx: Ctx): Promise<void> {
  const { db } = ctx;
  const waiting = await db
    .select({ part: testParts, run: testRuns, task: { number: tasks.number } })
    .from(testParts)
    .innerJoin(testRuns, eq(testRuns.id, testParts.runId))
    .innerJoin(tasks, eq(tasks.id, testRuns.taskId))
    .where(eq(testParts.status, 'queued'))
    .orderBy(asc(testRuns.createdAt), asc(testParts.part));
  const places = new Map<string, Place[]>();
  const targets = new Map<string, Awaited<ReturnType<typeof targetOf>>>();
  for (const { part, run, task } of waiting) {
    if (!places.has(run.companyId)) places.set(run.companyId, await placesOf(ctx, run.companyId));
    if (!targets.has(run.id)) targets.set(run.id, await targetOf(ctx, run));
    const found = targets.get(run.id)!;
    if (!found) {
      await endParts(ctx, and(eq(testParts.id, part.id), eq(testParts.status, 'queued'))!, 'no_repository');
      continue;
    }
    const open = places.get(run.companyId)!;
    const need = needOf(run, found.department) * GIB;
    const spots = open.map(p => ({ key: p.key, lent: p.lent, reaches: mayTake(p, run, found.department), busy: p.busy, load: p.load }));
    /* A part that ran again goes to another machine than the ones that lost it when one of them fits it now, else to
       any that does. */
    const lostOn = new Set(part.lost.map(l => l.key));
    const spot = pickMachine(spots.filter(s => !lostOn.has(s.key)), need) ?? pickMachine(spots, need);
    const place = spot && open.find(p => p.key === spot.key);
    if (!place) continue;
    place.busy = true;
    const [taken] = await db
      .update(testParts)
      .set({ status: 'running', nodeId: place.nodeId, builtin: place.builtin, machineId: place.machineId, machineName: place.name, startedAt: new Date() })
      .where(and(eq(testParts.id, part.id), eq(testParts.status, 'queued')))
      .returning();
    if (!taken) continue;
    const sent = ctx.hub.send(place.node, {
      type: 'tests.run',
      partId: part.id,
      ...(run.kind === 'work' ? { kind: 'work' as const, files: run.files } : {}),
      repo: found.repo ? { url: found.repo.url, token: found.repo.token } : null,
      branch: run.branch,
      task: task.number,
      command: commandFor(run, part.part),
      part: part.part,
      parts: run.parts,
      timeoutMs: run.timeoutMs,
    });
    /* The node went away meanwhile: the part waits for the next machine. */
    if (!sent) {
      await db
        .update(testParts)
        .set({ status: 'queued', nodeId: null, builtin: false, machineId: null, machineName: null, startedAt: null })
        .where(and(eq(testParts.id, part.id), eq(testParts.status, 'running')));
    }
  }
}

/* The free memory, in GB, a part of the run needs: what its agent said for work, else what its repository says. */
export const needOf = (run: Pick<Run, 'memoryGb'>, d: Department | null) => run.memoryGb ?? d?.repoTestMemoryGb ?? TEST_MEMORY_GB;

const pumps = new WeakMap<Ctx, Promise<void>>();

/* Waiting parts go out to machines that are free now, one round at a time, so two rounds never give one part twice. */
export function pumpTests(ctx: Ctx): Promise<void> {
  const next = (pumps.get(ctx) ?? Promise.resolve()).then(() => giveOut(ctx)).catch((err: unknown) => ctx.log.error({ error: loggable(err) }, 'Test runs could not be given out to machines.'));
  pumps.set(ctx, next);
  return next;
}

/* A run whose parts all ended ends with them, and its agent hears how it went on its task, unless the task is closed. */
async function settleRun(ctx: Ctx, runId: string): Promise<void> {
  const { db } = ctx;
  const parts = await db.select().from(testParts).where(eq(testParts.runId, runId)).orderBy(asc(testParts.part));
  if (!parts.length || parts.some(p => p.status === 'queued' || p.status === 'running')) return;
  const status = parts.every(p => p.status === 'passed') ? 'passed' : 'failed';
  const wake = await db.transaction(async tx => {
    const [run] = await tx
      .update(testRuns)
      .set({ status, finishedAt: new Date() })
      .where(and(eq(testRuns.id, runId), eq(testRuns.status, 'running')))
      .returning();
    if (!run) return null;
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, run.taskId));
    if (!task || CLOSED.includes(task.status)) return null;
    const files = await tx.select({ name: attachments.name }).from(attachments).where(and(eq(attachments.taskId, run.taskId), filesOf(run)));
    const w: Wake = { agentId: run.agentId, taskId: run.taskId, why: run.kind, text: account(run, task, parts, new Set(files.map(l => l.name!))) };
    await keepWakes(tx, run.companyId, [w]);
    return w;
  });
  if (wake) await wakeAll(ctx, [wake]);
}

/* Parts that end without a word from their node, and the runs they finish. */
async function endParts(ctx: Ctx, which: SQL, error: string, tail = ''): Promise<Part[]> {
  const ended = await ctx.db
    .update(testParts)
    .set({ status: 'failed', error, finishedAt: new Date(), ...(tail ? { tail } : {}) })
    .where(and(which, inArray(testParts.status, ['queued', 'running'])))
    .returning();
  for (const runId of new Set(ended.map(p => p.runId))) await settleRun(ctx, runId);
  return ended;
}

/* Parts their machines lost as they ran, as when a machine restarted, went offline, was disconnected or lost the plan its
   node ran for: each waits for another machine under a new id, so its lost run, should that come back, is told apart.
   One lost RERUNS times already fails with why. */
export async function loseParts(ctx: Ctx, which: SQL, why: string): Promise<void> {
  const lost = await ctx.db
    .select({ part: testParts, run: testRuns })
    .from(testParts)
    .innerJoin(testRuns, eq(testRuns.id, testParts.runId))
    .where(and(which, eq(testParts.status, 'running')));
  for (const { part: p, run } of lost) {
    const running = and(eq(testParts.id, p.id), eq(testParts.status, 'running'))!;
    if (p.lost.length >= RERUNS || !mayRepeat(run, why)) {
      await endParts(ctx, running, why);
      continue;
    }
    const where: LostRun = { key: p.builtin ? 'builtin' : (p.machineId ?? ''), machine: p.machineName ?? 'a machine', why };
    const [again] = await ctx.db
      .update(testParts)
      .set({ id: sql`gen_random_uuid()`, status: 'queued', lost: [...p.lost, where], nodeId: null, builtin: false, machineId: null, machineName: null, startedAt: null, queuedAt: new Date() })
      .where(running)
      .returning({ id: testParts.id });
    /* What the lost attempt put on the task goes: the part makes it again, and the old id takes no more. */
    if (again && run.kind === 'work') {
      await ctx.db.delete(attachments).where(and(eq(attachments.taskId, run.taskId), like(attachments.name, `${madeName(run, p.part, '')}%`)));
    }
  }
  await pumpTests(ctx);
}

/* A part's log goes on its task as a file of the turn that started the run, once. */
async function keepLog(ctx: Ctx, run: Run, part: Part, log: string): Promise<void> {
  const name = logName(run, part.part);
  const [had] = await ctx.db.select({ id: attachments.id }).from(attachments).where(and(eq(attachments.taskId, run.taskId), eq(attachments.name, name))).limit(1);
  if (had) return;
  const bytes = Buffer.from(log, 'utf8');
  await ctx.db.insert(attachments).values({ companyId: run.companyId, jobId: run.jobId, agentId: run.agentId, taskId: run.taskId, name, mediaType: 'text/plain; charset=utf-8', bytes, size: bytes.length });
}

/* The node began a part: its time counts from now. */
export async function partStarted(ctx: Ctx, id: NodeIdentity, partId: string): Promise<void> {
  if (!isId(partId)) return;
  await ctx.db
    .update(testParts)
    .set({ startedAt: new Date() })
    .where(and(eq(testParts.id, partId), eq(testParts.status, 'running'), ofNode(id)));
}

/* The node's end of a part: its result, and its log on the task, also for a part that ended here first. */
export async function partDone(ctx: Ctx, id: NodeIdentity, msg: TestsDone): Promise<void> {
  const { db } = ctx;
  if (isId(msg.partId)) {
    const [found] = await db.select({ part: testParts, run: testRuns }).from(testParts).innerJoin(testRuns, eq(testRuns.id, testParts.runId)).where(and(eq(testParts.id, msg.partId), ofNode(id)));
    if (found && found.part.status !== 'queued') {
      const [ended] = await db
        .update(testParts)
        .set({ status: msg.ok ? 'passed' : 'failed', commit: msg.commit, exitCode: msg.exitCode, error: msg.ok ? null : (msg.error ?? 'failed'), tail: tailOf(msg.log), finishedAt: new Date() })
        .where(and(eq(testParts.id, msg.partId), eq(testParts.status, 'running')))
        .returning();
      await keepLog(ctx, found.run, found.part, msg.log);
      if (ended) await settleRun(ctx, found.run.id);
    }
  }
  /* The node keeps the end until it hears this, and sends it again after a reconnect; a second one changes nothing. */
  ctx.hub.send(id, { type: 'tests.ack', partId: msg.partId });
  await pumpTests(ctx);
}

/* A node said hello: parts it ran and no longer knows were lost with a restart, and parts it still has that ended here
   meanwhile stop. A node of a build before test runs knows none. */
export async function testsHello(ctx: Ctx, id: NodeIdentity, has: string[] = []): Promise<void> {
  const known = has.filter(isId);
  await loseParts(ctx, and(ofNode(id), known.length ? notInArray(testParts.id, known) : undefined)!, 'machine_restarted');
  if (known.length) {
    const open = await ctx.db.select({ id: testParts.id }).from(testParts).where(and(inArray(testParts.id, known), eq(testParts.status, 'running'), ofNode(id)));
    const keep = new Set(open.map(p => p.id));
    for (const partId of known) if (!keep.has(partId)) ctx.hub.send(id, { type: 'tests.cancel', partId });
  }
  await pumpTests(ctx);
}

/* Parts past their time limit whose node never said they ended, parts whose machine is away too long, and parts that
   waited too long for a machine. */
export async function checkTestTimes(ctx: Ctx, now = new Date()): Promise<void> {
  const { db } = ctx;
  const open = await db
    .select({ part: testParts, run: testRuns })
    .from(testParts)
    .innerJoin(testRuns, eq(testRuns.id, testParts.runId))
    .where(inArray(testParts.status, ['queued', 'running']));
  for (const { part, run } of open) {
    if (part.status === 'running' && part.startedAt && part.startedAt.getTime() + run.timeoutMs + LATE_MS < now.getTime()) {
      const [ended] = await endParts(ctx, and(eq(testParts.id, part.id), eq(testParts.status, 'running'))!, 'timeout');
      const node = ended && nodeOf(ended);
      if (node) ctx.hub.send(node, { type: 'tests.cancel', partId: part.id });
      continue;
    }
    const node = part.status === 'running' ? nodeOf(part) : null;
    const away = node && ctx.hub.awaySince(node);
    if (away && away + AWAY_MS < now.getTime()) await loseParts(ctx, eq(testParts.id, part.id), 'machine_offline');
    if (part.status === 'queued' && part.queuedAt.getTime() + WAIT_MS < now.getTime()) {
      await endParts(ctx, and(eq(testParts.id, part.id), eq(testParts.status, 'queued'))!, 'no_machine');
    }
  }
  await pumpTests(ctx);
}

/* files: the task's files a part of work takes in; memory: the free memory, in GB, it needs; repeatable: it may run twice. */
export type RunInput = { task?: number | string; branch?: string; command: string; parts?: number; minutes?: number; files?: string[]; memory?: number; repeatable?: boolean };

/* The task a run is for: the one named, else the one the turn is on. */
async function taskFor(ctx: Ctx, job: ToolJob, ref: number | string | undefined, kind: RunKind): Promise<Task> {
  if (ref === undefined) {
    const [turn] = await ctx.db.select({ taskId: jobs.taskId }).from(jobs).where(eq(jobs.id, job.id));
    const [task] = turn?.taskId ? await ctx.db.select().from(tasks).where(eq(tasks.id, turn.taskId)) : [];
    if (!task) throw refuse(400, 'task_invalid', `This turn is on no task: name the task ${kind === 'work' ? 'the work is for' : 'whose branch to test'} with task.`);
    return task;
  }
  const task = await taskByRef(ctx, job.companyId, ref);
  if (!task || !onTask(job, task)) throw refuse(404, 'task_unknown', `There is no task ${ref} you work on.`);
  return task;
}

/* Starts a run for a task: a test run of its branch, or any other work, on a branch or in an empty folder with the task's
   files. Its parts go out to free machines now or wait for them. Says how it went out. */
export async function startRun(ctx: Ctx, job: ToolJob, input: RunInput, kind: RunKind = 'tests'): Promise<string> {
  const { db } = ctx;
  const task = await taskFor(ctx, job, input.task, kind);
  if (CLOSED.includes(task.status)) throw refuse(409, 'task_closed', `#${task.number} is ${task.status} already.`);
  const cloned = kind === 'tests' || input.branch !== undefined;
  const found = cloned ? await repoAt(ctx, [task.productId, task.departmentId]) : null;
  if (cloned && !found) {
    throw refuse(
      409,
      'repo_invalid',
      kind === 'tests'
        ? `#${task.number} has no repository to test: its department has none set.`
        : `#${task.number} has no repository to clone ${input.branch} from: its department has none set. Leave out branch to run in an empty folder.`,
    );
  }
  const files = kind === 'work' ? [...new Set(input.files ?? [])] : [];
  if (files.length) {
    const had = await db.select({ name: attachments.name }).from(attachments).where(and(eq(attachments.taskId, task.id), inArray(attachments.name, files)));
    const missing = files.find(f => !had.some(h => h.name === f));
    if (missing) throw refuse(404, 'attachment_unknown', `#${task.number} has no file ${missing}. Put it on the task with hh-attach --task ${task.number} first.`);
  }
  const parts = input.parts ?? 1;
  if (parts > 1 && !input.command.includes('{part}')) {
    throw refuse(400, 'task_invalid', 'A command split into parts says which part it runs with {part}, and with {parts} how many there are, as in --shard={part}/{parts}.');
  }
  const [open] = await db.select({ n: count() }).from(testRuns).where(and(eq(testRuns.agentId, job.agentId), eq(testRuns.status, 'running')));
  if (Number(open?.n ?? 0) >= OPEN_RUNS) throw refuse(409, 'task_invalid', `You have ${OPEN_RUNS} runs going on already. Wait for one to end, or stop one with stop_tests or stop_work.`);
  const department = found?.department ?? (await targetOf(ctx, { kind, branch: null, departmentId: task.productId ?? task.departmentId }))?.department ?? null;
  const run = await db.transaction(async tx => {
    /* Numbers go up one by one per company, so starting a run waits on the company row. */
    await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, job.companyId)).for('update');
    const [last] = await tx.select({ n: max(testRuns.number) }).from(testRuns).where(eq(testRuns.companyId, job.companyId));
    const [row] = await tx
      .insert(testRuns)
      .values({
        companyId: job.companyId,
        number: (last?.n ?? 0) + 1,
        taskId: task.id,
        agentId: job.agentId,
        jobId: job.id,
        departmentId: department?.id ?? null,
        kind,
        branch: input.branch ?? null,
        command: input.command,
        files,
        memoryGb: kind === 'work' ? (input.memory ?? WORK_MEMORY_GB) : null,
        repeatable: kind === 'work' && input.repeatable === true,
        parts,
        timeoutMs: (input.minutes ?? TEST_MINUTES) * 60_000,
      })
      .returning();
    await tx.insert(testParts).values(Array.from({ length: parts }, (_, i) => ({ companyId: job.companyId, runId: row!.id, part: i + 1 })));
    return row!;
  });
  await pumpTests(ctx);
  const went = await db.select().from(testParts).where(eq(testParts.runId, run.id)).orderBy(asc(testParts.part));
  const places = (await placesOf(ctx, job.companyId)).filter(p => mayTake(p, run, department));
  const one = went.length === 1;
  const where = went.map(p => {
    const at = p.status === 'running' ? `on ${p.machineName}` : 'waits for a free machine';
    return one ? at : `part ${p.part} ${p.status === 'running' ? 'runs ' : ''}${at}`;
  });
  const none = went.some(p => p.status === 'queued') && !places.length ? ' No machine that may take it is online now, so it waits until one is.' : '';
  return (
    `${named(run)} of #${task.number} ${one && went[0]!.status === 'running' ? 'runs ' : ''}${one ? where[0] : `has ${parts} parts: ${where.join(', ')}`}.${none} ` +
    `When every part has ended you are woken on #${task.number} with the result; ${toolsOf(kind).state} ${run.number} shows how it goes.`
  );
}

/* A run the agent may see and stop: its own, or one on a task it works on. */
async function runOf(ctx: Ctx, job: ToolJob, number: number, kind: RunKind): Promise<{ run: Run; task: Task }> {
  const [found] = await ctx.db
    .select({ run: testRuns, task: tasks })
    .from(testRuns)
    .innerJoin(tasks, eq(tasks.id, testRuns.taskId))
    .where(and(eq(testRuns.companyId, job.companyId), eq(testRuns.number, number)));
  if (!found || (found.run.agentId !== job.agentId && !onTask(job, found.task))) throw refuse(404, 'task_unknown', `There is no ${kind === 'work' ? 'work' : 'test'} run ${number} you can see.`);
  return found;
}

/* How a run goes, part by part. */
export async function runState(ctx: Ctx, job: ToolJob, number: number, kind: RunKind = 'tests'): Promise<object> {
  const { run, task } = await runOf(ctx, job, number, kind);
  const parts = await ctx.db.select().from(testParts).where(eq(testParts.runId, run.id)).orderBy(asc(testParts.part));
  const files = await ctx.db.select({ name: attachments.name }).from(attachments).where(and(eq(attachments.taskId, run.taskId), filesOf(run)));
  const [stopper] = run.stoppedByAgentId ? await ctx.db.select({ name: agents.name }).from(agents).where(eq(agents.id, run.stoppedByAgentId)) : [];
  const has = new Set(files.map(l => l.name));
  const work = run.kind === 'work';
  return {
    run: run.number,
    task: task.number,
    kind: run.kind,
    branch: work ? run.branch : (run.branch ?? `the task's own: task-${task.number} or the one that starts with task-${task.number}-`),
    command: run.command,
    ...(work ? { files: run.files, memoryGb: run.memoryGb, repeatable: run.repeatable } : {}),
    minutes: run.timeoutMs / 60_000,
    status: stateOf(run, run.status),
    ...(stopper ? { stoppedBy: stopper.name } : {}),
    startedAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    parts: parts.map(p => ({
      part: p.part,
      status: stateOf(run, p.status),
      machine: p.machineName,
      commit: p.commit,
      exitCode: p.exitCode,
      ...(p.error && p.status !== 'passed' ? { why: endedBy(run, p) } : {}),
      startedAt: p.startedAt?.toISOString() ?? null,
      finishedAt: p.finishedAt?.toISOString() ?? null,
      log: has.has(logName(run, p.part)) ? logName(run, p.part) : null,
      ...(work ? { made: [...has].filter(n => n!.startsWith(`work-${run.number}-${p.part}-`)).sort() } : {}),
      ...(p.lost.length ? { ranAgain: p.lost.map(lostLine) } : {}),
      ...(p.status === 'failed' && p.tail ? { end: p.tail } : {}),
    })),
  };
}

/* Stops a run: its waiting parts end here, its running ones on their nodes too. Its agent hears of it when another one
   stopped it. */
export async function stopRun(ctx: Ctx, job: ToolJob, number: number, kind: RunKind = 'tests'): Promise<string> {
  const { run, task } = await runOf(ctx, job, number, kind);
  if (run.status !== 'running') throw refuse(409, 'task_invalid', `${named(run)} ${run.status === 'stopped' ? 'is stopped' : stateOf(run, run.status) === 'done' ? 'is done' : run.status} already.`);
  const other = run.agentId !== job.agentId;
  const [me] = other ? await ctx.db.select({ name: agents.name }).from(agents).where(eq(agents.id, job.agentId)) : [];
  const now = new Date();
  const stopped = await ctx.db.transaction(async tx => {
    const [row] = await tx
      .update(testRuns)
      .set({ status: 'stopped', finishedAt: now, stoppedByAgentId: other ? job.agentId : null })
      .where(and(eq(testRuns.id, run.id), eq(testRuns.status, 'running')))
      .returning();
    if (!row) return null;
    const parts = await tx
      .update(testParts)
      .set({ status: 'stopped', finishedAt: now })
      .where(and(eq(testParts.runId, run.id), inArray(testParts.status, ['queued', 'running'])))
      .returning();
    const wakes: Wake[] = other && !CLOSED.includes(task.status) ? [{ agentId: run.agentId, taskId: run.taskId, why: run.kind, text: `${named(run)} was stopped by ${me?.name ?? 'another agent'}.` }] : [];
    await keepWakes(tx, run.companyId, wakes);
    return { parts, wakes };
  });
  if (!stopped) throw refuse(409, 'task_invalid', `${named(run)} ended meanwhile.`);
  for (const p of stopped.parts) {
    const node = nodeOf(p);
    if (node) ctx.hub.send(node, { type: 'tests.cancel', partId: p.id });
  }
  await wakeAll(ctx, stopped.wakes);
  await pumpTests(ctx);
  return `${named(run)} is stopped.`;
}

/* A running part of work on this node, and its run, for the part's files. */
export async function workPartOn(ctx: Ctx, id: NodeIdentity, partId: string): Promise<{ part: Part; run: Run; task: Task } | null> {
  if (!isId(partId)) return null;
  const [found] = await ctx.db
    .select({ part: testParts, run: testRuns, task: tasks })
    .from(testParts)
    .innerJoin(testRuns, eq(testRuns.id, testParts.runId))
    .innerJoin(tasks, eq(tasks.id, testRuns.taskId))
    .where(and(eq(testParts.id, partId), eq(testParts.status, 'running'), eq(testRuns.kind, 'work'), ofNode(id)));
  return found ?? null;
}
