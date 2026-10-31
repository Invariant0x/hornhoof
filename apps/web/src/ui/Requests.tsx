import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import type { TaskPlace, WaitingRequest } from '../types';
import { Field } from './Field';

/* Whether words to the agent in its window or terminal answer any of these: a question and a stuck task take them, a pick
   and a commit to approve do not. */
export const wordsAnswer = (requests: WaitingRequest[]) => requests.some(r => r.kind === 'question' || r.kind === 'stuck');

/* A picture an agent showed, as people who reach its task load it. */
const picture = (id: string) => `/api/attachments/${id}`;

/* company: whether the person sees the whole company, the only people who approve a commit. */
type Shared = { company: boolean; onOpenTask: (id: string) => void; placeName: (p: TaskPlace) => string };

/* One thing an agent waits for: a question to answer, a commit to approve, or a task it is stuck on. */
function RequestItem({ request, onDone, company, onOpenTask, placeName }: Shared & { request: WaitingRequest; onDone: () => void }) {
  const t = useT();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const { task, agent } = request;

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
      </header>
      <p className="req-text">{said}</p>
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
      {request.kind === 'choice' && (
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
      {request.kind === 'question' && (
        <form className="req-form" onSubmit={answer}>
          <Field label={t.tasks.yourAnswer}>{p => <textarea {...p} rows={2} value={text} maxLength={4000} onChange={e => setText(e.target.value)} />}</Field>
          <button className="btn small" type="submit" disabled={busy || !text.trim()}>{t.tasks.answer}</button>
        </form>
      )}
      {request.kind === 'approval' && !company && (
        <div className="req-form">
          <Commit request={request} />
          <p className="muted">{t.tasks.approvedByCompany}</p>
        </div>
      )}
      {request.kind === 'approval' && company && (
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
      {request.kind === 'stuck' && (
        <div className="req-form">
          <Field label={t.tasks.yourAnswer}>{p => <textarea {...p} rows={2} value={text} maxLength={4000} onChange={e => setText(e.target.value)} />}</Field>
          <div className="req-actions">
            <button className="btn small" type="button" disabled={busy} onClick={() => void reply(text.trim() ? { answer: text.trim() } : { retry: true })}>
              {text.trim() ? t.tasks.answer : t.tasks.retry}
            </button>
            <button className="btn small ghost" type="button" disabled={busy} onClick={() => void send(`/api/tasks/${task.id}/cancel`, {})}>
              {t.tasks.cancelTask}
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
