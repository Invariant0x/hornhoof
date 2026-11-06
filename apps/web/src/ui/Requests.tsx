import { useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useT, type Messages } from '../i18n';
import type { TaskPlace, WaitingRequest } from '../types';
import { DecidedByNote } from './DecidedBy';
import { Field } from './Field';
import {
  isAuthorizedHumanRequest,
  isHiddenSourceRequest,
  RequestExplanation,
  resolvePlainEnvelope,
  type HumanOptionView,
} from './RequestExplanation';
import { proseErrorText } from './TaskAttachments';

/* Whether this person's words to the agent in its window or terminal answer any of these: a question and a stuck task they
   may take take them, when the asking agent is visible to them; a pick, an approval and a hidden-source decision do not. */
export const wordsAnswer = (requests: WaitingRequest[]) =>
  requests.some(r => isAuthorizedHumanRequest(r) && !isHiddenSourceRequest(r) && r.canAnswer && (r.kind === 'question' || r.kind === 'stuck'));

/* A picture an agent showed, as people who reach its task load it. */
const picture = (id: string) => `/api/attachments/${id}`;

/* onOpenAgent opens the asking agent's window, to see in its terminal what it did. */
type Shared = { onOpenTask: (id: string) => void; onOpenAgent: (id: string) => void; placeName: (p: TaskPlace) => string };

const agentNameOf = (t: Messages, request: WaitingRequest): string =>
  isHiddenSourceRequest(request) ? t.window.hiddenEmployee : request.agent.name;

/* An approval names a commit, or under a department's policy the work its words say. */
const asksToApprove = (t: Messages, request: WaitingRequest, name: string) =>
  request.commit ? t.tasks.asksApproval(name) : t.tasks.asksApprovalOf(name);

function whoAsked(t: Messages, request: WaitingRequest): string {
  const name = agentNameOf(t, request);
  if (request.kind === 'approval') return asksToApprove(t, request, name);
  if (request.kind === 'stuck') return t.tasks.stuck(name);
  if (request.kind === 'choice') return t.tasks.asksChoice(name);
  return t.tasks.asks(name);
}

const pickBody = (pick: number, text: string) => (text.trim() ? { pick, answer: text.trim() } : { pick });
const approvalBody = (approve: boolean, text: string) => (text.trim() ? { approve, answer: text.trim() } : { approve });

/* A request for someone who may not take it: the commit or the ways it offers, and who takes it. */
function ReadOnly({ request, options }: { request: WaitingRequest; options: HumanOptionView[] }) {
  const t = useT();
  return (
    <div className="req-form">
      {request.kind === 'approval' && <ApprovedCommit request={request} />}
      {request.kind === 'choice' && options.length > 0 && (
        <ul className="req-ways">
          {options.map((o, i) => (
            <li key={i}>
              <span>{o.label}</span>
              {o.consequence && <span className="muted">{` (${t.tasks.consequenceLabel}: ${o.consequence})`}</span>}
            </li>
          ))}
        </ul>
      )}
      <DecidedByNote by={request.decidedBy} />
    </div>
  );
}

function RequestHeader({ who, request, hidden, onOpenTask, onOpenAgent, placeName }: Shared & { who: string; request: WaitingRequest; hidden: boolean }) {
  const t = useT();
  if (hidden) {
    return (
      <header>
        <b>{who}</b>
      </header>
    );
  }
  const { task, agent } = request;
  return (
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
  );
}

function RequestMedia({ request }: { request: WaitingRequest }) {
  const t = useT();
  return (
    <>
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
    </>
  );
}

type ChoiceProps = {
  options: HumanOptionView[];
  text: string;
  busy: boolean;
  onText: (value: string) => void;
  onPick: (index: number) => void;
  onSubmit: (e: FormEvent) => void;
};

/* A choice lets the person pick a way with an optional note, or send free-form feedback without picking any way. */
function ChoiceForm({ options, text, busy, onText, onPick, onSubmit }: ChoiceProps) {
  const t = useT();
  return (
    <form className="req-form" onSubmit={onSubmit}>
      {options.length > 0 && (
        <div className="req-options">
          {options.map((o, i) => (
            <button key={i} className="req-option" type="button" disabled={busy} onClick={() => onPick(i)}>
              {o.image && <img src={picture(o.image)} alt={o.label} />}
              <span>{o.label}</span>
              {o.consequence && <span className="muted">{`${t.tasks.consequenceLabel}: ${o.consequence}`}</span>}
            </button>
          ))}
        </div>
      )}
      <Field label={t.tasks.choiceNote} hint={t.tasks.choiceHint}>
        {p => <textarea {...p} rows={3} value={text} onChange={e => onText(e.target.value)} />}
      </Field>
      <div className="req-actions">
        <button className="btn small" type="submit" disabled={busy || !text.trim()}>
          {t.tasks.sendFeedback}
        </button>
      </div>
    </form>
  );
}

type QuestionProps = {
  canCancel: boolean;
  text: string;
  busy: boolean;
  onText: (value: string) => void;
  onSubmit: (e: FormEvent) => void;
  onCancel: () => void;
};

