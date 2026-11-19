import { useRef, useState } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT, type Messages } from '../i18n';
import { mapPeople, useOrg } from '../org';
import { RouteUnavailable, unavailableFailure } from '../screens/RouteUnavailable';
import { useGoal, useGoals, useTasks } from '../tasks';
import { humanStatus } from '../task-tree';
import type { GoalView, TaskLogLine } from '../types';
import { PanelFrame } from './SidePanels';
import { STATE_CLASS, WaitLine } from './TaskActivity';
import { Answers, CardBar, CardPath, Fact, goalChain, StatusPill, useEscapeCloses } from './TaskPanel';
import { GoalForm } from './TrackerForms';
import { dueText, momentText, trackerLine } from './tracker-words';

/* A goal's status as the colour of a task's: active as in work, reached as done, dropped as cancelled. */
export const GOAL_CLASS = { active: 'working', reached: 'done', dropped: 'cancelled' } as const;

/* How far a goal is: its number against its target, or else its tasks done; nothing when it has neither. */
export function goalProgress(t: Messages, goal: GoalView): { done: number; total: number; label: string } | null {
  if (goal.target !== null) {
    const now = goal.current ?? 0;
    return { done: Math.min(now, goal.target), total: goal.target, label: t.tracker.card.target(now, goal.target, goal.unit) };
  }
  return goal.total > 0 ? { done: goal.done, total: goal.total, label: t.tracker.card.tasksDone(goal.done, goal.total) } : null;
}

