import { Fragment, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { HIDDEN } from '@hornhoof/protocol/redaction';
import { errorText, useLanguage, useT } from '../i18n';
import { useOrg } from '../org';
import { routePath } from '../routes';
import { placeName, useGoals, usePipelines, useTask } from '../tasks';
import { graphPath } from '../tracker';
import { humanStatus, isClosed } from '../task-tree';
import type { GoalView, Org, TaskDetail, WaitingRequest } from '../types';
import { Field } from './Field';
import { TaskEdit } from './TrackerForms';
import { dueText, sinceSeconds, spanText } from './tracker-words';
import { FoldedMarkdown, Markdown } from './Markdown';
import { Requests, wordsAnswer } from './Requests';
import { PanelFrame } from './SidePanels';
import { RouteUnavailable, unavailableFailure } from '../screens/RouteUnavailable';
import { fullTextOf, LogParagraph, proseErrorText, TaskFiles } from './TaskAttachments';
import { HideSecret } from './HideSecret';
import { PhoneRecordings } from './PhoneRecordings';
import { FullTaskLog, ShortTaskLog } from './TaskHistory';
import { PriorityWord } from './TrackerMarks';
import { TaskWorkflow, TaskFindings } from './TaskWorkflow';

/* What waits for the person in this task. */
type Waiting = { requests: WaitingRequest[]; onRequestsChanged: () => void; onOpenAgent: (id: string) => void };
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
  const requests = inline ? waiting.requests.filter(request => request.canAnswer) : waiting.requests.map(request => ({ ...request, canAnswer: false }));
  if (requests.length === 0) return null;
  const heading = inline ? t.tasks.waitingHere : t.tasks.questions;

  return (
    <section className={inline ? 'tp-wait tp-question' : 'tp-wait'} aria-label={heading}>
      {!inline && <h4>{heading}</h4>}
      <Requests
        requests={requests}
        inline={inline}
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

/* Where the task belongs: the goals above it, from the company's, and the task it is part of. Each opens its own card. */
export function CardPath({ goals, parent, onOpenGoal, onOpen }: { goals: { id: string; title: string }[]; parent?: { id: string; number: number; title: string } | null; onOpenGoal?: (id: string) => void; onOpen: (id: string) => void }) {
  const t = useT();
  if (!goals.length && !parent) return null;
  return (
    <nav className="tp-path" aria-label={t.tracker.card.path}>
      <ol>
        {goals.map(g => (
          <li key={g.id}>{onOpenGoal ? <button className="linkish" type="button" dir="auto" onClick={() => onOpenGoal(g.id)}>{g.title}</button> : <span dir="auto">{g.title}</span>}</li>
        ))}
        {parent && <li><button className="linkish" type="button" dir="auto" onClick={() => onOpen(parent.id)}>#{parent.number} {parent.title}</button></li>}
      </ol>
    </nav>
  );
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

function TaskFacts({ task, asksYou, onOpen }: { task: TaskDetail; asksYou: boolean; onOpen: (id: string) => void }) {
  const t = useT();
  const { language } = useLanguage();
  const words = t.tracker.card;
  const due = dueText(t, language, task);
  const related = [
    ...(task.parent ? [{ ...task.parent, relation: words.path }] : []),
    ...task.after.map(item => ({ ...item, relation: words.waitsFor })),
    ...(task.neededFor ?? []).map(item => ({ ...item, relation: words.neededFor })),
    ...task.subtasks.map(item => ({ ...item, relation: t.tasks.subtasks })),
  ];

  return (
    <div className="tp-facts muted" role="group" aria-label={words.facts}>
      <span>{t.tracker.groups[humanStatus(task, asksYou)]}</span>{' · '}
      <span>{words.executor}: <bdi>{task.executor?.name ?? task.assignee?.name ?? t.tracker.nobody}</bdi></span>{' · '}
      <span>{words.responsible}: <bdi>{task.responsible?.name ?? t.tracker.nobody}</bdi></span>{' · '}
      {due && <><span>{words.due}: <bdi>{due.text}</bdi></span>{' · '}</>}
      <bdi dir="ltr">#{task.number}</bdi>
      {related.map(item => (
        <Fragment key={item.id}>
          {' · '}<a href={routePath({ kind: 'tasks', id: item.id })} title={item.relation} onClick={event => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onOpen(item.id);
          }}><bdi>#{item.number} {item.title}</bdi></a>
        </Fragment>
      ))}
    </div>
  );
}

function TaskDetails({ task, waiting, leads, onOpen, onChanged }: { task: TaskDetail; waiting: Waiting; leads: Leads; onOpen: (id: string) => void; onChanged: () => void }) {
  const t = useT();
  const { org } = useOrg();
  const { goals } = useGoals(!!task.goal);
  const { pipelines } = usePipelines(!!task.pipelineId);
  const pipeline = pipelines?.find(p => p.id === task.pipelineId);
  const stage = pipeline?.stages.find(s => s.id === task.pipelineStageId);
  const words = t.tracker.card;
  const meta = [placeName(t, org, task.department), task.product?.name, task.turn !== null ? t.tasks.turn(task.turn) : null].filter(Boolean).join(' / ');
  const time = task.time;
  const masked = [task.title, task.brief, task.body, ...task.log.flatMap(entry => [entry.text, JSON.stringify(entry.data)])].some(text => text?.includes(HIDDEN));

  return (
    <>
      <CardPath goals={goalChain(task.goal?.id, goals)} onOpenGoal={leads.onOpenGoal} onOpen={onOpen} />
      {meta && <p className="muted">{meta}</p>}
      <WorkLabels task={task} />
      {task.createdBy && <p className="muted">{t.tasks.givenBy(task.createdBy.name)}</p>}
      {task.why && (
        <section className="tp-why" aria-label={words.why}>
          <h4>{words.why}</h4>
          <p dir="auto">{task.why}</p>
        </section>
      )}
      <dl className="facts" aria-label={words.facts}>
        <Fact name={t.tracker.priority.label}><PriorityWord task={task} /></Fact>
        {pipeline && <Fact name={words.pipeline}>{stage ? `${pipeline.name}: ${stage.name}` : pipeline.name}</Fact>}
        {time && <Fact name={words.time}>
          {words.inStatus(t.tracker.groups[humanStatus(task, waiting.requests.some(request => request.canAnswer))], spanText(t, sinceSeconds(time.inStatusSince)))}
          {time.workSeconds > 0 && <small>{words.worked(spanText(t, time.workSeconds))}</small>}
        </Fact>}
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

const hasMaterials = (task: TaskDetail) => !!task.files?.length || task.log.some(entry =>
  (entry.kind === 'report' && entry.text) || (entry.kind === 'comment' && entry.text.match(LINK)),
);

/* What the work brought: its files, the last report on it, and the links people and employees left in comments. */
function Materials({ task }: { task: TaskDetail }) {
  const t = useT();
  const report = [...task.log].reverse().find(e => e.kind === 'report' && e.text);
  const links = [...new Set(task.log.filter(e => e.kind === 'comment').flatMap(e => e.text.match(LINK) ?? []))];
  if (!task.files?.length && !report && !links.length) return null;
  return (
    <section className="tp-materials" aria-label={t.tracker.card.materials}>
      <h4>{t.tracker.card.materials}</h4>
      <TaskFiles files={task.files} />
      {report && (
        <div>
          <h5>{t.tracker.card.report}</h5>
          <LogParagraph text={report.text} fullRef={fullTextOf(report.data, 'text')} />
        </div>
      )}
      {links.length > 0 && (
        <div>
          <h5>{t.tracker.card.links}</h5>
          <ul className="tp-subs">
            {links.map(href => <li key={href}><a className="req-link" href={href} target="_blank" rel="noopener noreferrer">{href}</a></li>)}
          </ul>
        </div>
      )}
    </section>
  );
}

/* The goals above a goal, from the company's down to the one given. */
export function goalChain(id: string | null | undefined, goals: GoalView[] | undefined) {
  return graphPath({ goal: id }, goals ?? [], []);
}

type View = 'menu' | 'details' | 'materials' | 'log' | 'edit' | 'comment' | 'cancel' | 'pause' | 'secret';

function TaskBody({ task, onOpen, onClose, active, onChanged, waiting, leads }: { task: TaskDetail; onOpen: (id: string) => void; onClose: () => void; active: boolean; onChanged: () => void; waiting: Waiting; leads: Leads }) {
  const t = useT();
  const { org } = useOrg();
  const [view, setView] = useState<View | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selection = useRef('');
  const menuId = useId();
  const asksYou = waiting.requests.some(request => request.canAnswer);
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
      <header className="ac-head tp-head">
        <div className="tp-title">
          <h2 className="tp-heading" dir="auto">{task.title}</h2>
          <button className="tp-menu-button" type="button" ref={trigger} aria-label={t.tasks.taskActions} aria-expanded={view !== null} aria-controls={view ? menuId : undefined}
            onMouseDown={() => { if (!view && task.mayHideSecret) selection.current = window.getSelection()?.toString() ?? ''; }}
            onClick={() => view ? closeMenu() : openMenu()}>
            <span aria-hidden="true">…</span>
          </button>
        </div>
        <TaskFacts task={task} asksYou={asksYou} onOpen={onOpen} />
      </header>
      <TaskMenu id={menuId} task={task} view={view} selection={selection.current} onView={next => {
        if (next !== 'secret') selection.current = '';
        setView(next);
      }} onClose={closeMenu} onOpen={onOpen} onChanged={onChanged} waiting={waiting} leads={leads} />
      {task.brief && <p className="tp-brief" dir="auto">{task.brief}</p>}
      {task.body && <FoldedMarkdown text={task.body} />}
      <ShortTaskLog task={task} asksYou={asksYou} />
      <TaskWaitingSection inline waiting={waiting} org={org} onOpen={onOpen} onChanged={onChanged} />
    </>
  );
}

function TaskMenu({ id, task, view, selection, onView, onClose, onOpen, onChanged, waiting, leads }: {
  id: string; task: TaskDetail; view: View | null; selection: string; onView: (view: View) => void; onClose: () => void; onOpen: (id: string) => void; onChanged: () => void; waiting: Waiting; leads: Leads;
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
          {hasMaterials(task) && <button className="linkish" type="button" onClick={() => select('materials')}>{words.materials}</button>}
          {task.log.length > 0 && <button className="linkish" type="button" onClick={() => select('log')}>{t.tasks.fullLog}</button>}
          {leads.onGraph && <button className="linkish" type="button" onClick={() => leads.onGraph?.({ task: task.id })}>{words.graphFromHere}</button>}
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
      {view === 'details' && <TaskDetails task={task} waiting={waiting} leads={leads} onOpen={onOpen} onChanged={onChanged} />}
      {view === 'materials' && <Materials task={task} />}
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

/* kind: where the panel stands, beside the tracker at the end side. */
export function TaskPanel({ taskId, kind, onClose, onOpen, onHome, onOpenGoal, onGraph, active = true, ...waiting }: { taskId: string; kind?: string; active?: boolean; onHome?: () => void; onClose: () => void; onOpen: (id: string) => void } & Waiting & Leads) {
  const t = useT();
  const { task, failure, load } = useTask(taskId);
  const title = task ? `#${task.number} ${task.title}` : t.tasks.heading;
  const shown = task && !unavailableFailure(failure);
  useEscapeCloses(onClose, active && !shown);
  return (
    <PanelFrame label={title} heading="" busy={!task && failure === null} kind={kind} onClose={onClose}>
      {failure !== null && (unavailableFailure(failure) ? <RouteUnavailable onHome={onHome} /> : <p className="alert" role="alert">{errorText(t, failure)}</p>)}
      {shown && <TaskBody key={task.id} task={task} onOpen={onOpen} onClose={onClose} active={active} onChanged={load} waiting={waiting} leads={{ onOpenGoal, onGraph }} />}
    </PanelFrame>
  );
}
