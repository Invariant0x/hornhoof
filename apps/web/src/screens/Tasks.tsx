import { RouteUnavailable, unavailableFailure } from './RouteUnavailable';
import { useId, useRef, useState } from 'react';
import { deptLabel, errorText, useT, type Messages } from '../i18n';
import { mapPeople, useOrg } from '../org';
import { placeName, useTaskDepartments, useTasks, useTurns, useWaitCards } from '../tasks';
import { searchTasks } from '../task-search';
import { ALL_DEPARTMENTS, byDepartment, byRelease, goals, inDepartment, indexGoals, inProgress, NO_DEPARTMENT, summaryOf, type Asks, type Preparing, type Released } from '../task-board';
import type { ComputerAccessDecision, Decisions, MachineAwayCard, MergeDecision, Org, ProposalDecision, TaskDepartments, TaskLine, TurnView } from '../types';
import { Backlog } from '../ui/Backlog';
import { ComputerCard } from '../ui/ComputerCard';
import { MergeCard } from '../ui/MergeCard';
import { Field } from '../ui/Field';
import { CEO_DECIDES } from '../ui/DecidedBy';
import { MachineAway } from '../ui/MachineAway';
import { Requests, wordsAnswer } from '../ui/Requests';
import { StaffCard } from '../ui/StaffCard';
import { StructureCard } from '../ui/StructureCard';
import { BoardSection, Fold, GoalList, GoalRows, Progress, SplitGoals, type CardRows } from '../ui/TaskBoard';
import { WaitCards } from '../ui/WaitCards';

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

/* The departments to pick from: all of them, each department, and for people with the whole company the orchestrator's
   own work. */
function choicesOf(t: Messages, places: TaskDepartments | undefined): Choice[] {
  if (!places) return [];
  const departments = places.departments.map(d => ({ id: d.id, label: deptLabel(t, d) }));
  return [{ id: ALL_DEPARTMENTS, label: t.tasks.board.allDepartments }, ...departments, ...(places.whole ? [{ id: NO_DEPARTMENT, label: t.tasks.board.orchestrator }] : [])];
}

