import { taskWaitText } from './task-wait';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT, type Messages } from '../i18n';
import { useOrg } from '../org';
import { cutLine } from '../restarts';
import { placeName, roleAfter, useTask } from '../tasks';
import type { AgentRef, TaskDetail, TaskLogLine, WaitingRequest } from '../types';
import { Field } from './Field';
import { Markdown } from './Markdown';
import { Requests, wordsAnswer } from './Requests';

const field = (data: unknown, key: string): unknown => (data && typeof data === 'object' && key in data ? (data as Record<string, unknown>)[key] : undefined);

/* Who wrote a log line; the orchestrator answering for a person says for whom. */
function authorOf(t: Messages, e: TaskLogLine): string {
  if (e.by?.for) return t.tasks.actedFor(t.window.orchestrator, e.by.for.name);
  return e.by?.name ?? t.window.hornhoof;
}

/* A log line in words: who did what, with its text and, for work handed in, the evidence. */
function eventTitle(t: Messages, e: TaskLogLine): string {
  const by = authorOf(t, e);
  const ev = t.tasks.events;
  switch (e.kind) {
    case 'verdict':
      return field(e.data, 'pass') ? ev.passed(by) : ev.sentBack(by);
    case 'report':
      return field(e.data, 'done') ? ev.reported(by) : ev.notDone(by);
    default:
      return e.kind in ev ? ev[e.kind as keyof typeof ev](by) : by;
  }
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
};
const lineText = (t: Messages, e: TaskLogLine, when: (at: string) => string): string => systemText[e.kind]?.(t, e, when) || e.text;

/* What waits for the person in this task. */
type Waiting = { requests: WaitingRequest[]; onRequestsChanged: () => void; onOpenAgent: (id: string) => void };

