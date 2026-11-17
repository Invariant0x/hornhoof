import { useId, useRef, useState } from 'react';
import { ApiFailure } from '../api';
import { deptLabel, errorText, useT } from '../i18n';
import { mapPeople, useOrg } from '../org';
import type { TrackerPlace } from '../routes';
import { searchTasks } from '../task-search';
import { placeName, useGoals, usePipelines, useTaskDepartments, useTasks, useWaitCards } from '../tasks';
import { doerOf, filterTasks, graphPath, graphTree, mine, pipelineTree, pruneGoals, TRACKER_VIEWS, waitingOn, workingNow, BOARD_STATUSES, type Crumb, type GraphNode, type WorkFilter } from '../tracker';
import type { ComputerAccessDecision, Decisions, GoalView, MachineAwayCard, Me, MergeDecision, Org, Pipeline, ProposalDecision, TaskDepartments, TaskLine } from '../types';
import { ComputerCard } from '../ui/ComputerCard';
import { CEO_DECIDES } from '../ui/DecidedBy';
import { Field } from '../ui/Field';
import { programOf, TrackerIcon } from '../ui/icons';
import { DepartmentMark } from '../ui/TrackerMarks';
import { MachineAway } from '../ui/MachineAway';
import { MergeCard } from '../ui/MergeCard';
import { Requests, wordsAnswer } from '../ui/Requests';
import { StaffCard } from '../ui/StaffCard';
import { StructureCard } from '../ui/StructureCard';
import { Progress } from '../ui/TaskBoard';
import { GoalForm, PipelineForm, TrackerNewTask } from '../ui/TrackerForms';
import { TrackerSide } from '../ui/TrackerSide';
import { TrackerBoard, TrackerFound, TrackerGraph, TrackerList, type Rows } from '../ui/TrackerViews';
import { TurnsAndReleases } from '../ui/TurnsAndReleases';
import { waitText } from '../ui/tracker-words';
import { WaitCards } from '../ui/WaitCards';
import { RouteUnavailable, unavailableFailure } from './RouteUnavailable';

type Props = {
  me: Me;
  /* Where the person is in the tracker, as its address keeps it. */
  place: TrackerPlace;
  onPlace: (place: TrackerPlace) => void;
  onHome?: () => void;
  decisions: Decisions | undefined;
  decisionsFailure?: unknown;
  onDecisionsChanged: () => void;
  selected: string | null;
  onOpenTask: (id: string) => void;
  onOpenGoal: (id: string) => void;
  onOpenAgent: (id: string) => void;
  /* Only for people who see the whole company: they are the ones who write to him. */
  onOpenOrchestrator?: () => void;
};

function TaskSearch({ query, onChange }: { query: string; onChange: (query: string) => void }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  return (
    <Field label={t.tasks.search}>
      {p => (
        <div className="task-search">
          <input {...p} ref={input} type="search" autoComplete="off" placeholder={t.tasks.search} value={query} onChange={e => onChange(e.target.value)} />
          {query && (
            <button className="zbtn" type="button" aria-label={t.tasks.clearSearch} title={t.tasks.clearSearch} onClick={() => { onChange(''); input.current?.focus(); }}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          )}
        </div>
      )}
    </Field>
  );
}

type Waiting = Pick<Props, 'decisions' | 'decisionsFailure' | 'onDecisionsChanged' | 'onOpenTask' | 'onOpenAgent' | 'onOpenOrchestrator'> & {
  org: Org | null;
  place: (p: TaskLine['department']) => string;
  /* Whose: the person looked at, or the viewer with none. filtered: the person is picked by a filter the viewer may take off. */
  personId: string | null;
  onClearPerson?: () => void;
  /* The tasks that wait for that person. */
  tasks: TaskLine[];
  recipient: string;
};

type Shown = Pick<Decisions, 'requests' | 'proposals'> & { machineAccess: ComputerAccessDecision[]; merges: MergeDecision[]; machinesAway: MachineAwayCard[] };

function ownedItems<T extends { ownerPersonId: string }>(items: T[], personId: string | null): T[] {
  return personId ? items.filter(i => i.ownerPersonId === personId) : items;
}

