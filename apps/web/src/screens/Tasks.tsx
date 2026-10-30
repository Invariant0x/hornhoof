import { useState } from 'react';
import { deptLabel, errorText, useT } from '../i18n';
import { useOrg } from '../org';
import { placeName, useTasks, useTurns } from '../tasks';
import type { Me, TaskLine, TaskStatus, TurnView, WaitingRequest } from '../types';
import { Field } from '../ui/Field';
import { Requests } from '../ui/Requests';
import { TaskRow } from '../ui/TaskRow';

type Props = {
  me: Me;
  requests: WaitingRequest[] | undefined;
  onRequestsChanged: () => void;
  selected: string | null;
  onOpenTask: (id: string) => void;
  /* Only for people who see the whole company: they are the ones who write to him. */
  onOpenOrchestrator?: () => void;
};

const CLOSED: TaskStatus[] = ['done', 'cancelled'];

type Rows = { selected: string | null; onOpenTask: (id: string) => void; place: (task: TaskLine) => string };

/* Tasks under the task they serve, in the order they were laid out; a task whose parent is not listed stands at the top. */
function TaskTree({ tasks, rows, under = null }: { tasks: TaskLine[]; rows: Rows; under?: string | null }) {
  const ids = new Set(tasks.map(x => x.id));
  const level = tasks.filter(x => (under ? x.parentId === under : !x.parentId || !ids.has(x.parentId))).sort((a, b) => a.number - b.number);
  if (!level.length) return null;
  return (
    <ul className={under ? 'ttree sub' : 'ttree'}>
      {level.map(task => (
        <li key={task.id}>
          <TaskRow task={task} on={rows.selected === task.id} place={rows.place(task)} onOpen={rows.onOpenTask} showTurn={false} />
          <TaskTree tasks={tasks} rows={rows} under={task.id} />
        </li>
      ))}
    </ul>
  );
}

/* One turn: its number and state, the short title and main point, the words it came from on click, then its tasks. */
function Turn({ turn, tasks, rows }: { turn: TurnView; tasks: TaskLine[]; rows: Rows }) {
  const t = useT();
  const share = turn.tasks.total ? Math.round((turn.tasks.done / turn.tasks.total) * 100) : 0;
  const head = (
    <>
      <div className="turn-name">
        <span className="turn-no">
          <b>{t.tasks.turn(turn.number)}</b>
          <span className={`turn-state ${turn.status}`}>{t.tasks.turnStates[turn.status]}</span>
        </span>
        <h2>{turn.title}</h2>
        {turn.goal && turn.goal !== turn.title && <p>{turn.goal}</p>}
      </div>
      {turn.status === 'planned' ? (
        <small className="turn-wait">{t.tasks.plannedTasks(turn.tasks.total)}</small>
      ) : (
        <div className="turn-progress">
          <span className="turn-track" aria-hidden="true">
            <i style={{ width: `${share}%` }} />
          </span>
          <small>{t.tasks.turnProgress(turn.tasks.done, turn.tasks.total)}</small>
        </div>
      )}
    </>
  );
  const body = (
    <>
      {turn.messages.length > 0 && (
        <details className="turn-words">
          <summary>{t.tasks.words(turn.messages.length)}</summary>
          {turn.messages.map((m, i) => (
            <blockquote key={`${i}-${m.at}`}>
              <cite>{m.by}</cite>
              <p>{m.text}</p>
            </blockquote>
          ))}
        </details>
      )}
      <TaskTree tasks={tasks} rows={rows} />
    </>
  );
  if (turn.status === 'closed') {
    return (
      <details className="turn closed" aria-label={t.tasks.turn(turn.number)}>
        <summary className="turn-head">{head}</summary>
        {body}
      </details>
    );
  }
  return (
    <section className={`turn ${turn.status}`} aria-label={t.tasks.turn(turn.number)}>
      <header className="turn-head">{head}</header>
      {body}
    </section>
  );
}

