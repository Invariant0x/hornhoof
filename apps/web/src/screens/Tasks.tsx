import { RouteUnavailable, unavailableFailure } from './RouteUnavailable';
import { useId, useRef, useState } from 'react';
import { api } from '../api';
import { deptLabel, errorText, useT, type Messages } from '../i18n';
import { mapPeople, useOrg } from '../org';
import { placeName, useTaskDepartments, useTasks, useTurns } from '../tasks';
import { searchTasks } from '../task-search';
import type { Decisions, MachineAwayCard, Org, ProposalDecision, TaskDepartments, TaskLine, TaskStatus, TurnMode as Mode, TurnView } from '../types';
import { Backlog } from '../ui/Backlog';
import { ComputerCard } from '../ui/ComputerCard';
import { Field } from '../ui/Field';
import { CEO_DECIDES } from '../ui/DecidedBy';
import { MachineAway } from '../ui/MachineAway';
import { Requests, wordsAnswer } from '../ui/Requests';
import { StaffCard } from '../ui/StaffCard';
import { StructureCard } from '../ui/StructureCard';
import { TaskTable, type TaskGroup } from '../ui/TaskTable';
import { TurnProgress } from '../ui/TurnProgress';

type Props = {
  onHome?: () => void;
  decisions: Decisions | undefined;
  decisionsFailure?: unknown;
  onDecisionsChanged: () => void;
  /* Opened from a person's card: only that person's decisions show until the filter is taken off. */
  personId: string | null;
  onClearPerson: () => void;
  selected: string | null;
  onOpenTask: (id: string) => void;
  onOpenAgent: (id: string) => void;
  /* Only for people who see the whole company: they are the ones who write to him. */
  onOpenOrchestrator?: () => void;
};

const CLOSED: TaskStatus[] = ['done', 'cancelled'];
const NONE = 'none';

