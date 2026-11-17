import type { Language, Messages } from '../i18n';
import { doerOf, isWaitForPerson } from '../tracker';
import type { TaskLine, TaskLogLine, TimeFacts } from '../types';

export const localeOf = (language: Language) => (language === 'ru' ? 'ru-RU' : 'en-GB');

/* A stretch of time in the largest whole unit that says it: minutes, hours with minutes, or days. */
export function spanText(t: Messages, seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return t.tracker.time.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t.tracker.time.hours(hours, minutes % 60);
  return t.tracker.time.days(Math.floor(hours / 24));
}

export const sinceSeconds = (at: string, now = Date.now()) => Math.max(0, (now - new Date(at).getTime()) / 1000);

export const momentText = (language: Language, at: string) => new Date(at).toLocaleString(localeOf(language), { dateStyle: 'short', timeStyle: 'short' });

const closed = (task: Pick<TaskLine, 'status'>) => task.status === 'done' || task.status === 'cancelled';

const DAY = 24 * 60 * 60 * 1000;

/* By when it is due, and that it is late once the whole day is past and it is not over. A due date is a day of the
   calendar kept as its midnight in UTC, so it reads as that day wherever the person is. */
export function dueText(t: Messages, language: Language, task: Pick<TaskLine, 'dueAt' | 'status'>, now = Date.now()): { text: string; late: boolean } | null {
  if (!task.dueAt) return null;
  const late = !closed(task) && now >= new Date(task.dueAt).getTime() + DAY;
  const day = new Date(task.dueAt).toLocaleDateString(localeOf(language), { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return { text: late ? t.tracker.late(day) : day, late };
}

type WaitTask = Pick<TaskLine, 'time' | 'status' | 'executor' | 'externalWait'> & Partial<Pick<TaskLine, 'assignee'>>;
type Wait = TimeFacts['waitsOn'][number];
export const matchesExternalWait = (fact: Wait, external: NonNullable<TaskLine['externalWait']>) =>
  fact.since === external.since && (fact.kind === 'external' || fact.kind === 'run' || fact.kind === 'work');

export function taskWaits(task: WaitTask): Wait[] {
  if (closed(task)) return [];
  const waits = [...(task.time?.waitsOn ?? [])];
  const external = task.externalWait;
  if (external && !waits.some(w => matchesExternalWait(w, external))) {
    const on = external.on;
    const who = on?.kind === 'employee' ? { kind: 'agent' as const, id: on.employee, name: on.name ?? '' } : null;
    waits.push({ kind: external.run ? 'run' : 'external', who, reason: external.run ? null : external.reason, since: external.since });
  }
  return waits.sort((a, b) => a.since.localeCompare(b.since));
}

export function waitLabel(t: Messages, task: WaitTask, wait: Wait, now = Date.now()): string {
  const words = t.tracker.wait;
  const span = spanText(t, sinceSeconds(wait.since, now));
  const agent = wait.who?.kind === 'agent' && wait.who.id !== doerOf(task)?.id ? wait.who.name : null;
  switch (wait.kind) {
    case 'person': return words.person(wait.who?.kind === 'person' ? wait.who.name : null, span);
    case 'after': return words.after(wait.reason, span);
    case 'review': return words.review(agent, span);
    case 'run': return words.run(wait.reason, span);
    case 'work': return words.work(wait.reason, span);
    case 'external': return words.external(agent, wait.reason, span);
    default: return words.unknown(span);
  }
}

/* What an open task waits for and how long already, by its oldest relevant wait. */
export function waitText(t: Messages, task: WaitTask, now = Date.now(), personId?: string): string | null {
  const wait = taskWaits(task).find(w => personId === undefined || isWaitForPerson(w, personId));
  return wait ? waitLabel(t, task, wait, now) : null;
}

const field = (data: unknown, key: string): unknown => (data && typeof data === 'object' && key in data ? (data as Record<string, unknown>)[key] : undefined);

/* What the tracker says of a history line of its own: a status change, an edit, or responsibility passed on, in the
   person's language. states: the words of the statuses of a task or of a goal; names: a person's name by id. Null for any
   other line. */
export function trackerLine(t: Messages, e: TaskLogLine, by: string, states: Record<string, string>, names: (id: string) => string | undefined): string | null {
  const words = t.tracker.history;
  const [from, to] = [field(e.data, 'fromStatus'), field(e.data, 'toStatus')];
  if (e.kind === 'status' && typeof from === 'string' && typeof to === 'string') return words.status(by, states[from] ?? from, states[to] ?? to);
  if (e.kind !== 'edited') return null;
  const [passedFrom, passedTo] = [field(e.data, 'from'), field(e.data, 'to')];
  if (!e.by && typeof passedFrom === 'string' && typeof passedTo === 'string') {
    const [a, b] = [names(passedFrom), names(passedTo)];
    return a && b ? words.passed(a, b) : e.text || null;
  }
  const fields = field(e.data, 'fields');
  if (!Array.isArray(fields)) return null;
  return words.edited(by, words.and(...fields.map(f => (words.fields as Record<string, string>)[f] ?? String(f))));
}
