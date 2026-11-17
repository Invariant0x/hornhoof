import { useRef, useState } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT } from '../i18n';
import { mapPeople, useOrg } from '../org';
import { RouteUnavailable, unavailableFailure } from '../screens/RouteUnavailable';
import { useGoal, useGoals, useTasks } from '../tasks';
import type { GoalView, TaskLogLine } from '../types';
import { PanelFrame } from './SidePanels';
import { Progress } from './TaskBoard';
import { CardPath, DueDay, Fact, goalChain, useEscapeCloses } from './TaskPanel';
import { GoalForm } from './TrackerForms';
import { dueText, momentText, trackerLine } from './tracker-words';

/* How far a goal is: its number against its target, or else its tasks done. */
function GoalProgress({ goal }: { goal: GoalView }) {
  const t = useT();
  if (goal.target !== null) {
    const now = goal.current ?? 0;
    return <Progress done={Math.min(now, goal.target)} total={goal.target} label={t.tracker.card.target(now, goal.target, goal.unit)} wide />;
  }
  return goal.total > 0 ? <Progress done={goal.done} total={goal.total} label={t.tracker.card.tasksDone(goal.done, goal.total)} wide /> : null;
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
    <section>
      <h4>{t.tracker.card.history}</h4>
      <ol className="tp-log" aria-label={t.tracker.card.history}>
        {log.map((e, i) => {
          const by = e.by?.name ?? t.window.hornhoof;
          const line = e.kind === 'created' ? t.tracker.history.goalCreated(by) : trackerLine(t, e, by, t.tracker.goal.statuses, names);
          return (
            <li key={i} className={e.kind}>
              <span className="tp-ev">{line ?? by} <time dateTime={e.at}>{momentText(language, e.at)}</time></span>
              {line === null && e.text && <p>{e.text}</p>}
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
  return (
    <>
      <CardPath goals={goalChain(goal.parentId, goals)} onOpenGoal={onOpenGoal} onOpen={onOpen} />
      <header className="ac-head">
        <p className="muted tp-type">{goal.department ? words.kinds.goal(goal.department.name) : words.kinds.companyGoal}</p>
        <h3>{goal.title}</h3>
        <p className="tp-state"><span className={`tstate ${goal.status === 'reached' ? 'done' : goal.status === 'active' ? 'working' : ''}`}>{t.tracker.goal.statuses[goal.status]}</span></p>
      </header>
      {goal.why && (
        <section className="tp-why" aria-label={words.why}>
          <h4>{words.why}</h4>
          <p dir="auto">{goal.why}</p>
        </section>
      )}
      <GoalProgress goal={goal} />
      <dl className="facts tp-facts" aria-label={words.facts}>
        <Fact name={words.responsible}>{goal.responsible.name}</Fact>
        {due && <Fact name={words.due}><DueDay due={due} /></Fact>}
      </dl>
      {(onGraph || (mayEdit && !editing)) && (
        <div className="entry-actions tp-leads">
          {onGraph && <button className="btn ghost" type="button" onClick={() => onGraph({ goal: goal.id })}>{words.graphFromHere}</button>}
          {mayEdit && !editing && <button className="btn ghost" type="button" onClick={() => setEditing(true)}>{words.edit}</button>}
        </div>
      )}
      {mayEdit && editing && <GoalForm goal={goal} department={goal.department} onCancel={() => setEditing(false)} onDone={() => { setEditing(false); onChanged(); }} onReload={onChanged} />}
      {smaller.length > 0 && (
        <section aria-label={words.smallerGoals}>
          <h4>{words.smallerGoals}</h4>
          <ul className="tp-subs">
            {smaller.map(g => (
              <li key={g.id}>
                <button className="linkish" type="button" onClick={() => onOpenGoal(g.id)}>{g.title}</button>
                <small>{t.tracker.goal.statuses[g.status]}</small>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label={words.tasks}>
        <h4>{words.tasks}</h4>
        {serving.length ? (
          <ul className="tp-subs">
            {serving.map(task => (
              <li key={task.id}>
                <button className="linkish" type="button" onClick={() => onOpen(task.id)}>#{task.number} {task.title}</button>
                <small>{t.tasks.states[task.status]}</small>
              </li>
            ))}
          </ul>
        ) : tasks && <p className="muted">{words.noTasks}</p>}
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
    <PanelFrame label={goal?.title ?? t.tracker.graph.goal} heading={t.tracker.graph.goal} busy={!goal && failure === null} kind={kind} onClose={onClose}>
      {failure !== null && (unavailableFailure(failure) ? <RouteUnavailable onHome={onHome} /> : <p className="alert" role="alert">{errorText(t, failure)}</p>)}
      {goal && !unavailableFailure(failure) && <GoalBody goal={goal} log={log ?? []} onChanged={load} {...rest} />}
    </PanelFrame>
  );
}