/* The tracker shows the work and changes nothing by itself: what waits for the person, then the turns as the orchestrator
   laid them out, the running one first, the planned ones in order and the finished ones folded away. */
export function Tasks({ me, requests, onRequestsChanged, selected, onOpenTask, onOpenOrchestrator }: Props) {
  const t = useT();
  const { org } = useOrg();
  const [department, setDepartment] = useState<string | null>(null);
  const { tasks, failure } = useTasks({ status: 'all', department });
  const { turns, failure: turnsFailure } = useTurns();
  const place = (p: TaskLine['department']) => placeName(t, org, p);
  const rows: Rows = { selected, onOpenTask, place: task => [place(task.department), task.product?.name].filter(Boolean).join(' / ') };
  const of = (turn: TurnView) => tasks?.filter(x => x.turn === turn.number) ?? [];
  const running = turns?.filter(x => x.status === 'open') ?? [];
  const planned = turns?.filter(x => x.status === 'planned') ?? [];
  const finished = turns?.filter(x => x.status === 'closed').reverse() ?? [];
  const outside = tasks?.filter(x => x.turn === null && !CLOSED.includes(x.status)) ?? [];
  const outsideClosed = tasks?.filter(x => x.turn === null && CLOSED.includes(x.status)) ?? [];
  const broken = failure ?? turnsFailure;

  return (
    <section className="tasks">
      <header className="people-head">
        <div>
          <h1>{t.tasks.heading}</h1>
          <p className="muted">{t.tasks.intro}</p>
        </div>
        {onOpenOrchestrator && (
          <button className="btn" type="button" onClick={onOpenOrchestrator}>
            {t.tasks.writeOrchestrator}
          </button>
        )}
      </header>

      <section className="waiting" aria-label={t.tasks.waiting}>
        <h2>{t.tasks.waiting}</h2>
        {requests?.length ? (
          <Requests requests={requests} onChanged={onRequestsChanged} company={me.person.scopeKind === 'company'} onOpenTask={onOpenTask} placeName={place} />
        ) : (
          requests && <p className="muted">{t.tasks.nothingWaiting}</p>
        )}
      </section>

      {!!org?.departments.length && (
        <div className="task-filters">
          <Field label={t.tasks.department}>
            {p => (
              <select {...p} value={department ?? ''} onChange={e => setDepartment(e.target.value || null)}>
                <option value="">{t.tasks.allDepartments}</option>
                {org.departments.map(d => (
                  <option key={d.id} value={d.id}>
                    {deptLabel(t, d)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      )}

      {broken !== null && <p className="alert" role="alert">{errorText(t, broken)}</p>}
      {turns && !turns.length && !outside.length && <p className="muted">{t.tasks.noTurns}</p>}

      {running.map(turn => (
        <Turn key={turn.id} turn={turn} tasks={of(turn)} rows={rows} />
      ))}

      {planned.length > 0 && (
        <section className="turns" aria-label={t.tasks.nextTurns}>
          <h2>{t.tasks.nextTurns}</h2>
          {planned.map(turn => (
            <Turn key={turn.id} turn={turn} tasks={of(turn)} rows={rows} />
          ))}
        </section>
      )}

      {outside.length > 0 && (
        <section className="turns" aria-label={t.tasks.outsideTurns}>
          <h2>{t.tasks.outsideTurns}</h2>
          <TaskTree tasks={outside} rows={rows} />
        </section>
      )}

      {finished.length > 0 && (
        <section className="turns" aria-label={t.tasks.finishedTurns}>
          <h2>{t.tasks.finishedTurns}</h2>
          {finished.map(turn => (
            <Turn key={turn.id} turn={turn} tasks={of(turn)} rows={rows} />
          ))}
        </section>
      )}

      {outsideClosed.length > 0 && (
        <details className="turns folded">
          <summary>{t.tasks.closedOutside(outsideClosed.length)}</summary>
          <TaskTree tasks={outsideClosed} rows={rows} />
        </details>
      )}
    </section>
  );
}
