import { isPersonWait, type TaskWaitFact } from '@hornhoof/protocol/waits';
import type { Language, Messages } from '../i18n';
import { isClosed, taskWaits, type WaitTask } from '../task-tree';
import { doerOf, isWaitForPerson } from '../tracker';
import type { TaskLine, TaskLogLine } from '../types';

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

const DAY = 24 * 60 * 60 * 1000;

/* By when it is due, and that it is late once the whole day is past and it is not over. A due date is a day of the
   calendar kept as its midnight in UTC, so it reads as that day wherever the person is. */
export function dueText(t: Messages, language: Language, task: Pick<TaskLine, 'dueAt' | 'status'>, now = Date.now()): { text: string; late: boolean } | null {
  if (!task.dueAt) return null;
  const late = !isClosed(task) && now >= new Date(task.dueAt).getTime() + DAY;
  const day = new Date(task.dueAt).toLocaleDateString(localeOf(language), { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return { text: late ? t.tracker.late(day) : day, late };
}

export const waitClass = (wait: TaskWaitFact) => wait.failure ? 'failure' : isPersonWait(wait) ? 'person' : wait.event === 'time' ? 'scheduled' : 'working';

export function waitLabel(t: Messages, task: WaitTask, wait: TaskWaitFact, now = Date.now(), language: Language = 'en', asksYou = false): string {
  const words = t.tracker.wait;
  const described = (label: string) => wait.reason ? words.detail(label, wait.reason) : label;
  if (wait.failure === 'run') {
    const label = words.failedRun(wait.reason, wait.kind === 'work');
    return wait.runError ? words.detail(label, words.runErrors[wait.runError]) : label;
  }
  if (wait.failure) return described(words[wait.failure]);
  if (wait.event === 'time') {
    if (!wait.until) return words.scheduled;
    const date = new Date(wait.until);
    const locale = localeOf(language);
    return described(words.fires(date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
      date.toLocaleDateString(locale, { day: 'numeric', month: 'short' })));
  }
  const agent = wait.who?.kind === 'agent' && wait.who.id !== doerOf(task)?.id ? wait.who.name : null;
  switch (wait.kind) {
    case 'person': {
      const span = spanText(t, sinceSeconds(wait.since, now));
      const name = wait.who?.kind === 'person' && wait.who.name || (wait.event === 'ceo' ? words.ceo : words.someone);
      return described(asksYou ? words.you(span) : words.person(name, span));
    }
    case 'after': return words.after(wait.reason);
    case 'review': return words.review(agent);
    case 'run': return words.run(wait.reason);
    case 'work': return words.work(wait.reason);
    case 'external': return agent ? described(words.employee(agent)) : wait.reason || words.inWork;
  }
}

/* The most important work fact, or what this person is needed for. */
export function waitText(t: Messages, task: WaitTask, now = Date.now(), personId?: string, language?: Language): string | null {
  const wait = taskWaits(task, now).find(w => personId === undefined || isWaitForPerson(w, personId));
  return wait ? waitLabel(t, task, wait, now, language) : null;
}

const field = (data: unknown, key: string): unknown => (data && typeof data === 'object' && key in data ? (data as Record<string, unknown>)[key] : undefined);

/* Whose history a line is in: a goal's or a task's. */
export type TrackerWhole = 'goal' | 'task';

/* What the tracker says of a history line of its own: a status change, an edit, or responsibility passed on, in the
   person's language. states: the words of the statuses of a task or of a goal; names: a person's name by id; whole: whose
   history it is, for an edit of what has no words of its own. Null for any other line. */
export function trackerLine(t: Messages, e: TaskLogLine, by: string, states: Record<string, string>, names: (id: string) => string | undefined, whole: TrackerWhole): string | null {
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
  return words.edited(by, words.and(...changedWords(words, fields, whole)));
}

/* What an edit changed, in words: each name by its own words, and every name without words of its own, or an edit that
   names nothing, as the goal or the task itself, said once. Never the name the code keeps it under. */
function changedWords(words: Messages['tracker']['history'], fields: unknown[], whole: TrackerWhole): string[] {
  const label = (f: unknown) => (typeof f === 'string' && Object.hasOwn(words.fields, f) ? words.fields[f] : undefined) ?? words.whole[whole];
  return fields.length ? [...new Set(fields.map(label))] : [words.whole[whole]];
}
