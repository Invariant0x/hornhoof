import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import type { TaskPlace, WaitingRequest } from '../types';
import { Field } from './Field';
import { Markdown } from './Markdown';

/* Whether words to the agent in its window or terminal answer any of these: a question and a stuck task take them, a pick
   and a commit to approve do not. */
export const wordsAnswer = (requests: WaitingRequest[]) => requests.some(r => r.kind === 'question' || r.kind === 'stuck');

/* A picture an agent showed, as people who reach its task load it. */
const picture = (id: string) => `/api/attachments/${id}`;

/* The form a request shows: the one of its kind to a person the server lets answer it, and none to anyone else. */
const formOf = (request: WaitingRequest): WaitingRequest['kind'] | null => (request.canAnswer ? request.kind : null);

/* onOpenAgent opens the asking agent's window, to see in its terminal what it did. */
type Shared = { onOpenTask: (id: string) => void; onOpenAgent: (id: string) => void; placeName: (p: TaskPlace) => string };

/* One thing an agent waits for: a question to answer, a commit to approve, or a task it is stuck on. Its answers show only
   to a person the server lets answer it: an approval to people who see the whole company. */
function RequestItem({ request, onDone, onOpenTask, onOpenAgent, placeName }: Shared & { request: WaitingRequest; onDone: () => void }) {
  const t = useT();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const { task, agent } = request;
  const form = formOf(request);

  async function send(path: string, body: unknown) {
    setBusy(true);
    setFailure(null);
    try {
      await api.post(path, body);
      onDone();
    } catch (err) {
      setFailure(err);
      setBusy(false);
    }
  }
  const reply = (body: object) => send(`/api/requests/${request.id}`, body);

  function answer(e: FormEvent) {
    e.preventDefault();
    if (text.trim()) void reply({ answer: text.trim() });
  }

  const who =
    request.kind === 'approval' ? t.tasks.asksApproval(agent.name) : request.kind === 'stuck' ? t.tasks.stuck(agent.name) : request.kind === 'choice' ? t.tasks.asksChoice(agent.name) : t.tasks.asks(agent.name);
  /* Hornhoof's own words about a stuck task are said in the person's language. */
  const said = request.kind === 'stuck' ? t.tasks.stuckText(agent.name, task.number) : request.text;
  return (
    <article className={`req req-${request.kind}`} aria-label={`#${task.number} ${task.title}`}>
      <header>
        <b>{who}</b>
        <button className="linkish" type="button" onClick={() => onOpenTask(task.id)}>
          #{task.number} {task.title}
        </button>
        {task.department && <small>{placeName(task.department)}</small>}
        <button className="btn small ghost req-term" type="button" onClick={() => onOpenAgent(agent.id)}>
          {t.tasks.openTerminal(agent.name)}
        </button>
      </header>
      {request.explained ? (
        <>
          <div className="req-explained">
            <Markdown text={request.explained} />
          </div>
          <details className="req-more">
            <summary>{t.tasks.inDetail}</summary>
            <p className="req-text">{said}</p>
          </details>
        </>
      ) : (
        <>
          <p className="req-text">{said}</p>
          {request.explaining && <p className="muted">{t.tasks.explaining}</p>}
        </>
      )}
      {request.images.length > 0 && (
        <div className="req-pics">
          {request.images.map((id, i) => (
            <a key={id} href={picture(id)} target="_blank" rel="noreferrer">
              <img src={picture(id)} alt={t.tasks.picture(i + 1)} />
            </a>
          ))}
        </div>
      )}
      {request.link && (
        <a className="req-link" href={request.link} target="_blank" rel="noreferrer">
          {t.tasks.seeWork}
        </a>
      )}
      {form === 'choice' && (
        <div className="req-form">
          <div className="req-options">
            {request.options.map((o, i) => (
              <button key={i} className="req-option" type="button" disabled={busy} onClick={() => void reply(text.trim() ? { pick: i, answer: text.trim() } : { pick: i })}>
                {o.image && <img src={picture(o.image)} alt={o.label} />}
                <span>{o.label}</span>
              </button>
            ))}
          </div>
          <Field label={t.tasks.note}>{p => <input {...p} value={text} maxLength={4000} onChange={e => setText(e.target.value)} />}</Field>
        </div>
      )}
      {(form === 'question' || form === 'stuck') && (
        <form className="req-form" onSubmit={answer}>
          <Field label={t.tasks.yourAnswer}>{p => <textarea {...p} rows={3} value={text} maxLength={4000} onChange={e => setText(e.target.value)} />}</Field>
          <div className="req-actions">
            <button className="btn small" type="submit" disabled={busy || !text.trim()}>
              {t.tasks.sendAnswer}
            </button>
            {request.kind === 'stuck' && (
              <button className="btn small ghost" type="button" disabled={busy} onClick={() => void send(`/api/tasks/${task.id}/cancel`, {})}>
                {t.tasks.cancelTask}
              </button>
            )}
          </div>
        </form>
      )}
      {request.kind === 'approval' && !request.canAnswer && (
        <div className="req-form">
          <Commit request={request} />
          <p className="muted">{t.tasks.approvedByCompany}</p>
        </div>
      )}
      {form === 'approval' && (
        <div className="req-form">
          <Commit request={request} />
          <Field label={t.tasks.note}>{p => <input {...p} value={text} maxLength={4000} onChange={e => setText(e.target.value)} />}</Field>
          <div className="req-actions">
            <button className="btn small" type="button" disabled={busy} onClick={() => void reply(text.trim() ? { approve: true, answer: text.trim() } : { approve: true })}>
              {t.tasks.approve}
            </button>
            <button className="btn small ghost" type="button" disabled={busy} onClick={() => void reply(text.trim() ? { approve: false, answer: text.trim() } : { approve: false })}>
              {t.tasks.decline}
            </button>
          </div>
        </div>
      )}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </article>
  );
}

/* The exact commit, linked on GitHub when the repository is there. */
function Commit({ request }: { request: WaitingRequest }) {
  const code = <code className="req-commit">{request.commit}</code>;
  return request.commitUrl ? (
    <a className="req-commit-link" href={request.commitUrl} target="_blank" rel="noreferrer">
      {code}
    </a>
  ) : (
    code
  );
}

export function Requests({ requests, onChanged, ...shared }: Shared & { requests: WaitingRequest[]; onChanged: () => void }) {
  return (
    <div className="reqs">
      {requests.map(r => (
        <RequestItem key={r.id} request={r} onDone={onChanged} {...shared} />
      ))}
    </div>
  );
}
