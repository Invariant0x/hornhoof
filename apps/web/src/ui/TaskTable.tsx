import { useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import type { TaskLine } from '../types';
import { Edge } from './Edge';
import { TaskRow } from './TaskRow';
import { stageName } from './stage-name';

/* A group of rows: a turn, the tasks given outside turns or what a search found. A folded group shows only its head until
   it is opened. found: the tasks stay in the order given, flat, as a search ranks them; otherwise by number in trees. */
export type TaskGroup = { key: string; head: ReactNode; tasks: TaskLine[]; folded?: boolean; empty?: string; found?: boolean };

/* all: every task of the table's department, for the subtasks of a row. */
type Rows = { all: TaskLine[]; selected: string | null; onOpenTask: (id: string) => void; place: (task: TaskLine) => string };

const COLUMNS = 4;
const byNumber = (a: TaskLine, b: TaskLine) => a.number - b.number;
const under = (all: TaskLine[], id: string) => all.filter(x => x.parentId === id).sort(byNumber);

/* The work under a task, each one opening in the task panel. */
function Subtasks({ tasks, rows }: { tasks: TaskLine[]; rows: Rows }) {
  if (!tasks.length) return null;
  return (
    <ul className="ttree sub">
      {tasks.map(task => (
        <li key={task.id}>
          <TaskRow task={task} on={rows.selected === task.id} place={rows.place(task)} onOpen={rows.onOpenTask} showTurn={false} />
          <Subtasks tasks={under(rows.all, task.id)} rows={rows} />
        </li>
      ))}
    </ul>
  );
}

/* What an opened row shows: its brief and what it waits for, the way to the whole task, and the work under it. */
function TaskSummary({ task, rows }: { task: TaskLine; rows: Rows }) {
  const t = useT();
  const subs = under(rows.all, task.id);
  return (
    <div className="task-sum">
      {task.brief && <p>{task.brief}</p>}
      {task.waitsFor.length > 0 && <p className="muted">{t.tasks.waitsFor(task.waitsFor.map(n => `#${n}`).join(', '))}</p>}
      <div className="entry-actions">
        <button className="btn small ghost" type="button" onClick={() => rows.onOpenTask(task.id)}>{t.tasks.table.open}</button>
      </div>
      {subs.length > 0 && (
        <section aria-label={t.tasks.subtasks}>
          <h3>{t.tasks.subtasks}</h3>
          <Subtasks tasks={subs} rows={rows} />
        </section>
      )}
    </div>
  );
}

function TaskTableRow({ task, rows }: { task: TaskLine; rows: Rows }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const name = `#${task.number} ${task.title}`;
  const place = rows.place(task);
  const stage = task.echelons.stage ? stageName(t, task.echelons, task.echelons.stage) : t.tasks.echelons.coordination;
  return (
    <>
      <tr className={`rm${open ? ' open' : ''}${rows.selected === task.id ? ' on' : ''}`} aria-label={name} onClick={() => { if (!window.getSelection()?.toString()) setOpen(!open); }}>
        <td className="k-name">
          <button className="rowbtn" type="button" aria-expanded={open} aria-label={t.tables.openCard(name)}>
            <svg className="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" /></svg>
            <span className="nm"><b>#{task.number} {task.title}</b>{place && <small>{place}</small>}</span>
          </button>
        </td>
        <td className="k-status"><span className={`tstate ${task.status}`}>{t.tasks.states[task.status]}</span></td>
        <td data-label={t.tasks.table.stage}>{stage}</td>
        <td data-label={t.tasks.table.holder}>{task.assignee?.name ?? t.tasks.nobody}</td>
      </tr>
      {open && <tr className="det"><td colSpan={COLUMNS}><TaskSummary task={task} rows={rows} /></td></tr>}
    </>
  );
}

/* One group: its head across the table, then its tasks at the top of their trees. */
function Group({ group, rows }: { group: TaskGroup; rows: Rows }) {
  const [shown, setShown] = useState(!group.folded);
  const ids = new Set(group.tasks.map(x => x.id));
  const top = group.found ? group.tasks : group.tasks.filter(x => !x.parentId || !ids.has(x.parentId)).sort(byNumber);
  return (
    <tbody>
      <tr className="grp">
        <th colSpan={COLUMNS} scope="colgroup">
          {group.folded ? (
            <button className="grp-toggle" type="button" aria-expanded={shown} onClick={() => setShown(!shown)}>
              <svg className="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" /></svg>
              {group.head}
            </button>
          ) : group.head}
        </th>
      </tr>
      {shown && top.map(task => <TaskTableRow key={task.id} task={task} rows={rows} />)}
      {shown && !top.length && group.empty && <tr className="grp-empty"><td colSpan={COLUMNS}>{group.empty}</td></tr>}
    </tbody>
  );
}

/* The tasks of one department as a table: one row a task, grouped by turn, a row opening to its details and subtasks. */
export function TaskTable({ label, groups, ...rows }: Rows & { label: string; groups: TaskGroup[] }) {
  const t = useT();
  if (!groups.length) return null;
  return (
    <Edge className="tbl-frame"><div className="tbl">
      <table className="dt task-table" aria-label={label}>
        <thead><tr>
          <th scope="col">{t.tasks.table.task}</th>
          <th scope="col">{t.tasks.table.state}</th>
          <th scope="col">{t.tasks.table.stage}</th>
          <th scope="col">{t.tasks.table.holder}</th>
        </tr></thead>
        {groups.map(group => <Group key={group.key} group={group} rows={rows} />)}
      </table>
    </div></Edge>
  );
}