/* A goal's history: it was set, changed, reached or dropped, and passed on to someone else. */
function GoalHistory({ log }: { log: TaskLogLine[] }) {
  const t = useT();
  const { language } = useLanguage();
  const { org } = useOrg();
  const people = mapPeople(org);
  const names = (id: string) => people.find(p => p.id === id)?.name;
  if (!log.length) return null;
  return (
    <section className="tp-sec">
      <h3>{t.tracker.card.history}</h3>
      <ol className="tp-log" aria-label={t.tracker.card.history}>
        {log.map((e, i) => {
          const by = e.by?.name ?? t.window.hornhoof;
          const line = e.kind === 'created' ? t.tracker.history.goalCreated(by) : trackerLine(t, e, by, t.tracker.goal.statuses, names, 'goal');
          return (
            <li key={i} className={e.kind}>
              <span className="tp-ev" dir="auto">{line ?? by} <time dateTime={e.at}>{momentText(language, e.at)}</time></span>
              {line === null && e.text && <p dir="auto">{e.text}</p>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* Reached, dropped, or open again, said by whoever sets the goal. */
function GoalStatusActions({ goal, onChanged }: { goal: GoalView; onChanged: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const sending = useRef(false);
  async function put(status: GoalView['status']) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await api.put(`/api/goals/${goal.id}/status`, { status, version: goal.version });
      onChanged();
    } catch (err) {
      setFailure(err);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  const words = t.tracker.card;
  return (
    <div className="ac-actions">
      <div className="entry-actions" role="group" aria-label={goal.title}>
        {goal.status === 'active' ? (
          <>
            <button className="btn ghost" type="button" disabled={busy} onClick={() => void put('reached')}>{words.reach}</button>
            <button className="btn ghost" type="button" disabled={busy} onClick={() => void put('dropped')}>{words.drop}</button>
          </>
        ) : (
          <button className="btn ghost" type="button" disabled={busy} onClick={() => void put('active')}>{words.reopen}</button>
        )}
      </div>
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </div>
  );
}

type Props = {
  goalId: string;
  kind?: string;
  active?: boolean;
  onClose: () => void;
  onHome?: () => void;
  onOpen: (taskId: string) => void;
  onOpenGoal: (goalId: string) => void;
  onGraph?: (root: { goal: string }) => void;
};

function GoalBody({ goal, log, onOpen, onOpenGoal, onGraph, onChanged }: Omit<Props, 'goalId' | 'kind' | 'active' | 'onClose' | 'onHome'> & { goal: GoalView; log: TaskLogLine[]; onChanged: () => void }) {
  const t = useT();
  const { language } = useLanguage();
  const { goals } = useGoals();
  const { tasks } = useTasks({ status: 'all' });
  const [editing, setEditing] = useState(false);
  const words = t.tracker.card;
  /* Who sets a goal is the server's word. */
  const mayEdit = !!goal.mayEdit;
  const smaller = (goals ?? []).filter(g => g.parentId === goal.id && g.status !== 'dropped').sort((a, b) => a.number - b.number);
  const ids = new Set((tasks ?? []).map(task => task.id));
  const serving = (tasks ?? []).filter(task => task.goal?.id === goal.id && (!task.parentId || !ids.has(task.parentId)) && task.status !== 'cancelled').sort((a, b) => a.number - b.number);
  const due = dueText(t, language, { dueAt: goal.dueAt, status: goal.status === 'active' ? 'open' : 'done' });
  const progress = goalProgress(t, goal);
  const reached = smaller.filter(g => g.status === 'reached').length + serving.filter(task => task.status === 'done').length;
  return (
    <>
      <header className="tp-head">
        <CardPath goals={goalChain(goal.parentId, goals)} onOpenGoal={onOpenGoal} onOpen={onOpen} />
        <p className="tp-kind" dir="auto">{goal.department ? words.kinds.goal(goal.department.name) : words.kinds.companyGoal}</p>
        <h2 className="tp-heading" dir="auto">{goal.title}</h2>
        <p className="tp-state"><StatusPill state={GOAL_CLASS[goal.status]}>{t.tracker.goal.statuses[goal.status]}</StatusPill></p>
        {goal.why && <p className="tp-why" dir="auto">{goal.why}</p>}
        {progress && <CardBar {...progress} />}
      </header>
      <div role="group" aria-label={words.facts}>
        <dl className="tp-card-facts">
          <Fact name={words.responsible}><Answers person={goal.responsible} /></Fact>
          {progress ? <Fact name={words.progress}>{progress.label}{due && ` · ${t.tracker.graph.until(due.text)}`}</Fact>
            : due && <Fact name={words.due}><span className={due.late ? 'tp-late' : undefined} dir="auto">{due.text}</span></Fact>}
        </dl>
      </div>
      {(onGraph || (mayEdit && !editing)) && (
        <div className="tp-acts">
          {onGraph && <button className="gbtn" type="button" onClick={() => onGraph({ goal: goal.id })}><span aria-hidden="true">⑂</span>{words.graphFromHere}</button>}
          {mayEdit && !editing && <button className="gbtn" type="button" onClick={() => setEditing(true)}>{words.edit}</button>}
        </div>
      )}
      {mayEdit && editing && <GoalForm goal={goal} department={goal.department} onCancel={() => setEditing(false)} onDone={() => { setEditing(false); onChanged(); }} onReload={onChanged} />}
      <section className="tp-sec" aria-label={words.under}>
        <h3>{words.underCount(reached, smaller.length + serving.length)}</h3>
        {smaller.length + serving.length ? (
          <ul className="tp-rows">
            {smaller.map(g => (
              <li className="tp-row" key={g.id}>
                <button className="linkish tp-link" type="button" dir="auto" onClick={() => onOpenGoal(g.id)}><span className={`tr-status-dot ${GOAL_CLASS[g.status]}`} aria-hidden="true" />{g.title}</button>
                <small>{t.tracker.goal.statuses[g.status]}</small>
              </li>
            ))}
            {serving.map(task => (
              <li className="tp-row" key={task.id}>
                <button className="linkish tp-link" type="button" dir="auto" onClick={() => onOpen(task.id)}><span className={`tr-status-dot ${STATE_CLASS[humanStatus(task)]}`} aria-hidden="true" />#{task.number} {task.title}</button>
                <small>{t.tracker.groups[humanStatus(task)]}</small>
                <WaitLine task={task} />
              </li>
            ))}
          </ul>
        ) : tasks && <p className="muted" dir="auto">{words.noTasks}</p>}
      </section>
      <GoalHistory log={log} />
      {mayEdit && <GoalStatusActions goal={goal} onChanged={onChanged} />}
    </>
  );
}

/* A goal in the same side panel as a task: where it belongs, why, how far it is, its smaller goals and its tasks. */
export function GoalPanel({ goalId, kind, active = true, onClose, onHome, ...rest }: Props) {
  const t = useT();
  const { goal, log, failure, load } = useGoal(goalId);
  useEscapeCloses(onClose, active);
  return (
    <PanelFrame label={goal?.title ?? t.tracker.graph.goal} heading={t.tracker.graph.goal} plain busy={!goal && failure === null} kind={kind} onClose={onClose}>
      {failure !== null && (unavailableFailure(failure) ? <RouteUnavailable onHome={onHome} /> : <p className="alert" role="alert" dir="auto">{errorText(t, failure)}</p>)}
      {goal && !unavailableFailure(failure) && <GoalBody goal={goal} log={log ?? []} onChanged={load} {...rest} />}
    </PanelFrame>
  );
}
