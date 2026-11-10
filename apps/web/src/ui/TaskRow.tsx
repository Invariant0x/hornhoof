import { useT } from '../i18n';
import type { TaskLine, TaskStatus } from '../types';
import { stageName } from './stage-name';

/* What needs people first, then what moves, then what has not started and what waits for its turn; closed tasks after. */
export const ORDER: TaskStatus[] = ['waiting', 'blocked', 'review', 'working', 'open', 'planned', 'done', 'cancelled'];

/* Tasks in that order, the newest first within a state. */
export const byState = (a: TaskLine, b: TaskLine) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.number - a.number;

/* One task in a list: number and title, its brief, and where it stands. place names its department or product; a list
   grouped by turns leaves the turn out. */
export function TaskRow({ task, on, place, onOpen, showTurn = true }: { task: TaskLine; on: boolean; place: string; onOpen: (id: string) => void; showTurn?: boolean }) {
  const t = useT();
  const workflow = task.echelons;
  const owner = workflow.ownerAgentId;
  const ownerName = task.assignee?.id === owner ? task.assignee.name : owner;
  return (
    <button className={`trow${on ? ' on' : ''}`} type="button" onClick={() => onOpen(task.id)}>
      <span className="trow-title">
        <b>#{task.number}</b> {task.title}
      </span>
      {task.brief && <span className="trow-brief">{task.brief}</span>}
      <span className="trow-meta">
        <span className={`tstate ${task.status}`}>{t.tasks.states[task.status]}</span>
        {place}
        {ownerName && <span>{t.tasks.echelons.owner(ownerName)}</span>}
        <span className="trow-gate">{workflow.stage ? stageName(t, workflow, workflow.stage) : t.tasks.echelons.coordination}</span>
        {showTurn && task.turn !== null && <span>{t.tasks.turn(task.turn)}</span>}
      </span>
    </button>
  );
}
