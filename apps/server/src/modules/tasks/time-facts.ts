import { externalWaitFact, validSourceKey, type TaskWaitFact as WaitFact, type WaitRunError, type WaitWho as Who } from '@hornhoof/protocol/waits';
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { jobs, people, requests, taskEvents, testParts, testRuns } from '../../db/schema.js';
import { candidates } from './decision-people.js';
import { NO_FAILURE, turnFailed } from './failure-records.js';
import { decisionOwner, openPersonRequests } from './decisions.js';
import { requestSubject, type Task } from './state.js';
import { waitForSourceKey, type TaskWait } from './wait-state.js';
import { prerequisiteOf } from './wait-views.js';

/* What a task's time says, worked out on the server: since when it is in its status, how long its turns ran, and whom it
   waits for since when. */
export type TimeFacts = {
  inStatusSince: string;
  workSeconds: number;
  waitsOn: (WaitFact & { request?: true })[];
};

/* Since when each task is in its status: its last change of status, or, for a task from before the log said so, its last
   line, or its start. */
async function statusSince(db: Ctx['db'], rows: Pick<Task, 'id'>[]): Promise<Map<string, Date>> {
  const found = await db
    .selectDistinctOn([taskEvents.taskId], { taskId: taskEvents.taskId, at: taskEvents.createdAt })
    .from(taskEvents)
    .where(inArray(taskEvents.taskId, rows.map(t => t.id)))
    .orderBy(taskEvents.taskId, sql`(${taskEvents.data} ? 'toStatus') desc`, sql`${taskEvents.id} desc`);
  return new Map(found.map(r => [r.taskId, r.at]));
}

/* Seconds each task's turns ran: every one that started, to its end, or to now while it runs. */
async function workedSeconds(db: Ctx['db'], rows: Pick<Task, 'id'>[], now: number): Promise<Map<string, number>> {
  const ran = await db
    .select({ taskId: jobs.taskId, status: jobs.status, startedAt: jobs.startedAt, finishedAt: jobs.finishedAt })
    .from(jobs)
    .where(and(inArray(jobs.taskId, rows.map(t => t.id)), isNotNull(jobs.startedAt)));
  const seconds = new Map<string, number>();
  for (const j of ran) {
    const end = j.finishedAt?.getTime() ?? (j.status === 'running' ? now : null);
    if (end === null || !j.taskId) continue;
    seconds.set(j.taskId, (seconds.get(j.taskId) ?? 0) + Math.max(0, Math.round((end - j.startedAt!.getTime()) / 1000)));
  }
  return seconds;
}

export type TimedTask = Pick<Task, 'id' | 'companyId' | 'status' | 'createdAt' | 'after' | 'departmentId' | 'productId' | 'assigneeAgentId' | 'executorAgentId' | 'externalWait'>;
const uuid = z.uuid();

/* The last part names the reviewer in both the current and the original review keys. */
export function reviewerOf(wait: TaskWait): string | null {
  if (wait.kind !== 'review') return null;
  const parsed = uuid.safeParse(wait.sourceKey.split(':').at(-1));
  return parsed.success ? parsed.data : null;
}

const runIdOf = (wait: TaskWait) => wait.kind === 'run' && validSourceKey('run', wait.sourceKey) ? wait.sourceKey.slice('run:'.length) : null;
const requestIdOf = (wait: TaskWait) => wait.kind === 'person' && wait.sourceKey.startsWith('request:') && validSourceKey('person', wait.sourceKey) ? wait.sourceKey.slice('request:'.length) : null;

function personWaitFact(fact: WaitFact, request: string | null, id: string | null, names: Map<string, string>): TimeFacts['waitsOn'] {
  if (request && !id) return [];
  const who: Who | null = id ? { kind: 'person', id, name: names.get(id) ?? '' } : null;
  return [{ ...fact, who, ...(request ? { request: true } : {}) }];
}

