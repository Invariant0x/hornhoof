import { useLanguage, useT, type Messages } from '../i18n';
import { roleAfter } from '../tasks';
import type { Lang, TaskLine, TaskStatus } from '../types';

/* What needs people first, then what moves, then what has not started and what waits for its turn; closed tasks after. */
export const ORDER: TaskStatus[] = ['waiting', 'blocked', 'review', 'working', 'open', 'planned', 'done', 'cancelled'];

/* Tasks in that order, the newest first within a state. */
export const byState = (a: TaskLine, b: TaskLine) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.number - a.number;

function stageText(task: TaskLine, t: Messages): string | null {
  if (task.echelons) return t.tasks.echelons.stages[task.echelons.stage];
  return task.status === 'review' && task.stage > 0 ? t.tasks.gateOf(task.stage, task.gateCount) : null;
}

function ownerText(task: TaskLine, language: keyof Lang, t: Messages): string | null {
  if (!task.echelons) return task.assignee ? `${task.assignee.name}${roleAfter(task.assignee, language)}` : null;
  const id = task.echelons.ownerAgentId;
  if (!id) return null;
  const name = task.assignee?.id === id ? task.assignee.name : id;
  return t.tasks.echelons.owner(name);
}

/* One task in a list: number and title, its brief, and where it stands. place names its department or product; a list
   grouped by turns leaves the turn out. */
export function TaskRow({ task, on, place, onOpen, showTurn = true }: { task: TaskLine; on: boolean; place: string; onOpen: (id: string) => void; showTurn?: boolean }) {
  const t = useT();
  const { language } = useLanguage();
  const owner = ownerText(task, language, t);
  const stage = stageText(task, t);
  return (
    <button className={`trow${on ? ' on' : ''}`} type="button" onClick={() => onOpen(task.id)}>
      <span className="trow-title">
        <b>#{task.number}</b> {task.title}
      </span>
      {task.brief && <span className="trow-brief">{task.brief}</span>}
      <span className="trow-meta">
        <span className={`tstate ${task.status}`}>{t.tasks.states[task.status]}</span>
        {place}
        {owner && <span>{owner}</span>}
        {stage && <span className="trow-gate">{stage}</span>}
        {task.bounces > 0 && <span className="trow-back">{t.tasks.sentBack(task.bounces)}</span>}
        {showTurn && task.turn !== null && <span>{t.tasks.turn(task.turn)}</span>}
      </span>
    </button>
  );
}
