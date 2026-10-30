import { useLanguage, useT } from '../i18n';
import { roleAfter } from '../tasks';
import type { TaskLine, TaskStatus } from '../types';

/* What needs people first, then what moves, then what has not started; closed tasks after. */
export const ORDER: TaskStatus[] = ['waiting', 'blocked', 'review', 'working', 'open', 'done', 'cancelled'];

/* Tasks in that order, the newest first within a state. */
export const byState = (a: TaskLine, b: TaskLine) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.number - a.number;

/* One task in a list: number and title, its brief, and where it stands. place names its department or product. */
export function TaskRow({ task, on, place, onOpen }: { task: TaskLine; on: boolean; place: string; onOpen: (id: string) => void }) {
  const t = useT();
  const { language } = useLanguage();
  return (
    <button className={`trow${on ? ' on' : ''}`} type="button" onClick={() => onOpen(task.id)}>
      <span className="trow-title">
        <b>#{task.number}</b> {task.title}
      </span>
      {task.brief && <span className="trow-brief">{task.brief}</span>}
      <span className="trow-meta">
        {place}
        {task.assignee && (
          <span>
            {task.assignee.name}
            {roleAfter(task.assignee, language)}
          </span>
        )}
        {task.status === 'review' && task.stage > 0 && <span className="trow-gate">{t.tasks.gateOf(task.stage, task.gateCount)}</span>}
        {task.bounces > 0 && <span className="trow-back">{t.tasks.sentBack(task.bounces)}</span>}
        {task.turn !== null && <span>{t.tasks.turn(task.turn)}</span>}
      </span>
    </button>
  );
}
