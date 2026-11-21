import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { deptLabel, errorText, useLanguage, useT, type Messages } from '../i18n';
import { mapPeople, useOrg } from '../org';
import type { TrackerPlace } from '../routes';
import { searchTasks } from '../task-search';
import { placeName, useGoals, usePipelines, useTaskDepartments, useTasks, useWaitCards } from '../tasks';
import { doerOf, filterTasks, graphPath, graphTree, mine, personWaited, pipelineTree, pruneGoals, shownDecisions, TRACKER_VIEWS, waitingOn, waitingOnPeople, waitsCount, withoutRequestWaits, workingNow, BOARD_STATUSES, boardStatus, type Crumb, type DecisionsOf, type GraphNode, type ShownDecisions, type WorkFilter } from '../tracker';
import type { Decisions, Department, Me, Org, PersonRef, Pipeline, PipelineStage, ProposalDecision, TaskDepartments, TaskDetail, TaskLine, WaitCard, WaitingRequest } from '../types';
import { CEO_DECIDES, DecidedByNote } from '../ui/DecidedBy';
import { Field } from '../ui/Field';
import { programOf, TrackerIcon } from '../ui/icons';
import { DepartmentMark, PersonMark } from '../ui/TrackerMarks';
import { shownLoadFailure, useLoadFailure, useUpdateSaysIt } from '../ui/LoadFailure';
import { Busy, Hold, LoadState, noneYet, useHeldRows, useLoad, type Load, type LoadPart } from '../ui/Loading';
import { CopySchemaFailure, MachineAway } from '../ui/MachineAway';
import { MachineLow } from '../ui/MachineLow';
import { MergeCard } from '../ui/MergeCard';
import { namedReadOnly, Requests, wordsAnswer } from '../ui/Requests';
import { StaffCard } from '../ui/StaffCard';
import { StructureCard } from '../ui/StructureCard';
import { GoalForm, PipelineForm, TrackerNewTask } from '../ui/TrackerForms';
import { TrackerSide } from '../ui/TrackerSide';
import { HeldList, TrackerBoard, TrackerFound, TrackerGoals, TrackerGraph, TrackerList, type Rows } from '../ui/TrackerViews';
import { TurnsAndReleases } from '../ui/TurnsAndReleases';
import { sinceSeconds, spanText, waitText } from '../ui/tracker-words';
import { cardWords, WaitCards } from '../ui/WaitCards';
import { WaitingQueue, type WaitQueueEntry } from '../ui/WaitingQueue';
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

/* The page stays where the person scrolled it as the card opens or closes and the work narrows for it or widens back (no
   anchoring moves it: overflow-anchor: none, and WebKit has none). Only when the row or card of that task would leave the
   screen, as the titles above it wrap anew, does the page scroll, as little as brings it whole into sight. */
const rowOf = (id: string) => [...document.querySelectorAll<HTMLElement>('.tracker [data-task]')].find(row => row.dataset.task === id) ?? null;
/* A server without goals, pipelines or kept cards yet answers that it has none, which is no failure. */
const tracked = (f: unknown) => (noneYet(f) ? null : f);

/* A list as a part of the tracker's load, the goals or the kept cards: a server without it yet has none. */
const listPart = (list: unknown, failure: unknown, load: () => unknown): LoadPart => ({ data: list ?? (noneYet(failure) ? [] : undefined), failure: tracked(failure), load });

type TrackerReads = { places: unknown; tasks: unknown; tasksFailure: unknown; goals: unknown; goalsFailure: unknown; pipelinesFailure: unknown };

/* What the tracker could not load, said on top of the page. What the work and the goals did not bring stands where they
   would instead, while they have not come. */
function brokenOf(r: TrackerReads, updateSaysIt: boolean): unknown {
  const shown = (f: unknown) => shownLoadFailure(f, updateSaysIt);
  return shown(r.places) ?? (r.tasks ? shown(r.tasksFailure) : null) ?? (r.goals ? shown(tracked(r.goalsFailure)) : null) ?? shown(tracked(r.pipelinesFailure));
}

function useRowInSight(selected: string | null) {
  const last = useRef(selected);
  useLayoutEffect(() => {
    const id = selected ?? last.current;
    const changed = last.current !== selected;
    last.current = selected;
    const row = changed && id ? rowOf(id) : null;
    const line = row?.querySelector<HTMLElement>(':scope > .tr-cells') ?? row;
    const page = row?.closest<HTMLElement>('.body');
    if (!line || !page) return;
    const [at, view] = [line.getBoundingClientRect(), page.getBoundingClientRect()];
    const top = view.top + page.clientTop, bottom = top + page.clientHeight;
    /* Whole pixels, rounded out: WebKit keeps a whole scroll offset and would leave a part of a pixel out of sight. */
    if (at.top < top) page.scrollTop -= Math.ceil(top - at.top);
    else if (at.bottom > bottom) page.scrollTop += Math.min(Math.ceil(at.bottom - bottom), Math.floor(at.top - top));
  }, [selected]);
}

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
  /* Whose: the person looked at, whom the page's title names, or the viewer with none. */
  personId: string | null;
  queue: boolean;
  /* The tasks that wait for that person. */
  tasks: TaskLine[];
  recipient: string;
  /* The cards Hornhoof kept for the viewer, which the screen also counts. */
  kept: WaitCard[] | undefined;
  onCardsSeen: () => void;
  /* What else the section waits for before it says anything, its tasks among them; live: it is the page's one status. */
  sources: LoadPart[];
  live: boolean;
};

