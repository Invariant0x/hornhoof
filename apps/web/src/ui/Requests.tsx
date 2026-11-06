import { useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useT, type Messages } from '../i18n';
import type { TaskPlace, WaitingRequest } from '../types';
import { DecidedByNote } from './DecidedBy';
import { Field } from './Field';
import { MaterialViewer } from './MaterialViewer';
import { BoundApprovalSnapshot } from './Outbound';
import {
  isAuthorizedHumanRequest,
  isHiddenSourceRequest,
  RequestExplanation,
  resolvePlainEnvelope,
  type HumanOptionView,
  type PlainEnvelopeView,
} from './RequestExplanation';
import { OptionMaterialItems, RequestMaterialsZone, readMaterialStamp, useRequestMaterials, type MaterialItem, type MaterialManifestView } from './RequestMaterials';
import { proseErrorText } from './TaskAttachments';

/* Whether this person's words to the agent in its window or terminal answer any of these: a question and a stuck task they
   may take take them, when the asking agent is visible to them; a pick, an approval and a hidden-source decision do not. */
export const wordsAnswer = (requests: WaitingRequest[]) =>
  requests.some(r => isAuthorizedHumanRequest(r) && !isHiddenSourceRequest(r) && r.canAnswer && (r.kind === 'question' || r.kind === 'stuck'));

const draftsByRequest = new Map<string, string>();

export function clearRequestDraftsForTests(): void {
  draftsByRequest.clear();
}

function storeRequestDraft(requestId: string, value: string): void {
  if (value) draftsByRequest.set(requestId, value);
  else draftsByRequest.delete(requestId);
}

const defaultPlaceName = (p: TaskPlace) => p?.name ?? '';

/* onOpenAgent opens the asking agent's window, to see in its terminal what it did. */
type Shared = { onOpenTask: (id: string) => void; onOpenAgent: (id: string) => void; placeName?: (p: TaskPlace) => string };

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
const optionMaterialsAt = (manifest: MaterialManifestView, index: number): MaterialItem[] => manifest.options[index]?.materials ?? [];
const anyOptionHasMaterials = (manifest: MaterialManifestView): boolean => manifest.options.some(o => o.materials.length > 0);
const cardLabelOf = (t: Messages, request: WaitingRequest, hidden: boolean): string =>
  hidden ? t.tasks.hiddenDecisionLabel : `#${request.task.number} ${request.task.title}`;

function materialSourceFor(request: WaitingRequest, envelope: PlainEnvelopeView): WaitingRequest {
  if (!envelope.classified) return request;
  if (envelope.pending) return { ...request, images: [], link: null, options: [] };
  return { ...request, options: envelope.options.map(o => ({ label: o.label, image: o.image })) };
}

function OptionHeading({ index, label, consequence }: { index: number; label: string; consequence: string | null }) {
  const t = useT();
  return (
    <p className="opt-name">
      <span className="opt-n">{index + 1}</span>
      <span>
        {label}
        {consequence && <span className="muted">{` (${t.tasks.consequenceLabel}: ${consequence})`}</span>}
      </span>
    </p>
  );
}

function ReadOnlyChoice({
  options,
  manifest,
  onOpenMaterial,
}: {
  options: HumanOptionView[];
  manifest: MaterialManifestView;
  onOpenMaterial: (id: string, opener: HTMLElement | null) => void;
}) {
  const t = useT();
  if (anyOptionHasMaterials(manifest)) {
    return (
      <ol className="opts">
        {options.map((o, i) => (
          <li key={i} className="opt">
            <OptionHeading index={i} label={o.label} consequence={o.consequence} />
            <OptionMaterialItems items={optionMaterialsAt(manifest, i)} onOpen={onOpenMaterial} />
          </li>
        ))}
      </ol>
    );
  }
  if (options.length === 0) return null;
  return (
    <ul className="req-ways">
      {options.map((o, i) => (
        <li key={i}>
          <span>{o.label}</span>
          {o.consequence && <span className="muted">{` (${t.tasks.consequenceLabel}: ${o.consequence})`}</span>}
        </li>
      ))}
    </ul>
  );
}

