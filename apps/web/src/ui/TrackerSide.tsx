import { useState, type ReactNode } from 'react';
import { deptLabel, useT } from '../i18n';
import type { TrackerPlace } from '../routes';
import { mapPeople } from '../org';
import { shownEmployees, waitingOn } from '../tracker';
import type { Org, Pipeline, TaskDepartments, TaskLine } from '../types';
import { taskText } from './Chip';
import { Fold } from './TaskBoard';
import { TrackerIcon } from './icons';
import { DepartmentMark, PersonMark } from './TrackerMarks';
import { employeeKind, WorkerMark } from './WorkerMark';

/* How many employees of a department stay in sight before the rest fold under "N more". */
const EMPLOYEES_SHOWN = 3;

type Props = {
  id: string;
  place: TrackerPlace;
  onPlace: (place: TrackerPlace) => void;
  onOpenTask: (id: string) => void;
  org: Org | null;
  places: TaskDepartments | undefined;
  pipelines: Pipeline[];
  tasks: TaskLine[];
  counts: { waits: number; failures: number; mine: number; working: number };
  onAddTask?: () => void;
  open: boolean;
  onClose: () => void;
};

/* An item of the panel: a place to go, marked while the person is there, with its icon and optional count. */
function Item({ on, onClick, count, attention, icon, children }: { on: boolean; onClick: () => void; count?: number; attention?: boolean; icon: ReactNode; children: ReactNode }) {
  return (
    <button className={`tr-item${on ? ' on' : ''}`} type="button" aria-current={on ? 'page' : undefined} onClick={onClick}>
      <span className="tr-item-name">{icon}<span>{children}</span></span>
      {count !== undefined && <>{' '}<span className={`tr-count tr-badge${attention && count > 0 ? ' attention' : ''}`}>{count}</span></>}
    </button>
  );
}

type Dept = TaskDepartments['departments'][number];

/* A department unfolds to its goals and pipelines. Its products and employees have their own disclosures. */
function DepartmentItem({ d, org, place, go, onOpenTask, pipelines }: { d: Dept; org: Org | null; place: TrackerPlace; go: (place: TrackerPlace) => void; onOpenTask: (id: string) => void; pipelines: Pipeline[] }) {
  const t = useT();
  const words = t.tracker.side;
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const [all, setAll] = useState(false);
  const known = org?.departments.find(x => x.id === d.id);
  const name = deptLabel(t, d);
  const { shown, more } = shownEmployees(known?.employees ?? [], EMPLOYEES_SHOWN);
  const here = place.department === d.id;
  const open = expanded ?? here;
  const ownPipelines = pipelines.filter(p => p.department.id === d.id && !p.archived);
  const at = (next: TrackerPlace) => go({ department: d.id, personId: place.personId, ...next });
  return (
    <li className="tr-dept">
      <div className="tr-dept-head">
        <Item icon={<DepartmentMark id={d.id} name={name} template={d.templateKey} />} on={here && !place.goal && !place.pipeline && !place.product && place.view !== 'goals'} onClick={() => { setExpanded(true); at({ view: 'list' }); }}>{name}</Item>
        <button className="zbtn tr-unfold" type="button" aria-expanded={open} aria-label={words.unfold(name)} title={words.unfold(name)} onClick={() => setExpanded(!open)}>
          <svg className="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" /></svg>
        </button>
      </div>
      {open && (
        <div className="tr-dept-body">
          <Item icon={<TrackerIcon name="goals" />} on={here && !place.pipeline && place.view === 'goals'} onClick={() => at({ view: 'goals' })}>{words.goals}</Item>
          <h3 className="tr-side-caption"><TrackerIcon name="pipeline" />{words.pipelines}</h3>
          {ownPipelines.length ? (
            <ul className="tr-pipelines">{ownPipelines.map(p => <li key={p.id}><Item icon={<TrackerIcon name="chevron" />} on={here && place.pipeline === p.id} onClick={() => at({ pipeline: p.id, view: place.view === 'goals' || place.view === 'due' ? 'list' : place.view })}>{p.name}</Item></li>)}</ul>
          ) : <p className="muted">{words.noPipelines}</p>}
          <Item icon={<TrackerIcon name="list" />} on={here && place.pipeline === 'none'} onClick={() => at({ pipeline: 'none', view: 'list' })}>{words.withoutPipeline}</Item>
          {known && known.products.length > 0 && (
            <details open={here && Boolean(place.product) || undefined}>
              <summary>{words.products}</summary>
              <ul>{known.products.map(p => <li key={p.id}><Item icon={<TrackerIcon name="list" />} on={here && place.product === p.id} onClick={() => at({ product: p.id })}>{p.name}</Item></li>)}</ul>
            </details>
          )}
          {known && known.employees.length > 0 && (
            <details>
              <summary>{words.employees}</summary>
              <ul className="tr-people">
                {[...shown, ...(all ? more : [])].map(e => (
                  <li key={e.id}>
                    <span className="tr-person"><span className="worker-name"><WorkerMark kind={employeeKind(e.turnkey)} /><b dir="auto">{e.name}</b></span> <span className={`tstate ${e.status === 'working' ? 'working' : e.status === 'waiting' ? 'waiting' : ''}`}>{t.dept.status[e.status]}</span></span>
                    {e.task && <button className="linkish" type="button" onClick={() => onOpenTask(e.task!.id)}>{taskText(e, t)}</button>}
                  </li>
                ))}
              </ul>
              {more.length > 0 && <Fold open={all} onToggle={() => setAll(!all)}>{all ? words.fewer : words.more(more.length)}</Fold>}
            </details>
          )}
        </div>
      )}
    </li>
  );
}

