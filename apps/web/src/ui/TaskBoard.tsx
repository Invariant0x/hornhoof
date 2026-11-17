import { useId, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import { askingTask, goalStatus, type Asks, type Goal, type HumanStatus, type Split } from '../task-board';
import type { TaskLine } from '../types';

/* How a card opens its task and names where it is: its department or product. asksYou: whether an open question on a task is
   the person's to answer. */
export type CardRows = { selected: string | null; onOpenTask: (id: string) => void; place: (task: TaskLine) => string; asksYou?: Asks };

/* The colours of a state as the task lists already draw them; the person's own answer in the colour of attention. */
const STATE_CLASS: Record<HumanStatus, string> = {
  notStarted: 'open', working: 'working', review: 'review', waiting: 'waiting', waitingYou: 'you', stopped: 'blocked', paused: 'blocked', done: 'done', cancelled: 'cancelled',
};

function Chevron() {
  return <svg className="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" /></svg>;
}

/* A state in plain words, marked when it waits for the person. */
function StateChip({ status }: { status: HumanStatus }) {
  const t = useT();
  return (
    <span className={`tstate ${STATE_CLASS[status]}`}>
      {status === 'waitingYou' && <b aria-hidden="true">!</b>}
      <span>{t.tasks.board.statuses[status]}</span>
    </span>
  );
}

/* How much of a whole is done, in whole goals or tasks, as a bar and in words. */
export function Progress({ done, total, label, wide = false }: { done: number; total: number; label: string; wide?: boolean }) {
  return (
    <div className={`goal-progress${wide ? ' wide' : ''}`}>
      <span className="turn-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <i style={{ inlineSize: `${total ? (done / total) * 100 : 0}%` }} />
      </span>
      <small aria-hidden="true">{label}</small>
    </div>
  );
}

/* A button that shows or hides what follows it, with its state for screen readers. */
export function Fold({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button className="goal-fold" type="button" aria-expanded={open} onClick={onToggle}>
      <Chevron />
      <span>{children}</span>
    </button>
  );
}

/* A task in one short line: its state, its title to open it and who has it. The work under it is not unfolded here, and a
   question for the person waits under what waits for them: a link opens the task with that work, or the task that asks. */
function GoalRow({ goal, rows }: { goal: Goal; rows: CardRows }) {
  const t = useT();
  const { task } = goal;
  const asking = askingTask(goal, rows.asksYou);
  return (
    <li className={`goal-row${rows.selected === task.id ? ' on' : ''}`} aria-label={`#${task.number} ${task.title}`}>
      <StateChip status={goalStatus(goal, asking !== null)} />
      <button className="linkish goal-row-title" type="button" onClick={() => rows.onOpenTask(task.id)}>{task.title}</button>
      <span className="goal-row-who">{task.assignee ? t.tasks.board.assignee(task.assignee.name) : t.tasks.board.noAssignee}</span>
      {(asking || goal.children.length > 0) && (
        <button className="linkish goal-row-open" type="button" onClick={() => rows.onOpenTask(asking?.id ?? task.id)}>{t.tasks.board.openTask}</button>
      )}
    </li>
  );
}

/* Tasks in short lines, one under another. */
export function GoalRows({ goals, rows }: { goals: Goal[]; rows: CardRows }) {
  if (!goals.length) return null;
  return <ul className="goal-rows">{goals.map(goal => <GoalRow key={goal.task.id} goal={goal} rows={rows} />)}</ul>;
}

/* One goal as a card: its title, what it does and why, its state in plain words, where it is, who has it and how many of
   its related tasks are done. A goal whose work waits for the person's answer is framed and marked, with a button to the
   task that asks; the question itself is under what waits for the person. The related tasks stay folded until one click opens them as short lines. */
function GoalCard({ goal, rows }: { goal: Goal; rows: CardRows }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { task } = goal;
  const asking = askingTask(goal, rows.asksYou);
  const status = goalStatus(goal, asking !== null);
  const place = rows.place(task);
  return (
    <article className={`goal${asking ? ' you' : ''}${rows.selected === task.id ? ' on' : ''}`} aria-label={`#${task.number} ${task.title}`}>
      <div className="goal-head">
        <h3 className="goal-title">
          <button className="linkish" type="button" onClick={() => rows.onOpenTask(task.id)}>{task.title}</button>
        </h3>
        <span className="goal-no">#{task.number}</span>
      </div>
      {task.brief && <p className="goal-brief">{task.brief}</p>}
      <div className="goal-meta">
        <StateChip status={status} />
        {task.urgent && <span className="badge urgent">{t.tasks.board.urgent}</span>}
        {place && <span className="badge goal-place">{place}</span>}
        <span>{task.turn === null ? t.tasks.board.outsideTurns : t.tasks.turn(task.turn)}</span>
        <span>{task.assignee ? t.tasks.board.assignee(task.assignee.name) : t.tasks.board.noAssignee}</span>
      </div>
      {goal.total > 0 && <Progress done={goal.done} total={goal.total} label={t.tasks.board.progress(goal.done, goal.total)} />}
      {goal.children.length > 0 && (
        <>
          <Fold open={open} onToggle={() => setOpen(!open)}>{t.tasks.board.related(goal.done, goal.total)}</Fold>
          {open && (
            <ul className="goal-subs">
              {goal.children.map(child => <GoalRow key={child.task.id} goal={child} rows={rows} />)}
            </ul>
          )}
        </>
      )}
      {asking && <button className="btn small goal-answer" type="button" onClick={() => rows.onOpenTask(asking.id)}>{t.tasks.board.openTask}</button>}
    </article>
  );
}

function GoalList({ goals, rows }: { goals: Goal[]; rows: CardRows }) {
  if (!goals.length) return null;
  return <ul className="goals">{goals.map(goal => <li key={goal.task.id}><GoalCard goal={goal} rows={rows} /></li>)}</ul>;
}

/* Goals still going, or what to say when there are none, and what is over folded under them. */
export function SplitGoals({ split, rows, empty }: { split: Split; rows: CardRows; empty?: string }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  return (
    <>
      {split.open.length ? <GoalList goals={split.open} rows={rows} /> : empty && <p className="muted">{empty}</p>}
      {split.closed.length > 0 && (
        <div className="goal-closed">
          <Fold open={shown} onToggle={() => setShown(!shown)}>{t.tasks.board.closed(split.closed.length)}</Fold>
          {shown && <GoalList goals={split.closed} rows={rows} />}
        </div>
      )}
    </>
  );
}

/* A part of the board under its own heading. folded: only the heading shows until it is opened. */
export function BoardSection({ heading, folded = false, children }: { heading: string; folded?: boolean; children: ReactNode }) {
  const id = useId();
  const [shown, setShown] = useState(!folded);
  return (
    <section className="board-section" aria-labelledby={id}>
      <h2 id={id}>{folded ? <Fold open={shown} onToggle={() => setShown(!shown)}>{heading}</Fold> : heading}</h2>
      {shown && children}
    </section>
  );
}