function ExternalTaskWait({ wait }: { wait: TaskDetail['externalWait'] }) {
  const t = useT();
  const { language } = useLanguage();
  if (!wait) return null;
  const until = new Date(wait.until).toLocaleTimeString(language === 'ru' ? 'ru-RU' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  return <p className="muted">{taskWaitText(t, wait, until)}</p>;
}

function TaskBody({ task, onOpen, onChanged, waiting }: { task: TaskDetail; onOpen: (id: string) => void; onChanged: () => void; waiting: Waiting }) {
  const t = useT();
  const { language } = useLanguage();
  const { org } = useOrg();
  const when = (at: string) => new Date(at).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' });
  const who = (a: AgentRef) => `${a.name}${roleAfter(a, language)}`;
  const closed = task.status === 'done' || task.status === 'cancelled';
  const waits = task.waitsFor.length > 0;
  const executorState =
    task.stage > 0 || task.status === 'done'
      ? t.tasks.gateStates.did
      : task.merging
        ? t.tasks.gateStates.merging
        : waits
          ? t.tasks.waitsFor(task.waitsFor.map(n => `#${n}`).join(', '))
          : t.tasks.gateStates.working;

  return (
    <>
      <header className="ac-head">
        <h3>{task.title}</h3>
        <p className="muted">{[placeName(t, org, task.department), task.product?.name, task.turn !== null ? t.tasks.turn(task.turn) : null].filter(Boolean).join(' / ')}</p>
        <p className={`tstate ${task.status}`}>{t.tasks.states[task.status]}</p>
        <ExternalTaskWait wait={task.externalWait} />
        {task.createdBy && <p className="muted">{t.tasks.givenBy(task.createdBy.name)}</p>}
      </header>
      {waiting.requests.length > 0 && (
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
      )}
      {task.parent && (
        <p className="tp-parent">
          {t.tasks.partOf}{' '}
          <button className="linkish" type="button" onClick={() => onOpen(task.parent!.id)}>
            #{task.parent.number} {task.parent.title}
          </button>
        </p>
      )}
      {task.executor ? (
        <ol className="tgates" aria-label={t.tasks.gates}>
          {!task.turnReview && (
            <li className={task.stage > 0 || task.status === 'done' ? 'passed' : waits ? 'next' : 'current'}>
              <b>{task.executor.name}</b>
              {roleAfter(task.executor, language)}, <span>{executorState}</span>
            </li>
          )}
          {task.gates.map(g => (
            <li key={g.id} className={g.state}>
              <b>{g.name}</b>
              {roleAfter(g, language)}, <span>{t.tasks.gateStates[g.state]}</span>
            </li>
          ))}
        </ol>
      ) : (
        task.assignee && <p className="muted">{who(task.assignee)}</p>
      )}
      {task.after.length > 0 && (
        <section aria-label={t.tasks.after}>
          <h4>{t.tasks.after}</h4>
          <ul className="tp-subs">
            {task.after.map(a => (
              <li key={a.id}>
                <button className="linkish" type="button" onClick={() => onOpen(a.id)}>
                  #{a.number} {a.title}
                </button>
                <small>{t.tasks.states[a.status]}</small>
              </li>
            ))}
          </ul>
        </section>
      )}
      {task.brief && <p className="tp-brief">{task.brief}</p>}
      {task.body && (
        <section className="tp-body">
          <h4>{t.tasks.details}</h4>
          <Markdown text={task.body} />
        </section>
      )}
      {task.subtasks.length > 0 && (
        <section>
          <h4>{t.tasks.subtasks}</h4>
          <ul className="tp-subs">
            {task.subtasks.map(s => (
              <li key={s.id}>
                <button className="linkish" type="button" onClick={() => onOpen(s.id)}>
                  #{s.number} {s.title}
                </button>
                <small>{t.tasks.states[s.status]}</small>
              </li>
            ))}
          </ul>
        </section>
      )}
      {task.requests.length > 0 && (
        <section>
          <h4>{t.tasks.questions}</h4>
          <ul className="tp-log">
            {task.requests.map(r => (
              <li key={r.id}>
                <span className="tp-ev">
                  {r.agent?.name ?? t.window.hornhoof}: {r.text} <small>{t.tasks.requestStates[r.status] ?? r.status}</small>
                </span>
                {r.answer && <p>{r.answer}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h4>{t.tasks.log}</h4>
        <ol className="tp-log" aria-label={t.tasks.log}>
          {task.log.map((e, i) => {
            const evidence = field(e.data, 'evidence');
            const said = lineText(t, e, when);
            return (
              <li key={i} className={e.kind}>
                <span className="tp-ev">
                  {eventTitle(t, e)} <time dateTime={e.at}>{when(e.at)}</time>
                </span>
                {said && e.kind !== 'created' && <p>{said}</p>}
                {typeof evidence === 'string' && evidence && (
                  <p className="tp-evidence">
                    {t.tasks.evidence}: {evidence}
                  </p>
                )}
              </li>
            );
          })}
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
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setFailure(null);
    try {
      await action();
      setText('');
      setAsking(false);
      onChanged();
    } catch (err) {
      setFailure(err);
    } finally {
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
        <Field label={t.tasks.comment}>{p => <textarea {...p} rows={3} value={text} maxLength={4000} onChange={e => setText(e.target.value)} />}</Field>
        <button className="btn small" type="submit" disabled={busy || !text.trim()}>{t.tasks.addComment}</button>
      </form>
      <div className="ac-actions">
        {asking ? (
          <>
            <span className="tp-ask">{t.tasks.cancelAsk(task.number)}</span>
            <button className="btn small" type="button" disabled={busy} onClick={() => void run(() => api.post(`/api/tasks/${task.id}/cancel`, {}))}>
              {t.tasks.yesCancel}
            </button>
            <button className="btn small ghost" type="button" onClick={() => setAsking(false)}>
              {t.tasks.keep}
            </button>
          </>
        ) : (
          <button className="btn small ghost" type="button" onClick={() => setAsking(true)}>
            {t.tasks.cancelTask}
          </button>
        )}
      </div>
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </>
  );
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

export function TaskPanel({ taskId, onClose, onOpen, active = true, ...waiting }: { taskId: string; active?: boolean; onClose: () => void; onOpen: (id: string) => void } & Waiting) {
  const t = useT();
  const { task, failure, load } = useTask(taskId);
  const title = task ? `#${task.number} ${task.title}` : t.tasks.heading;
  useEscapeCloses(onClose, active);
  return (
    <aside className="acard tpanel" aria-label={title} aria-busy={!task && failure === null}>
      <div className="t-bar">
        <span className="lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span>{task ? `#${task.number}` : ''}</span>
        <button type="button" aria-label={t.window.close} onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div className="ac-body">
        {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
        {task && <TaskBody task={task} onOpen={onOpen} onChanged={load} waiting={waiting} />}
      </div>
    </aside>
  );
}
