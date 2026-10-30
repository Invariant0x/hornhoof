import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import type { TaskPlace, WaitingRequest } from '../types';
import { Field } from './Field';

type Shared = { onOpenTask: (id: string) => void; placeName: (p: TaskPlace) => string };

/* One thing an agent waits for: a question to answer, a commit to approve, or a task it is stuck on. */
function RequestItem({ request, onDone, onOpenTask, placeName }: Shared & { request: WaitingRequest; onDone: () => void }) {
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

  const who = request.kind === 'approval' ? t.tasks.asksApproval(agent.name) : request.kind === 'stuck' ? t.tasks.stuck(agent.name) : t.tasks.asks(agent.name);
  return (
    <article className={`req ${request.kind}`} aria-label={`#${task.number} ${task.title}`}>
      <header>
        <b>{who}</b>
        <button className="linkish" type="button" onClick={() => onOpenTask(task.id)}>
          #{task.number} {task.title}
        </button>
        {task.department && <small>{placeName(task.department)}</small>}
      </header>
      <p className="req-text">{request.text}</p>
      {request.kind === 'question' && (
        <form className="req-form" onSubmit={answer}>
          <Field label={t.tasks.yourAnswer}>{p => <textarea {...p} rows={2} value={text} maxLength={4000} onChange={e => setText(e.target.value)} />}</Field>
          <button className="btn small" type="submit" disabled={busy || !text.trim()}>{t.tasks.answer}</button>
        </form>
      )}
      {request.kind === 'approval' && (
        <div className="req-form">
          <code className="req-commit">{request.commit}</code>
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

export function Requests({ requests, onChanged, ...shared }: Shared & { requests: WaitingRequest[]; onChanged: () => void }) {
  return (
    <div className="reqs">
      {requests.map(r => (
        <RequestItem key={r.id} request={r} onDone={onChanged} {...shared} />
      ))}
    </div>
  );
}