/* What waits lists the decisions of the person picked, or with none the viewer's own. */
const decisionsOfWho = (personId: string | null): DecisionsOf => personId ? { person: personId } : 'viewer';

const shownNone = (s: ShownDecisions) => !s.requests.length && !s.proposals.length && !s.merges.length;

const taskTitle = (task: Pick<TaskLine, 'number' | 'title'>) => `#${task.number} ${task.title}`;
const requestIcon = { question: 'waits', approval: 'list', choice: 'branch', stuck: 'failure' } as const;
const age = (t: Messages, at: string) => spanText(t, sinceSeconds(at));

const nothing = () => {};

/* Tasks a search found or that have a date, once the tasks came: until then the room holds the indicator, so it never says
   that there are none while they may still come. */
function FoundList({ load, tasks, all, rows, none }: { load: Load; tasks: TaskLine[]; all: TaskLine[]; rows: Rows; none: string }) {
  const t = useT();
  const shown = tasks.length ? <TrackerFound tasks={tasks} all={all} rows={rows} /> : <p className="muted" role="status">{none}</p>;
  return <Hold load={load}>{load.phase === 'done' ? shown : <Busy ring={load.ring} words={t.load.tasks} />}</Hold>;
}

/* The work of a view, held while it comes (style book 1.5, section 4): the list holds its rows at their final size, as many
   as it showed last in this tab; the board and the graph hold the ring where they will stand. Once it came, it fades in. */
function HeldWork({ load, view, list, shown, children }: { load: Load; view: string; list: string; shown: number; children: ReactNode }) {
  const t = useT();
  const done = load.phase === 'done';
  const rows = useHeldRows(list, done && view === 'list' ? shown : null);
  return (
    <Hold load={load} className="tr-hold" keep={view === 'list'}>
      {done ? children : view === 'list' ? <HeldList rows={rows} load={load} /> : <Busy ring={load.ring} words={t.load.tasks} />}
    </Hold>
  );
}

/* Who takes a card this person may not take; nothing for one they take. */
const lockOf = (card: ProposalDecision) => (card.canAnswer ? undefined : (card.decidedBy ?? CEO_DECIDES));

/* An orchestrator's card as his window shows it: a structure to build, or people to hire into a department. Correcting it
   in words opens his window. waitsFor: whom it waits for, where the list says so. */
function ProposalCard({ card, org, onCorrect = nothing, onDone, waitsFor }: { card: ProposalDecision; org: Org | null; onCorrect?: () => void; onDone: () => void; waitsFor?: string }) {
  const t = useT();
  const locked = lockOf(card);
  if (card.kind === 'structure') return <StructureCard proposal={{ id: card.id, brief: card.brief, items: card.items, ...{ materialRevision: card.materialRevision, materialDigest: card.materialDigest } }} departments={org?.departments ?? []} onCorrect={onCorrect} onDone={onDone} locked={locked} waitsFor={waitsFor} />;
  if (!card.department) return null;
  const known = org?.departments.find(d => d.id === card.department!.id);
  const department = { id: card.department.id, name: known ? deptLabel(t, known) : card.department.name };
  return <StaffCard department={department} proposal={{ id: card.id, brief: card.brief, people: card.items, ...{ materialRevision: card.materialRevision, materialDigest: card.materialDigest } }} onCorrect={onCorrect} onDone={onDone} locked={locked} waitsFor={waitsFor} />;
}

type Listed = Pick<Waiting, 'onDecisionsChanged' | 'onOpenTask' | 'onOpenAgent' | 'onOpenOrchestrator' | 'org' | 'place'> & {
  shown: ShownDecisions;
  onFailure: (err: unknown) => void;
  /* Whom a decision waits for, by the person it is for, on lists of more people than one. */
  waitsFor?: (personId: string) => string;
};

/* Each decision with the buttons it has elsewhere. */
function DecisionList({ shown, onDecisionsChanged, onOpenTask, onOpenAgent, onOpenOrchestrator, org, place, onFailure, waitsFor }: Listed) {
  const t = useT();
  const { requests, proposals, merges } = shown;
  return (
    <>
      {requests.length > 0 && <Requests requests={requests} onChanged={onDecisionsChanged} onOpenTask={onOpenTask} onOpenAgent={onOpenAgent} placeName={place} waitsFor={waitsFor} />}
      {wordsAnswer(requests) && <p className="muted">{t.tasks.answerElsewhere}</p>}
      {proposals.map(c => (
        <ProposalCard key={c.id} card={c} org={org} onCorrect={onOpenOrchestrator} onDone={onDecisionsChanged} waitsFor={waitsFor?.(c.ownerPersonId)} />
      ))}
      {merges.map(merge => (
        <MergeCard key={merge.id} merge={merge} onChange={onDecisionsChanged} onFailure={onFailure} waitsFor={waitsFor?.(merge.ownerPersonId)} />
      ))}
    </>
  );
}