function DepartmentPicker({ choices, value, onChange }: { choices: Choice[]; value: string; onChange: (id: string) => void }) {
  const t = useT();
  return (
    <Field label={t.tasks.department}>
      {p => (
        <select {...p} value={value} onChange={e => onChange(e.target.value)}>
          {choices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      )}
    </Field>
  );
}

const VIEWS = ['active', 'departments', 'releases'] as const;
type View = (typeof VIEWS)[number];

/* Three ways to look at the same work: what is in progress, each department's, and by turn and release. */
function ViewPicker({ value, onChange }: { value: View; onChange: (view: View) => void }) {
  const t = useT();
  const name = useId();
  return (
    <fieldset className="segments board-views">
      <legend className="sr">{t.tasks.board.view}</legend>
      {VIEWS.map(view => (
        <label key={view} className={view === value ? 'on' : ''}>
          <input type="radio" name={name} value={view} checked={view === value} onChange={() => onChange(view)} />
          {t.tasks.board.views[view]}
        </label>
      ))}
    </fieldset>
  );
}

/* What a turn is for and the words it came from on click. */
function TurnAbout({ turn }: { turn: TurnView }) {
  const t = useT();
  return (
    <div className="grp-head">
      <b className="grp-title">{turn.title}</b>
      {turn.goal && turn.goal !== turn.title && <span className="muted">{turn.goal}</span>}
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
    </div>
  );
}

/* The next release of a department: what it is, how many of its goals are done, and its goals in short lines. Its version is
   set by the tag it comes out with, so until then it names the release it follows. */
function NextRelease({ next, rows }: { next: Preparing; rows: CardRows }) {
  const t = useT();
  const { turn, going, done } = next;
  const total = going.length + done.length;
  return (
    <BoardSection heading={t.tasks.board.preparing(turn.number, turn.baseVersion)}>
      <p className="muted">{t.tasks.board.nextWhy}</p>
      <TurnAbout turn={turn} />
      {total > 0 && <Progress done={done.length} total={total} label={t.tasks.board.goalsDone(done.length, total)} wide />}
      {total > 0 ? <GoalRows goals={[...going, ...done]} rows={rows} /> : <p className="muted">{t.tasks.board.noneInTurn}</p>}
    </BoardSection>
  );
}

/* A release out already, folded to one line with how many tasks went into it. */
function ReleasedTurn({ release, rows }: { release: Released; rows: CardRows }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { turn, goals: went } = release;
  return (
    <div className="release-fold">
      <Fold open={open} onToggle={() => setOpen(!open)}>
        <b>{t.tasks.board.released(turn.number, turn.version)}</b> <span className="muted">{t.tasks.board.relCount(went.length)}</span>
      </Fold>
      {open && <GoalRows goals={went} rows={rows} />}
    </div>
  );
}

const SHOWS = ['releases', 'outside'] as const;
type Show = (typeof SHOWS)[number];

/* Releases, or the work outside every release. */
function ShowPicker({ value, onChange }: { value: Show; onChange: (show: Show) => void }) {
  const t = useT();
  const name = useId();
  const label = { releases: t.tasks.board.showReleases, outside: t.tasks.board.showOutside };
  return (
    <fieldset className="segments rel-show">
      <legend>{t.tasks.board.show}</legend>
      {SHOWS.map(show => (
        <label key={show} className={show === value ? 'on' : ''}>
          <input type="radio" name={name} value={show} checked={show === value} onChange={() => onChange(show)} />
          {label[show]}
        </label>
      ))}
    </fieldset>
  );
}

/* Turns and releases: what a turn is, the next release of each department getting ready with its goals counted, and the
   releases out already, folded; or, on its own choice, the work outside every release. Then the list for later turns of a
   department of the person's own. */
function Releases({ tasks, turns, rows, department, places }: { tasks: TaskLine[]; turns: TurnView[]; rows: CardRows; department: string; places: TaskDepartments | undefined }) {
  const t = useT();
  const [show, setShow] = useState<Show>('releases');
  const { preparing, outside, released } = byRelease(tasks, turns, rows.asksYou);
  const mine = places?.departments.filter(d => d.mine) ?? [];
  return (
    <>
      <p className="muted">{t.tasks.board.relsWhy}</p>
      <ShowPicker value={show} onChange={setShow} />
      {show === 'outside' ? (
        <>
          <p className="muted">{t.tasks.board.outsideAbout}</p>
          <SplitGoals split={outside} rows={rows} empty={t.tasks.board.noneOutside} />
        </>
      ) : (
        <>
          {!preparing.length && !released.length && <p className="muted">{t.tasks.board.nothingYet}</p>}
          {preparing.map(next => <NextRelease key={next.turn.id} next={next} rows={rows} />)}
          {released.length > 0 && (
            <BoardSection heading={t.tasks.board.closedReleases}>
              {released.map(release => <ReleasedTurn key={release.turn.id} release={release} rows={rows} />)}
            </BoardSection>
          )}
          {mine.some(d => d.id === department) ? <Backlog departmentId={department} /> : mine.length > 0 && <p className="muted">{t.tasks.board.pickDepartment}</p>}
        </>
      )}
    </>
  );
}

/* By department: every department under its own name with what is in progress in it, the orchestrator's own work last. */
function Departments({ tasks, rows, order, label }: { tasks: TaskLine[]; rows: CardRows; order: string[]; label: (id: string) => string }) {
  const t = useT();
  return (
    <>
      {byDepartment(tasks, order, rows.asksYou).map(section => (
        <BoardSection key={section.id} heading={label(section.id)}>
          <p className="muted">{t.tasks.board.inProgress(section.split.open.length)}</p>
          <SplitGoals split={section.split} rows={rows} empty={t.tasks.board.noneInDepartment} />
        </BoardSection>
      ))}
    </>
  );
}

/* The work of the departments the person reads: a view to pick, a department, a search over every task, the related ones
   too, and the goals with what is under them folded. */
function Board({ tasks, turns, places, rows }: { tasks: TaskLine[] | undefined; turns: TurnView[] | undefined; places: TaskDepartments | undefined; rows: CardRows }) {
  const t = useT();
  const [view, setView] = useState<View>('active');
  const [picked, setPicked] = useState(ALL_DEPARTMENTS);
  const [query, setQuery] = useState('');
  const choices = choicesOf(t, places);
  /* What is in progress is every department's: picking one is for the views by department and by release. */
  const picking = view !== 'active' && choices.length > 1;
  const department = picking && choices.some(c => c.id === picked) ? picked : ALL_DEPARTMENTS;
  const shown = inDepartment(tasks ?? [], department);
  const shownTurns = (turns ?? []).filter(turn => department === ALL_DEPARTMENTS || turn.departmentId === department);
  const order = (places?.departments ?? []).map(d => d.id).filter(id => department === ALL_DEPARTMENTS || id === department);
  const label = (id: string) => choices.find(c => c.id === id)?.label ?? '';
  const found = query.trim() ? searchTasks(shown, query) : null;
  const every = indexGoals(goals(shown));
  const ready = tasks !== undefined && turns !== undefined;
  return (
    <section className="board" aria-label={t.tasks.board.label}>
      <ViewPicker value={view} onChange={setView} />
      <div className="board-tools">
        {picking && <DepartmentPicker choices={choices} value={department} onChange={setPicked} />}
        <TaskSearch query={query} onChange={setQuery} />
      </div>
      {found ? (
        <BoardSection heading={t.tasks.searchResults}>
          {found.length ? <GoalList goals={found.map(task => every.get(task.id)!)} rows={rows} /> : <p className="muted" role="status">{t.tasks.noSearchResults}</p>}
        </BoardSection>
      ) : ready && (
        <>
          {view === 'active' && <SplitGoals split={inProgress(shown, rows.asksYou)} rows={rows} empty={t.tasks.board.noneActive} />}
          {view === 'departments' && <Departments tasks={shown} rows={rows} order={order} label={label} />}
          {view === 'releases' && <Releases tasks={shown} turns={shownTurns} rows={rows} department={department} places={places} />}
        </>
      )}
    </section>
  );
}

/* Under the heading, at a glance: how many goals wait for the person's answer, how many go on now, and how many results
   the next releases already hold. */
function AtAGlance({ tasks, turns, asksYou }: { tasks: TaskLine[]; turns: TurnView[]; asksYou: Asks }) {
  const t = useT();
  const words = t.tasks.board.summary;
  const { waitingYou, working, ready } = summaryOf(tasks, turns, asksYou);
  return (
    <ul className="summary" aria-label={words.label}>
      <li className={`sum you${waitingYou ? '' : ' calm'}`}><b>{waitingYou}</b> <span>{waitingYou ? words.you : words.youNone}</span></li>
      <li className="sum"><b>{working}</b> <span>{words.running}</span></li>
      <li className="sum"><b>{ready}</b> <span>{words.ready}</span></li>
    </ul>
  );
}

type Waiting = Pick<Props, 'decisions' | 'decisionsFailure' | 'onDecisionsChanged' | 'personId' | 'onClearPerson' | 'onOpenTask' | 'onOpenAgent' | 'onOpenOrchestrator'> & {
  org: Org | null;
  place: (p: TaskLine['department']) => string;
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

/* What waits for the person: what agents ask, the orchestrator's cards and his request for the computer, and the cards
   Hornhoof kept for them. Opened from a person's card, only that person's decisions, with the filter in sight. */
function WaitingForYou({ decisions, decisionsFailure, personId, onClearPerson, ...rest }: Waiting) {
  const t = useT();
  const [failure, setFailure] = useState<unknown>(null);
  const { cards: kept, load: reloadCards } = useWaitCards();
  const shown = shownOf(decisions, personId);
  const cards = personId ? [] : (kept ?? []);
  const name = mapPeople(rest.org).find(p => p.id === personId)?.name ?? t.tasks.someone;

  return (
    <section className="waiting" aria-label={t.tasks.waiting}>
      <h2>{t.tasks.waiting}</h2>
      {personId && <PersonFilter name={name} onClear={onClearPerson} />}
      <DecisionList shown={shown} onFailure={setFailure} {...rest} />
      <WaitCards cards={cards} onOpenTask={rest.onOpenTask} onSeen={reloadCards} />
      {decisions && shownNone(shown) && !cards.length && <p className="muted">{personId ? t.tasks.nothingFor(name) : t.tasks.nothingWaiting}</p>}
      <DecisionsFailure failure={decisionsFailure} onRetry={rest.onDecisionsChanged} />
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </section>
  );
}

/* The tracker: what waits for the person, then the goals of every department with the work under them folded, to look at
   by what is in progress, by department or by turn and release. Everyone of the company reads every department's work. */
export function Tasks({ decisions, decisionsFailure, onDecisionsChanged, personId, onClearPerson, selected, onOpenTask, onOpenAgent, onOpenOrchestrator, onHome }: Props) {
  const t = useT();
  const { org } = useOrg();
  const { taskDepartments, failure: placesFailure } = useTaskDepartments();
  const { tasks, failure } = useTasks({ status: 'all' });
  const { turns, failure: turnsFailure } = useTurns();
  const place = (p: TaskLine['department']) => placeName(t, org, p);
  const asking = new Set((decisions?.requests ?? []).filter(r => r.canAnswer).map(r => r.task.id));
  const rows: CardRows = {
    selected, onOpenTask, place: (task: TaskLine) => [task.department ? place(task.department) : t.tasks.board.orchestrator, task.product?.name].filter(Boolean).join(' / '),
    asksYou: id => asking.has(id),
  };
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
          <button className="btn ghost" type="button" onClick={onOpenOrchestrator}>
            {t.tasks.writeOrchestrator}
          </button>
        )}
      </header>
      {tasks && turns && <AtAGlance tasks={tasks} turns={turns} asksYou={rows.asksYou!} />}

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

      {broken !== null && <p className="alert" role="alert">{errorText(t, broken)}</p>}
      <Board tasks={tasks} turns={turns} places={taskDepartments} rows={rows} />
    </section>
  );
}
