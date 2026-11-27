import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { deptLabel, useT } from '../i18n';
import type { TrackerPlace } from '../routes';
import { mapPeople } from '../org';
import { shownEmployees } from '../tracker';
import type { Employee, GoalView, Org, Pipeline, TaskDepartments, TaskLine } from '../types';
import { TrackerIcon } from './icons';
import { DepartmentMark, PersonMark } from './TrackerMarks';

/* How many employees of a department stay in sight before the rest fold under "N more", as in the mockup. */
const EMPLOYEES_SHOWN = 6;

/* What the + beside Tasks offers: what the person may make here and writing to the orchestrator, with a note when something
   cannot be made yet. */
export type Create = { note?: string; items: { key: string; label: string; onChoose: () => void }[] };

type Props = {
  id: string;
  place: TrackerPlace;
  onPlace: (place: TrackerPlace) => void;
  onOpenTask: (id: string) => void;
  onOpenAgent?: (id: string) => void;
  org: Org | null;
  places: TaskDepartments | undefined;
  pipelines: Pipeline[];
  goals: GoalView[];
  tasks: TaskLine[];
  /* people: what waits for people in the company, counted only for those who see the whole company. */
  counts: { waits: number; people?: number; failures: number; mine: number; working: number };
  create?: Create;
  open: boolean;
  onClose: () => void;
};

/* How a count reads at the end of a row: a pink badge for what needs the person, a quiet badge, plain muted digits, or the
   green of work going on. */
type Tone = 'attention' | 'quiet' | 'plain' | 'working';
const TONE_CLASS: Record<Tone, string> = { attention: 'tr-count tr-badge attention', quiet: 'tr-count tr-badge', plain: 'tr-count', working: 'tr-count working' };

/* How far in a row stands under the row above it. */
const LEVEL_CLASS = { 1: ' tr-l1', 2: ' tr-l2' } as const;

type ItemProps = {
  on?: boolean; onClick: () => void; count?: number; tone?: Tone; icon: ReactNode; level?: 1 | 2; more?: boolean;
  /* A second line under the name, and words at the end of the row, both told to screen readers after the name. */
  sub?: ReactNode; end?: ReactNode; working?: boolean; expanded?: boolean; children: ReactNode;
};

/* A row of the panel, the mockup's .si: a place to go, marked while the person is there, its icon, its name with an
   optional second line, and a count or words at the end that wrap under the name as a whole when the row is tight. */
function Item({ on = false, onClick, count, tone = 'quiet', icon, level, more, sub, end, working = false, expanded, children }: ItemProps) {
  const id = useId();
  const described = [sub !== undefined && `${id}-s`, end !== undefined && `${id}-e`].filter(Boolean).join(' ');
  return (
    <button className={`tr-item${level ? LEVEL_CLASS[level] : ''}${more ? ' more' : ''}${on ? ' on' : ''}`} type="button" aria-current={on ? 'page' : undefined}
      aria-expanded={expanded} aria-labelledby={count === undefined ? `${id}-n` : `${id}-n ${id}-c`} aria-describedby={described || undefined} onClick={onClick}>
      <span className="tr-item-name">
        {icon}
        {sub === undefined ? <span id={`${id}-n`} dir="auto">{children}</span> : (
          <span className="tr-item-text"><span id={`${id}-n`} dir="auto">{children}</span><small id={`${id}-s`} dir="auto">{sub}</small></span>
        )}
      </span>
      {count !== undefined && <span id={`${id}-c`} className={TONE_CLASS[tone === 'attention' && !count ? 'quiet' : tone]}>{count}</span>}
      {end !== undefined && <span id={`${id}-e`} className={working ? 'tr-item-end working' : 'tr-item-end'}>{end}</span>}
    </button>
  );
}

const dotOf = (status: Employee['status']) => (status === 'working' ? 'tr-live' : status === 'waiting' ? 'tr-waitd' : 'tr-idle');

