import { TaskWorkflow, TaskFindings } from './TaskWorkflow';
import { taskWaitText } from './task-wait';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT, type Messages } from '../i18n';
import { mapPeople, useOrg } from '../org';
import { cutLine } from '../restarts';
import { placeName, useGoals, usePipelines, useTask } from '../tasks';
import { graphPath } from '../tracker';
import type { GoalView, Org, TaskDetail, TaskLogLine, TaskStatus, WaitingRequest } from '../types';
import { Field } from './Field';
import { TaskEdit } from './TrackerForms';
import { dueText, momentText, sinceSeconds, spanText, trackerLine, waitText } from './tracker-words';
import { OfflineMachine } from './OfflineMachine';
import { Markdown } from './Markdown';
import { Requests, wordsAnswer } from './Requests';
import { PanelFrame } from './SidePanels';
import { RouteUnavailable, unavailableFailure } from '../screens/RouteUnavailable';
import { fullTextOf, LogParagraph, proseErrorText, TaskFiles } from './TaskAttachments';

const field = (data: unknown, key: string): unknown => (data && typeof data === 'object' && key in data ? (data as Record<string, unknown>)[key] : undefined);

/* Who wrote a log line; the orchestrator answering for a person says for whom. */
function authorOf(t: Messages, e: TaskLogLine): string {
  if (e.by?.for) return t.tasks.actedFor(t.window.orchestrator, e.by.for.name);
  return e.by?.name ?? t.window.hornhoof;
}

function eventKey(e: TaskLogLine): string {
  if (e.kind === 'verdict') return field(e.data, 'pass') ? 'passed' : 'sentBack';
  if (e.kind === 'report') return field(e.data, 'done') ? 'reported' : 'notDone';
  return e.kind;
}

/* A log line in words: who did what, with its text and, for work handed in, the evidence. */
function eventTitle(t: Messages, e: TaskLogLine): string {
  const by = authorOf(t, e);
  const ev = t.tasks.events as Record<string, ((who: string) => string) | undefined>;
  return ev[eventKey(e)]?.(by) ?? by;
}

/* Hornhoof's line about a turn a node restart cut off, in the person's language, from what it kept: where, when and why,
   then the retry, or who in Operations was called when the retry was cut off too. Its English text is for the agents. */
function cutText(t: Messages, data: unknown, when: (at: string) => string): string | null {
  const [job, cause, at, node] = [field(data, 'job'), field(data, 'cause'), field(data, 'at'), field(data, 'node')];
  if (typeof job !== 'string' || typeof cause !== 'string' || typeof at !== 'string') return null;
  const named = field(node, 'id') ? String(field(node, 'name')) : null;
  const [retry, called] = [field(data, 'retry'), field(data, 'called')];
  const then =
    field(data, 'first') !== undefined
      ? called
        ? t.restarts.called(String(field(called, 'name')))
        : t.restarts.nobody
      : retry
        ? t.restarts.retry(Number(field(retry, 'n')), Number(field(retry, 'of')))
        : t.restarts.notRetried;
  return `${cutLine(t, { node: named, cause, job }, when(at))} ${then}`;
}

/* Hornhoof's line about a turn whose machine it cannot reach, and about that machine coming back, in the person's
   language. Its English text is for the agents. */
function awayText(t: Messages, e: TaskLogLine, when: (at: string) => string): string | null {
  const [stage, host, since] = [field(e.data, 'stage'), field(e.data, 'host'), field(e.data, 'since')];
  const machine = typeof host === 'string' && host ? host : null;
  if (stage === 'back') return t.tasks.away.back(machine);
  if (stage === 'ended') return t.tasks.away.ended(machine);
  return stage === 'away' && typeof since === 'string' ? t.tasks.away.gone(machine, when(since)) : null;
}

function skippedText(t: Messages, e: TaskLogLine): string {
  const wake = field(e.data, 'wake');
  if (typeof wake !== 'string') return e.text;
  const run = t.tasks.skippedRuns[wake] ?? t.tasks.skippedRuns.task!;
  const text = t.tasks.skippedRun(authorOf(t, e), run);
  const job = field(e.data, 'job');
  return typeof job === 'string' ? `${text} ${t.tasks.skippedJob(job)}` : text;
}

