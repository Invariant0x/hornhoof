import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { HIDDEN } from '@hornhoof/protocol/redaction';
import { errorText, useLanguage, useT, type Messages } from '../i18n';
import { useOrg } from '../org';
import { routePath } from '../routes';
import { knownLine, knownSubtasks, placeName, useGoals, usePipelines, useTask } from '../tasks';
import { graphPath } from '../tracker';
import { humanStatus, isClosed } from '../task-tree';
import type { GoalView, Org, TaskDetail, TaskLine, TaskStatus, WaitingRequest } from '../types';
import { Field } from './Field';
import { useLoadFailure } from './LoadFailure';
import { Busy, Hold, Idle, LoadState, useLoad, type Load } from './Loading';
import { TaskEdit } from './TrackerForms';
import { dueText, sinceSeconds, spanText } from './tracker-words';
import { FoldedMarkdown, Markdown } from './Markdown';
import { namedReadOnly, Requests, wordsAnswer } from './Requests';
import { PanelFrame } from './SidePanels';
import { RouteUnavailable, unavailableFailure } from '../screens/RouteUnavailable';
import { fullTextOf, LogParagraph, Material, proseErrorText, TaskFiles } from './TaskAttachments';
import { HideSecret } from './HideSecret';
import { PhoneRecordings } from './PhoneRecordings';
import { FullTaskLog, ShortTaskLog } from './TaskHistory';
import { STATE_CLASS } from './TaskActivity';
import { PersonMark, PriorityWord } from './TrackerMarks';
import { TaskWorkflow, TaskFindings } from './TaskWorkflow';

/* What waits for the person in this task. */
type Waiting = { requests: WaitingRequest[]; onRequestsChanged: () => void; onOpenAgent: (id: string) => void; viewerId?: string };
/* Where the card leads in the tracker: a goal's own card, and the graph grown from this task. */
type Leads = { onOpenGoal?: (id: string) => void; onGraph?: (root: { task: string }) => void };

/* Its kind and risk class, as far as someone said them. */
function WorkLabels({ task }: { task: TaskDetail }) {
  const t = useT();
  const labels = [task.workKind && t.tasks.workKinds[task.workKind], task.riskClass && t.tasks.riskLine(t.tasks.riskClasses[task.riskClass])].filter(Boolean);
  return labels.length > 0 && <p className="muted">{labels.join(', ')}</p>;
}

function TaskWaitingSection({ waiting, org, onOpen, onChanged, inline }: { waiting: Waiting; org: Org | null; onOpen: (id: string) => void; onChanged: () => void; inline?: boolean }) {
  const t = useT();
  const requests = inline ? waiting.requests.filter(request => request.canAnswer || namedReadOnly(request)) : waiting.requests.map(request => ({ ...request, canAnswer: false }));
  if (requests.length === 0) return null;
  const heading = inline ? t.tasks.waitingHere : t.tasks.questions;

  return (
    <section className={inline ? 'tp-wait tp-question' : 'tp-wait'} aria-label={heading}>
      {!inline && <h4>{heading}</h4>}
      <Requests
        requests={requests}
        inline={inline}
        viewerId={waiting.viewerId}
        onChanged={() => {
          waiting.onRequestsChanged();
          onChanged();
        }}
        onOpenTask={onOpen}
        onOpenAgent={waiting.onOpenAgent}
        placeName={p => placeName(t, org, p)}
      />
      {!inline && wordsAnswer(waiting.requests) && <p className="muted">{t.tasks.answerElsewhere}</p>}
    </section>
  );
}

function IndependentPartSection({ part, onOpen }: { part: TaskDetail['independentPart']; onOpen: (id: string) => void }) {
  const t = useT();
  if (!part) return null;
  if ('reason' in part) {
    return <section aria-label={t.tasks.independentPart}><h4>{t.tasks.independentPart}</h4><p>{part.reason}</p></section>;
  }
  return (
    <section aria-label={t.tasks.independentPart}>
      <h4>{t.tasks.independentPart}</h4>
      {part.brief && <p className="muted">{part.brief}</p>}
      <Markdown text={part.body} />
      <p className="muted">{part.executor.name}</p>
      <p>
        <button className="linkish" type="button" onClick={() => onOpen(part.task.id)}>#{part.task.number} {part.task.title}</button>{' '}
        <small>{t.tracker.groups[humanStatus(part.task)]}</small>
      </p>
    </section>
  );
}