function NamedQuestionRow({ request, person, onOpenTask }: { request: WaitingRequest; person?: PersonRef | null; onOpenTask: (id: string) => void }) {
  const t = useT();
  return (
    <article className="entry wait-question" aria-label={taskTitle(request.task)}>
      <div className="wait-question-copy">
        <p className="wait-question-text" dir="auto">{request.text}</p>
        <div className="wait-meta">
          <bdi>{t.tasks.queue.asked}</bdi>
          {person && <PersonMark person={person} decorative />}
          <bdi>{person?.name ?? t.tasks.someone}</bdi>
          <span aria-hidden="true">·</span><bdi dir="ltr">#{request.task.number}</bdi>
          <span aria-hidden="true">·</span><bdi>{age(t, request.at)}</bdi>
        </div>
        <DecidedByNote by={request.decidedBy} />
      </div>
      <div className="entry-actions">
        <button className="btn ghost" type="button" onClick={() => onOpenTask(request.task.id)}>{t.tasks.queue.open}</button>
      </div>
    </article>
  );
}

const queueDone = (done: () => void, refresh: () => void) => () => { done(); refresh(); };

function QueueDeck({ shown, tasks, cards, recipient, onCardsSeen, onDecisionsChanged, onOpenTask, onOpenAgent, onOpenOrchestrator, org, place, onFailure }: Omit<Listed, 'waitsFor'> & {
  tasks: TaskLine[];
  cards: WaitCard[];
  recipient: string;
  onCardsSeen: () => void;
}) {
  const t = useT();
  const deferButton = (defer: () => void) => <div className="entry-actions"><button className="btn ghost" type="button" onClick={defer}>{t.tasks.queue.defer}</button></div>;
  const items: WaitQueueEntry[] = [
    ...shown.requests.map(request => ({
      id: `request:${request.id}`, title: taskTitle(request.task), icon: requestIcon[request.kind],
      text: request.kind === 'stuck' ? t.tasks.stuckText(request.agent.name, request.task.number) : request.text,
      meta: <><bdi>{request.agent.name}</bdi><span aria-hidden="true">·</span><bdi dir="ltr">#{request.task.number}</bdi><span aria-hidden="true">·</span><bdi>{age(t, request.at)}</bdi></>,
      show: (done: () => void, defer: () => void) => <Requests requests={[request]} onChanged={queueDone(done, onDecisionsChanged)} onDefer={defer} onOpenTask={onOpenTask} onOpenAgent={onOpenAgent} placeName={place} />,
    })),
    ...shown.proposals.map(card => ({
      id: `proposal:${card.id}`, title: card.department ? t.staff.title(card.department.name) : t.card.title, text: card.brief, icon: 'list' as const,
      meta: <><bdi>{card.agent.name}</bdi><span aria-hidden="true">·</span><bdi>{age(t, card.at)}</bdi></>,
      show: (done: () => void, defer: () => void) => <><ProposalCard card={card} org={org} onCorrect={onOpenOrchestrator} onDone={queueDone(done, onDecisionsChanged)} />{deferButton(defer)}</>,
    })),
    ...shown.merges.map(merge => ({
      id: `merge:${merge.id}`, title: merge.label, text: merge.label, meta: null, icon: 'branch' as const,
      show: (_done: () => void, defer: () => void) => <><MergeCard merge={merge} onChange={onDecisionsChanged} onFailure={onFailure} />{deferButton(defer)}</>,
    })),
    ...cards.map(card => {
      const { title, text } = cardWords(t, card);
      return {
        id: `card:${card.id}`, title, text, meta: age(t, card.at), icon: 'waits' as const,
        show: (done: () => void, defer: () => void) => <><WaitCards cards={[card]} onOpenTask={onOpenTask} onSeen={queueDone(done, onCardsSeen)} />{deferButton(defer)}</>,
      };
    }),
    ...tasks.map(task => {
      const wait = waitText(t, task, undefined, recipient);
      return {
        id: `task:${task.id}`, title: taskTitle(task), text: task.title, meta: wait, icon: 'waits' as const,
        show: (_done: () => void, defer: () => void) => <>
          <p className="wait-meta">{wait}</p>
          <p dir="auto">{taskTitle(task)}</p>
          <div className="entry-actions">
            <button className="btn" type="button" onClick={() => onOpenTask(task.id)}>{t.tasks.cards.open}</button>
            <button className="btn ghost" type="button" onClick={defer}>{t.tasks.queue.defer}</button>
          </div>
        </>,
      };
    }),
  ];
  return <WaitingQueue items={items} />;
}

function DecisionsFailure({ failure, onRetry }: { failure: unknown; onRetry: () => void }) {
  const t = useT();
  const shown = useLoadFailure(failure);
  if (shown === null) return null;
  return <div className="notebook-unread">
    <p className="alert" role="alert">{errorText(t, shown)}</p>
    <button className="btn small ghost" type="button" onClick={onRetry}>{t.app.tryAgain}</button>
  </div>;
}

/* What waits for the person, once all of it came: what agents ask, the orchestrator's cards, the cards Hornhoof kept for them,
   and the tasks that wait for them, or that nothing does. */
type PersonalWaiting = Omit<Waiting, 'sources' | 'live' | 'decisionsFailure'> & { onFailure: (failure: unknown) => void };