function TaskSearch({ query, onChange }: { query: string; onChange: (query: string) => void }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  return (
    <Field label={t.tasks.search}>
      {p => (
        <div className="task-search">
          <input {...p} ref={input} type="search" autoComplete="off" placeholder={t.tasks.searchPlaceholder} value={query} onChange={e => onChange(e.target.value)} />
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

type Choice = { id: string; label: string };

/* The departments whose tasks the person reads, and the orchestrator's own work for those with the whole company. */
function choicesOf(t: Messages, places: TaskDepartments | undefined): Choice[] {
  if (!places) return [];
  const departments = places.departments.map(d => ({ id: d.id, label: deptLabel(t, d) }));
  return places.whole ? [...departments, { id: NONE, label: t.tasks.noDepartment }] : departments;
}

/* Which department's tasks show. Someone with one department sees its name and has nothing to pick. */
function DepartmentPicker({ choices, value, onChange }: { choices: Choice[]; value: string | null; onChange: (id: string) => void }) {
  const t = useT();
  const name = useId();
  if (choices.length === 1) return <p className="dept-one"><span className="muted">{t.tasks.department}</span> <b>{choices[0]!.label}</b></p>;
  return (
    <fieldset className="segments dept-pick">
      <legend className="sr">{t.tasks.department}</legend>
      {choices.map(c => (
        <label key={c.id} className={c.id === value ? 'on' : ''}>
          <input type="radio" name={name} value={c.id} checked={c.id === value} onChange={() => onChange(c.id)} />
          {c.label}
        </label>
      ))}
    </fieldset>
  );
}

/* How a turn runs. A person who sees the whole company or owns the turn's department picks it while the turn is planned;
   once it starts it stays as it is, so only its words show. */
function TurnModeOf({ turn }: { turn: TurnView }) {
  const t = useT();
  const id = useId();
  const [failure, setFailure] = useState<unknown>(null);
  if (!turn.canChangeMode || turn.status !== 'planned') return <small className="turn-wait">{t.tasks.turnModeIs[turn.mode]}</small>;
  async function change(mode: Mode) {
    setFailure(null);
    try {
      await api.patch(`/api/turns/${turn.number}`, { mode });
    } catch (err) {
      setFailure(err);
    }
  }
  return (
    <span className="turn-mode">
      <label htmlFor={id}>{t.tasks.turnMode}</label>
      <select id={id} value={turn.mode} onChange={e => void change(e.target.value as Mode)}>
        <option value="echelons">{t.tasks.turnModes.echelons}</option>
        <option value="turnkey">{t.tasks.turnModes.turnkey}</option>
      </select>
      {failure !== null && <span className="alert" role="alert">{errorText(t, failure)}</span>}
    </span>
  );
}

/* A turn's head in the table: its number and state, its title and main point, how it runs, how far the whole turn is, and
   the words it came from on click. */
function TurnHead({ turn }: { turn: TurnView }) {
  const t = useT();
  return (
    <span className="grp-head">
      <span className="turn-no">
        <b>{t.tasks.turn(turn.number)}</b>
        <span className={`turn-state ${turn.status}`}>{t.tasks.turnStates[turn.status]}</span>
      </span>
      <b className="grp-title">{turn.title}</b>
      {turn.goal && turn.goal !== turn.title && <span className="muted">{turn.goal}</span>}
      <TurnModeOf turn={turn} />
      {turn.status === 'planned' ? <small className="turn-wait">{t.tasks.plannedTasks(turn.tasks.total)}</small> : <TurnProgress tasks={turn.tasks} />}
      {turn.messages.length > 0 && (
        <details className="turn-words" onClick={e => e.stopPropagation()}>
          <summary>{t.tasks.words(turn.messages.length)}</summary>
          {turn.messages.map((m, i) => (
            <blockquote key={`${i}-${m.at}`}>
              <cite>{m.by}</cite>
              <p>{m.text}</p>
            </blockquote>
          ))}
        </details>
      )}
    </span>
  );
}

/* The groups of the department's table: its running turn and its planned ones with what is given outside turns, and apart
   from them what is over, folded. Each department runs its own turns: one of its own shows even with nothing in it yet,
   another department's only while it holds a task of this one. */
function groupsOf(t: Messages, department: string, tasks: TaskLine[], turns: TurnView[]): { now: TaskGroup[]; past: TaskGroup[] } {
  const of = (turn: TurnView) => tasks.filter(x => x.turn === turn.number);
  const turnGroup = (turn: TurnView, folded = false): TaskGroup => ({ key: turn.id, head: <TurnHead turn={turn} />, tasks: of(turn), folded, empty: t.tasks.table.noneHere });
  const outside = tasks.filter(x => x.turn === null);
  const open = outside.filter(x => !CLOSED.includes(x.status));
  const closed = outside.filter(x => CLOSED.includes(x.status));
  const now = [
    ...turns.filter(x => x.status !== 'closed' && (x.departmentId === department || of(x).length)).map(turn => turnGroup(turn)),
    ...(open.length ? [{ key: 'outside', head: <b className="grp-title">{t.tasks.table.outside}</b>, tasks: open }] : []),
  ];
  const past = [
    ...turns.filter(x => x.status === 'closed' && of(x).length).reverse().map(turn => turnGroup(turn, true)),
    ...(closed.length ? [{ key: 'closed-outside', head: <b className="grp-title">{t.tasks.table.closedOutside(closed.length)}</b>, tasks: closed, folded: true }] : []),
  ];
  return { now, past };
}

/* The department's tasks: a search over all of them, or the tables by turn with the department's list for later turns
   between what runs and what is over. */
function DepartmentTasks({ department, tasks, turns, rows }: { department: string; tasks: TaskLine[] | undefined; turns: TurnView[] | undefined; rows: Omit<Rows, 'all'> }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const all = tasks ?? [];
  const table = { ...rows, all };
  const { now, past } = groupsOf(t, department, all, turns ?? []);
  const found = query.trim() ? searchTasks(all, query) : null;
  return (
    <>
      <TaskSearch query={query} onChange={setQuery} />
      {found ? (
        <>
          {!found.length && <p className="muted" role="status">{t.tasks.noSearchResults}</p>}
          {found.length > 0 && <TaskTable {...table} label={t.tasks.searchResults} groups={[{ key: 'found', head: <b className="grp-title">{t.tasks.searchResults}</b>, tasks: found, found: true }]} />}
        </>
      ) : (
        <>
          {tasks && turns && !now.length && !past.length && <p className="muted">{t.tasks.noTurns}</p>}
          <TaskTable {...table} label={t.tasks.table.current} groups={now} />
          {department !== NONE && <Backlog departmentId={department} />}
          <TaskTable {...table} label={t.tasks.table.finished} groups={past} />
        </>
      )}
    </>
  );
}

type Rows = { all: TaskLine[]; selected: string | null; onOpenTask: (id: string) => void; place: (task: TaskLine) => string };

type Waiting = Pick<Props, 'decisions' | 'decisionsFailure' | 'onDecisionsChanged' | 'personId' | 'onClearPerson' | 'onOpenTask' | 'onOpenAgent' | 'onOpenOrchestrator'> & {
  org: Org | null;
  place: (p: TaskLine['department']) => string;
};

type Shown = Pick<Decisions, 'requests' | 'proposals' | 'computerAccess'> & { machinesAway: MachineAwayCard[] };

function ownedItems<T extends { ownerPersonId: string }>(items: T[], personId: string | null): T[] {
  return personId ? items.filter(i => i.ownerPersonId === personId) : items;
}

/* What of the decisions the screen lists: all of them, or one person's; nothing before the first answer. */
function shownOf(decisions: Decisions | undefined, personId: string | null): Shown {
  if (!decisions) return { requests: [], proposals: [], computerAccess: null, machinesAway: [] };
  const theirs = <T extends { ownerPersonId: string }>(items: T[]) => ownedItems(items, personId);
  const computer = decisions.computerAccess ? theirs([decisions.computerAccess]) : [];
  return { requests: theirs(decisions.requests ?? []), proposals: theirs(decisions.proposals ?? []), computerAccess: computer[0] ?? null, machinesAway: decisions.machinesAway ?? [] };
}

const shownNone = (s: Shown) => !s.requests.length && !s.proposals.length && !s.computerAccess && !s.machinesAway.some(m => !m.back);

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
  const { requests, proposals, computerAccess, machinesAway } = shown;
  return (
    <>
      <MachineAway machines={machinesAway} />
      {requests.length > 0 && <Requests requests={requests} onChanged={onDecisionsChanged} onOpenTask={onOpenTask} onOpenAgent={onOpenAgent} placeName={place} />}
      {wordsAnswer(requests) && <p className="muted">{t.tasks.answerElsewhere}</p>}
      {proposals.map(c => (
        <ProposalCard key={c.id} card={c} org={org} onCorrect={onOpenOrchestrator} onDone={onDecisionsChanged} />
      ))}
      {computerAccess && <ComputerCard view={computerAccess.view} onChange={onDecisionsChanged} onFailure={onFailure} />}
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

/* What waits for the person: what agents ask, the orchestrator's cards and his request for the computer. Opened from a
   person's card, only theirs, with the filter in sight. */
function WaitingForYou({ decisions, decisionsFailure, personId, onClearPerson, ...rest }: Waiting) {
  const t = useT();
  const [failure, setFailure] = useState<unknown>(null);
  const shown = shownOf(decisions, personId);
  const name = mapPeople(rest.org).find(p => p.id === personId)?.name ?? t.tasks.someone;

  return (
    <section className="waiting" aria-label={t.tasks.waiting}>
      <h2>{t.tasks.waiting}</h2>
      {personId && <PersonFilter name={name} onClear={onClearPerson} />}
      <DecisionList shown={shown} onFailure={setFailure} {...rest} />
      {decisions && shownNone(shown) && <p className="muted">{personId ? t.tasks.nothingFor(name) : t.tasks.nothingWaiting}</p>}
      <DecisionsFailure failure={decisionsFailure} onRetry={rest.onDecisionsChanged} />
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </section>
  );
}

/* The tracker shows a department's work: what waits for the person, then the department's tasks in a table by turn, its
   list for later turns and what is over. People read only the departments they have. */
export function Tasks({ decisions, decisionsFailure, onDecisionsChanged, personId, onClearPerson, selected, onOpenTask, onOpenAgent, onOpenOrchestrator, onHome }: Props) {
  const t = useT();
  const { org } = useOrg();
  const { taskDepartments, failure: placesFailure } = useTaskDepartments();
  const [picked, setPicked] = useState<string | null>(null);
  const choices = choicesOf(t, taskDepartments);
  const department = choices.find(c => c.id === picked)?.id ?? choices[0]?.id ?? null;
  const { tasks, failure } = useTasks({ status: 'all', department: department ?? NONE }, department !== null);
  const { turns, failure: turnsFailure } = useTurns();
  const place = (p: TaskLine['department']) => placeName(t, org, p);
  const rows = { selected, onOpenTask, place: (task: TaskLine) => [department === NONE ? place(task.department) : null, task.product?.name].filter(Boolean).join(' / ') };
  const broken = placesFailure ?? failure ?? turnsFailure;
  if (unavailableFailure(broken)) return <RouteUnavailable onHome={onHome} />;

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

      <WaitingForYou
        decisions={decisions}
        decisionsFailure={decisionsFailure}
        onDecisionsChanged={onDecisionsChanged}
        personId={personId}
        onClearPerson={onClearPerson}
        onOpenTask={onOpenTask}
        onOpenAgent={onOpenAgent}
        onOpenOrchestrator={onOpenOrchestrator}
        org={org}
        place={place}
      />

      <DepartmentPicker choices={choices} value={department} onChange={setPicked} />
      {taskDepartments && !choices.length && <p className="muted">{t.tasks.noDepartments}</p>}
      {broken !== null && <p className="alert" role="alert">{errorText(t, broken)}</p>}
      {department && <DepartmentTasks key={department} department={department} tasks={tasks} turns={turns} rows={rows} />}
    </section>
  );
}