function TaskQuestionsSection({ requests }: { requests: TaskDetail['requests'] }) {
  const t = useT();
  if (requests.length === 0) return null;
  return (
    <section>
      <h4>{t.tasks.questions}</h4>
      <ul className="tp-log">
        {requests.map(r => (
          <li key={r.id}>
            <span className="tp-ev">
              {r.agent?.name ?? t.window.hornhoof}: {r.text} <small>{t.tasks.requestStates[r.status] ?? r.status}</small>
              {r.byOrchestrator && <> <small>{t.tasks.byOrchestrator}</small></>}
            </span>
            {r.answer && <p>{r.answer}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* Where the task belongs: the goals above it, from the company's, each with the goal's mark, and the task it is part of, each
   followed by the mark that leads on to the card itself. Each opens its own card. */
export function CardPath({ goals, parent, onOpenGoal, onOpen }: { goals: { id: string; title: string }[]; parent?: { id: string; number: number; title: string } | null; onOpenGoal?: (id: string) => void; onOpen: (id: string) => void }) {
  const t = useT();
  if (!goals.length && !parent) return null;
  return (
    <nav className="tp-path" aria-label={t.tracker.card.path}>
      <ol>
        {goals.map(g => (
          <li key={g.id}>{onOpenGoal ? <button className="linkish tp-goal" type="button" dir="auto" onClick={() => onOpenGoal(g.id)}>{g.title}</button> : <span className="tp-goal" dir="auto">{g.title}</span>}</li>
        ))}
        {parent && <li><button className="linkish" type="button" dir="auto" onClick={() => onOpen(parent.id)}>#{parent.number} {parent.title}</button></li>}
      </ol>
    </nav>
  );
}

/* A status in words on a pill of its colour, as the list's groups and the board's columns show it. */
export function StatusPill({ state, children }: { state: string; children: ReactNode }) {
  return <span className={`tr-status-pill ${state}`}>{children}</span>;
}

/* How much of a task or a goal is done, as a thin bar under its title. */
export function CardBar({ done, total, label }: { done: number; total: number; label: string }) {
  return (
    <span className="tp-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
      <i style={{ inlineSize: `${total ? (done * 100) / total : 0}%` }} />
    </span>
  );
}

/* The person who answers for a task or a goal: their mark and their name. */
export function Answers({ person }: { person: { id: string; name: string } | null | undefined }) {
  const t = useT();
  return person ? <><PersonMark person={person} decorative /><bdi>{person.name}</bdi></> : <>{t.tracker.nobody}</>;
}

/* A fact under its name, the name labelling it for screen readers. */
export function Fact({ name, children }: { name: string; children: ReactNode }) {
  const id = useId();
  return (
    <>
      <dt id={id}>{name}</dt>
      <dd aria-labelledby={id}>{children}</dd>
    </>
  );
}

/* A due day in its own direction, so "20 Nov" reads day then month right to left too; past it, in the colour of a delay. */
export function DueDay({ due }: { due: { text: string; late: boolean } }) {
  return <span className={due.late ? 'tp-late' : undefined} dir="auto">{due.text}</span>;
}

/* Which turn a task in the queue waits for, in the card's facts; a task given out has no such line. */
function QueueFact({ task }: { task: TaskLine }) {
  const words = useT().tracker.card;
  return task.queue ? <Fact name={words.queue}>{words.queueText(task.queue.ahead, task.queue.openTurn)}</Fact> : null;
}

/* Who answers for it and who does it, its pipeline and its due day with how long it is in its status, a name beside each. */
function CardFacts({ task, status, org }: { task: TaskDetail; org: Org | null | undefined; status: ReturnType<typeof humanStatus> }) {
  const t = useT();
  const { language } = useLanguage();
  const { pipelines } = usePipelines(!!task.pipelineId);
  const pipeline = pipelines?.find(p => p.id === task.pipelineId);
  const stage = pipeline?.stages.find(s => s.id === task.pipelineStageId);
  const lead = task.department
    ? org?.departments.find(dept => dept.id === task.department?.id)?.employees.find(employee => employee.kind === 'head')
    : org?.orchestrator;
  const words = t.tracker.card;
  const due = dueText(t, language, task);
  const inStatus = task.time ? words.inStatus(t.tracker.groups[status], spanText(t, sinceSeconds(task.time.inStatusSince))) : null;
  return (
    <div role="group" aria-label={words.facts}>
      <dl className="tp-card-facts">
        <Fact name={words.askedBy}><Answers person={task.askedBy ?? task.createdBy} /></Fact>
        <Fact name={words.decides}><Answers person={task.responsible} /></Fact>
        <QueueFact task={task} />
        <Fact name={words.executor}><bdi>{task.executor?.name ?? task.assignee?.name ?? lead?.name ?? t.tracker.nobody}</bdi></Fact>
        {pipeline && <Fact name={words.pipeline}>{stage ? words.pipelineStage(pipeline.name, stage.name) : pipeline.name}</Fact>}
        {due ? <Fact name={words.due}><DueDay due={due} />{inStatus && ` · ${inStatus}`}</Fact> : inStatus && <Fact name={words.time}>{inStatus}</Fact>}
      </dl>
    </div>
  );
}

type Related = { id: string; number: number; title: string; status: TaskStatus };

/* A task this card leads to: its status ring and its number and title, opening its own card. */
function TaskLink({ item, title, onOpen }: { item: Related; title?: string; onOpen: (id: string) => void }) {
  return (
    <a className="tp-link" href={routePath({ kind: 'tasks', id: item.id })} title={title} onClick={event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onOpen(item.id);
    }}>
      <span className={`tr-status-dot ${STATE_CLASS[humanStatus(item)]}`} aria-hidden="true" />
      <bdi>#{item.number} {item.title}</bdi>
    </a>
  );
}

/* The tasks under this one, how many of them are done, each with its status. */
function Subtasks({ task, onOpen }: { task: TaskDetail; onOpen: (id: string) => void }) {
  const t = useT();
  if (!task.subtasks.length) return null;
  const done = task.subtasks.filter(sub => sub.status === 'done').length;
  return (
    <section className="tp-sec" aria-label={t.tasks.subtasks}>
      <h3>{t.tracker.card.subtasks(done, task.subtasks.length)}</h3>
      <ul className="tp-rows">
        {task.subtasks.map(sub => (
          <li className="tp-row" key={sub.id}>
            <TaskLink item={sub} title={t.tasks.subtasks} onOpen={onOpen} />
            <small>{t.tracker.groups[humanStatus(sub)]}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* What this task waits for and what waits for it, each with its status. */
function Relations({ task, onOpen }: { task: TaskDetail; onOpen: (id: string) => void }) {
  const t = useT();
  const words = t.tracker.card;
  const links = [
    ...task.after.map(item => ({ item, word: t.tracker.graph.waitsFor, title: words.waitsFor })),
    ...(task.neededFor ?? []).map(item => ({ item, word: t.tracker.graph.neededFor, title: words.neededFor })),
  ];
  if (!links.length) return null;
  return (
    <section className="tp-sec" aria-label={words.relations}>
      <h3>{words.relations}</h3>
      <ul className="tp-rows">
        {links.map(({ item, word, title }) => {
          const status = humanStatus(item);
          return (
            <li className="tp-row" key={`${title}-${item.id}`}>
              <span className="tp-row-main"><span className="tp-rel">{word}</span><TaskLink item={item} title={title} onOpen={onOpen} /></span>
              <StatusPill state={STATE_CLASS[status]}>{t.tracker.groups[status]}</StatusPill>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TaskDetails({ task, waiting, onOpen, onChanged }: { task: TaskDetail; waiting: Waiting; onOpen: (id: string) => void; onChanged: () => void }) {
  const t = useT();
  const { org } = useOrg();
  const words = t.tracker.card;
  const meta = [placeName(t, org, task.department), task.product?.name, task.turn !== null ? t.tasks.turn(task.turn) : null].filter(Boolean).join(' / ');
  const worked = task.time?.workSeconds ?? 0;
  const masked = [task.title, task.brief, task.body, ...task.log.flatMap(entry => [entry.text, JSON.stringify(entry.data)])].some(text => text?.includes(HIDDEN));

  return (
    <>
      {meta && <p className="muted">{meta}</p>}
      <WorkLabels task={task} />
      {task.createdBy && <p className="muted">{t.tasks.givenBy(task.createdBy.name)}</p>}
      <dl className="facts" aria-label={words.facts}>
        <Fact name={t.tracker.priority.label}><PriorityWord task={task} /></Fact>
        {worked > 0 && <Fact name={words.time}>{words.worked(spanText(t, worked))}</Fact>}
      </dl>
      <TaskWorkflow workflow={task.echelons} task={task} org={org} />
      <TaskFindings findings={task.echelonFindings} workflow={task.echelons} />
      <IndependentPartSection part={task.independentPart} onOpen={onOpen} />
      <PhoneRecordings taskId={task.id} />
      <TaskWaitingSection waiting={waiting} org={org} onOpen={onOpen} onChanged={onChanged} />
      <TaskQuestionsSection requests={task.requests.filter(request => !waiting.requests.some(live => live.id === request.id))} />
      {masked && <p className="muted"><a href="/settings/passwords">{t.tasks.hideSecret.vault}</a></p>}
    </>
  );
}

const LINK = /https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g;

/* What the work brought: its files, the last report on it, and the links people and employees left in comments. */
function Materials({ task }: { task: TaskDetail }) {
  const t = useT();
  const words = t.tracker.card;
  const report = [...task.log].reverse().find(e => e.kind === 'report' && e.text);
  const links = [...new Set(task.log.filter(e => e.kind === 'comment').flatMap(e => e.text.match(LINK) ?? []))];
  if (!task.files?.length && !report && !links.length) return null;
  return (
    <section className="tp-sec" aria-label={words.materials}>
      <h3>{words.materials}</h3>
      <ul className="tp-mats">
        <TaskFiles files={task.files} />
        {report && <Material kind={words.materialKinds.report}><LogParagraph text={report.text} fullRef={fullTextOf(report.data, 'text')} /></Material>}
        {links.map(href => <Material key={href} kind={words.materialKinds.link} href={href} name={href}><span dir="ltr">{href}</span></Material>)}
      </ul>
    </section>
  );
}

/* The goals above a goal, from the company's down to the one given. */
export function goalChain(id: string | null | undefined, goals: GoalView[] | undefined) {
  return graphPath({ goal: id }, goals ?? [], []);
}

type View = 'menu' | 'details' | 'log' | 'edit' | 'comment' | 'cancel' | 'pause' | 'secret';

function TaskBody({ task, onOpen, onClose, active, onChanged, waiting, leads }: { task: TaskDetail; onOpen: (id: string) => void; onClose: () => void; active: boolean; onChanged: () => void; waiting: Waiting; leads: Leads }) {
  const t = useT();
  const { org } = useOrg();
  const { goals } = useGoals(!!task.goal);
  const [view, setView] = useState<View | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selection = useRef('');
  const menuId = useId();
  const asksYou = waiting.requests.some(request => request.canAnswer);
  const status = humanStatus(task, asksYou);
  const words = t.tracker.card;
  const done = task.subtasks.filter(sub => sub.status === 'done').length;
  const closeMenu = () => {
    selection.current = '';
    setView(null);
    trigger.current?.focus();
  };
  function openMenu() {
    if (task.mayHideSecret && !selection.current) selection.current = window.getSelection()?.toString() ?? '';
    setView('menu');
  }
  useEscapeCloses(view ? closeMenu : onClose, active);

  return (
    <>
      <header className="tp-head">
        <CardPath goals={goalChain(task.goal?.id, goals)} parent={task.parent} onOpenGoal={leads.onOpenGoal} onOpen={onOpen} />
        <p className="tp-kind">{task.parentId || task.parent ? words.kinds.subtask : words.kinds.task}</p>
        <div className="tp-title">
          <h2 className="tp-heading" dir="auto">{task.title}</h2>
          <button className="tp-menu-button" type="button" ref={trigger} aria-label={t.tasks.taskActions} aria-expanded={view !== null} aria-controls={view ? menuId : undefined}
            onMouseDown={() => { if (!view && task.mayHideSecret) selection.current = window.getSelection()?.toString() ?? ''; }}
            onClick={() => view ? closeMenu() : openMenu()}>
            <span aria-hidden="true">…</span>
          </button>
        </div>
        {task.brief && <p className="tp-brief" dir="auto">{task.brief}</p>}
        <p className="tp-state"><StatusPill state={STATE_CLASS[status]}>{t.tracker.groups[status]}</StatusPill></p>
        {task.why && <p className="tp-why" dir="auto">{task.why}</p>}
        {task.subtasks.length > 0 && <CardBar done={done} total={task.subtasks.length} label={t.tracker.list.subtasks(done, task.subtasks.length)} />}
      </header>
      <TaskMenu id={menuId} task={task} view={view} selection={selection.current} onView={next => {
        if (next !== 'secret') selection.current = '';
        setView(next);
      }} onClose={closeMenu} onOpen={onOpen} onChanged={onChanged} waiting={waiting} />
      <CardFacts task={task} status={status} org={org} />
      <GraphFromHere id={task.id} onGraph={leads.onGraph} />
      {task.body && <FoldedMarkdown text={task.body} />}
      <Subtasks task={task} onOpen={onOpen} />
      <Relations task={task} onOpen={onOpen} />
      <Materials task={task} />
      <ShortTaskLog task={task} asksYou={asksYou} heading={words.history} />
      <TaskWaitingSection inline waiting={waiting} org={org} onOpen={onOpen} onChanged={onChanged} />
    </>
  );
}

function TaskMenu({ id, task, view, selection, onView, onClose, onOpen, onChanged, waiting }: {
  id: string; task: TaskDetail; view: View | null; selection: string; onView: (view: View) => void; onClose: () => void; onOpen: (id: string) => void; onChanged: () => void; waiting: Waiting;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const sending = useRef(false);
  const menu = useRef<HTMLDivElement>(null);
  const { version, revision } = task;
  const mayEdit = task.mayEdit && typeof version === 'number' && typeof revision === 'number';
  const mayAct = !isClosed(task);
  const mayPause = mayAct && task.mayPause;
  const canResume = mayPause && task.paused?.root === task.id;
  const words = t.tracker.card;

  useEffect(() => {
    menu.current?.querySelector('button')?.focus();
  }, [view]);

  function done() {
    onClose();
    onChanged();
  }

  async function run(action: () => Promise<unknown>) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await action();
      setText('');
      setWhy('');
      done();
    } catch (err) {
      setFailure(err);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  function select(next: View) {
    setFailure(null);
    onView(next);
  }

  function comment(e: FormEvent) {
    e.preventDefault();
    if (text.trim()) void run(() => api.post(`/api/tasks/${task.id}/comments`, { text: text.trim() }));
  }

  function pause(paused: boolean, reason: string) {
    void run(() => api.put(`/api/tasks/${task.id}/paused`, { paused, reason }));
  }

  if (!view) return null;
  const back = () => select('menu');
  return (
    <div className="tp-menu" id={id} ref={menu} role="group" aria-label={t.tasks.taskActions} aria-busy={busy}>
      {view !== 'menu' && <button className="t-link tp-disclosure" type="button" onClick={back}>{t.tasks.backToActions}</button>}
      {view === 'menu' && (
        <div className="tp-menu-list">
          <button className="linkish" type="button" onClick={() => select('details')}>{t.tasks.details}</button>
          {task.log.length > 0 && <button className="linkish" type="button" onClick={() => select('log')}>{t.tasks.fullLog}</button>}
          {task.mayHideSecret && <button className="linkish" type="button" onClick={() => select('secret')}>{t.tasks.hideSecret.action}</button>}
          {mayEdit && <button className="linkish" type="button" onClick={() => select('edit')}>{words.edit}</button>}
          {mayAct && <button className="linkish" type="button" onClick={() => select('comment')}>{t.tasks.comment}</button>}
          {mayPause && !task.parentId && (
            <button className="linkish" type="button" disabled={busy} onClick={() => void run(() => api.put(`/api/tasks/${task.id}/urgent`, { urgent: !task.urgent }))}>
              {task.urgent ? words.notUrgent : words.makeUrgent}
            </button>
          )}
          {mayPause && !task.paused && <button className="linkish" type="button" onClick={() => select('pause')}>{t.tasks.pause}</button>}
          {canResume && <button className="linkish" type="button" disabled={busy} onClick={() => pause(false, '')}>{t.tasks.resume}</button>}
          {mayAct && <button className="linkish" type="button" onClick={() => select('cancel')}>{t.tasks.cancelTask}</button>}
        </div>
      )}
      {view === 'details' && <TaskDetails task={task} waiting={waiting} onOpen={onOpen} onChanged={onChanged} />}
      {view === 'log' && <FullTaskLog task={task} onChanged={onChanged} />}
      {view === 'secret' && task.mayHideSecret && <HideSecret taskId={task.id} onChanged={onChanged} onClose={back} initialValue={selection} />}
      {view === 'edit' && mayEdit && <TaskEdit task={{ ...task, version, revision }} onCancel={back} onDone={done} onReload={onChanged} />}
      {view === 'comment' && mayAct && (
        <form className="tp-comment" onSubmit={comment}>
          <Field label={t.tasks.comment}>{p => <textarea {...p} rows={3} value={text} onChange={e => setText(e.target.value)} />}</Field>
          <div className="form-foot" role="group" aria-label={t.tasks.actions}>
            <button className="btn" type="submit" disabled={busy || !text.trim()}>{t.tasks.addComment}</button>
          </div>
        </form>
      )}
      {view === 'cancel' && mayAct && (
        <>
          <p>{t.tasks.cancelAsk(task.number)}</p>
          <div className="entry-actions" role="group" aria-label={task.title}>
            <button className="btn" type="button" disabled={busy} onClick={() => void run(() => api.post(`/api/tasks/${task.id}/cancel`, {}))}>{t.tasks.yesCancel}</button>
            <button className="btn ghost" type="button" onClick={back}>{t.tasks.keep}</button>
          </div>
        </>
      )}
      {view === 'pause' && mayPause && !task.paused && (
        <form className="tp-comment" onSubmit={e => { e.preventDefault(); if (why.trim()) pause(true, why.trim()); }}>
          <Field label={t.tasks.pauseWhy}>{p => <textarea {...p} rows={2} value={why} onChange={e => setWhy(e.target.value)} />}</Field>
          <div className="form-foot" role="group" aria-label={t.tasks.pause}>
            <button className="btn" type="submit" disabled={busy || !why.trim()}>{t.tasks.yesPause}</button>
            <button className="btn ghost" type="button" onClick={back}>{t.tasks.keep}</button>
          </div>
        </form>
      )}
      {busy && <p className="muted" role="status">{t.tasks.sending}</p>}
      {failure !== null && <p className="alert" role="alert">{proseErrorText(t, failure)}</p>}
    </div>
  );
}

/* One task in the left panel, kept fresh from the live stream. */
/* Escape closes the panel before what lies under it, such as a department's tasks, which leave an Escape it took alone. */
const closesTask = (e: KeyboardEvent, active: boolean): boolean => active && e.key === 'Escape' && !e.defaultPrevented;

export function useEscapeCloses(onClose: () => void, active: boolean): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!closesTask(e, active)) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose, active]);
}

/* The way from a card to the graph grown from its task, in the tracker. */
function GraphFromHere({ id, onGraph }: { id: string; onGraph: Leads['onGraph'] }) {
  const t = useT();
  if (!onGraph) return null;
  return <div className="tp-acts"><button className="gbtn" type="button" onClick={() => onGraph({ task: id })}><span aria-hidden="true">⑂</span>{t.tracker.card.graphFromHere}</button></div>;
}

const HELD_LINES = ['100%', '92%', '56%'];

/* A task's card while the rest of it comes (style book 1.5, section 4): the title, the status and the facts its row showed are
   drawn at once and stay; the details after them are held as a tail, with the ring and three idle lines. */
function HeldTask({ line, load, asksYou, onGraph }: { line: TaskLine; load: Load; asksYou: boolean; onGraph: Leads['onGraph'] }) {
  const t = useT();
  const words = t.tracker.card;
  const status = humanStatus(line, asksYou);
  const subtasks = knownSubtasks(line.id);
  const done = subtasks.filter(sub => sub.status === 'done').length;
  return (
    <>
      <header className="tp-head">
        {(line.goal || line.parentId) && <nav className="tp-path" aria-hidden="true"><ol><li className="tp-path-held"><Idle w="12ch" /></li></ol></nav>}
        <p className="tp-kind">{line.parentId ? words.kinds.subtask : words.kinds.task}</p>
        <div className="tp-title"><h2 className="tp-heading" dir="auto">{line.title}</h2><span className="tp-menu-button" aria-hidden="true" /></div>
        <p className="tp-state"><StatusPill state={STATE_CLASS[status]}>{t.tracker.groups[status]}</StatusPill></p>
        {line.why && <p className="tp-why" dir="auto">{line.why}</p>}
        {subtasks.length > 0 && <CardBar done={done} total={subtasks.length} label={t.tracker.list.subtasks(done, subtasks.length)} />}
      </header>
      <CardFacts task={line} status={status} />
      <GraphFromHere id={line.id} onGraph={onGraph} />
      <Hold load={load} className="tp-tail">
        <div className="tp-held">
          <Busy ring={load.ring} words={t.load.task} live={false} />
          <p>{HELD_LINES.map(w => <span key={w} className="ph-line"><Idle w={w} /></span>)}</p>
        </div>
      </Hold>
    </>
  );
}

type PanelProps = { taskId: string; kind?: string; active?: boolean; onHome?: () => void; onClose: () => void; onOpen: (id: string) => void } & Waiting & Leads;

/* What a card shows while its task is not shown: no such task, the row it opened from with its details held, or the ring
   alone for a card opened with no row read. */
function NotShown({ line, load, failure, asksYou, onHome, onGraph }: { line: TaskLine | undefined; load: Load; failure: unknown; asksYou: boolean; onHome?: () => void; onGraph: Leads['onGraph'] }) {
  const t = useT();
  if (unavailableFailure(failure)) return <RouteUnavailable onHome={onHome} />;
  if (line) return <HeldTask line={line} load={load} asksYou={asksYou} onGraph={onGraph} />;
  return <LoadState load={load} words={t.load.task} />;
}

/* The task to show once its load is done and the person may see it; until then, nothing. */
const shownTask = (task: TaskDetail | null | undefined, load: Load, failure: unknown) => (task && load.phase === 'done' && !unavailableFailure(failure) ? task : null);

/* The card's bar: a task or a subtask, and its number, once its row or its details are known. */
function cardBar(t: Messages, line: TaskLine | null | undefined, task: TaskDetail | null | undefined): string {
  if (!line) return '';
  const kinds = t.tracker.card.kinds;
  return t.tracker.card.bar(line.parentId || task?.parent ? kinds.subtask : kinds.task, line.number);
}

/* kind: where the panel stands, beside the tracker at the end side. */
export function TaskPanel({ taskId, kind, onClose, onOpen, onHome, onOpenGoal, onGraph, active = true, ...waiting }: PanelProps) {
  const t = useT();
  const { task, failure: readFailure, load, cancel } = useTask(taskId);
  const failure = useLoadFailure(readFailure);
  const taskLoad = useLoad([{ data: task, failure: readFailure, load, cancel }]);
  const line = task ?? knownLine(taskId);
  const title = line ? `#${line.number} ${line.title}` : t.tasks.heading;
  const shown = shownTask(task, taskLoad, failure);
  useEscapeCloses(onClose, active && !shown);
  return (
    <PanelFrame label={title} heading={cardBar(t, line, task)} plain kind={kind} onClose={onClose}>
      {shown && failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
      {shown ? <TaskBody key={shown.id} task={shown} onOpen={onOpen} onClose={onClose} active={active} onChanged={load} waiting={waiting} leads={{ onOpenGoal, onGraph }} />
        : <NotShown line={line} load={taskLoad} failure={failure} asksYou={waiting.requests.some(request => request.canAnswer)} onHome={onHome} onGraph={onGraph} />}
    </PanelFrame>
  );
}