function PersonalWaitList({ shown, cards, personId, tasks, recipient, onCardsSeen, ...rest }: Omit<Listed, 'waitsFor'> & {
  personId: string | null; tasks: TaskLine[]; cards: WaitCard[]; recipient: string; onCardsSeen: () => void;
}) {
  const t = useT();
  const name = mapPeople(rest.org).find(p => p.id === personId)?.name ?? t.tasks.someone;
  return (
    <>
      <DecisionList shown={shown} {...rest} />
      <WaitCards cards={cards} onOpenTask={rest.onOpenTask} onSeen={onCardsSeen} />
      {tasks.length > 0 && <WaitingTasks tasks={tasks} personOf={() => recipient} heading={personId ? t.tracker.waitTasksOf(name) : t.tracker.waitTasks} onOpenTask={rest.onOpenTask} />}
      {shownNone(shown) && !cards.length && !tasks.length && <p className="muted">{personId ? t.tasks.nothingFor(name) : t.tasks.nothingWaiting}</p>}
    </>
  );
}

function WaitingForYouBody({ decisions, personId, queue, kept, ...rest }: PersonalWaiting) {
  const shown = shownDecisions(decisions, decisionsOfWho(personId));
  const cards = keptShown(kept, personId);
  if (queue && !personId) return <QueueDeck shown={shown} cards={cards} {...rest} />;
  return <PersonalWaitList shown={shown} cards={cards} personId={personId} {...rest} />;
}

/* A section of what waits, under its heading: the shared indicator in its room until every source of it came (the decisions,
   and what else it names), so it never says that nothing waits while something may still come; then what came, which fades
   in. A failure of what came before stays by its section. */
function WaitingSection({ label, heading, load, live, decisions, decisionsFailure, onRetry, failure, children }: {
  label: string; heading: ReactNode; load: Load; live: boolean; decisions: Decisions | undefined; decisionsFailure: unknown; onRetry: () => void; failure: unknown; children: ReactNode;
}) {
  const t = useT();
  return (
    <section className="waiting" aria-label={label}>
      {heading}
      <Hold load={load} className="waiting-hold">
        {load.phase === 'done' ? children : <Busy ring={load.ring} live={live} />}
      </Hold>
      {decisions && <DecisionsFailure failure={decisionsFailure} onRetry={onRetry} />}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </section>
  );
}

/* What waits for the person. For another person, only theirs; the page's title names them, and what waits for everyone else
   is in Waiting for people. */
function WaitingForYou({ sources, live, decisionsFailure, ...rest }: Waiting) {
  const t = useT();
  const [failure, setFailure] = useState<unknown>(null);
  const load = useLoad([{ data: rest.decisions, failure: decisionsFailure, load: rest.onDecisionsChanged }, ...sources]);
  return (
    <WaitingSection label={t.tasks.waiting} heading={<h2>{t.tasks.waiting}</h2>} load={load} live={live} decisions={rest.decisions} decisionsFailure={decisionsFailure} onRetry={rest.onDecisionsChanged} failure={failure}>
      <WaitingForYouBody {...rest} onFailure={setFailure} />
    </WaitingSection>
  );
}

type PeopleWaiting = Pick<Waiting, 'decisions' | 'decisionsFailure' | 'onDecisionsChanged' | 'onOpenTask' | 'onOpenAgent' | 'onOpenOrchestrator' | 'org' | 'place' | 'sources' | 'live'> & {
  allTasks: TaskLine[];
  /* The tasks that wait for any person. */
  tasks: TaskLine[];
  /* The section names itself below the results of a search; the page's title right above names it otherwise. */
  titled: boolean;
};

function namedAddressee({ task, ownerPersonId }: WaitingRequest, people: PersonRef[], tasks: TaskLine[]) {
  const listed = people.find(person => person.id === ownerPersonId);
  if (listed) return listed;
  const line = tasks.find(candidate => candidate.id === task.id);
  const wait = line?.time?.waitsOn.find(({ who }) => who?.kind === 'person' && who.id === ownerPersonId && who.name);
  return wait?.who;
}

/* What waits for people in the company, for those who see the whole of it, once all of it came: every decision the viewer
   sees, each saying whom it waits for, and the tasks that wait for a person. */
function WaitingForPeople({ decisions, decisionsFailure, allTasks, tasks, titled, sources, live, ...rest }: PeopleWaiting) {
  const t = useT();
  const words = t.tracker.peopleWaits;
  const [failure, setFailure] = useState<unknown>(null);
  const load = useLoad([{ data: decisions, failure: decisionsFailure, load: rest.onDecisionsChanged }, ...sources]);
  const shown = shownDecisions(decisions, 'everyone');
  const named = shown.requests.filter(namedReadOnly);
  const actionable = { ...shown, requests: shown.requests.filter(request => !namedReadOnly(request)) };
  const people = mapPeople(rest.org);
  const waitsFor = (personId: string) => {
    const name = people.find(p => p.id === personId)?.name;
    return name ? words.waitingFor(name) : words.waitingForSomeone;
  };
  return (
    <WaitingSection label={words.title} heading={titled && <h2>{words.title}</h2>} load={load} live={live} decisions={decisions} decisionsFailure={decisionsFailure} onRetry={rest.onDecisionsChanged} failure={failure}>
      {named.length > 0 && <div className="reqs">{named.map(request => <NamedQuestionRow key={request.id} request={request} person={namedAddressee(request, people, allTasks)} onOpenTask={rest.onOpenTask} />)}</div>}
      <DecisionList shown={actionable} onFailure={setFailure} waitsFor={waitsFor} {...rest} />
      {tasks.length > 0 && <WaitingTasks tasks={tasks} personOf={personWaited} heading={words.tasks} onOpenTask={rest.onOpenTask} />}
      {shownNone(shown) && !tasks.length && <p className="muted">{words.nothing}</p>}
    </WaitingSection>
  );
}