/* What of the decisions the screen lists: all of them, or one person's; nothing before the first answer. */
function shownOf(decisions: Decisions | undefined, personId: string | null): Shown {
  if (!decisions) return { requests: [], proposals: [], machineAccess: [], merges: [], machinesAway: [] };
  const theirs = <T extends { ownerPersonId: string }>(items: T[]) => ownedItems(items, personId);
  return { requests: theirs(decisions.requests ?? []), proposals: theirs(decisions.proposals ?? []), machineAccess: theirs(decisions.machineAccess ?? []), merges: theirs(decisions.merges ?? []), machinesAway: decisions.machinesAway ?? [] };
}

const shownNone = (s: Shown) => !s.requests.length && !s.proposals.length && !s.machineAccess.length && !s.merges.length && !s.machinesAway.some(m => !m.back);

/* The person whose decisions show, with a cross that shows everyone's again. */
function PersonFilter({ name, onClear }: { name: string; onClear: () => void }) {
  const t = useT();
  return (
    <p className="filter-chip">
      <span>{t.tasks.decisionsFor(name)}</span>
      <button className="zbtn" type="button" aria-label={t.tasks.showAll} title={t.tasks.showAll} onClick={onClear}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </p>
  );
}

const nothing = () => {};

/* Who takes a card this person may not take; nothing for one they take. */
const lockOf = (card: ProposalDecision) => (card.canAnswer ? undefined : (card.decidedBy ?? CEO_DECIDES));

/* An orchestrator's card as his window shows it: a structure to build, or people to hire into a department. Correcting it
   in words opens his window. */
function ProposalCard({ card, org, onCorrect = nothing, onDone }: { card: ProposalDecision; org: Org | null; onCorrect?: () => void; onDone: () => void }) {
  const t = useT();
  const locked = lockOf(card);
  if (card.kind === 'structure') return <StructureCard proposal={{ id: card.id, brief: card.brief, items: card.items, ...{ materialRevision: card.materialRevision, materialDigest: card.materialDigest } }} departments={org?.departments ?? []} onCorrect={onCorrect} onDone={onDone} locked={locked} />;
  if (!card.department) return null;
  const known = org?.departments.find(d => d.id === card.department!.id);
  const department = { id: card.department.id, name: known ? deptLabel(t, known) : card.department.name };
  return <StaffCard department={department} proposal={{ id: card.id, brief: card.brief, people: card.items, ...{ materialRevision: card.materialRevision, materialDigest: card.materialDigest } }} onCorrect={onCorrect} onDone={onDone} locked={locked} />;
}

type Listed = Pick<Waiting, 'onDecisionsChanged' | 'onOpenTask' | 'onOpenAgent' | 'onOpenOrchestrator' | 'org' | 'place'> & { shown: Shown; onFailure: (err: unknown) => void };

/* Each decision with the buttons it already has elsewhere: requests, then the orchestrator's cards, then the computer. */
function DecisionList({ shown, onDecisionsChanged, onOpenTask, onOpenAgent, onOpenOrchestrator, org, place, onFailure }: Listed) {
  const t = useT();
  const { requests, proposals, machineAccess, merges, machinesAway } = shown;
  return (
    <>
      <MachineAway machines={machinesAway} />
      {requests.length > 0 && <Requests requests={requests} onChanged={onDecisionsChanged} onOpenTask={onOpenTask} onOpenAgent={onOpenAgent} placeName={place} />}
      {wordsAnswer(requests) && <p className="muted">{t.tasks.answerElsewhere}</p>}
      {proposals.map(c => (
        <ProposalCard key={c.id} card={c} org={org} onCorrect={onOpenOrchestrator} onDone={onDecisionsChanged} />
      ))}
      {machineAccess.map(card => (
        <ComputerCard key={card.id} view={card.view} onChange={onDecisionsChanged} onFailure={onFailure} />
      ))}
      {merges.map(merge => (
        <MergeCard key={merge.id} merge={merge} onChange={onDecisionsChanged} onFailure={onFailure} />
      ))}
    </>
  );
}

