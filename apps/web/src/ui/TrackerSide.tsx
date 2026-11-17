import { useState, type ReactNode } from 'react';
import { deptLabel, useT } from '../i18n';
import type { TrackerPlace } from '../routes';
import { responsibles, shownEmployees } from '../tracker';
import type { GoalView, Org, Pipeline, TaskDepartments, TaskLine } from '../types';
import { taskText } from './Chip';
import { Fold } from './TaskBoard';

/* How many employees of a department stay in sight before the rest fold under "N more". */
const EMPLOYEES_SHOWN = 3;

type Props = {
  id: string;
  place: TrackerPlace;
  onPlace: (place: TrackerPlace) => void;
  onOpenTask: (id: string) => void;
  viewer: string;
  org: Org | null;
  places: TaskDepartments | undefined;
  goals: GoalView[];
  pipelines: Pipeline[];
  tasks: TaskLine[];
  counts: { waits: number; working: number };
  open: boolean;
  onClose: () => void;
};

/* An item of the panel: a place to go, marked while the person is there, with a line under it and a count. */
function Item({ on, onClick, count, note, children }: { on: boolean; onClick: () => void; count?: number; note?: ReactNode; children: ReactNode }) {
  return (
    <button className={`tr-item${on ? ' on' : ''}`} type="button" aria-current={on ? 'page' : undefined} onClick={onClick}>
      <span className="tr-item-name">{children}</span>
      {count !== undefined && <span className="tr-count">{count}</span>}
      {note && <small>{note}</small>}
    </button>
  );
}

type Dept = TaskDepartments['departments'][number];

/* A department: its name, who answers for it and how many work now; unfolded, its goals, pipelines, products and employees,
   those at work first with the task they are on, the rest under "N more". */
function DepartmentItem({ d, org, place, go, onOpenTask, goals, pipelines }: { d: Dept; org: Org | null; place: TrackerPlace; go: (place: TrackerPlace) => void; onOpenTask: (id: string) => void; goals: GoalView[]; pipelines: Pipeline[] }) {
  const t = useT();
  const words = t.tracker.side;
  const [open, setOpen] = useState(place.department === d.id);
  const [all, setAll] = useState(false);
  const known = org?.departments.find(x => x.id === d.id);
  const name = deptLabel(t, d);
  const working = known?.employees.filter(e => e.status === 'working').length ?? 0;
  const { shown, more } = shownEmployees(known?.employees ?? [], EMPLOYEES_SHOWN);
  const here = place.department === d.id;
  const ownGoals = goals.filter(g => g.department?.id === d.id && g.status === 'active');
  const ownPipelines = pipelines.filter(p => p.department.id === d.id && !p.archived);
  const at = (more: TrackerPlace) => go({ department: d.id, view: place.view, ...more });
  return (
    <li className="tr-dept">
      <div className="tr-dept-head">
        <Item on={here && !place.goal && !place.pipeline && !place.product} onClick={() => at({})} note={`${d.responsible?.name ?? words.nobodyAnswers}, ${words.workingCount(working)}`}>{name}</Item>
        <button className="zbtn tr-unfold" type="button" aria-expanded={open} aria-label={words.unfold(name)} title={words.unfold(name)} onClick={() => setOpen(!open)}>
          <svg className="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" /></svg>
        </button>
      </div>
      {open && (
        <div className="tr-dept-body">
          <h3>{words.goals}</h3>
          {ownGoals.length ? (
            <ul>{ownGoals.map(g => <li key={g.id}><Item on={here && place.goal === g.id} onClick={() => at({ goal: g.id })}>{g.title}</Item></li>)}</ul>
          ) : <p className="muted">{words.noGoals}</p>}
          <h3>{words.pipelines}</h3>
          {ownPipelines.length ? (
            <ul>{ownPipelines.map(p => <li key={p.id}><Item on={here && place.pipeline === p.id} onClick={() => at({ pipeline: p.id })}>{p.name}</Item></li>)}</ul>
          ) : <p className="muted">{words.noPipelines}</p>}
          {known && known.products.length > 0 && (
            <>
              <h3>{words.products}</h3>
              <ul>{known.products.map(p => <li key={p.id}><Item on={here && place.product === p.id} onClick={() => at({ product: p.id })}>{p.name}</Item></li>)}</ul>
            </>
          )}
          {known && known.employees.length > 0 && (
            <>
              <h3>{words.employees}</h3>
              <ul className="tr-people">
                {[...shown, ...(all ? more : [])].map(e => (
                  <li key={e.id}>
                    <span className="tr-person"><b>{e.name}</b> <span className={`tstate ${e.status === 'working' ? 'working' : e.status === 'waiting' ? 'waiting' : ''}`}>{t.dept.status[e.status]}</span></span>
                    {e.task && <button className="linkish" type="button" dir="auto" onClick={() => onOpenTask(e.task!.id)}>{taskText(e, t)}</button>}
                  </li>
                ))}
              </ul>
              {more.length > 0 && <Fold open={all} onToggle={() => setAll(!all)}>{all ? words.fewer : words.more(more.length)}</Fold>}
            </>
          )}
        </div>
      )}
    </li>
  );
}