/* Tasks that wait for a person, each with how long already; personOf: the person whose wait a task's line tells. */
function WaitingTasks({ tasks, personOf, heading, onOpenTask }: { tasks: TaskLine[]; personOf: (task: TaskLine) => string | undefined; heading: string; onOpenTask: (id: string) => void }) {
  const t = useT();
  return (
    <div className="tr-waits">
      <h3>{heading}</h3>
      <ul className="tp-subs">
        {tasks.map(task => (
          <li key={task.id}>
            <button className="linkish" type="button" onClick={() => onOpenTask(task.id)}>#{task.number} {task.title}</button>
            <small dir="auto">{waitText(t, task, undefined, personOf(task))}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* The kept cards are the viewer's own, so they show only while no other person is picked. */
const keptShown = (kept: WaitCard[] | undefined, personId: string | null) => (personId ? [] : (kept ?? []));

/* Which part of the tracker a place is: what waits for a person, the turns, the goals, the due dates, or work to look at as a
   list, a board or a graph. */
type Section =
  | { kind: 'waits' | 'people' | 'failures' | 'turns' | 'mine' | 'working' | 'company' | 'goals' | 'due' }
  | { kind: 'department' | 'responsible' | 'goal' | 'root'; id: string };

/* What waits for people in the company is for those who see the whole company; anyone else asking for it by its address
   gets what waits for them. */
const placeFor = (place: TrackerPlace, company: boolean): TrackerPlace => (company || place.show !== 'people' ? place : { ...place, show: 'waits' });

/* The number beside what waits for people in the company, only for those who see it. */
const peopleCount = (decisions: Decisions | undefined, tasks: TaskLine[], company: boolean) => (company ? waitsCount(shownDecisions(decisions, 'everyone'), tasks, []) : undefined);

/* The pages whose list is what waits; those that show it, under their work too; and those that hold what is being made above
   what they show, as they are not a list of work. */
const WAIT_PAGES = new Set<Section['kind']>(['waits', 'people']);
const WAITS_SHOWN = new Set<Section['kind']>(['waits', 'people', 'mine']);
const MAKE_ON_TOP = new Set<Section['kind']>(['waits', 'people', 'due', 'turns']);

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

type Chips = Pick<WorkFilter, 'status' | 'executor' | 'responsible'>;

/* The mockup's chips: the group by status, the subtasks, the executor and the responsible, each a choice of what the work
   shown holds, or any. */
function FilterChips({ chips, onChange, tasks, subtasks, onSubtasks }: {
  chips: Chips; onChange: (chips: Chips) => void; tasks: TaskLine[];
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
    </div>
  );
}

const VIEW_ICON = { list: 'list', board: 'board', graph: 'branch' } as const;

/* List, Board and Graph, the mockup's three tabs; nothing more on the row. */
function ViewTabs({ value, onChange }: { value: (typeof TRACKER_VIEWS)[number]; onChange: (view: (typeof TRACKER_VIEWS)[number]) => void }) {
  const t = useT();
  const name = useId();
  return (
    <fieldset className="tr-views">
      <legend className="sr">{t.tracker.views.label}</legend>
      {TRACKER_VIEWS.map(view => (
        <label key={view} className={view === value ? 'on' : ''}>
          <input className="sr" type="radio" name={name} value={view} checked={view === value} onChange={() => onChange(view)} />
          <TrackerIcon name={VIEW_ICON[view]} />
          <span>{t.tracker.views[view]}</span>
        </label>
      ))}
    </fieldset>
  );
}

type Making = 'task' | 'goal' | 'pipeline' | 'editPipeline' | null;

/* The departments the person may give a task: where the server says they plan, and a head takes it. */
function plannable(places: TaskDepartments | undefined, org: Org | null): Department[] {
  return (org?.departments ?? []).filter(d => places?.departments.find(p => p.id === d.id)?.mayPlan && d.employees.some(e => e.kind === 'head'));
}

/* What a person may make where they are: a task for the department through its head, a goal of the department or of the
   company, and the department's pipelines, where the server says they plan. A department without a head says so. Away from
   a department, a task goes to one the person picks. */
function mayMake(places: TaskDepartments | undefined, org: Org | null, department: string | null, pipeline: Pipeline | null): { kinds: NonNullable<Making>[]; needsHead: boolean } {
  if (department === null) {
    const kinds: NonNullable<Making>[] = [];
    if (plannable(places, org).length) kinds.push('task');
    if (places?.mayPlanCompany) kinds.push('goal');
    return { kinds, needsHead: false };
  }
  const known = org?.departments.find(d => d.id === department);
  if (!known || !places?.departments.find(d => d.id === department)?.mayPlan) return { kinds: [], needsHead: false };
  const head = known.employees.some(e => e.kind === 'head');
  const kinds: NonNullable<Making>[] = [];
  if (head) kinds.push('task');
  kinds.push('goal', 'pipeline');
  if (pipeline?.mayEdit) kinds.push('editPipeline');
  return { kinds, needsHead: !head };
}

/* A task from a page of no department: the form starts with which of them gets it, the first by default. */
function NewTaskAnywhere({ departments, onCancel, onCreated }: { departments: Department[]; onCancel: () => void; onCreated: (task: TaskDetail) => void }) {
  const t = useT();
  const [id, setId] = useState(departments[0]?.id);
  const department = departments.find(d => d.id === id) ?? departments[0];
  if (!department) return null;
  const place = (
    <Field label={t.tasks.department}>
      {p => (
        <select {...p} value={department.id} onChange={e => setId(e.target.value)}>
          {departments.map(d => <option key={d.id} value={d.id}>{deptLabel(t, d)}</option>)}
        </select>
      )}
    </Field>
  );
  return <TrackerNewTask department={department} place={place} onCancel={onCancel} onCreated={onCreated} />;
}

/* The form of what the person chose to make from the + beside Tasks. */
function MakeHere({ org, places, department, pipeline, loose, making, setMaking, onOpenTask }: {
  org: Org | null; places: TaskDepartments | undefined; department: string | null; pipeline: Pipeline | null; loose: boolean; making: Making; setMaking: (m: Making) => void; onOpenTask: (id: string) => void;
}) {
  const t = useT();
  const known = department ? org?.departments.find(d => d.id === department) : undefined;
  if (!making) return null;
  const close = () => setMaking(null);
  const named = known ? { id: known.id, name: deptLabel(t, known) } : null;
  return (
    <>
      {making === 'task' && known && <TrackerNewTask department={known} pipelineId={loose ? null : pipeline?.id} onCancel={close} onCreated={task => { close(); onOpenTask(task.id); }} />}
      {making === 'task' && department === null && <NewTaskAnywhere departments={plannable(places, org)} onCancel={close} onCreated={task => { close(); onOpenTask(task.id); }} />}
      {making === 'goal' && <GoalForm department={named} onCancel={close} onDone={close} />}
      {making === 'pipeline' && known && <PipelineForm department={known} onCancel={close} onDone={close} />}
      {making === 'editPipeline' && known && pipeline && <PipelineForm key={pipeline.id} pipeline={pipeline} department={known} onCancel={close} onDone={close} />}
    </>
  );
}

/* The machines short of disk space among what waits for people; a server from before sends none. */
const lowMachines = (decisions: Decisions | null | undefined) => decisions?.machinesLow ?? [];

/* The tracker keeps the same task and goal cards across its views. */
export function Tasks({ me, place: asked, onPlace, decisions, decisionsFailure, onDecisionsChanged, selected, onOpenTask, onOpenGoal, onOpenAgent, onOpenOrchestrator, onHome }: Props) {
  const t = useT();
  const company = me.person.scopeKind === 'company';
  const place = placeFor(asked, company);
  const { language } = useLanguage();
  const sideId = useId();
  const { org } = useOrg();
  const { taskDepartments: places, failure: placesFailure } = useTaskDepartments();
  const { tasks, failure, load: loadTasks, cancel: cancelTasks } = useTasks({ status: 'all' });
  const updateSaysIt = useUpdateSaysIt();
  const { goals: goalList, failure: goalsFailure, load: loadGoals } = useGoals();
  /* The work and the goals come with the shared indicator where they will stand, and say why when they do not. A server
     without goals yet answers that it has none. */
  const taskPart: LoadPart = { data: tasks, failure, load: loadTasks, cancel: cancelTasks };
  const tasksLoad = useLoad([taskPart]);
  const goalsLoad = useLoad([listPart(goalList, goalsFailure, loadGoals)]);
  const { pipelines: pipelineList, failure: pipelinesFailure } = usePipelines();
  const [drawer, setDrawer] = useState(false);
  const [query, setQuery] = useState('');
  const [chips, setChips] = useState<Chips>({});
  useRowInSight(selected);
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
  const { cards: kept, failure: keptFailure, load: reloadCards } = useWaitCards();
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
  const pickerPeople = people.filter(p => p.id !== me.person.id && !p.assistant && (p.status === 'active' || p.id === viewed));
  const questions = new Map((decisions?.requests ?? []).filter(r => r.canAnswer && r.ownerPersonId === who).map(r => [r.task.id, r.at]));
  const questionAt = (id: string) => questions.get(id);
  const asksYou = (id: string) => questions.has(id);
  const place_ = (p: TaskLine['department']) => placeName(t, org, p);
  const employees = new Map(org?.departments.flatMap(d => d.employees.map(e => [e.id, e] as const)));
  const working = workingNow(all, org);
  const workingIds = new Set(working.map(task => task.id));
  const rows: Rows = {
    selected, onOpenTask, asksYou, questionAt, placeName: place_, now: id => workingIds.has(id),
    departmentTemplate: id => places?.departments.find(d => d.id === id)?.templateKey ?? org?.departments.find(d => d.id === id)?.templateKey,
    turnkeyOf: id => employees.get(id)?.turnkey,
    stageOwner: (stage: PipelineStage) => org?.departments.flatMap(d => d.roles).find(r => r.id === stage.ownerRole)?.title[language] ?? stage.owner?.name,
    programOf: id => {
      const employee = employees.get(id);
      if (employee?.provider) return programOf(employee.provider, employee.apiProtocol);
      const orchestrator = org?.orchestrator;
      const sub = orchestrator?.id === id ? orchestrator.subscription : null;
      return sub ? programOf(sub.provider, sub.api?.protocol) : null;
    },
  };
  const own = mine(all, goals, who);
  const otherWaits = withoutRequestWaits(all, decisions);
  const waitsOnWho = waitingOn(otherWaits, recipient);
  const waitsOnPeople = waitingOnPeople(otherWaits);
  const failures = all.filter(task => boardStatus(task) === 'failure');
  const machinesAway = decisions?.machinesAway ?? [];
  const copySchemaFailures = decisions?.copySchemaFailures ?? [];
  const machinesLow = lowMachines(decisions);
  const pipeline = place.pipeline ? pipelines.find(p => p.id === place.pipeline) ?? null : null;
  /* The department where the person is: its work, or its goals. */
  const departmentId = section.kind === 'department' ? section.id : section.kind === 'goals' ? place.department : undefined;
  const department = departmentId ? places?.departments.find(d => d.id === departmentId) : undefined;
  const departmentName = departmentId ? (departmentId === 'none' ? t.tracker.side.orchestrator : department ? deptLabel(t, department) : '') : '';

  /* The work of the place, then the filters of the chips over it. */
  const base: { tasks: TaskLine[]; filter: WorkFilter } =
    section.kind === 'mine' ? { tasks: own.tasks, filter: {} }
    : section.kind === 'working' ? { tasks: working, filter: {} }
    : section.kind === 'department' ? { tasks: all, filter: { department: section.id, product: place.product, pipeline: place.pipeline, goal: place.goal } }
    : section.kind === 'responsible' ? { tasks: all, filter: { responsible: section.id } }
    : section.kind === 'goal' ? { tasks: all, filter: { goal: section.id } }
    : section.kind === 'root' ? { tasks: treeOf(section.id, all), filter: {} }
    : section.kind === 'company' ? { tasks: all, filter: {} }
    : section.kind === 'failures' ? { tasks: failures, filter: {} }
    : section.kind === 'due' ? { tasks: all.filter(task => task.dueAt), filter: {} }
    : { tasks: [], filter: {} };
  const view = place.view ?? 'list';
  /* The chips stand over the list only, as in the mockup: the board and the graph show the place's whole work. */
  const work = filterTasks(base.tasks, view === 'list' ? { ...base.filter, ...chips } : base.filter, goals, asksYou);
  const chipTasks = filterTasks(base.tasks, base.filter, goals, asksYou);
  const stages = stageMode ?? Boolean(pipeline);
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
      case 'people': return { title: t.tracker.peopleWaits.title };
      case 'failures': return { title: t.tracker.side.failures };
      case 'working': return { title: t.tracker.where.working };
      case 'turns': return { title: t.tracker.where.turns };
      case 'company': return { title: t.tracker.where.company };
      case 'due': return { title: t.tracker.side.dates };
      case 'goals': return departmentId ? { title: departmentName, within: t.tracker.side.goals } : { title: t.tracker.side.allGoals };
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
  const mainFailure = shownLoadFailure(placesFailure, updateSaysIt) ?? shownLoadFailure(failure, updateSaysIt);
  if (unavailableFailure(mainFailure)) return <RouteUnavailable onHome={onHome} />;
  const broken = brokenOf({ places: placesFailure, tasks, tasksFailure: failure, goals: goalList, goalsFailure, pipelinesFailure }, updateSaysIt);
  /* What waits: for people in the company on their page, else for the person. */
  const waiting = section.kind === 'people' ? (
    <WaitingForPeople
      decisions={decisions}
      decisionsFailure={decisionsFailure}
      onDecisionsChanged={onDecisionsChanged}
      allTasks={all}
      tasks={waitsOnPeople}
      titled={found !== null}
      sources={[taskPart]}
      live={WAIT_PAGES.has(section.kind)}
      onOpenTask={onOpenTask}
      onOpenAgent={onOpenAgent}
      onOpenOrchestrator={onOpenOrchestrator}
      org={org}
      place={place_}
    />
  ) : (
    <WaitingForYou
      decisions={decisions}
      decisionsFailure={decisionsFailure}
      onDecisionsChanged={onDecisionsChanged}
      personId={decisionsOf}
      queue={section.kind === 'waits'}
      tasks={waitsOnWho}
      recipient={recipient}
      kept={kept}
      onCardsSeen={reloadCards}
      sources={[{ ...taskPart, quiet: section.kind === 'mine' }, listPart(kept, keptFailure, reloadCards)]}
      live={WAIT_PAGES.has(section.kind)}
      onOpenTask={onOpenTask}
      onOpenAgent={onOpenAgent}
      onOpenOrchestrator={onOpenOrchestrator}
      org={org}
      place={place_}
    />
  );
  const empty = section.kind === 'mine' ? t.tracker.noMine : section.kind === 'working' ? t.tracker.nothingWorking : t.tracker.noTasks;
  const makeDepartment = departmentId ?? (other ? 'none' : null);
  const makeHere = <MakeHere org={org} places={places} department={makeDepartment} pipeline={pipeline} loose={place.pipeline === 'none'} making={making} setMaking={setMaking} onOpenTask={onOpenTask} />;
  const makeOnTop = found || MAKE_ON_TOP.has(section.kind);
  /* The mockup's one way to make something: the + beside Tasks, on every page, with what the person may make there and the
     orchestrator. */
  const can = mayMake(places, org, makeDepartment, pipeline);
  const makeWords = { task: t.tracker.actions.newTask, goal: t.tracker.actions.newGoal, pipeline: t.tracker.actions.newPipeline, editPipeline: t.tracker.actions.editPipeline };
  const create = {
    note: can.needsHead ? t.dept.needsHead : undefined,
    items: [
      ...can.kinds.map(kind => ({ key: kind, label: makeWords[kind], onChoose: () => setMaking(kind) })),
      ...(onOpenOrchestrator ? [{ key: 'orchestrator', label: t.tasks.writeOrchestrator, onChoose: onOpenOrchestrator }] : []),
    ],
  };
  const shownGoals = goals.filter(g => g.status !== 'dropped' && (!departmentId || g.department?.id === departmentId));
  const { forest, crumbs } = view === 'graph' ? graph() : { forest: [], crumbs: [] };

  return (
    <div className="tracker fit">
      <TrackerSide
        id={sideId}
        place={place}
        onPlace={onPlace}
        onOpenTask={onOpenTask}
        org={org}
        places={places}
        pipelines={pipelines}
        goals={goals}
        tasks={all}
        onOpenAgent={onOpenAgent}
        counts={{
          waits: waitsCount(shownDecisions(decisions, decisionsOfWho(decisionsOf)), waitsOnWho, keptShown(kept, decisionsOf)),
          people: peopleCount(decisions, waitsOnPeople, company),
          failures: failures.length + machinesAway.filter(machine => !machine.back).length + copySchemaFailures.length + machinesLow.length,
          mine: own.tasks.length,
          working: working.length,
        }}
        create={create}
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
                  <span className="tr-person-picker">
                    <span aria-hidden="true" dir="auto">{other ? whoName : t.tracker.viewAsSelf(me.person.name)}</span>
                    <TrackerIcon name="chevron" />
                    <select {...p} value={other ? who : ''} onChange={e => onPlace({ ...place, personId: e.target.value || undefined })}>
                      <option value="">{t.tracker.viewAsSelf(me.person.name)}</option>
                      {pickerPeople.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </span>
                )}
              </Field>
            </div>
          )}
          <div className="tr-search"><TaskSearch query={query} onChange={setQuery} /></div>
        </header>
        {broken !== null && <p className="alert" role="alert">{errorText(t, broken)}</p>}
        {makeOnTop && makeHere}
        {found ? (
          <>
            <section className="tr-found" aria-label={t.tracker.search.results}>
              <h2>{t.tracker.search.results}</h2>
              <FoundList load={tasksLoad} tasks={found} all={all} rows={rows} none={t.tasks.noSearchResults} />
            </section>
            {/* A search leaves what waits for the person where it was. */}
            {WAITS_SHOWN.has(section.kind) && waiting}
          </>
        ) : WAIT_PAGES.has(section.kind) ? waiting
          : section.kind === 'goals' ? (
            <>
              {/* Until the goals come, the page says it is loading rather than that there are none. */}
              {goalList && goalsLoad.phase === 'done' ? <TrackerGoals goals={shownGoals} label={departmentId ? t.tracker.side.goals : t.tracker.side.allGoals} empty={t.tracker.noGoals} onOpenGoal={onOpenGoal} />
                : <LoadState load={goalsLoad} />}
              {makeHere}
            </>
          )
          : section.kind === 'due' ? (
            <section className="tr-found" aria-label={t.tracker.side.dates}>
              <FoundList load={tasksLoad} tasks={[...work].sort((a, b) => a.dueAt!.localeCompare(b.dueAt!))} all={all} rows={rows} none={t.tracker.noDates} />
            </section>
          )
          : section.kind === 'turns' ? <TurnsAndReleases tasks={taskPart} places={places} rows={{ selected, onOpenTask, asksYou, questionAt, place: task => [task.department ? place_(task.department) : t.tracker.side.orchestrator, task.product?.name].filter(Boolean).join(' / ') }} />
          : (
            <>
              <div className="tr-bar">
                <ViewTabs value={view} onChange={next => onPlace({ ...place, view: next })} />
                {view === 'list' && <FilterChips chips={chips} onChange={setChips} tasks={chipTasks}
                  subtasks={showSubtasks} onSubtasks={() => setShowSubtasks(!showSubtasks)} />}
              </div>
              {section.kind === 'failures' && (
                <>
                  <MachineAway machines={machinesAway} />
                  {copySchemaFailures.map(card => <CopySchemaFailure key={card.id} card={card} />)}
                  <MachineLow machines={machinesLow} />
                </>
              )}
              {makeHere}
              <HeldWork load={tasksLoad} view={view} list={`${sectionKey}|${view}|${JSON.stringify(chips)}`} shown={work.length}>
                {view === 'list' ? <TrackerList tasks={work} all={all} rows={rows} empty={empty} showSubtasks={showSubtasks} />
                : view === 'board' ? <TrackerBoard tasks={work} all={all} pipeline={pipeline} cancelled={false} rows={rows} />
                : <TrackerGraph forest={forest} crumbs={crumbs} top={section.kind === 'department' ? departmentName : t.tracker.graph.all} onCrumb={toCrumb} rows={rows} onOpenGoal={onOpenGoal} stages={pipeline ? { on: stages, onChange: setStageMode } : undefined} />}
              </HeldWork>
              {section.kind === 'mine' && waiting}
            </>
          )}
      </div>
    </div>
  );
}
