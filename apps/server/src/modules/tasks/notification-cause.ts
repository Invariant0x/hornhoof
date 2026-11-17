import type { NotificationSource } from '@hornhoof/protocol';
import type { TaskEventKind } from '../../db/schema.js';
import type { Actor, Task, Wake } from './engine.js';

/* Kept with the move, rather than inferred from a newer task log at delivery time. */
export type WakeCause = {
  actor?: Actor;
  actors?: Actor[];
  action?: string;
  source?: NotificationSource;
  eventId?: number;
  task?: { id: string; number: number };
  report?: string;
  wait?: { setter: string; until: string };
};

type ActionNote = { kind: TaskEventKind; actor: Actor; text?: string; data?: Record<string, unknown>; automatic?: NotificationSource };
const ACTIONS: Partial<Record<TaskEventKind, string>> = {
  created: 'assigned work', assigned: 'assigned work', submitted: 'handed in work', report: 'reported work done', cancelled: 'cancelled work',
  blocked: 'blocked work', updated: 'rewrote work', comment: 'commented', verdict: 'reviewed work', asked: 'asked people',
};
const AUTOMATIC = new Set(['reminder', 'go_on', 'wait_ended', 'tests', 'work', 'calls', 'turn']);

function answerAction(note: ActionNote): string {
  const status = note.data?.status;
  if (status === 'approved') return `approved ${String(note.data?.commit)}`;
  if (status === 'declined') return `declined ${String(note.data?.commit)}`;
  return 'answered';
}

function actionOf(note: ActionNote): string | undefined {
  if (note.kind === 'answered') return answerAction(note);
  if (note.kind === 'verdict' && note.data?.pass === false) return note.data.wrongGoal === true ? 'escalated work' : 'kept work for repair';
  if (note.kind === 'report' && note.data?.done === false) return 'reported blocked work';
  return ACTIONS[note.kind];
}

function waitCause(task: Task): WakeCause['wait'] {
  return task.externalWait && task.assigneeAgentId ? { setter: task.assigneeAgentId, until: task.externalWait.until } : undefined;
}

function causeOf(wake: Wake, note: ActionNote, eventId: number, task: Task): WakeCause {
  const cause: WakeCause = { eventId, task: { id: task.id, number: task.number } };
  if (note.automatic) return { ...cause, source: note.automatic };
  const action = actionOf(note);
  if (action && !AUTOMATIC.has(wake.why)) Object.assign(cause, { actor: note.actor, action });
  if (note.kind === 'submitted' || note.kind === 'report') cause.report = note.text?.trim();
  if (wake.why === 'wait_ended') cause.wait = waitCause(task);
  return cause;
}

export function recordCause(wakes: Wake[], note: ActionNote, eventId: number, task: Task): void {
  for (const wake of wakes) {
    if (wake.cause) continue;
    const cause = causeOf(wake, note, eventId, task);
    if (cause.actor || cause.report || cause.wait || cause.source) wake.cause = cause;
  }
}
