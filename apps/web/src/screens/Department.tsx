import { useId, useState } from 'react';
import { deptLabel, errorText, useLanguage, useT } from '../i18n';
import { PROVIDER_NAMES } from '../providers';
import { useTasks } from '../tasks';
import type { Department, Employee, Me, PersonView } from '../types';
import { Edge } from '../ui/Edge';
import { NewTask } from '../ui/NewTask';
import { RepoSettings } from '../ui/RepoSettings';
import { byState, TaskRow } from '../ui/TaskRow';

type Props = {
  me: Me;
  department: Department;
  /* The people next to the CEO; those whose access lists this department reach it too. */
  deputies: PersonView[];
  selected: string | null;
  selectedTask: string | null;
  onBack(): void;
  onHire(): void;
  onOpen(agentId: string): void;
  onOpenTask(taskId: string): void;
};

function EmployeeCard({ e, on, onOpen }: { e: Employee; on: boolean; onOpen(id: string): void }) {
  const t = useT();
  const { language } = useLanguage();
  const role = e.title?.[language] ?? e.roleId;
  return (
    <button type="button" className={`emp${on ? ' on' : ''}`} aria-pressed={on} onClick={() => onOpen(e.id)}>
      <Edge cut={10} corner={e.kind === 'head'}>
        <b className="emp-name">{e.name}</b>
        {role && role !== e.name && <span className="emp-role">{role}</span>}
        <span className="emp-model">{[e.modelName || e.model || t.agent.default, e.provider && PROVIDER_NAMES[e.provider]].filter(Boolean).join(', ')}</span>
        <span className="emp-state">
          <i className={`dot ${e.state}`} />
          <span>{t.dept.states[e.state]}</span>
        </span>
      </Edge>
    </button>
  );
}

/* The department's open tasks, and a new one for its head from people whose access lists the department. */
function DeptTasks({ department: d, head, canGive, selected, onOpenTask }: { department: Department; head: Employee | undefined; canGive: boolean; selected: string | null; onOpenTask(id: string): void }) {
  const t = useT();
  const id = useId();
  const { tasks, failure, load } = useTasks({ status: 'open', department: d.id });
  const [writing, setWriting] = useState(false);

  return (
    <section aria-labelledby={`${id}-tasks`}>
      <div className="dv-h">
        <h3 id={`${id}-tasks`}>{t.dept.tasks}</h3>
        {canGive && head && !writing && (
          <button className="btn small ghost" type="button" onClick={() => setWriting(true)}>
            {t.dept.newTask}
          </button>
        )}
      </div>
      {canGive && !head && <p className="muted">{t.dept.needsHead}</p>}
      {writing && head && (
        <NewTask
          department={d}
          head={head.name}
          onCancel={() => setWriting(false)}
          onCreated={task => {
            setWriting(false);
            load();
            onOpenTask(task.id);
          }}
        />
      )}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
      {tasks && !tasks.length && <p className="muted">{t.dept.noTasks}</p>}
      {tasks && tasks.length > 0 && (
        <ul className="dv-tasks">
          {[...tasks].sort(byState).map(task => (
            <li key={task.id}>
              <TaskRow task={task} on={selected === task.id} place={[t.tasks.groups[task.status], task.product?.name].filter(Boolean).join(' / ')} onOpen={onOpenTask} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* Inside a department: its head on top, the members below, its tasks, and at the side its repository, products and the people who reach it. */
export function DepartmentView({ me, department: d, deputies, selected, selectedTask, onBack, onHire, onOpen, onOpenTask }: Props) {
  const t = useT();
  const id = useId();
  const company = me.person.scopeKind === 'company';
  const head = d.employees.find(e => e.kind === 'head');
  const members = d.employees.filter(e => e.kind !== 'head');
  const reach = [
    ...d.people,
    ...deputies.filter(p => !p.access.whole && (p.access.departments.some(x => x.id === d.id) || p.access.teams.some(x => x.departmentId === d.id))),
  ];
  /* Tasks are for people who reach the department; giving it one takes the department itself in the access, not only a team in it. */
  const mine = reach.find(p => p.id === me.person.id);
  const sees = company || !!mine;
  const canGive = company || !!mine?.access.departments.some(x => x.id === d.id);

  return (
    <div className="dview">
      <header className="dv-top">
        <button className="btn small ghost" type="button" onClick={onBack}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
          {t.dept.back}
        </button>
        <div className="dv-title">
          <h2>{deptLabel(t, d)}</h2>
          <span className="role">{d.roleCode}</span>
        </div>
        {company && (
          <button className="btn" type="button" onClick={onHire}>
            {t.dept.hire}
          </button>
        )}
      </header>
      <div className="dv-body">
        <div className="dv-main">
          <section aria-labelledby={`${id}-head`}>
            <h3 id={`${id}-head`}>{t.dept.head}</h3>
            {head ? <EmployeeCard e={head} on={selected === head.id} onOpen={onOpen} /> : <p className="muted">{t.dept.noHead}</p>}
          </section>
          <section aria-labelledby={`${id}-members`}>
            <h3 id={`${id}-members`}>{t.dept.members}</h3>
            {members.length ? (
              <ul className="dv-grid">
                {members.map(e => (
                  <li key={e.id}>
                    <EmployeeCard e={e} on={selected === e.id} onOpen={onOpen} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{t.dept.noMembers}</p>
            )}
          </section>
          {sees && <DeptTasks department={d} head={head} canGive={canGive} selected={selectedTask} onOpenTask={onOpenTask} />}
        </div>
        <div className="dv-side">
          {company && (
            <section aria-labelledby={`${id}-repo`}>
              <h3 id={`${id}-repo`}>{t.dept.repository}</h3>
              <RepoSettings placeId={d.id} repository={d.repository} />
            </section>
          )}
          {d.products.length > 0 && (
            <section aria-labelledby={`${id}-products`}>
              <h3 id={`${id}-products`}>{t.dept.products}</h3>
              <ul>
                {d.products.map(p => (
                  <li key={p.id}>
                    <b>{p.name}</b>
                    {company && <RepoSettings placeId={p.id} repository={p.repository} compact />}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section aria-labelledby={`${id}-people`}>
            <h3 id={`${id}-people`}>{t.dept.people}</h3>
            {reach.length ? (
              <ul>
                {reach.map(p => (
                  <li key={p.id}>
                    <b>{p.name}</b>
                    {p.title && <small>{p.title}</small>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{t.dept.noPeople}</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