/* Use the same recipient as the decision card, including when a question predates wait ownership. */
async function questionRecipients(db: Ctx['db'], rows: TimedTask[], waits: (t: TimedTask) => TaskWait[]): Promise<Map<string, string | null>> {
  const ids = rows.flatMap(task => waits(task).flatMap(wait => requestIdOf(wait) ?? []));
  const asked = ids.length ? await db.select({ id: requests.id, taskId: requests.taskId, companyId: requests.companyId, kind: requests.kind, decisionTopic: requests.decisionTopic, recipientPersonId: requests.recipientPersonId })
    .from(requests).where(and(inArray(requests.id, ids), openPersonRequests())) : [];
  const companies = [...new Set(asked.map(q => q.companyId))];
  const everyone = new Map(await Promise.all(companies.map(async id => [id, await candidates({ db }, id)] as const)));
  const tasks = new Map(rows.map(task => [task.id, task]));
  const recipients = new Map<string, string | null>();
  for (const q of asked) {
    const people = everyone.get(q.companyId)!;
    const task = tasks.get(q.taskId);
    if (!task) continue;
    recipients.set(q.id, people.some(p => p.isOwner && p.status === 'active') ? decisionOwner(requestSubject(q, task), people) : null);
  }
  return recipients;
}

/* Keep machine and repository failures readable without exposing command output. */
const RUN_ERRORS: Record<string, WaitRunError> = {
  timeout: 'timeout', machine_restarted: 'machine', machine_offline: 'machine', machine_disconnected: 'machine',
  subscription_removed: 'machine', no_machine: 'machine', clone_failed: 'repository', no_repository: 'repository',
  files_failed: 'files', commit_mismatch: 'revision', cancelled: 'stopped',
};

/* The last turn of each task's holder on it since the task came to its status, where it failed and no turn of the holder on
   the task waits or runs to take it on: the task fails until a turn of its holder goes well, or the task moves on. */
async function failedTurns(db: Ctx['db'], open: TimedTask[], since: Map<string, Date>): Promise<Map<string, Date>> {
  if (!open.length) return new Map();
  const ids = open.map(t => t.id);
  const ended = { id: jobs.id, taskId: jobs.taskId, agentId: jobs.agentId, status: jobs.status, error: jobs.error, failure: jobs.failure, finishedAt: jobs.finishedAt, createdAt: jobs.createdAt };
  const last = await db.selectDistinctOn([jobs.taskId, jobs.agentId], ended)
    .from(jobs).where(and(inArray(jobs.taskId, ids), eq(jobs.kind, 'conversation'), inArray(jobs.status, ['done', 'failed']), or(isNull(jobs.error), notInArray(jobs.error, NO_FAILURE))))
    .orderBy(jobs.taskId, jobs.agentId, desc(sql`coalesce(${jobs.finishedAt}, ${jobs.createdAt})`), desc(jobs.createdAt));
  const holders = new Map(open.map(t => [t.id, t.executorAgentId ?? t.assigneeAgentId]));
  const at = (j: { finishedAt: Date | null; createdAt: Date }) => j.finishedAt ?? j.createdAt;
  const own = last.filter(j => j.taskId && holders.get(j.taskId) === j.agentId && at(j) >= (since.get(j.taskId) ?? new Date(0)));
  if (!own.some(j => j.status === 'failed')) return new Map();
  const going = await db.selectDistinct({ taskId: jobs.taskId, agentId: jobs.agentId }).from(jobs)
    .where(and(inArray(jobs.taskId, ids), eq(jobs.kind, 'conversation'), inArray(jobs.status, ['queued', 'running'])));
  const goesOn = new Set(own.filter(j => going.some(g => g.taskId === j.taskId && g.agentId === j.agentId)).map(j => j.id));
  return new Map(own.filter(j => turnFailed(j, goesOn)).map(j => [j.taskId!, at(j)]));
}

export type WaitNames = { agent(id: string): string | undefined; task(id: string): number | undefined };

type StuckAsk = { triage: string | null; at: Date };

/* An agent stuck on its task asked for help: the task fails until someone answers. The first open ask of each task counts. */
async function stuckAsks(db: Ctx['db'], openIds: string[]): Promise<Map<string, StuckAsk>> {
  if (!openIds.length) return new Map();
  const asks = await db.select({ taskId: requests.taskId, triage: requests.triageAgentId, at: requests.createdAt }).from(requests)
    .where(and(inArray(requests.taskId, openIds), eq(requests.kind, 'stuck'), eq(requests.status, 'open'))).orderBy(asc(requests.createdAt));
  return asks.reduce((byTask, ask) => (byTask.has(ask.taskId) ? byTask : byTask.set(ask.taskId, ask)), new Map<string, StuckAsk>());
}

