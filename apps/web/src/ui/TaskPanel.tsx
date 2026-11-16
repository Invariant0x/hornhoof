import { TaskWorkflow, TaskFindings } from './TaskWorkflow';
import { taskWaitText } from './task-wait';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT, type Messages } from '../i18n';
import { useOrg } from '../org';
import { cutLine } from '../restarts';
import { placeName, useTask } from '../tasks';
import type { Org, TaskDetail, TaskLogLine, TaskStatus, WaitingRequest } from '../types';
import { Field } from './Field';
import { OfflineMachine } from './OfflineMachine';
import { Markdown } from './Markdown';
import { Requests, wordsAnswer } from './Requests';
import { PanelFrame } from './SidePanels';
import { RouteUnavailable, unavailableFailure } from '../screens/RouteUnavailable';
import { fullTextOf, LogParagraph, proseErrorText, TaskFiles } from './TaskAttachments';
import { PhoneRecordings } from './PhoneRecordings';
import { HideSecret } from './HideSecret';

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
const lineText = (t: Messages, e: TaskLogLine, when: (at: string) => string): string => field(e.data, 'secretHidden') === true ? t.tasks.hideSecret.done : systemText[e.kind]?.(t, e, when) || e.text;

/* What waits for the person in this task. */
type Waiting = { requests: WaitingRequest[]; onRequestsChanged: () => void; onOpenAgent: (id: string) => void };

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
      <h3>{task.title}</h3>
      <p className="muted">{meta}</p>
      <WorkLabels task={task} />
      <p className={`tstate ${task.status}`}>{t.tasks.states[task.status]}</p>
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

function TaskRelatedSection({ heading, ariaLabel, items, onOpen }: { heading: string; ariaLabel?: string; items: RelatedItem[]; onOpen: (id: string) => void }) {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <section aria-label={ariaLabel}>
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
              {r.byOrchestrator && <> <small>{t.tasks.byOrchestrator}</small></>}
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

function LogEntry({ entry, when, task, onChanged }: { entry: TaskLogLine; when: (at: string) => string; task: TaskDetail; onChanged: () => void }) {
  const t = useT();
  const said = entry.kind === 'created' ? null : lineText(t, entry, when) || null;
  const evidence = evidenceOf(entry.data);

  return (
    <li className={entry.kind}>
      <span className="tp-ev">
        {eventTitle(t, entry)} {entry.by?.byOrchestrator && <><small>{t.tasks.byOrchestrator}</small> </>}<time dateTime={entry.at}>{when(entry.at)}</time>
      </span>
      <LogParagraph text={said} fullRef={fullTextOf(entry.data, 'text')} />
      <LogParagraph text={evidence} fullRef={fullTextOf(entry.data, 'evidence')} prefix={`${t.tasks.evidence}: `} className="tp-evidence" />
      {task.mayHideSecret && (said || evidence) && <HideSecret taskId={task.id} onChanged={onChanged} />}
    </li>
  );
}

function TaskBody({ task, onOpen, onChanged, waiting }: { task: TaskDetail; onOpen: (id: string) => void; onChanged: () => void; waiting: Waiting }) {
  const t = useT();
  const { language } = useLanguage();
  const { org } = useOrg();
  const when = (at: string) => new Date(at).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' });
  const closed = task.status === 'done' || task.status === 'cancelled';

  return (
    <>
      <TaskHeader task={task} org={org} />
      {task.mayHideSecret && <HideSecret taskId={task.id} onChanged={onChanged} />}
      <TaskWaitingSection waiting={waiting} org={org} onOpen={onOpen} onChanged={onChanged} />
      {task.parent && (
        <p className="tp-parent">
          {t.tasks.partOf}{' '}
          <button className="linkish" type="button" onClick={() => onOpen(task.parent!.id)}>
            #{task.parent.number} {task.parent.title}
          </button>
        </p>
      )}
      <TaskWorkflow workflow={task.echelons} task={task} org={org} />
      <TaskFindings findings={task.echelonFindings} workflow={task.echelons} />
      <TaskRelatedSection heading={t.tasks.after} ariaLabel={t.tasks.after} items={task.after} onOpen={onOpen} />
      <IndependentPartSection part={task.independentPart} onOpen={onOpen} />
      {task.brief && <p className="tp-brief">{task.brief}</p>}
      {task.body && (
        <section className="tp-body">
          <h4>{t.tasks.details}</h4>
          <Markdown text={task.body} />
        </section>
      )}
      <TaskRelatedSection heading={t.tasks.subtasks} items={task.subtasks} onOpen={onOpen} />
      <TaskFiles files={task.files} />
      <PhoneRecordings key={task.id} taskId={task.id} />
      <TaskQuestionsSection requests={task.requests} />
      <section>
        <h4>{t.tasks.log}</h4>
        <ol className="tp-log" aria-label={t.tasks.log}>
          {task.log.map((e, i) => (
            <LogEntry key={i} entry={e} when={when} task={task} onChanged={onChanged} />
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

function useEscapeCloses(onClose: () => void, active: boolean): void {
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

export function TaskPanel({ taskId, onClose, onOpen, onHome, active = true, ...waiting }: { taskId: string; active?: boolean; onHome?: () => void; onClose: () => void; onOpen: (id: string) => void } & Waiting) {
  const t = useT();
  const { task, failure, load } = useTask(taskId);
  const title = task ? `#${task.number} ${task.title}` : t.tasks.heading;
  useEscapeCloses(onClose, active);
  return (
    <PanelFrame label={title} heading={task ? `#${task.number}` : ''} busy={!task && failure === null} onClose={onClose}>
      {failure !== null && (unavailableFailure(failure) ? <RouteUnavailable onHome={onHome} /> : <p className="alert" role="alert">{errorText(t, failure)}</p>)}
      {task && !unavailableFailure(failure) && <TaskBody task={task} onOpen={onOpen} onChanged={load} waiting={waiting} />}
    </PanelFrame>
  );
}