function obsoleteText(t: Messages, e: TaskLogLine): string {
  const wake = field(e.data, 'wake');
  if (typeof wake !== 'string') return e.text;
  const run = t.tasks.skippedRuns[wake] ?? t.tasks.skippedRuns.task!;
  return t.tasks.obsoleteRun(authorOf(t, e), run);
}

/* System log lines use the person's language; employees' own words stay as they wrote them. */
const systemText: Record<string, (t: Messages, e: TaskLogLine, when: (at: string) => string) => string | null> = {
  wake_skipped: skippedText,
  wake_obsolete: obsoleteText,
  interrupted: (t, e, when) => cutText(t, e.data, when),
  away: awayText,
};
const lineText = (t: Messages, e: TaskLogLine, when: (at: string) => string): string => systemText[e.kind]?.(t, e, when) || e.text;

/* What waits for the person in this task. */
type Waiting = { requests: WaitingRequest[]; onRequestsChanged: () => void; onOpenAgent: (id: string) => void };
/* Where the card leads in the tracker: a goal's own card, and the graph grown from this task. */
type Leads = { onOpenGoal?: (id: string) => void; onGraph?: (root: { task: string }) => void };

/* Its kind and risk class, as far as someone said them. */
function WorkLabels({ task }: { task: TaskDetail }) {
  const t = useT();
  const labels = [task.workKind && t.tasks.workKinds[task.workKind], task.riskClass && t.tasks.riskLine(t.tasks.riskClasses[task.riskClass])].filter(Boolean);
  return labels.length > 0 && <p className="muted tp-kind">{labels.join(', ')}</p>;
}