function QuestionForm({ canCancel, text, busy, onText, onSubmit, onCancel }: QuestionProps) {
  const t = useT();
  return (
    <form className="req-form" onSubmit={onSubmit}>
      <Field label={t.tasks.yourAnswer}>
        {p => <textarea {...p} rows={3} value={text} onChange={e => onText(e.target.value)} />}
      </Field>
      <div className="req-actions">
        <button className="btn small" type="submit" disabled={busy || !text.trim()}>
          {t.tasks.sendAnswer}
        </button>
        {canCancel && (
          <button className="btn small ghost" type="button" disabled={busy} onClick={onCancel}>
            {t.tasks.cancelTask}
          </button>
        )}
      </div>
    </form>
  );
}

type ApprovalProps = {
  request: WaitingRequest;
  text: string;
  busy: boolean;
  onText: (value: string) => void;
  onDecide: (approve: boolean) => void;
};

function ApprovalForm({ request, text, busy, onText, onDecide }: ApprovalProps) {
  const t = useT();
  return (
    <div className="req-form">
      <ApprovedCommit request={request} />
      <Field label={t.tasks.note}>{p => <textarea {...p} rows={3} value={text} onChange={e => onText(e.target.value)} />}</Field>
      <div className="req-actions">
        <button className="btn small" type="button" disabled={busy} onClick={() => onDecide(true)}>
          {t.tasks.approve}
        </button>
        <button className="btn small ghost" type="button" disabled={busy} onClick={() => onDecide(false)}>
          {t.tasks.decline}
        </button>
      </div>
    </div>
  );
}

type FormActions = {
  options: HumanOptionView[];
  canCancel: boolean;
  text: string;
  busy: boolean;
  onText: (value: string) => void;
  onAnswer: (e: FormEvent) => void;
  onPick: (index: number) => void;
  onDecide: (approve: boolean) => void;
  onCancel: () => void;
};

function RequestForm({ request, options, canCancel, text, busy, onText, onAnswer, onPick, onDecide, onCancel }: FormActions & { request: WaitingRequest }) {
  if (!request.canAnswer) return <ReadOnly request={request} options={options} />;
  if (request.kind === 'choice') return <ChoiceForm options={options} text={text} busy={busy} onText={onText} onPick={onPick} onSubmit={onAnswer} />;
  if (request.kind === 'approval') return <ApprovalForm request={request} text={text} busy={busy} onText={onText} onDecide={onDecide} />;
  return <QuestionForm canCancel={canCancel} text={text} busy={busy} onText={onText} onSubmit={onAnswer} onCancel={onCancel} />;
}

function useRequestSend(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const sending = useRef(false);

  async function send(path: string, body: unknown) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await api.post(path, body);
      onDone();
    } catch (err) {
      sending.current = false;
      setFailure(err);
      setBusy(false);
    }
  }

  return { busy, failure, send };
}

function RequestFeedback({ busy, failure }: { busy: boolean; failure: unknown }) {
  const t = useT();
  if (busy) return <p className="muted" role="status">{t.tasks.sending}</p>;
  if (failure !== null) return <p className="alert" role="alert">{proseErrorText(t, failure)}</p>;
  return null;
}

/* One thing an agent waits for: a question to answer, a choice to answer or pick, a commit to approve, or a stuck task.
   Its answers show only to a person the server lets take it; anyone else reads who takes it. */
function RequestItem({ request, onDone, ...shared }: Shared & { request: WaitingRequest; onDone: () => void }) {
  const t = useT();
  const [text, setText] = useState('');
  const { busy, failure, send } = useRequestSend(onDone);
  const hidden = isHiddenSourceRequest(request);
  const envelope = resolvePlainEnvelope(request);
  const label = hidden ? t.tasks.hiddenDecisionLabel : `#${request.task.number} ${request.task.title}`;
  const reply = (body: object) => void send(`/api/requests/${request.id}`, body);

  function answer(e: FormEvent) {
    e.preventDefault();
    if (text.trim()) reply({ answer: text.trim() });
  }

  return (
    <article className={`req req-${request.kind}`} aria-label={label} aria-busy={busy}>
      <RequestHeader who={whoAsked(t, request)} request={request} hidden={hidden} {...shared} />
      <RequestExplanation request={request} envelope={envelope} />
      <RequestMedia request={request} />
      <RequestForm
        request={request}
        options={envelope.options}
        canCancel={request.kind === 'stuck' && !hidden}
        text={text}
        busy={busy}
        onText={setText}
        onAnswer={answer}
        onPick={i => reply(pickBody(i, text))}
        onDecide={approve => reply(approvalBody(approve, text))}
        onCancel={() => void send(`/api/tasks/${request.task.id}/cancel`, {})}
      />
      <RequestFeedback busy={busy} failure={failure} />
    </article>
  );
}

/* The exact commit, linked on GitHub when the repository is there. */
/* An approval under a department's policy is about the work its words name, and shows no commit. */
const ApprovedCommit = ({ request }: { request: WaitingRequest }) => (request.commit ? <Commit request={request} /> : null);

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
  const visible = requests.filter(isAuthorizedHumanRequest);
  if (visible.length === 0) return null;
  return (
    <div className="reqs">
      {visible.map(r => (
        <RequestItem key={r.id} request={r} onDone={onChanged} {...shared} />
      ))}
    </div>
  );
}