type Dept = TaskDepartments['departments'][number];

/* The 30px + beside Tasks, the mockup's one way to make something, opens a short menu in the look of the card's menu.
   Escape or a press elsewhere closes it; a choice closes it and the phone's drawer. */
function CreateMenu({ create, onClose }: { create: Create; onClose: () => void }) {
  const t = useT();
  const label = t.tracker.side.create;
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector('button')?.focus();
    /* On the window, before the card's own Escape on the document, so one Escape closes only the menu. */
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [open]);
  return (
    <>
      <button className="tr-new" type="button" ref={trigger} aria-label={label} title={label} aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen(!open)}>
        <TrackerIcon name="add" />
      </button>
      {open && (
        <div className="tr-new-menu" id={menuId} ref={menu} role="group" aria-label={label}>
          {create.note && <p className="muted" dir="auto">{create.note}</p>}
          {create.items.length > 0 && (
            <div className="tp-menu-list">
              {create.items.map(item => (
                <button key={item.key} className="linkish" type="button" onClick={() => { setOpen(false); item.onChoose(); onClose(); }}>{item.label}</button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/* A department as the mockup draws it: its caret, mark and name, who answers for it and how many of its employees work now.
   Open, it shows its goals, its pipelines with work outside them, its employees, then its products. */
function DepartmentItem({ d, org, place, go, onOpenTask, onOpenAgent, pipelines, goals }: {
  d: Dept; org: Org | null; place: TrackerPlace; go: (place: TrackerPlace) => void; onOpenTask: (id: string) => void; onOpenAgent?: (id: string) => void; pipelines: Pipeline[]; goals: GoalView[];
}) {
  const t = useT();
  const words = t.tracker.side;
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const [pipesOpen, setPipesOpen] = useState(true);
  const [staffOpen, setStaffOpen] = useState(true);
  const [productsOpen, setProductsOpen] = useState(Boolean(place.product));
  const [all, setAll] = useState(false);
  const known = org?.departments.find(x => x.id === d.id);
  const name = deptLabel(t, d);
  const employees = known?.employees ?? [];
  const { shown, more } = shownEmployees(employees, EMPLOYEES_SHOWN);
  const here = place.department === d.id;
  const current = here && !place.goal && !place.pipeline && !place.product && !place.show;
  const open = expanded ?? here;
  const ownPipelines = pipelines.filter(p => p.department.id === d.id && !p.archived);
  const ownGoals = goals.filter(g => g.department?.id === d.id && g.status !== 'dropped');
  const working = employees.filter(e => e.status === 'working').length;
  const at = (next: TrackerPlace) => go({ department: d.id, personId: place.personId, ...next });
  const answers = d.responsible ? words.answers(d.responsible.name) : undefined;
  /* Folded, the line under its name also counts its employees, as the mockup's "Leo answers · 14". */
  const sub = !open && employees.length ? [answers, employees.length].filter(Boolean).join(' · ') : answers;
  const view = place.view ?? 'list';
  return (
    <li className="tr-dept">
      <div className={`tr-dept-head${current ? ' on' : ''}`}>
        <button className="tr-unfold" type="button" aria-expanded={open} aria-label={words.unfold(name)} title={words.unfold(name)} onClick={() => setExpanded(!open)}>
          <span className="tr-caret" aria-hidden="true" />
        </button>
        <Item icon={<DepartmentMark id={d.id} name={name} template={d.templateKey} />} on={current} sub={sub} end={working ? words.workingCount(working) : undefined} working
          onClick={() => { setExpanded(true); at({ view }); }}>{name}</Item>
      </div>
      {open && (
        <ul className="tr-items tr-dept-body">
          <li><Item level={1} icon={<TrackerIcon name="goals" />} count={ownGoals.length} tone="plain" on={here && place.show === 'goals'} onClick={() => at({ show: 'goals' })}>{words.goals}</Item></li>
          <li>
            <Item level={1} icon={<TrackerIcon name="pipeline" className="tr-pipe-ic" />} count={ownPipelines.length} tone="plain" expanded={pipesOpen} onClick={() => setPipesOpen(!pipesOpen)}>{words.pipelines}</Item>
            {pipesOpen && (
              <ul className="tr-items tr-pipelines">
                {ownPipelines.map(p => <li key={p.id}><Item level={2} icon={<TrackerIcon name="chevron" className="tr-pipe-ic" />} on={here && place.pipeline === p.id} onClick={() => at({ pipeline: p.id, view })}>{p.isDefault ? words.defaultPipeline(p.name) : p.name}</Item></li>)}
                <li><Item level={2} icon={<TrackerIcon name="chevron" className="tr-pipe-ic" />} on={here && place.pipeline === 'none'} onClick={() => at({ pipeline: 'none', view })}>{words.withoutPipeline}</Item></li>
              </ul>
            )}
          </li>
          {employees.length > 0 && (
            <li>
              <Item level={1} icon={<TrackerIcon name="employees" />} count={employees.length} tone="plain" expanded={staffOpen} onClick={() => setStaffOpen(!staffOpen)}>{words.employees}</Item>
              {staffOpen && (
                <ul className="tr-items tr-people">
                  {[...shown, ...(all ? more : [])].map(e => (
                    <li key={e.id}>
                      <Item level={2} icon={<span className={dotOf(e.status)} aria-hidden="true" />}
                        sub={e.task ? `#${e.task.number} ${e.task.title}` : e.kind === 'head' && e.status !== 'idle' ? words.head : t.dept.status[e.status]}
                        end={e.status !== 'working' && e.status !== 'idle' && e.task ? t.dept.status[e.status] : undefined}
                        onClick={() => (e.task ? onOpenTask(e.task.id) : onOpenAgent?.(e.id))}>{e.name}</Item>
                    </li>
                  ))}
                  {more.length > 0 && <li><Item level={2} more icon={null} expanded={all} onClick={() => setAll(!all)}>{all ? words.fewer : words.more(more.length)}</Item></li>}
                </ul>
              )}
            </li>
          )}
          {known && known.products.length > 0 && (
            <li>
              <Item level={1} icon={<TrackerIcon name="list" />} count={known.products.length} tone="plain" expanded={productsOpen} onClick={() => setProductsOpen(!productsOpen)}>{words.products}</Item>
              {productsOpen && (
                <ul className="tr-items">
                  {known.products.map(p => <li key={p.id}><Item level={2} icon={<TrackerIcon name="chevron" />} on={here && place.product === p.id} onClick={() => at({ product: p.id, view })}>{p.name}</Item></li>)}
                </ul>
              )}
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/* What waits for people in the company, a row only for those who see the whole company, who have its count. */
function PeopleWaitsItem({ count, on, go }: { count?: number; on: boolean; go: (next: TrackerPlace) => void }) {
  const t = useT();
  if (count === undefined) return null;
  return <li><Item icon={<TrackerIcon name="waits" />} on={on} count={count} tone="attention" onClick={() => go({ show: 'people' })}>{t.tracker.peopleWaits.title}</Item></li>;
}

/* The left panel of mockup 10: what waits for the person, their tasks and the work going on now; the people who answer
   for the work; the departments. What the product needs besides, the goals, due dates, failures, the orchestrator's own
   work and the turns, follows in the same rows. A phone opens it as a drawer. */
export function TrackerSide({ id, place, onPlace, onOpenTask, onOpenAgent, org, places, pipelines, goals, tasks, counts, open, onClose, create }: Props) {
  const t = useT();
  const words = t.tracker.side;
  const go = (next: TrackerPlace) => {
    onPlace(next);
    onClose();
  };
  const person = place.personId ? { personId: place.personId } : {};
  const mine = !place.show && !place.department && !place.responsible && !place.goal && !place.root;
  const people = mapPeople(org).filter(p => !p.assistant && p.status === 'active');
  const departments = places?.departments ?? [];
  /* What a person answers for: the CEO the whole company, anyone else the departments they answer for, or their title. */
  const answersFor = (p: (typeof people)[number]) => {
    if (p.isOwner) return [p.title, words.wholeCompany].filter(Boolean).join(', ');
    const own = departments.filter(d => d.responsible?.id === p.id).map(d => deptLabel(t, d));
    return own.length ? own.join(', ') : p.title || undefined;
  };
  const assigned = new Map<string, number>();
  for (const task of tasks) {
    if (task.responsible && task.status !== 'cancelled') {
      const id = task.responsible.id;
      assigned.set(id, (assigned.get(id) ?? 0) + 1);
    }
  }
  const companyGoals = goals.filter(g => g.status !== 'dropped');
  return (
    <nav id={id} className={`tr-side${open ? ' open' : ''}`} aria-label={words.label}>
      <div className="tr-side-title">
        <h2>{words.title}</h2>
        {create && (create.items.length > 0 || create.note) && <CreateMenu create={create} onClose={onClose} />}
        <button className="zbtn tr-side-close" type="button" aria-label={words.close} title={words.close} onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      <ul className="tr-items">
        <li><Item icon={<TrackerIcon name="waits" />} on={place.show === 'waits'} count={counts.waits} tone="attention" onClick={() => go({ show: 'waits', ...person })}>{words.waits}</Item></li>
        <PeopleWaitsItem count={counts.people} on={place.show === 'people'} go={go} />
        <li><Item icon={<TrackerIcon name="mine" />} on={mine} count={counts.mine} onClick={() => go({ ...person, view: 'list' })}>{words.mine}</Item></li>
        <li><Item icon={<span className="tr-live" aria-hidden="true" />} on={place.show === 'working'} count={counts.working} tone="working" onClick={() => go({ show: 'working', ...person, view: 'list' })}>{words.working}</Item></li>
      </ul>
      <h2 className="tr-side-heading">{words.people}</h2>
      <ul className="tr-items">
        {people.map(p => {
          return (
            <li key={p.id}>
              <Item icon={<PersonMark person={p} decorative />} on={place.responsible === p.id} sub={answersFor(p)} count={assigned.get(p.id)}
                onClick={() => go({ ...person, responsible: p.id, view: 'list' })}>{p.name}</Item>
            </li>
          );
        })}
      </ul>
      <h2 className="tr-side-heading">{words.departments}</h2>
      <ul className="tr-items">
        {departments.map(d => <DepartmentItem key={d.id} d={d} org={org} place={place} go={go} onOpenTask={task => { onOpenTask(task); onClose(); }} onOpenAgent={onOpenAgent} pipelines={pipelines} goals={goals} />)}
      </ul>
      <ul className="tr-items tr-more">
        <li><Item icon={<TrackerIcon name="goals" />} on={place.show === 'goals' && !place.department} count={companyGoals.length} tone="plain" onClick={() => go({ show: 'goals', ...person })}>{words.allGoals}</Item></li>
        <li><Item icon={<TrackerIcon name="dates" />} on={place.show === 'due'} onClick={() => go({ show: 'due', ...person })}>{words.dates}</Item></li>
        <li><Item icon={<TrackerIcon name="failure" />} on={place.show === 'failures'} count={counts.failures} tone="attention" onClick={() => go({ show: 'failures', ...person, view: 'list' })}>{words.failures}</Item></li>
        {places?.whole && <li><Item icon={<TrackerIcon name="list" />} on={place.department === 'none'} onClick={() => go({ ...person, department: 'none', view: 'list' })}>{words.orchestrator}</Item></li>}
        <li><Item icon={<TrackerIcon name="dates" />} on={place.show === 'turns'} onClick={() => go({ show: 'turns' })}>{words.turns}</Item></li>
      </ul>
    </nav>
  );
}