function ExternalTaskWait({ wait }: { wait: TaskDetail['externalWait'] }) {
  const t = useT();
  const { language } = useLanguage();
  if (!wait) return null;
  const until = new Date(wait.until).toLocaleTimeString(language === 'ru' ? 'ru-RU' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  return <p className="muted">{taskWaitText(t, wait, until)}</p>;
}

function TaskHeader({ task, org }: { task: TaskDetail; org: Org | null }) {
  const t = useT();
  const turnText = task.turn !== null ? t.tasks.turn(task.turn) : null;
  const meta = [placeName(t, org, task.department), task.product?.name, turnText].filter(Boolean).join(' / ');
  return (
    <header className="ac-head">
      <p className="muted tp-kind">{task.parentId ? t.tracker.card.kinds.subtask : t.tracker.card.kinds.task}</p>
      <h3>{task.title}</h3>
      <p className="muted">{meta}</p>
      <WorkLabels task={task} />
      <p className="tp-state">
        <span className={`tstate ${task.status}`}>{t.tasks.states[task.status]}</span>
        {task.urgent && <span className="badge urgent">{t.tracker.card.urgent}</span>}
      </p>
      {task.assigneeOffline && <OfflineMachine offline={task.assigneeOffline} />}
      <ExternalTaskWait wait={task.externalWait} />
      {task.paused && <p className="muted">{t.tasks.pausedLine(task.paused.reason)}</p>}
      {task.createdBy && <p className="muted">{t.tasks.givenBy(task.createdBy.name)}</p>}
    </header>
  );
}

function TaskWaitingSection({ waiting, org, onOpen, onChanged }: { waiting: Waiting; org: Org | null; onOpen: (id: string) => void; onChanged: () => void }) {
  const t = useT();
  if (waiting.requests.length === 0) return null;
  return (
    <section className="tp-wait" aria-label={t.tasks.waitingHere}>
      <h4>{t.tasks.waitingHere}</h4>
      <Requests
        requests={waiting.requests}
        onChanged={() => {
          waiting.onRequestsChanged();
          onChanged();
        }}
        onOpenTask={onOpen}
        onOpenAgent={waiting.onOpenAgent}
        placeName={p => placeName(t, org, p)}
      />
      {wordsAnswer(waiting.requests) && <p className="muted">{t.tasks.answerElsewhere}</p>}
    </section>
  );
}

type RelatedItem = { id: string; number: number; title: string; status: TaskStatus };

function TaskRelatedSection({ heading, items, onOpen }: { heading: string; items: RelatedItem[]; onOpen: (id: string) => void }) {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <section aria-label={heading}>
      <h4>{heading}</h4>
      <ul className="tp-subs">
        {items.map(item => (
          <li key={item.id}>
            <button className="linkish" type="button" onClick={() => onOpen(item.id)}>
              #{item.number} {item.title}
            </button>
            <small>{t.tasks.states[item.status]}</small>
          </li>
        ))}
      </ul>
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
        <small>{t.tasks.states[part.task.status]}</small>
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
            </span>
            {r.answer && <p>{r.answer}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

const evidenceOf = (data: unknown): string | null => {
  const raw = field(data, 'evidence');
  return typeof raw === 'string' && raw ? raw : null;
};

/* The words of the tracker's own lines: a status in the person's language, and a person's name by id. */
type Words = { states: Record<string, string>; names: (id: string) => string | undefined };

/* A log line in words: who did what, with its text and, for work handed in, the evidence. The tracker's own lines, a status
   change, an edit or work passed on to someone else, say it all in their title. */
export function LogEntry({ entry, when, words }: { entry: TaskLogLine; when: (at: string) => string; words: Words }) {
  const t = useT();
  const own = trackerLine(t, entry, authorOf(t, entry), words.states, words.names);
  const said = own !== null || entry.kind === 'created' ? null : lineText(t, entry, when) || null;
  const evidence = evidenceOf(entry.data);

  return (
    <li className={entry.kind}>
      <span className="tp-ev">
        {own ?? eventTitle(t, entry)} <time dateTime={entry.at}>{when(entry.at)}</time>
      </span>
      <LogParagraph text={said} fullRef={fullTextOf(entry.data, 'text')} />
      <LogParagraph text={evidence} fullRef={fullTextOf(entry.data, 'evidence')} prefix={`${t.tasks.evidence}: `} className="tp-evidence" />
    </li>
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
          <li key={g.id}>{onOpenGoal ? <button className="linkish" type="button" onClick={() => onOpenGoal(g.id)}>{g.title}</button> : <span>{g.title}</span>}</li>
        ))}
        {parent && <li><button className="linkish" type="button" onClick={() => onOpen(parent.id)}>#{parent.number} {parent.title}</button></li>}
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

/* Who answers for it, who does it, its pipeline and stage, its date, and its time in words. */
function TaskFacts({ task }: { task: TaskDetail }) {
  const t = useT();
  const { language } = useLanguage();
  const { pipelines } = usePipelines(!!task.pipelineId);
  const words = t.tracker.card;
  const pipeline = pipelines?.find(p => p.id === task.pipelineId);
  const stage = pipeline?.stages.find(s => s.id === task.pipelineStageId);
  const due = dueText(t, language, task);
  const time = task.time;
  const waits = waitText(t, task);
  return (
    <dl className="facts tp-facts" aria-label={words.facts}>
      <Fact name={words.responsible}>{task.responsible?.name ?? t.tracker.nobody}</Fact>
      <Fact name={words.executor}>{task.executor?.name ?? task.assignee?.name ?? t.tracker.nobody}</Fact>
      {pipeline && <Fact name={words.pipeline}>{stage ? `${pipeline.name}: ${stage.name}` : pipeline.name}</Fact>}
      {due && <Fact name={words.due}><span className={due.late ? 'tp-late' : undefined}>{due.text}</span></Fact>}
      {time && (
        <Fact name={words.time}>
          {words.inStatus(t.tasks.states[task.status], spanText(t, sinceSeconds(time.inStatusSince)))}
          {time.workSeconds > 0 && <small>{words.worked(spanText(t, time.workSeconds))}</small>}
          {waits && <small>{waits}</small>}
        </Fact>
      )}
    </dl>
  );
}

const LINK = /https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g;

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

function TaskBody({ task, onOpen, onChanged, waiting, leads }: { task: TaskDetail; onOpen: (id: string) => void; onChanged: () => void; waiting: Waiting; leads: Leads }) {
  const t = useT();
  const { language } = useLanguage();
  const { org } = useOrg();
  const { goals } = useGoals(!!task.goal);
  const [editing, setEditing] = useState(false);
  const when = (at: string) => momentText(language, at);
  const closed = task.status === 'done' || task.status === 'cancelled';
  const people = mapPeople(org);
  const words: Words = { states: t.tasks.states, names: id => people.find(p => p.id === id)?.name };
  const version = task.version;
  const mayEdit = !!task.mayEdit && typeof version === 'number';

  return (
    <>
      <CardPath goals={goalChain(task.goal?.id, goals)} parent={task.parent} onOpenGoal={leads.onOpenGoal} onOpen={onOpen} />
      <TaskHeader task={task} org={org} />
      <TaskWaitingSection waiting={waiting} org={org} onOpen={onOpen} onChanged={onChanged} />
      {task.why && (
        <section className="tp-why" aria-label={t.tracker.card.why}>
          <h4>{t.tracker.card.why}</h4>
          <p>{task.why}</p>
        </section>
      )}
      <TaskFacts task={task} />
      {(leads.onGraph || (mayEdit && !editing)) && (
        <div className="entry-actions tp-leads">
          {leads.onGraph && <button className="btn ghost" type="button" onClick={() => leads.onGraph!({ task: task.id })}>{t.tracker.card.graphFromHere}</button>}
          {mayEdit && !editing && <button className="btn ghost" type="button" onClick={() => setEditing(true)}>{t.tracker.card.edit}</button>}
        </div>
      )}
      {mayEdit && editing && <TaskEdit task={{ ...task, version }} onCancel={() => setEditing(false)} onDone={() => { setEditing(false); onChanged(); }} />}
      <TaskWorkflow workflow={task.echelons} task={task} org={org} />
      <TaskFindings findings={task.echelonFindings} workflow={task.echelons} />
      <TaskRelatedSection heading={t.tracker.card.waitsFor} items={task.after} onOpen={onOpen} />
      <TaskRelatedSection heading={t.tracker.card.neededFor} items={task.neededFor ?? []} onOpen={onOpen} />
      <IndependentPartSection part={task.independentPart} onOpen={onOpen} />
      {task.brief && <p className="tp-brief">{task.brief}</p>}
      {task.body && (
        <section className="tp-body">
          <h4>{t.tasks.details}</h4>
          <Markdown text={task.body} />
        </section>
      )}
      <TaskRelatedSection heading={t.tasks.subtasks} items={task.subtasks} onOpen={onOpen} />
      <Materials task={task} />
      <TaskQuestionsSection requests={task.requests} />
      <section>
        <h4>{t.tasks.log}</h4>
        <ol className="tp-log" aria-label={t.tasks.log}>
          {task.log.map((e, i) => (
            <LogEntry key={i} entry={e} when={when} words={words} />
          ))}
        </ol>
      </section>
      {closed ? null : <Actions task={task} onChanged={onChanged} />}
    </>
  );
}

/* A comment for the log, and cancelling the task with what is under it after asking. */
function Actions({ task, onChanged }: { task: TaskDetail; onChanged: () => void }) {
  const t = useT();
  const [text, setText] = useState('');
  const [asking, setAsking] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const sending = useRef(false);

  async function run(action: () => Promise<unknown>) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await action();
      setText('');
      setAsking(false);
      setPausing(false);
      setWhy('');
      onChanged();
    } catch (err) {
      setFailure(err);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  function comment(e: FormEvent) {
    e.preventDefault();
    if (text.trim()) void run(() => api.post(`/api/tasks/${task.id}/comments`, { text: text.trim() }));
  }

  return (
    <>
      <form className="tp-comment" onSubmit={comment}>
        <Field label={t.tasks.comment}>{p => <textarea {...p} rows={3} value={text} onChange={e => setText(e.target.value)} />}</Field>
        <div className="form-foot" role="group" aria-label={t.tasks.actions}>
          <button className="btn" type="submit" disabled={busy || !text.trim()}>{t.tasks.addComment}</button>
        </div>
      </form>
      <div className="ac-actions">
        <div className="entry-actions" role="group" aria-label={task.title}>
          {asking ? (
            <>
              <span className="tp-ask">{t.tasks.cancelAsk(task.number)}</span>
              <button className="btn" type="button" disabled={busy} onClick={() => void run(() => api.post(`/api/tasks/${task.id}/cancel`, {}))}>
                {t.tasks.yesCancel}
              </button>
              <button className="btn ghost" type="button" onClick={() => setAsking(false)}>
                {t.tasks.keep}
              </button>
            </>
          ) : (
            <button className="btn ghost" type="button" onClick={() => setAsking(true)}>
              {t.tasks.cancelTask}
            </button>
          )}
        </div>
      </div>
      {task.mayPause && <PauseActions task={task} busy={busy} pausing={pausing} why={why} setPausing={setPausing} setWhy={setWhy} run={run} />}
      {task.mayPause && !task.parentId && (
        <div className="ac-actions"><div className="entry-actions" role="group" aria-label={t.tracker.card.urgent}>
          <button className="btn ghost" type="button" disabled={busy} onClick={() => void run(() => api.put(`/api/tasks/${task.id}/urgent`, { urgent: !task.urgent }))}>
            {task.urgent ? t.tracker.card.notUrgent : t.tracker.card.makeUrgent}
          </button>
        </div></div>
      )}
      {failure !== null && (
        <p className="alert" role="alert">
          {proseErrorText(t, failure)}
        </p>
      )}
    </>
  );
}

type PauseProps = { task: TaskDetail; busy: boolean; pausing: boolean; why: string; setPausing(on: boolean): void; setWhy(text: string): void; run(action: () => Promise<unknown>): Promise<void> };

/* Pausing asks why, since the reason is what the holder reads; resuming is one step. Work paused with the task above it
   is resumed there. */
function PauseActions({ task, busy, pausing, why, setPausing, setWhy, run }: PauseProps) {
  const t = useT();
  const put = (paused: boolean, reason: string) => run(() => api.put(`/api/tasks/${task.id}/paused`, { paused, reason }));
  if (task.paused) {
    if (task.paused.root !== task.id) return null;
    return <div className="ac-actions"><div className="entry-actions" role="group" aria-label={t.tasks.pause}>
      <button className="btn" type="button" disabled={busy} onClick={() => void put(false, '')}>{t.tasks.resume}</button>
    </div></div>;
  }
  if (!pausing) return <div className="ac-actions"><div className="entry-actions" role="group" aria-label={t.tasks.pause}>
    <button className="btn ghost" type="button" onClick={() => setPausing(true)}>{t.tasks.pause}</button>
  </div></div>;
  return <form className="tp-comment" onSubmit={e => { e.preventDefault(); if (why.trim()) void put(true, why.trim()); }}>
    <Field label={t.tasks.pauseWhy}>{p => <textarea {...p} rows={2} value={why} onChange={e => setWhy(e.target.value)} />}</Field>
    <div className="form-foot" role="group" aria-label={t.tasks.pause}>
      <button className="btn" type="submit" disabled={busy || !why.trim()}>{t.tasks.yesPause}</button>
      <button className="btn ghost" type="button" onClick={() => setPausing(false)}>{t.tasks.keep}</button>
    </div>
  </form>;
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
  useEscapeCloses(onClose, active);
  return (
    <PanelFrame label={title} heading={task ? `#${task.number}` : ''} busy={!task && failure === null} kind={kind} onClose={onClose}>
      {failure !== null && (unavailableFailure(failure) ? <RouteUnavailable onHome={onHome} /> : <p className="alert" role="alert">{errorText(t, failure)}</p>)}
      {task && !unavailableFailure(failure) && <TaskBody task={task} onOpen={onOpen} onChanged={load} waiting={waiting} leads={{ onOpenGoal, onGraph }} />}
    </PanelFrame>
  );
}
