import { useState } from 'react';
import { deptLabel, errorText, useT } from '../i18n';
import { useOrg } from '../org';
import { placeName, useTasks, type TaskFilter } from '../tasks';
import type { Me, TaskLine, WaitingRequest } from '../types';
import { Field } from '../ui/Field';
import { Requests } from '../ui/Requests';
import { ORDER, TaskRow } from '../ui/TaskRow';
import { TurnBar } from '../ui/TurnBar';

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
  const { org } = useOrg();
  const [filter, setFilter] = useState<TaskFilter>({ status: 'open', department: null });
  const { tasks, failure } = useTasks(filter);
  const place = (p: TaskLine['department']) => placeName(t, org, p);

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
                .map(task => (
                  <li key={task.id}>
                    <TaskRow task={task} on={selected === task.id} place={[place(task.department), task.product?.name].filter(Boolean).join(' / ')} onOpen={onOpenTask} />
                  </li>
                ))}
            </ul>
          </section>
        ))}
    </section>
  );
}
