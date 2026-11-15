import { useId, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import { humanStatus, type Goal, type HumanStatus, type Split } from '../task-board';
import type { TaskLine } from '../types';

/* How a card opens its task and names where it is: its department or product. */
export type CardRows = { selected: string | null; onOpenTask: (id: string) => void; place: (task: TaskLine) => string };

/* The colours of a state as the task lists already draw them. */
const STATE_CLASS: Record<HumanStatus, string> = { working: 'working', review: 'review', waiting: 'waiting', paused: 'blocked', done: 'done', cancelled: 'cancelled' };

function Chevron() {
  return <svg className="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" /></svg>;
}

/* How far a task is, as a bar and in words. */
function Progress({ value }: { value: number }) {
  const t = useT();
  const percent = Math.round(value * 100);
  const label = t.tasks.board.progress(percent);
  return (
    <div className="goal-progress">
      <span className="turn-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <i style={{ width: `${percent}%` }} />
      </span>
      <small aria-hidden="true">{label}</small>
    </div>
  );
}

/* A button that shows or hides what follows it, with its state for screen readers. */
function Fold({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button className="goal-fold" type="button" aria-expanded={open} onClick={onToggle}>
      <Chevron />
      <span>{children}</span>
    </button>
  );
}

/* One task as a card: its title, what it does and why, its state in plain words, where it is, who has it and how far it
   is. The related tasks under it stay folded until one click opens them as a compact list of cards of their own, each
   with its state, holder and progress on one line. within: the place of the card a related task is in, which it names
   only when its own differs. */
export function GoalCard({ goal, rows, within }: { goal: Goal; rows: CardRows; within?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { task } = goal;
  const status = humanStatus(task);
  const place = rows.place(task);
  const related = within !== undefined;
  const Title = related ? 'h4' : 'h3';
  const progress = <Progress value={goal.progress} />;
  return (
    <article className={`goal${related ? ' sub' : ''}${rows.selected === task.id ? ' on' : ''}`} aria-label={`#${task.number} ${task.title}`}>
      <div className="goal-head">
        <Title className="goal-title">
          <button className="linkish" type="button" onClick={() => rows.onOpenTask(task.id)}>{task.title}</button>
        </Title>
        <span className="goal-no">#{task.number}</span>
      </div>
      {task.brief && <p className="goal-brief">{task.brief}</p>}
      <div className="goal-meta">
        <span className={`tstate ${STATE_CLASS[status]}`}>{t.tasks.board.statuses[status]}</span>
        {task.urgent && <span className="badge urgent">{t.tasks.board.urgent}</span>}
        {place && place !== within && <span className="badge goal-place">{place}</span>}
        {!related && <span>{task.turn === null ? t.tasks.board.outsideTurns : t.tasks.turn(task.turn)}</span>}
        <span>{task.assignee ? t.tasks.board.assignee(task.assignee.name) : t.tasks.board.noAssignee}</span>
        {related && progress}
      </div>
      {!related && progress}
      {goal.children.length > 0 && (
        <>
          <Fold open={open} onToggle={() => setOpen(!open)}>{t.tasks.board.related(goal.done, goal.total)}</Fold>
          {open && (
            <ul className="goal-subs">
              {goal.children.map(child => <li key={child.task.id}><GoalCard goal={child} rows={rows} within={place} /></li>)}
            </ul>
          )}
        </>
      )}
    </article>
  );
}

export function GoalList({ goals, rows }: { goals: Goal[]; rows: CardRows }) {
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
