import { validSourceKey, type WaitSourceKind } from '@hornhoof/protocol/waits';
import { inArray, isNotNull, and, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { jobs, people, requests, taskEvents, testRuns } from '../../db/schema.js';
import { candidates, decisionOwner } from './decisions.js';
import { requestSubject, type Task } from './engine.js';
import { waitForSourceKey, type TaskWait } from './wait-state.js';
import { prerequisiteOf } from './wait-views.js';

/* What a task's time says, worked out on the server: since when it is in its status, how long its turns ran, and whom it
   waits for since when. */
type Who = { kind: 'person' | 'agent'; id: string; name: string };
type WaitFact = { who: Who | null; since: string; kind: WaitSourceKind | 'work'; reason: string | null };
export type TimeFacts = {
  inStatusSince: string;
  workSeconds: number;
  waitsOn: WaitFact[];
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

export type TimedTask = Pick<Task, 'id' | 'createdAt' | 'after' | 'departmentId' | 'productId' | 'assigneeAgentId' | 'executorAgentId' | 'externalWait'>;
const uuid = z.uuid();

/* The last part names the reviewer in both the current and the original review keys. */
export function reviewerOf(wait: TaskWait): string | null {
  if (wait.kind !== 'review') return null;
  const parsed = uuid.safeParse(wait.sourceKey.split(':').at(-1));
  return parsed.success ? parsed.data : null;
}

const runIdOf = (wait: TaskWait) => wait.kind === 'run' && validSourceKey('run', wait.sourceKey) ? wait.sourceKey.slice('run:'.length) : null;
const requestIdOf = (wait: TaskWait) => wait.kind === 'person' && wait.sourceKey.startsWith('request:') && validSourceKey('person', wait.sourceKey) ? wait.sourceKey.slice('request:'.length) : null;

/* Use the same recipient as the decision card, including when a question predates wait ownership. */
async function questionRecipients(db: Ctx['db'], rows: TimedTask[], waits: (t: TimedTask) => TaskWait[]): Promise<Map<string, string | null>> {
  const ids = rows.flatMap(task => waits(task).flatMap(wait => requestIdOf(wait) ?? []));
  const asked = ids.length ? await db.select({ id: requests.id, taskId: requests.taskId, companyId: requests.companyId, status: requests.status, kind: requests.kind, decisionTopic: requests.decisionTopic })
    .from(requests).where(inArray(requests.id, ids)) : [];
  const companies = [...new Set(asked.map(q => q.companyId))];
  const everyone = new Map(await Promise.all(companies.map(async id => [id, await candidates({ db }, id)] as const)));
  const tasks = new Map(rows.map(task => [task.id, task]));
  const recipients = new Map<string, string | null>();
  for (const q of asked) {
    const people = everyone.get(q.companyId)!;
    const task = tasks.get(q.taskId);
    if (!task) continue;
    recipients.set(q.id, q.status === 'open' && people.some(p => p.isOwner && p.status === 'active') ? decisionOwner(requestSubject(q, task), people) : null);
  }
  return recipients;
}

export type WaitNames = { agent(id: string): string | undefined; task(id: string): number | undefined };

/* The facts of every task at once. The task lookup exposes only prerequisites this reader sees. */
export async function timeFacts(db: Ctx['db'], rows: TimedTask[], waits: (t: TimedTask) => TaskWait[], names: WaitNames, now = Date.now()): Promise<Map<string, TimeFacts>> {
  if (!rows.length) return new Map();
  const since = await statusSince(db, rows);
  const seconds = await workedSeconds(db, rows, now);
  const recipients = await questionRecipients(db, rows, waits);
  const personIdOf = (wait: TaskWait) => {
    const request = requestIdOf(wait);
    return request ? recipients.get(request) ?? null : wait.ownerPersonId;
  };
  const personIds = [...new Set(rows.flatMap(t => waits(t).flatMap(w => w.kind === 'person' ? personIdOf(w) ?? [] : [])))];
  const named = new Map((personIds.length ? await db.select({ id: people.id, name: people.name }).from(people).where(inArray(people.id, personIds)) : []).map(p => [p.id, p.name]));
  const runIds = [...new Set(rows.flatMap(t => [t.externalWait?.run, ...waits(t).map(runIdOf)]).filter((id): id is string => uuid.safeParse(id).success))];
  const runs = runIds.length ? await db.select({ id: testRuns.id, taskId: testRuns.taskId, kind: testRuns.kind, number: testRuns.number }).from(testRuns).where(inArray(testRuns.id, runIds)) : [];
  const byRun = new Map(runs.map(r => [r.id, r]));

  const waitsOf = (task: TimedTask): WaitFact[] => {
    const agent = (id: string | null): Who | null => id && id !== (task.executorAgentId ?? task.assigneeAgentId)
      ? { kind: 'agent', id, name: names.agent(id) ?? '' } : null;
    const run = (id: string | null, since: string): WaitFact => {
      const found = id ? byRun.get(id) : undefined;
      const match = found?.taskId === task.id ? found : undefined;
      return { kind: match?.kind === 'work' ? 'work' : 'run', who: null, reason: match ? String(match.number) : null, since };
    };
    const external = task.externalWait;
    const facts = waits(task).flatMap((wait): WaitFact[] => {
      const since = wait.createdAt.toISOString();
      const fact = { kind: wait.kind, who: null, reason: null, since };
      switch (wait.kind) {
        case 'after': {
          const id = prerequisiteOf(wait)!;
          const number = task.after.includes(id) ? names.task(id) : undefined;
          return number === undefined ? [] : [{ ...fact, reason: `#${number}` }];
        }
        case 'person': {
          const id = personIdOf(wait);
          return [{ ...fact, who: id ? { kind: 'person', id, name: named.get(id) ?? '' } : null }];
        }
        case 'review': return [{ ...fact, who: agent(reviewerOf(wait)) }];
        case 'run': {
          const id = runIdOf(wait);
          return id && id === external?.run ? [] : [run(id, since)];
        }
        case 'external': return wait.sourceKey.startsWith(waitForSourceKey('')) ? [] : [fact];
      }
    });
    if (!external) return facts;
    const on = external.on;
    const fact: WaitFact = external.run ? run(external.run, external.since) : {
      kind: 'external', who: agent(on?.kind === 'employee' ? on.employee : null), reason: external.reason, since: external.since,
    };
    return [...facts, fact];
  };
  return new Map(rows.map(t => [t.id, {
    inStatusSince: (since.get(t.id) ?? t.createdAt).toISOString(),
    workSeconds: seconds.get(t.id) ?? 0,
    waitsOn: waitsOf(t),
  }]));
}