function DecisionsFailure({ failure, onRetry }: { failure: unknown; onRetry: () => void }) {
  const t = useT();
  if (failure === undefined || failure === null) return null;
  return <div className="notebook-unread">
    <p className="alert" role="alert">{errorText(t, failure)}</p>
    <button className="btn small ghost" type="button" onClick={onRetry}>{t.app.tryAgain}</button>
  </div>;
}

/* What waits for the person: what agents ask, the orchestrator's cards and his request for the computer, the cards Hornhoof
   kept for them, and the tasks that wait for them. For another person, only theirs, with the filter in sight when it may be
   taken off. */
function WaitingForYou({ decisions, decisionsFailure, personId, onClearPerson, tasks, recipient, ...rest }: Waiting) {
  const t = useT();
  const [failure, setFailure] = useState<unknown>(null);
  const { cards: kept, load: reloadCards } = useWaitCards();
  const shown = shownOf(decisions, personId);
  const cards = personId ? [] : (kept ?? []);
  const name = mapPeople(rest.org).find(p => p.id === personId)?.name ?? t.tasks.someone;

  return (
    <section className="waiting" aria-label={t.tasks.waiting}>
      <h2>{t.tasks.waiting}</h2>
      {personId && onClearPerson && <PersonFilter name={name} onClear={onClearPerson} />}
      <DecisionList shown={shown} onFailure={setFailure} {...rest} />
      <WaitCards cards={cards} onOpenTask={rest.onOpenTask} onSeen={reloadCards} />
      {tasks.length > 0 && <WaitingTasks tasks={tasks} recipient={recipient} heading={personId ? t.tracker.waitTasksOf(name) : t.tracker.waitTasks} onOpenTask={rest.onOpenTask} />}
      {decisions && shownNone(shown) && !cards.length && !tasks.length && <p className="muted">{personId ? t.tasks.nothingFor(name) : t.tasks.nothingWaiting}</p>}
      <DecisionsFailure failure={decisionsFailure} onRetry={rest.onDecisionsChanged} />
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </section>
  );
}