/* A request for someone who may not take it: the commit or the ways it offers, and who takes it. */
function ReadOnly({
  request,
  options,
  manifest,
  onOpenMaterial,
}: {
  request: WaitingRequest;
  options: HumanOptionView[];
  manifest: MaterialManifestView;
  onOpenMaterial: (id: string, opener: HTMLElement | null) => void;
}) {
  return (
    <div className="req-form">
      {request.kind === 'approval' && <ApprovedCommit request={request} />}
      {request.kind === 'choice' && <ReadOnlyChoice options={options} manifest={manifest} onOpenMaterial={onOpenMaterial} />}
      <DecidedByNote by={request.decidedBy} />
    </div>
  );
}

function RequestHeader({
  who,
  request,
  hidden,
  onOpenTask,
  onOpenAgent,
  placeName = defaultPlaceName,
}: Shared & { who: string; request: WaitingRequest; hidden: boolean }) {
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

function OptionCardsChoice({
  options,
  manifest,
  busy,
  onPick,
  onOpenMaterial,
}: {
  options: HumanOptionView[];
  manifest: MaterialManifestView;
  busy: boolean;
  onPick: (index: number) => void;
  onOpenMaterial: (id: string, opener: HTMLElement | null) => void;
}) {
  const t = useT();
  return (
    <ol className="opts">
      {options.map((o, i) => (
        <li key={i} className="opt">
          <OptionHeading index={i} label={o.label} consequence={o.consequence} />
          <OptionMaterialItems items={optionMaterialsAt(manifest, i)} onOpen={onOpenMaterial} />
          <div className="entry-actions">
            <button className="btn" type="button" disabled={busy} onClick={() => onPick(i)}>
              {t.tasks.chooseOption(i + 1)}
            </button>
          </div>
        </li>
      ))}
    </ol>
  );
}

function PlainChoiceButtons({ options, busy, onPick }: { options: HumanOptionView[]; busy: boolean; onPick: (index: number) => void }) {
  const t = useT();
  if (options.length === 0) return null;
  return (
    <div className="choice-list req-options">
      {options.map((o, i) => (
        <button key={i} className="req-option" type="button" disabled={busy} onClick={() => onPick(i)}>
          <span>{o.label}</span>
          {o.consequence && <span className="muted">{`${t.tasks.consequenceLabel}: ${o.consequence}`}</span>}
        </button>
      ))}
    </div>
  );
}

type ChoiceProps = {
  options: HumanOptionView[];
  manifest: MaterialManifestView;
  text: string;
  busy: boolean;
  onText: (value: string) => void;
  onPick: (index: number) => void;
  onSubmit: (e: FormEvent) => void;
  onOpenMaterial: (id: string, opener: HTMLElement | null) => void;
};

/* A choice lets the person inspect materials first, then pick a way with an optional note or send feedback without picking one. */
function ChoiceForm({ options, manifest, text, busy, onText, onPick, onSubmit, onOpenMaterial }: ChoiceProps) {
  const t = useT();
  return (
    <form className="req-form" onSubmit={onSubmit}>
      {anyOptionHasMaterials(manifest) ? (
        <OptionCardsChoice options={options} manifest={manifest} busy={busy} onPick={onPick} onOpenMaterial={onOpenMaterial} />
      ) : (
        <PlainChoiceButtons options={options} busy={busy} onPick={onPick} />
      )}
      <div className="answer-zone">
        <Field label={t.tasks.choiceNote} hint={t.tasks.choiceHint}>
          {p => <textarea {...p} rows={3} value={text} onChange={e => onText(e.target.value)} />}
        </Field>
        <div className="req-actions entry-actions">
          <button className="btn ghost" type="submit" disabled={busy || !text.trim()}>
            {t.tasks.sendFeedback}
          </button>
        </div>
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
      <div className="req-actions entry-actions">
        <button className="btn" type="submit" disabled={busy || !text.trim()}>
          {t.tasks.sendAnswer}
        </button>
        {canCancel && (
          <button className="btn ghost" type="button" disabled={busy} onClick={onCancel}>
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
      <div className="req-actions entry-actions">
        <button className="btn" type="button" disabled={busy} onClick={() => onDecide(true)}>
          {t.tasks.approve}
        </button>
        <button className="btn ghost" type="button" disabled={busy} onClick={() => onDecide(false)}>
          {t.tasks.decline}
        </button>
      </div>
    </div>
  );
}

type FormActions = {
  options: HumanOptionView[];
  manifest: MaterialManifestView;
  canCancel: boolean;
  text: string;
  busy: boolean;
  onText: (value: string) => void;
  onAnswer: (e: FormEvent) => void;
  onPick: (index: number) => void;
  onDecide: (approve: boolean) => void;
  onCancel: () => void;
  onOpenMaterial: (id: string, opener: HTMLElement | null) => void;
};

function RequestForm({
  request,
  options,
  manifest,
  canCancel,
  text,
  busy,
  onText,
  onAnswer,
  onPick,
  onDecide,
  onCancel,
  onOpenMaterial,
}: FormActions & { request: WaitingRequest }) {
  if (!request.canAnswer) return <ReadOnly request={request} options={options} manifest={manifest} onOpenMaterial={onOpenMaterial} />;
  if (request.kind === 'choice') {
    return (
      <ChoiceForm
        options={options}
        manifest={manifest}
        text={text}
        busy={busy}
        onText={onText}
        onPick={onPick}
        onSubmit={onAnswer}
        onOpenMaterial={onOpenMaterial}
      />
    );
  }
  if (request.kind === 'approval') return <ApprovalForm request={request} text={text} busy={busy} onText={onText} onDecide={onDecide} />;
  return <QuestionForm canCancel={canCancel} text={text} busy={busy} onText={onText} onSubmit={onAnswer} onCancel={onCancel} />;
}

function useRequestSend(requestId: string, onDone: () => void) {
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
      draftsByRequest.delete(requestId);
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
  if (busy) {
    return (
      <p className="muted" role="status">
        {t.tasks.sending}
      </p>
    );
  }
  if (failure !== null) {
    return (
      <p className="alert" role="alert">
        {proseErrorText(t, failure)}
      </p>
    );
  }
  return null;
}

/* One thing an agent waits for: a question to answer, a choice to answer or pick, a commit to approve, or a stuck task.
   Its answers show only to a person the server lets take it; anyone else reads who takes it. */
function RequestItem({ request, onDone, ...shared }: Shared & { request: WaitingRequest; onDone: () => void }) {
  const t = useT();
  const [text, setText] = useState(() => draftsByRequest.get(request.id) ?? '');
  const { busy, failure, send } = useRequestSend(request.id, onDone);
  const hidden = isHiddenSourceRequest(request);
  const envelope = resolvePlainEnvelope(request);
  const { manifest, availableItems, failure: manifestFailure, viewer, openViewer, selectViewer, closeViewer } = useRequestMaterials(
    materialSourceFor(request, envelope),
    t,
  );
  const stamp = readMaterialStamp(request, manifest);
  const reply = (body: object) => void send(`/api/requests/${request.id}`, { ...stamp, ...body });

  function updateDraft(next: string) {
    setText(next);
    storeRequestDraft(request.id, next);
  }

  function answer(e: FormEvent) {
    e.preventDefault();
    if (text.trim()) reply({ answer: text.trim() });
  }

  return (
    <article className={`req req-${request.kind}`} aria-label={cardLabelOf(t, request, hidden)} aria-busy={busy}>
      <RequestHeader who={whoAsked(t, request)} request={request} hidden={hidden} {...shared} />
      <RequestExplanation request={request} envelope={envelope} />
      <RequestMaterialsZone items={manifest.common} failure={manifestFailure} onOpen={openViewer} />
      <RequestForm
        request={request}
        options={envelope.options}
        manifest={manifest}
        canCancel={request.kind === 'stuck' && !hidden}
        text={text}
        busy={busy}
        onText={updateDraft}
        onAnswer={answer}
        onPick={i => reply(pickBody(i, text))}
        onDecide={approve => reply(approvalBody(approve, text))}
        onCancel={() => {
          if (!hidden) void send(`/api/tasks/${request.task.id}/cancel`, {});
        }}
        onOpenMaterial={openViewer}
      />
      <RequestFeedback busy={busy} failure={failure} />
      {viewer && <MaterialViewer items={availableItems} activeId={viewer.id} opener={viewer.opener} onSelect={selectViewer} onClose={closeViewer} />}
    </article>
  );
}

/* The exact commit, linked on GitHub when the repository is there. */
/* An approval under a department's policy is about the work its words name, and shows its bound snapshot when present. */
const ApprovedCommit = ({ request }: { request: WaitingRequest }) => (request.commit ? <Commit request={request} /> : <BoundApprovalSnapshot requestId={request.id} />);

function Commit({ request }: { request: WaitingRequest }) {
  const code = (
    <code className="req-commit" style={{ display: 'block', minWidth: 0 }}>
      {request.commit}
    </code>
  );
  return request.commitUrl ? (
    <a className="req-commit-link" style={{ minWidth: 0 }} href={request.commitUrl} target="_blank" rel="noreferrer">
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