/* The failures of a task that need someone: its holder's last turn failed, or an agent stuck on it asked for help. */
function failureFacts(turn: Date | undefined, asked: StuckAsk | undefined, names: WaitNames): WaitFact[] {
  const who = (id: string): Who => ({ kind: 'agent', id, name: names.agent(id) ?? '' });
  return [
    ...(turn ? [{ kind: 'external' as const, who: null, reason: null, since: turn.toISOString(), failure: 'turn' as const }] : []),
    ...(asked ? [{ kind: 'external' as const, who: asked.triage ? who(asked.triage) : null, reason: null, since: asked.at.toISOString(), failure: 'stuck' as const }] : []),
  ];
}

/* The facts of every task at once. The task lookup exposes only prerequisites this reader sees. */
export async function timeFacts(db: Ctx['db'], rows: TimedTask[], waits: (t: TimedTask) => TaskWait[], names: WaitNames, now = Date.now()): Promise<Map<string, TimeFacts>> {
  if (!rows.length) return new Map();
  const sinceByTask = await statusSince(db, rows);
  const seconds = await workedSeconds(db, rows, now);
  const recipients = await questionRecipients(db, rows, waits);
  const openIds = rows.filter(t => t.status !== 'done' && t.status !== 'cancelled').map(t => t.id);
  const companies = [...new Set(rows.filter(t => t.externalWait?.on?.kind === 'external' && t.externalWait.on.event === 'ceo').map(t => t.companyId))];
  const owners = new Map((companies.length ? await db.select({ companyId: people.companyId, id: people.id, name: people.name }).from(people)
    .where(and(inArray(people.companyId, companies), eq(people.isOwner, true), eq(people.status, 'active'))) : []).map(p => [p.companyId, p]));
  const transitions = new Map((openIds.length ? await db.selectDistinctOn([taskEvents.taskId], {
    taskId: taskEvents.taskId, data: taskEvents.data, at: taskEvents.createdAt,
  }).from(taskEvents).where(and(inArray(taskEvents.taskId, openIds), sql`(${taskEvents.data} ? 'externalWait' OR ${taskEvents.data} ? 'toStatus')`))
    .orderBy(taskEvents.taskId, desc(taskEvents.id)) : []).map(e => [e.taskId, e]));
  const personIdOf = (wait: TaskWait) => {
    const request = requestIdOf(wait);
    return request ? recipients.get(request) ?? null : wait.ownerPersonId;
  };
  const personIds = [...new Set(rows.flatMap(t => waits(t).flatMap(w => w.kind === 'person' ? personIdOf(w) ?? [] : [])))];
  const named = new Map((personIds.length ? await db.select({ id: people.id, name: people.name }).from(people).where(inArray(people.id, personIds)) : []).map(p => [p.id, p.name]));
  const runIds = [...new Set(rows.flatMap(t => [t.externalWait?.run, ...waits(t).map(runIdOf)]).filter((id): id is string => uuid.safeParse(id).success))];
  const runFields = { id: testRuns.id, taskId: testRuns.taskId, kind: testRuns.kind, number: testRuns.number,
    status: testRuns.status, createdAt: testRuns.createdAt, finishedAt: testRuns.finishedAt };
  const runs = runIds.length ? await db.select(runFields).from(testRuns).where(inArray(testRuns.id, runIds)) : [];
  /* A refused or stopped run proves nothing, so it neither fails the task nor clears the failure of a run before it. */
  const latestRuns = (openIds.length ? await db.selectDistinctOn([testRuns.taskId, testRuns.kind], runFields).from(testRuns)
    .where(and(inArray(testRuns.taskId, openIds), inArray(testRuns.status, ['running', 'passed', 'failed']))).orderBy(testRuns.taskId, testRuns.kind, desc(testRuns.number)) : [])
    .reduce((byTask, run) => byTask.set(run.taskId, [...(byTask.get(run.taskId) ?? []), run]), new Map<string, typeof runs>());
  const stuck = await stuckAsks(db, openIds);
  const open = new Set(openIds);
  const turnsFailed = await failedTurns(db, rows.filter(t => open.has(t.id)), sinceByTask);
  const byRun = new Map(runs.map(r => [r.id, r]));
  const failedIds = [...new Set([...runs, ...[...latestRuns.values()].flat()].filter(r => r.status === 'failed').map(r => r.id))];
  const failedParts = failedIds.length ? await db.select({ runId: testParts.runId, error: testParts.error }).from(testParts)
    .where(and(inArray(testParts.runId, failedIds), eq(testParts.status, 'failed'), isNotNull(testParts.error))).orderBy(testParts.part) : [];
  const errors = new Map<string, WaitRunError>();
  for (const part of failedParts) {
    const error = part.error && Object.hasOwn(RUN_ERRORS, part.error) ? RUN_ERRORS[part.error] : undefined;
    if (error && !errors.has(part.runId)) errors.set(part.runId, error);
  }
  const runFact = (run: typeof runs[number] | undefined, since: string): WaitFact => {
    const runError = run && errors.get(run.id);
    return { kind: run?.kind === 'work' ? 'work' : 'run', who: null, reason: run ? String(run.number) : null, since,
      ...(run?.status === 'failed' ? { failure: 'run' } : {}), ...(runError ? { runError } : {}) };
  };


  const waitsOf = (task: TimedTask): TimeFacts['waitsOn'] => {
    const records = waits(task);
    const agent = (id: string | null): Who | null => id && id !== (task.executorAgentId ?? task.assigneeAgentId)
      ? { kind: 'agent', id, name: names.agent(id) ?? '' } : null;
    const run = (id: string | null, since: string): WaitFact => {
      const found = id ? byRun.get(id) : undefined;
      const match = found?.taskId === task.id ? found : undefined;
      return runFact(match, since);
    };
    const external = task.externalWait;
    const facts = records.flatMap((wait): TimeFacts['waitsOn'] => {
      const since = wait.createdAt.toISOString();
      const fact = { kind: wait.kind, who: null, reason: null, since };
      switch (wait.kind) {
        case 'after': {
          const id = prerequisiteOf(wait)!;
          const number = task.after.includes(id) ? names.task(id) : undefined;
          return number === undefined ? [] : [{ ...fact, reason: `#${number}` }];
        }
        case 'person': return personWaitFact(fact, requestIdOf(wait), personIdOf(wait), named);
        case 'review': return [{ ...fact, who: agent(reviewerOf(wait)) }];
        case 'run': {
          const id = runIdOf(wait);
          return id && id === external?.run ? [] : [run(id, since)];
        }
        case 'external': {
          if (wait.sourceKey.startsWith(waitForSourceKey(''))) return [];
          const who = wait.sourceKey.startsWith('question:') ? agent(wait.ownerAgentId) : null;
          return [{ ...fact, who }];
        }
      }
    });
    const activeRuns = new Set(records.map(runIdOf));
    for (const latest of latestRuns.get(task.id) ?? []) {
      if (latest.id === external?.run || activeRuns.has(latest.id)) continue;
      if (latest.status !== 'running' && latest.status !== 'failed') continue;
      const at = latest.finishedAt ?? latest.createdAt;
      if (latest.status === 'failed' && at < (sinceByTask.get(task.id) ?? task.createdAt)) continue;
      facts.push(runFact(latest, at.toISOString()));
    }
    facts.push(...failureFacts(turnsFailed.get(task.id), stuck.get(task.id), names));
    if (external) {
      const on = external.on;
      const owner = owners.get(task.companyId);
      const who: Who | null = on?.kind === 'employee' ? agent(on.employee)
        : on?.kind === 'external' && on.event === 'ceo' && owner ? { kind: 'person', id: owner.id, name: owner.name } : null;
      facts.push(externalWaitFact(external, now, external.run ? run(external.run, external.since) : { kind: 'external', who, reason: external.reason, since: external.since }));
    } else {
      const transition = transitions.get(task.id);
      const failure = transition?.data.waitFailure;
      if (transition && (failure === 'expired' || failure === 'machine' || failure === 'unavailable')) {
        facts.push({ kind: 'external', who: null, reason: typeof transition.data.reason === 'string' ? transition.data.reason : null,
          since: transition.at.toISOString(), failure });
      }
    }
    return facts;
  };
  return new Map(rows.map(t => [t.id, {
    inStatusSince: (sinceByTask.get(t.id) ?? t.createdAt).toISOString(),
    workSeconds: seconds.get(t.id) ?? 0,
    waitsOn: waitsOf(t),
  }]));
}