/* Tasks that wait for a person, each with how long already. */
function WaitingTasks({ tasks, recipient, heading, onOpenTask }: { tasks: TaskLine[]; recipient: string; heading: string; onOpenTask: (id: string) => void }) {
  const t = useT();
  return (
    <div className="tr-waits">
      <h3>{heading}</h3>
      <ul className="tp-subs">
        {tasks.map(task => (
          <li key={task.id}>
            <button className="linkish" type="button" onClick={() => onOpenTask(task.id)}>#{task.number} {task.title}</button>
            <small dir="auto">{waitText(t, task, undefined, recipient)}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* What waits for a person, counted as the left panel shows it. */
const countOf = (s: Shown, tasks: TaskLine[]) => s.requests.length + s.proposals.length + s.machineAccess.length + s.merges.length + s.machinesAway.filter(m => !m.back).length + tasks.length;

/* Which part of the tracker a place is: what waits for a person, the turns, or work to look at as a list, a board or a graph. */
type Section =
  | { kind: 'waits' | 'turns' | 'mine' | 'working' | 'company' }
  | { kind: 'department' | 'responsible' | 'goal' | 'root'; id: string };

function sectionOf(place: TrackerPlace): Section {
  if (place.show) return { kind: place.show };
  if (place.department) return { kind: 'department', id: place.department };
  if (place.responsible) return { kind: 'responsible', id: place.responsible };
  if (place.root) return { kind: 'root', id: place.root };
  if (place.goal) return { kind: 'goal', id: place.goal };
  return { kind: 'mine' };
}

/* A task and every task under it, at any depth. */
function treeOf(id: string, tasks: TaskLine[]): TaskLine[] {
  const found = tasks.filter(t => t.id === id);
  for (let i = 0; i < found.length; i++) found.push(...tasks.filter(t => t.parentId === found[i]!.id));
  return found;
}

type Chips = Pick<WorkFilter, 'status' | 'executor' | 'responsible' | 'goal'>;

/* Status, executor, responsible and goal, each a choice of what the work shown holds, or any. */
function FilterChips({ chips, onChange, tasks, goals, subtasks, onSubtasks }: {
  chips: Chips; onChange: (chips: Chips) => void; tasks: TaskLine[]; goals: GoalView[];
  subtasks?: boolean; onSubtasks: () => void;
}) {
  const t = useT();
  const words = t.tracker.filters;
  const unique = <T extends { id: string; name: string }>(items: (T | null | undefined)[]) => [...new Map(items.filter((x): x is T => !!x).map(x => [x.id, x])).values()].sort((a, b) => a.name.localeCompare(b.name));
  const chip = (key: keyof Chips, label: string, options: { id: string; name: string }[]) => {
    const selected = options.find(o => o.id === chips[key]);
    const text = key === 'status' ? words.group(selected?.name) : selected ? words.chosen(label, selected.name) : label;
    return (
      <label className={`tr-chip${selected || key === 'status' ? ' on' : ''}`}>
        <span aria-hidden="true" dir="auto">{text}</span>
        <select aria-label={label} value={chips[key] ?? ''} onChange={e => onChange({ ...chips, [key]: e.target.value || null })}>
          <option value="">{words.any}</option>
          {options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
    );
  };
  return (
    <div className="tr-chips" role="group" aria-label={words.label}>
      {chip('status', words.status, BOARD_STATUSES.map(s => ({ id: s, name: t.tracker.statuses[s] })))}
      {subtasks !== undefined && <button className={`tr-chip${subtasks ? ' on' : ''}`} type="button" aria-pressed={subtasks} onClick={onSubtasks}>{subtasks ? words.showSubtasks : words.hideSubtasks}</button>}
      {chip('executor', words.executor, unique(tasks.map(doerOf)))}
      {chip('responsible', words.responsible, unique(tasks.map(task => task.responsible)))}
      {chip('goal', words.goal, goals.filter(g => g.status !== 'dropped').map(g => ({ id: g.id, name: g.title })))}
    </div>
  );
}

const VIEW_ICON = { list: 'list', board: 'board', due: 'dates', goals: 'goals', graph: 'pipeline' } as const;

function ViewTabs({ value, pipeline, onChange }: { value: (typeof TRACKER_VIEWS)[number]; pipeline: boolean; onChange: (view: (typeof TRACKER_VIEWS)[number]) => void }) {
  const t = useT();
  const name = useId();
  const [custom, setCustom] = useState(false);
  return (
    <>
      <fieldset className="tr-views">
        <legend className="sr">{t.tracker.views.label}</legend>
        {TRACKER_VIEWS.map(view => (
          <label key={view} className={view === value ? 'on' : ''}>
            <input className="sr" type="radio" name={name} value={view} checked={view === value} onChange={() => { setCustom(false); onChange(view); }} />
            <TrackerIcon name={VIEW_ICON[view]} />
            <span>{view === 'graph' && pipeline ? t.tracker.views.diagram : t.tracker.views[view]}</span>
          </label>
        ))}
        <button className="tr-add-view" type="button" aria-expanded={custom} aria-controls={`${name}-custom`} onClick={() => setCustom(!custom)}>
          <TrackerIcon name="add" />{t.tracker.views.add}
        </button>
      </fieldset>
      <p className="tr-view-empty muted" id={`${name}-custom`} hidden={!custom}>{t.tracker.views.noSaved}</p>
    </>
  );
}

/* The goals a person answers for, each opening its card, with how far it is. */
function OwnGoals({ goals, label, onOpenGoal }: { goals: GoalView[]; label: string; onOpenGoal: (id: string) => void }) {
  const t = useT();
  return (
    <section className="tr-goals" aria-label={label}>
      <h2>{label}</h2>
      {goals.length ? (
        <ul>
          {goals.map(g => (
            <li key={g.id}>
              <button className="linkish" type="button" onClick={() => onOpenGoal(g.id)}>{g.title}</button>
              {g.target !== null ? <Progress done={Math.min(g.current ?? 0, g.target)} total={g.target} label={t.tracker.card.target(g.current ?? 0, g.target, g.unit)} />
                : g.total > 0 && <Progress done={g.done} total={g.total} label={t.tracker.card.tasksDone(g.done, g.total)} />}
            </li>
          ))}
        </ul>
      ) : <p className="muted">{t.tracker.noGoals}</p>}
    </section>
  );
}

type Making = 'task' | 'goal' | 'pipeline' | 'editPipeline' | null;

/* What a person may make where they are: a task for the department, a goal of the department or of the company, and the
   department's pipelines, where the server says they plan. */
function MakeHere({ places, org, department, pipeline, making, setMaking, onOpenTask }: {
  places: TaskDepartments | undefined; org: Org | null; department: string | null; pipeline: Pipeline | null; making: Making; setMaking: (m: Making) => void; onOpenTask: (id: string) => void;
}) {
  const t = useT();
  const words = t.tracker.actions;
  const known = department ? org?.departments.find(d => d.id === department) : undefined;
  const plans = department === null ? !!places?.mayPlanCompany : !!places?.departments.find(d => d.id === department)?.mayPlan;
  if (department === 'none' || !plans || (department && !known)) return null;
  const close = () => setMaking(null);
  const named = known ? { id: known.id, name: deptLabel(t, known) } : null;
  const head = known?.employees.some(e => e.kind === 'head');
  return (
    <>
      {known && !head && <p className="muted" dir="auto">{t.dept.needsHead}</p>}
      {!making && (
        <div className="entry-actions tr-make">
          {known && head && <button className="btn small ghost" type="button" onClick={() => setMaking('task')}>{words.newTask}</button>}
          <button className="btn small ghost" type="button" onClick={() => setMaking('goal')}>{words.newGoal}</button>
          {known && <button className="btn small ghost" type="button" onClick={() => setMaking('pipeline')}>{words.newPipeline}</button>}
          {known && pipeline?.mayEdit && <button className="btn small ghost" type="button" onClick={() => setMaking('editPipeline')}>{words.editPipeline}</button>}
        </div>
      )}
      {making === 'task' && known && <TrackerNewTask department={known} pipelineId={pipeline?.id} onCancel={close} onCreated={task => { close(); onOpenTask(task.id); }} />}
      {making === 'goal' && <GoalForm department={named} onCancel={close} onDone={close} />}
      {making === 'pipeline' && known && <PipelineForm department={known} onCancel={close} onDone={close} />}
      {making === 'editPipeline' && known && pipeline && <PipelineForm key={pipeline.id} pipeline={pipeline} department={known} onCancel={close} onDone={close} />}
    </>
  );
}

/* The tracker: on the left what waits for the person, their tasks, what works now, who answers for what, the departments
   and the turns; on top where the person is, View as and the search; then the work as a list, a board or a graph, each
   task and goal opening the same card. Everyone of the company reads every department's work. */
export function Tasks({ me, place, onPlace, decisions, decisionsFailure, onDecisionsChanged, selected, onOpenTask, onOpenGoal, onOpenAgent, onOpenOrchestrator, onHome }: Props) {
  const t = useT();
  const sideId = useId();
  const { org } = useOrg();
  const { taskDepartments: places, failure: placesFailure } = useTaskDepartments();
  const { tasks, failure } = useTasks({ status: 'all' });
  const { goals: goalList, failure: goalsFailure } = useGoals();
  const { pipelines: pipelineList, failure: pipelinesFailure } = usePipelines();
  const [drawer, setDrawer] = useState(false);
  const [query, setQuery] = useState('');
  const [chips, setChips] = useState<Chips>({});
  const [stageMode, setStageMode] = useState<boolean | null>(null);
  const [showSubtasks, setShowSubtasks] = useState(true);
  const [making, setMaking] = useState<Making>(null);
  const section = sectionOf(place);
  const sectionKey = JSON.stringify({ ...place, view: undefined });
  const [shownKey, setShownKey] = useState(sectionKey);
  if (shownKey !== sectionKey) {
    /* Another place starts with its own filters, and nothing half made. */
    setShownKey(sectionKey);
    setChips({});
    setMaking(null);
    setStageMode(null);
  }

  const all = tasks ?? [];
  const goals = goalList ?? [];
  const pipelines = pipelineList ?? [];
  const people = mapPeople(org);
  /* View as is the CEO's and the CEO delegate's, as the server checks it; for anyone else an address naming a person still
     shows their own screen. The map's way to a person's decisions stays everyone's: it picks among the decisions the person
     sees anyway. */
  const viewAs = me.canDecideCompany ?? (me.person.isOwner || (Boolean(me.person.isCeoDelegate) && me.person.scopeKind === 'company'));
  const viewed = viewAs ? (place.personId ?? null) : null;
  const decisionsOf = viewed ?? (place.show === 'waits' ? (place.personId ?? null) : null);
  const recipient = decisionsOf ?? me.person.id;
  const who = viewed ?? me.person.id;
  const whoName = people.find(p => p.id === who)?.name ?? t.tasks.someone;
  const other = who !== me.person.id;
  const asking = new Set((decisions?.requests ?? []).filter(r => r.canAnswer).map(r => r.task.id));
  const asksYou = (id: string) => asking.has(id);
  const place_ = (p: TaskLine['department']) => placeName(t, org, p);
  const employees = new Map(org?.departments.flatMap(d => d.employees.map(e => [e.id, e] as const)));
  const rows: Rows = {
    selected, onOpenTask, onOpenGoal, asksYou, placeName: place_,
    departmentTemplate: id => places?.departments.find(d => d.id === id)?.templateKey ?? org?.departments.find(d => d.id === id)?.templateKey,
    programOf: id => {
      const employee = employees.get(id);
      if (employee?.provider) return programOf(employee.provider, employee.apiProtocol);
      const orchestrator = org?.orchestrator;
      const sub = orchestrator?.id === id ? orchestrator.subscription : null;
      return sub ? programOf(sub.provider, sub.api?.protocol) : null;
    },
  };
  const own = mine(all, goals, who);
  const working = workingNow(all, org);
  const waitsOnWho = waitingOn(all, recipient);
  const pipeline = place.pipeline ? pipelines.find(p => p.id === place.pipeline) ?? null : null;
  const department = section.kind === 'department' ? places?.departments.find(d => d.id === section.id) : undefined;
  const departmentName = section.kind === 'department' ? (section.id === 'none' ? t.tracker.side.orchestrator : department ? deptLabel(t, department) : '') : '';

  /* The work of the place, then the filters of the chips over it. */
  const base: { tasks: TaskLine[]; filter: WorkFilter } =
    section.kind === 'mine' ? { tasks: own.tasks, filter: {} }
    : section.kind === 'working' ? { tasks: working, filter: {} }
    : section.kind === 'department' ? { tasks: all, filter: { department: section.id, product: place.product, pipeline: place.pipeline, goal: place.goal } }
    : section.kind === 'responsible' ? { tasks: all, filter: { responsible: section.id } }
    : section.kind === 'goal' ? { tasks: all, filter: { goal: section.id } }
    : section.kind === 'root' ? { tasks: treeOf(section.id, all), filter: {} }
    : section.kind === 'company' ? { tasks: all, filter: {} }
    : { tasks: [], filter: {} };
  const work = filterTasks(base.tasks, { ...base.filter, ...chips }, goals, asksYou);
  const chipTasks = filterTasks(base.tasks, base.filter, goals, asksYou);
  const view = place.view ?? 'list';
  const stages = stageMode ?? Boolean(pipeline);
  const addInGroup = department?.mayPlan && org?.departments.find(d => d.id === department.id)?.employees.some(e => e.kind === 'head')
    ? () => setMaking('task') : undefined;
  const found = query.trim() ? searchTasks(all, query) : null;

  const graph = (): { forest: GraphNode[]; crumbs: Crumb[] } => {
    if (pipeline && stages) return { forest: pipelineTree(pipeline, work), crumbs: [] };
    if (place.root) return { forest: graphTree({ task: place.root }, goals, work), crumbs: graphPath({ task: place.root }, goals, all) };
    if (place.goal) return { forest: graphTree({ goal: place.goal }, goals, work), crumbs: graphPath({ goal: place.goal }, goals, all) };
    if (section.kind === 'department') return { forest: pruneGoals(graphTree({ department: section.id }, goals, work), g => g.department?.id === section.id), crumbs: [] };
    if (section.kind === 'company') return { forest: graphTree({}, goals, work), crumbs: [] };
    return { forest: pruneGoals(graphTree({}, goals, work), g => section.kind === 'mine' && g.status === 'active' && g.responsible.id === who), crumbs: [] };
  };
  /* Up to a goal or a task above, or to the top: the department's goals, else every goal of the company. */
  const toCrumb = (c: Crumb | null) => onPlace(c
    ? { department: place.department, product: place.product, ...(c.kind === 'goal' ? { goal: c.id } : { root: c.id }), view: 'graph' }
    : place.department ? { department: place.department, product: place.product, view: 'graph' } : { show: 'company', view: 'graph' });

  const where = (() => {
    const goal = goals.find(g => g.id === place.goal);
    const product = org?.departments.find(d => d.id === place.department)?.products.find(p => p.id === place.product);
    switch (section.kind) {
      case 'mine': return { title: other ? t.tracker.where.theirs(whoName) : t.tracker.where.mine };
      case 'waits': return { title: recipient === me.person.id ? t.tracker.where.waits : t.tracker.where.waitsFor(people.find(p => p.id === recipient)?.name ?? t.tasks.someone) };
      case 'working': return { title: t.tracker.where.working };
      case 'turns': return { title: t.tracker.where.turns };
      case 'company': return { title: view === 'due' ? t.tracker.views.due : t.tracker.where.company };
      case 'responsible': return { title: t.tracker.where.responsible(people.find(p => p.id === section.id)?.name ?? t.tasks.someone) };
      case 'root': {
        const task = all.find(x => x.id === section.id);
        return { title: task ? t.tracker.where.task(task.number, task.title) : '' };
      }
      case 'goal': return { title: goal ? t.tracker.where.goal(goal.title) : '' };
      case 'department': return {
        title: departmentName,
        within: pipeline?.name ?? product?.name ?? goal?.title ?? (place.pipeline === 'none' ? t.tracker.side.withoutPipeline : t.tracker.views[view]),
      };
    }
  })();

  /* A server without goals and pipelines yet answers that it has none: the tracker shows the tasks without them. */
  const tracked = (f: unknown) => (f instanceof ApiFailure && f.status === 404 ? null : f);
  if (unavailableFailure(placesFailure ?? failure)) return <RouteUnavailable onHome={onHome} />;
  const broken = placesFailure ?? failure ?? tracked(goalsFailure) ?? tracked(pipelinesFailure);
  const clearPerson = () => onPlace({ ...place, personId: undefined });
  const waiting = (
    <WaitingForYou
      decisions={decisions}
      decisionsFailure={decisionsFailure}
      onDecisionsChanged={onDecisionsChanged}
      personId={decisionsOf}
      onClearPerson={clearPerson}
      tasks={waitsOnWho}
      recipient={recipient}
      onOpenTask={onOpenTask}
      onOpenAgent={onOpenAgent}
      onOpenOrchestrator={onOpenOrchestrator}
      org={org}
      place={place_}
    />
  );
  const empty = section.kind === 'mine' ? t.tracker.noMine : section.kind === 'working' ? t.tracker.nothingWorking : t.tracker.noTasks;
  const makeHere = (section.kind === 'mine' || section.kind === 'department' || section.kind === 'company') && (
    <MakeHere places={places} org={org} department={section.kind === 'department' ? section.id : other ? 'none' : null} pipeline={pipeline} making={making} setMaking={setMaking} onOpenTask={onOpenTask} />
  );
  const { forest, crumbs } = view === 'graph' ? graph() : { forest: [], crumbs: [] };

  return (
    <div className="tracker">
      <TrackerSide
        id={sideId}
        place={place}
        onPlace={onPlace}
        onOpenTask={onOpenTask}
        org={org}
        places={places}
        pipelines={pipelines}
        tasks={all}
        counts={{ waits: countOf(shownOf(decisions, decisionsOf), waitsOnWho), mine: own.tasks.length, working: working.length }}
        onAddTask={addInGroup}
        open={drawer}
        onClose={() => setDrawer(false)}
      />
      <div className="tr-main">
        <header className="tr-top">
          <button className="btn ghost tr-menu" type="button" aria-expanded={drawer} aria-controls={sideId} onClick={() => setDrawer(!drawer)}>{t.tracker.side.open}</button>
          <h1 className="tr-where" aria-label={where.within ? `${where.title} / ${where.within}` : undefined}>
            {department && <DepartmentMark id={department.id} name={where.title} template={department.templateKey} />}
            <bdi>{where.title}</bdi>
            {where.within && <><span className="tr-divider">{' / '}</span><bdi>{where.within}</bdi></>}
          </h1>
          {viewAs && (
            <div className="tr-view-as">
              <Field label={t.tracker.viewAs}>
                {p => (
                  <select {...p} value={other ? who : ''} onChange={e => onPlace({ ...place, personId: e.target.value || undefined })}>
                    <option value="">{t.tracker.viewAsSelf(me.person.name)}</option>
                    {people.filter(p => p.id !== me.person.id && !p.assistant && p.status === 'active').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                )}
              </Field>
            </div>
          )}
          <div className="tr-search"><TaskSearch query={query} onChange={setQuery} /></div>
        </header>
        {broken !== null && <p className="alert" role="alert">{errorText(t, broken)}</p>}
        {found ? (
          <>
            <section className="tr-found" aria-label={t.tracker.search.results}>
              <h2>{t.tracker.search.results}</h2>
              {found.length ? <TrackerFound tasks={found} all={all} rows={rows} /> : <p className="muted" role="status">{t.tasks.noSearchResults}</p>}
            </section>
            {/* A search leaves what waits for the person where it was. */}
            {(section.kind === 'waits' || section.kind === 'mine') && waiting}
          </>
        ) : section.kind === 'waits' ? waiting
          : section.kind === 'turns' ? <TurnsAndReleases tasks={tasks} places={places} rows={{ selected, onOpenTask, asksYou, place: task => [task.department ? place_(task.department) : t.tracker.side.orchestrator, task.product?.name].filter(Boolean).join(' / ') }} />
          : (
            <>
              <div className="tr-bar">
                <ViewTabs value={view} pipeline={Boolean(pipeline)} onChange={next => onPlace({ ...place, view: next })} />
                <FilterChips chips={{ ...chips, goal: chips.goal === undefined ? base.filter.goal : chips.goal }} onChange={setChips} tasks={chipTasks} goals={goals}
                  subtasks={view === 'list' ? showSubtasks : undefined} onSubtasks={() => setShowSubtasks(!showSubtasks)} />
              </div>
              {making && makeHere}
              {section.kind === 'mine' && view !== 'goals' && <OwnGoals goals={own.goals} label={other ? t.tracker.goalsOf(whoName) : t.tracker.yourGoals} onOpenGoal={onOpenGoal} />}
              {!tasks && broken === null && <p className="muted" role="status">{t.common.loading}</p>}
              {tasks && (
                view === 'list' ? <TrackerList tasks={work} all={all} rows={rows} empty={empty} onAddTask={addInGroup} showSubtasks={showSubtasks} />
                : view === 'board' ? <TrackerBoard tasks={work} all={all} pipeline={pipeline} cancelled={chips.status === 'cancelled'} rows={rows} />
                : view === 'due' ? (
                  <section aria-label={t.tracker.views.due}>
                    {work.some(task => task.dueAt) ? <TrackerFound tasks={work.filter(task => task.dueAt).sort((a, b) => a.dueAt!.localeCompare(b.dueAt!))} all={all} rows={rows} /> : <p className="muted">{t.tracker.noDates}</p>}
                  </section>
                ) : view === 'goals' ? (
                  <OwnGoals goals={section.kind === 'department' ? goals.filter(g => g.department?.id === section.id && g.status !== 'dropped') : section.kind === 'mine' ? own.goals : goals.filter(g => g.status !== 'dropped')}
                    label={section.kind === 'department' ? t.tracker.side.goals : t.tracker.views.goals} onOpenGoal={onOpenGoal} />
                ) : <TrackerGraph forest={forest} crumbs={crumbs} top={section.kind === 'department' ? departmentName : t.tracker.graph.all} onCrumb={toCrumb} rows={rows} onOpenGoal={onOpenGoal} stages={pipeline ? { on: stages, onChange: setStageMode } : undefined} />
              )}
              {!making && makeHere}
              {section.kind === 'mine' && waiting}
            </>
          )}
        {onOpenOrchestrator && <button className="btn ghost tr-write" type="button" onClick={onOpenOrchestrator}>{t.tasks.writeOrchestrator}</button>}
      </div>
    </div>
  );
}