/* A phone opens the tracker sidebar in a drawer. */
export function TrackerSide({ id, place, onPlace, onOpenTask, org, places, pipelines, tasks, counts, open, onClose, onAddTask }: Props) {
  const t = useT();
  const words = t.tracker.side;
  const go = (next: TrackerPlace) => {
    onPlace(next);
    onClose();
  };
  const person = place.personId ? { personId: place.personId } : {};
  const mine = !place.show && !place.department && !place.responsible && !place.goal && !place.root;
  const people = mapPeople(org).filter(p => !p.assistant && p.status === 'active');
  return (
    <nav id={id} className={`tr-side${open ? ' open' : ''}`} aria-label={words.label}>
      <div className="tr-side-title">
        <span>{words.title}</span>
        {onAddTask && <button className="zbtn tr-new" type="button" aria-label={t.tracker.list.addTask} title={t.tracker.list.addTask} onClick={() => { onAddTask(); onClose(); }}><TrackerIcon name="add" /></button>}
        <button className="zbtn tr-side-close" type="button" aria-label={words.close} title={words.close} onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      <ul className="tr-items">
        <li><Item icon={<TrackerIcon name="waits" />} on={place.show === 'waits'} count={counts.waits} attention onClick={() => go({ show: 'waits', ...person })}>{words.waits}</Item></li>
        <li><Item icon={<TrackerIcon name="mine" />} on={mine} count={counts.mine} onClick={() => go({ ...person, view: 'list' })}>{words.mine}</Item></li>
        <li><Item icon={<TrackerIcon name="dates" />} on={place.show === 'company' && place.view === 'due'} onClick={() => go({ show: 'company', ...person, view: 'due' })}>{words.dates}</Item></li>
        <li><Item icon={<TrackerIcon name="failure" />} on={place.show === 'failures'} count={counts.failures} attention onClick={() => go({ show: 'failures', ...person, view: 'list' })}>{words.failures}</Item></li>
      </ul>
      <h2>{words.people}</h2>
      <ul className="tr-items">
        {people.map(p => (
          <li key={p.id}>
            <Item icon={<PersonMark person={p} decorative />} on={place.responsible === p.id} count={waitingOn(tasks, p.id).length || undefined} attention onClick={() => go({ ...person, responsible: p.id, view: 'list' })}>{p.name}</Item>
          </li>
        ))}
      </ul>
      <h2>{words.departments}</h2>
      <ul className="tr-items">
        {(places?.departments ?? []).map(d => <DepartmentItem key={d.id} d={d} org={org} place={place} go={go} onOpenTask={id => { onOpenTask(id); onClose(); }} pipelines={pipelines} />)}
        {places?.whole && <li><Item icon={<TrackerIcon name="list" />} on={place.department === 'none'} onClick={() => go({ ...person, department: 'none', view: 'list' })}>{words.orchestrator}</Item></li>}
      </ul>
      <ul className="tr-items tr-turns">
        <li><Item icon={<TrackerIcon name="list" />} on={place.show === 'working'} count={counts.working} onClick={() => go({ show: 'working', ...person, view: 'list' })}>{words.working}</Item></li>
        <li><Item icon={<TrackerIcon name="dates" />} on={place.show === 'turns'} onClick={() => go({ show: 'turns' })}>{words.turns}</Item></li>
      </ul>
    </nav>
  );
}
