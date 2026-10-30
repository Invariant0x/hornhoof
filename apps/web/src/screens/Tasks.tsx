import { useState } from 'react';
import { deptLabel, errorText, useLanguage, useT } from '../i18n';
import { useOrg } from '../org';
import { placeName, useTasks, type TaskFilter } from '../tasks';
import type { Me, TaskLine, TaskStatus, WaitingRequest } from '../types';
import { Field } from '../ui/Field';
import { Requests } from '../ui/Requests';
import { TurnBar } from '../ui/TurnBar';

/* What needs people first, then what moves, then what has not started; closed tasks after. */
const ORDER: TaskStatus[] = ['waiting', 'blocked', 'review', 'working', 'open', 'done', 'cancelled'];

type Props = {
  me: Me;
  requests: WaitingRequest[] | undefined;
  onRequestsChanged: () => void;
  selected: string | null;
  onOpenTask: (id: string) => void;
};

/* The tracker: the company's turn, what waits for the person, and every task they reach, by state. */
export function Tasks({ me, requests, onRequestsChanged, selected, onOpenTask }: Props) {
  const t = useT();
  const { language } = useLanguage();
  const { org } = useOrg();
  const [filter, setFilter] = useState<TaskFilter>({ status: 'open', department: null });
  const { tasks, failure } = useTasks(filter);
  const place = (p: TaskLine['department']) => placeName(t, org, p);

  const row = (task: TaskLine) => (
    <li key={task.id}>
      <button className={`trow${selected === task.id ? ' on' : ''}`} type="button" onClick={() => onOpenTask(task.id)}>
        <span className="trow-title">
          <b>#{task.number}</b> {task.title}
        </span>
        {task.brief && <span className="trow-brief">{task.brief}</span>}
        <span className="trow-meta">
          {[place(task.department), task.product?.name].filter(Boolean).join(' / ')}
          {task.assignee && <span>{task.assignee.name}{task.assignee.role ? `, ${task.assignee.role[language]}` : ''}</span>}
          {task.status === 'review' && task.stage > 0 && <span className="trow-gate">{t.tasks.gateOf(task.stage, task.gateCount)}</span>}
          {task.bounces > 0 && <span className="trow-back">{t.tasks.sentBack(task.bounces)}</span>}
          {task.turn !== null && <span>{t.tasks.turn(task.turn)}</span>}
        </span>
      </button>
    </li>
  );

  return (
    <section className="tasks">
      <header className="people-head">
        <div>
          <h1>{t.tasks.heading}</h1>
          <p className="muted">{t.tasks.intro}</p>
        </div>
      </header>

      <TurnBar company={me.person.scopeKind === 'company'} />

      <section className="waiting" aria-label={t.tasks.waiting}>
        <h2>{t.tasks.waiting}</h2>
        {requests?.length ? (
          <Requests requests={requests} onChanged={onRequestsChanged} onOpenTask={onOpenTask} placeName={place} />
        ) : (
          requests && <p className="muted">{t.tasks.nothingWaiting}</p>
        )}
      </section>

      <div className="task-filters">
        <Field label={t.tasks.department}>
          {p => (
            <select {...p} value={filter.department ?? ''} onChange={e => setFilter({ ...filter, department: e.target.value || null })}>
              <option value="">{t.tasks.allDepartments}</option>
              {org?.departments.map(d => (
                <option key={d.id} value={d.id}>
                  {deptLabel(t, d)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="seg" role="group" aria-label={t.tasks.show}>
          {(['open', 'closed'] as const).map(status => (
            <button key={status} type="button" aria-pressed={filter.status === status} onClick={() => setFilter({ ...filter, status })}>
              {t.tasks[status]}
            </button>
          ))}
        </div>
      </div>

      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
      {tasks && !tasks.length && <p className="muted">{t.tasks.empty}</p>}
      {tasks &&
        ORDER.filter(status => tasks.some(x => x.status === status)).map(status => (
          <section key={status} className="tgroup" aria-label={t.tasks.groups[status]}>
            <h3>{t.tasks.groups[status]}</h3>
            <ul>
              {tasks
                .filter(x => x.status === status)
                .sort((a, b) => b.number - a.number)
                .map(row)}
            </ul>
          </section>
        ))}
    </section>
  );
}