/* The left panel: what waits for the person, their tasks and what works now; who answers for what; the departments with
   what is in them; and the turns and releases. On a phone it is a drawer over the page. */
export function TrackerSide({ id, place, onPlace, onOpenTask, viewer, org, places, goals, pipelines, tasks, counts, open, onClose }: Props) {
  const t = useT();
  const words = t.tracker.side;
  const go = (next: TrackerPlace) => {
    onPlace(next);
    onClose();
  };
  const person = place.personId ? { personId: place.personId } : {};
  const section = !place.show && !place.department && !place.responsible && !place.goal && !place.root;
  const departments = [...(places?.departments ?? [])].sort((a, b) => Number(b.responsible?.id === viewer) - Number(a.responsible?.id === viewer));
  const named = (ids: string[]) => ids.map(x => { const d = places?.departments.find(p => p.id === x); return d ? deptLabel(t, d) : ''; }).filter(Boolean).join(', ');
  return (
    <nav id={id} className={`tr-side${open ? ' open' : ''}`} aria-label={words.label}>
      <div className="tr-side-close">
        <button className="zbtn" type="button" aria-label={words.close} title={words.close} onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      <ul className="tr-items">
        <li><Item on={place.show === 'waits'} count={counts.waits} onClick={() => go({ show: 'waits', ...person })}>{words.waits}</Item></li>
        <li><Item on={section} onClick={() => go({ ...person, view: place.view })}>{words.mine}</Item></li>
        <li><Item on={place.show === 'working'} count={counts.working} onClick={() => go({ show: 'working', view: place.view })}>{words.working}</Item></li>
      </ul>
      <h2>{words.responsible}</h2>
      <ul className="tr-items">
        {responsibles(places?.departments ?? [], goals, tasks).map(r => (
          <li key={r.person.id}>
            <Item on={place.responsible === r.person.id} onClick={() => go({ responsible: r.person.id, view: place.view })} note={[r.departments.length ? words.answersFor(named(r.departments)) : '', words.openTasks(r.open)].filter(Boolean).join(', ')}>
              {r.person.name}
            </Item>
          </li>
        ))}
      </ul>
      <h2>{words.departments}</h2>
      <ul className="tr-items">
        {departments.map(d => <DepartmentItem key={d.id} d={d} org={org} place={place} go={go} onOpenTask={id => { onOpenTask(id); onClose(); }} goals={goals} pipelines={pipelines} />)}
        {places?.whole && <li><Item on={place.department === 'none'} onClick={() => go({ department: 'none', view: place.view })}>{words.orchestrator}</Item></li>}
      </ul>
      <ul className="tr-items tr-turns">
        <li><Item on={place.show === 'turns'} onClick={() => go({ show: 'turns' })}>{words.turns}</Item></li>
      </ul>
    </nav>
  );
}
