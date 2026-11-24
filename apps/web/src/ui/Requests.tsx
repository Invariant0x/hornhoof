import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { Phrase, useT, type Messages } from '../i18n';
import type { TaskPlace, UncheckedItem, WaitingRequest } from '../types';
import { useConfirmAction } from './ConfirmAction';
import { DecidedByNote } from './DecidedBy';
import { Field } from './Field';
import { Markdown } from './Markdown';
import { MaterialViewer } from './MaterialViewer';
import { OptionMaterialItems, RequestMaterialsZone, readMaterialStamp, useRequestMaterials, type MaterialItem, type MaterialManifestView } from './RequestMaterials';
import { proseErrorText } from './TaskAttachments';
import { sinceSeconds, spanText } from './tracker-words';

/* Whether this person's words to the agent in its window or terminal answer any of these: a question and a stuck task they
   may take take them, a pick and a commit to approve do not. */
export const wordsAnswer = (requests: WaitingRequest[]) => requests.some(r => r.canAnswer && (r.kind === 'question' || r.kind === 'stuck'));

/* What this person typed and did not send yet, kept while a card closes and opens again. */
const draftsByRequest = new Map<string, string>();

/* A person leaving the tab takes what they typed and did not send with them: the next one starts with empty answers. */
export function forgetRequestDrafts(): void {
  draftsByRequest.clear();
}

/* Drafts of so many cards stay at most, the one typed in last kept newest; the oldest one goes first. */
export function keepDraft(drafts: Map<string, string>, requestId: string, value: string, kept = 200): void {
  drafts.delete(requestId);
  if (value) drafts.set(requestId, value);
  if (drafts.size > kept) drafts.delete(drafts.keys().next().value!);
}

function storeRequestDraft(requestId: string, value: string): void {
  keepDraft(draftsByRequest, requestId, value);
}

const defaultPlaceName = (p: TaskPlace) => p?.name ?? '';

/* onOpenAgent opens the asking agent's window, to see in its terminal what it did. */
/* waitsFor: whom a request waits for, by the person it is for, on lists of more people than one. */
/* viewerId: the signed-in person; headings address them directly only when the request waits for them and they may answer it. */
type Shared = { onOpenTask: (id: string) => void; onOpenAgent: (id: string) => void; placeName?: (p: TaskPlace) => string; inline?: boolean; waitsFor?: (personId: string) => string; viewerId?: string; onDefer?: () => void };

const isAddressedToViewer = (request: WaitingRequest, viewerId?: string): boolean =>
  request.canAnswer && (viewerId === undefined || request.ownerPersonId === viewerId);

/* An approval names a commit, or under a department's policy the work its words say. */
export function whoAsked(t: Messages, request: WaitingRequest, viewerId?: string): string {
  if (request.kind === 'stuck') return t.tasks.stuck(request.agent.name);
  const words = isAddressedToViewer(request, viewerId)
    ? { question: t.tasks.asks, choice: t.tasks.asksChoice, approval: t.tasks.asksApproval, approvalOf: t.tasks.asksApprovalOf }
    : t.tasks.asksOther;
  if (request.kind === 'approval') return (request.commit ? words.approval : words.approvalOf)(request.agent.name);
  return words[request.kind](request.agent.name);
}

const pickBody = (pick: number, text: string) => (text.trim() ? { pick, answer: text.trim() } : { pick });
const approvalBody = (approve: boolean, text: string) => (text.trim() ? { approve, answer: text.trim() } : { approve });
const optionMaterialsAt = (manifest: MaterialManifestView, index: number): MaterialItem[] => manifest.options[index]?.materials ?? [];
const anyOptionHasMaterials = (manifest: MaterialManifestView): boolean => manifest.options.some(o => o.materials.length > 0);

function OptionHeading({ index, label }: { index: number; label: string }) {
  return (
    <p className="opt-name">
      <span className="opt-n">{index + 1}</span>
      <span>{label}</span>
    </p>
  );
}

function ReadOnlyChoice({
  options,
  manifest,
  onOpenMaterial,
}: {
  options: WaitingRequest['options'];
  manifest: MaterialManifestView;
  onOpenMaterial: (id: string, opener: HTMLElement | null) => void;
}) {
  if (anyOptionHasMaterials(manifest)) {
    return (
      <ol className="opts">
        {options.map((o, i) => (
          <li key={i} className="opt">
            <OptionHeading index={i} label={o.label} />
            <OptionMaterialItems items={optionMaterialsAt(manifest, i)} onOpen={onOpenMaterial} />
          </li>
        ))}
      </ol>
    );
  }
  return (
    <ul className="req-ways">
      {options.map((o, i) => (
        <li key={i}>{o.label}</li>
      ))}
    </ul>
  );
}

/* A request for someone who may not take it: the commit or the ways it offers, and who takes it. */
function ReadOnly({
  request,
  manifest,
  onOpenMaterial,
}: {
  request: WaitingRequest;
  manifest: MaterialManifestView;
  onOpenMaterial: (id: string, opener: HTMLElement | null) => void;
}) {
  return (
    <div className="req-form">
      {request.kind === 'approval' && <ApprovedCommit request={request} />}
      {request.kind === 'approval' && <UncheckedList request={request} />}
      {request.kind === 'choice' && <ReadOnlyChoice options={request.options} manifest={manifest} onOpenMaterial={onOpenMaterial} />}
      <DecidedByNote by={request.decidedBy} />
    </div>
  );
}

function RequestAuthor({ who, request }: { who: string; request: WaitingRequest }) {
  const t = useT();
  return <><b><bdi>{who}</bdi></b>{namedReadOnly(request) && <span className="status wait-neutral">{t.tasks.queue.readOnly}</span>}</>;
}

function RequestHeader({ who, request, onOpenTask, onOpenAgent, placeName = defaultPlaceName, waitsFor, onDefer }: Shared & { who: string; request: WaitingRequest }) {
  const t = useT();
  const { task, agent } = request;
  return (
    <header>
      <RequestAuthor who={who} request={request} />
      <button className="linkish" type="button" onClick={() => onOpenTask(task.id)}>
        <bdi>#{task.number} {task.title}</bdi>
      </button>
      {task.department && <small>{placeName(task.department)}</small>}
      {onDefer && <small><bdi>{spanText(t, sinceSeconds(request.at))}</bdi></small>}
      {waitsFor && <small>{waitsFor(request.ownerPersonId)}</small>}
      <button className="btn small ghost req-term" type="button" onClick={() => onOpenAgent(agent.id)}>
        {t.tasks.openTerminal(agent.name)}
      </button>
    </header>
  );
}

function RequestWords({ request, said, inline }: { request: WaitingRequest; said: string; inline?: boolean }) {
  const t = useT();
  if (request.explained) {
    return (
      <>
        <div className="req-explained">
          <Markdown text={request.explained} />
        </div>
        {!inline && <details className="req-more">
          <summary>{t.tasks.inDetail}</summary>
          <p className="req-text" dir="auto">{said}</p>
        </details>}
      </>
    );
  }
  return (
    <>
      <p className="req-text" dir="auto">{said}</p>
      {request.explaining && <p className="muted">{t.tasks.explaining}</p>}
    </>
  );
}

function OptionCardsChoice({
  options,
  manifest,
  busy,
  onPick,
  onOpenMaterial,
}: {
  options: WaitingRequest['options'];
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
          <OptionHeading index={i} label={o.label} />
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

function PlainChoiceButtons({ options, busy, onPick }: { options: WaitingRequest['options']; busy: boolean; onPick: (index: number) => void }) {
  return (
    <div className="choice-list req-options">
      {options.map((o, i) => (
        <button key={i} className="req-option" type="button" disabled={busy} onClick={() => onPick(i)}>
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

type ChoiceProps = {
  defer?: ReactNode;
  options: WaitingRequest['options'];
  manifest: MaterialManifestView;
  text: string;
  busy: boolean;
  onText: (value: string) => void;
  onPick: (index: number) => void;
  onSubmit: (e: FormEvent) => void;
  onOpenMaterial: (id: string, opener: HTMLElement | null) => void;
};

/* A choice lets the person inspect materials first, then pick a way with an optional note or send feedback without picking one. */
function ChoiceForm({ options, manifest, text, busy, onText, onPick, onSubmit, onOpenMaterial, defer }: ChoiceProps) {
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
          {defer}
        </div>
      </div>
    </form>
  );
}

type QuestionProps = {
  defer?: ReactNode;
  text: string;
  busy: boolean;
  onText: (value: string) => void;
  onSubmit: (e: FormEvent) => void;
  onCancel?: () => void;
};

function QuestionForm({ text, busy, onText, onSubmit, onCancel, defer }: QuestionProps) {
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
        {onCancel && (
          <button className="btn ghost" type="button" disabled={busy} onClick={onCancel}>
            {t.tasks.cancelTask}
          </button>
        )}
        {defer}
      </div>
    </form>
  );
}

type ApprovalProps = {
  defer?: ReactNode;
  request: WaitingRequest;
  text: string;
  busy: boolean;
  onText: (value: string) => void;
  onDecide: (approve: boolean) => void;
};

function ApprovalForm({ request, text, busy, onText, onDecide, defer }: ApprovalProps) {
  const t = useT();
  return (
    <div className="req-form">
      <ApprovedCommit request={request} />
      <UncheckedList request={request} />
      <Field label={t.tasks.note}>{p => <textarea {...p} rows={3} value={text} onChange={e => onText(e.target.value)} />}</Field>
      <div className="req-actions entry-actions">
        <button className="btn" type="button" disabled={busy} onClick={() => onDecide(true)}>
          {t.tasks.approve}
        </button>
        <button className="btn ghost" type="button" disabled={busy} onClick={() => onDecide(false)}>
          {t.tasks.decline}
        </button>
        {defer}
      </div>
    </div>
  );
}

type FormActions = {
  defer?: ReactNode;
  manifest: MaterialManifestView;
  text: string;
  busy: boolean;
  onText: (value: string) => void;
  onAnswer: (e: FormEvent) => void;
  onPick: (index: number) => void;
  onDecide: (approve: boolean) => void;
  onCancel?: () => void;
  onOpenMaterial: (id: string, opener: HTMLElement | null) => void;
};

function RequestForm({ request, manifest, text, busy, onText, onAnswer, onPick, onDecide, onCancel, onOpenMaterial, defer }: FormActions & { request: WaitingRequest }) {
  if (!request.canAnswer) return <ReadOnly request={request} manifest={manifest} onOpenMaterial={onOpenMaterial} />;
  if (request.kind === 'choice') {
    return (
      <ChoiceForm
        options={request.options}
        manifest={manifest}
        text={text}
        busy={busy}
        onText={onText}
        onPick={onPick}
        onSubmit={onAnswer}
        onOpenMaterial={onOpenMaterial}
        defer={defer}
      />
    );
  }
  if (request.kind === 'approval') return <ApprovalForm request={request} text={text} busy={busy} onText={onText} onDecide={onDecide} defer={defer} />;
  return <QuestionForm text={text} busy={busy} onText={onText} onSubmit={onAnswer} onCancel={request.kind === 'stuck' ? onCancel : undefined} defer={defer} />;
}

function useRequestSend(requestId: string, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const sending = useRef(false);

  async function post(path: string, body: unknown) {
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
      setBusy(false);
      throw err;
    }
  }

  async function send(path: string, body: unknown) {
    try {
      await post(path, body);
    } catch (err) {
      setFailure(err);
    }
  }

  return { busy, failure, send, post };
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
export const namedReadOnly = (request: WaitingRequest) => !request.canAnswer && request.decidedBy?.kind === 'named_person';

function RequestItem({ request, onDone, inline, onDefer, viewerId, ...shared }: Shared & { request: WaitingRequest; onDone: () => void }) {
  const t = useT();
  const [text, setText] = useState(() => draftsByRequest.get(request.id) ?? '');
  const { busy, failure, send, post } = useRequestSend(request.id, onDone);
  const confirmation = useConfirmAction();
  const { manifest, availableItems, failure: manifestFailure, viewer, openViewer, selectViewer, closeViewer } = useRequestMaterials(request, t);
  const { task, agent } = request;
  const stamp = readMaterialStamp(request, manifest);
  const reply = (body: object) => void send(`/api/requests/${request.id}`, { ...stamp, ...body });
  const taskLabel = `#${task.number} ${task.title}`;

  function askCancel() {
    confirmation.ask({
      ...t.tasks.confirm.cancel,
      effect: <Phrase words={t.tasks.confirm.cancel.effect} values={[<bdi>{taskLabel}</bdi>]} />,
      danger: true,
      onYes: () => post(`/api/tasks/${task.id}/cancel`, {}),
    });
  }

  function updateDraft(next: string) {
    setText(next);
    storeRequestDraft(request.id, next);
  }

  function answer(e: FormEvent) {
    e.preventDefault();
    if (text.trim()) reply({ answer: text.trim() });
  }

  /* Hornhoof's own words about a stuck task are said in the person's language. */
  const said = request.kind === 'stuck' ? t.tasks.stuckText(agent.name, task.number) : request.text;
  const who = whoAsked(t, request, viewerId);
  return (
    <article className={`req req-${request.kind}`} aria-label={`#${task.number} ${task.title}`} aria-busy={busy}>
      {inline ? <header><RequestAuthor who={who} request={request} /></header> : <RequestHeader who={who} request={request} onDefer={onDefer} {...shared} />}
      <RequestWords request={request} said={said} inline={inline} />
      <RequestMaterialsZone items={manifest.common} failure={manifestFailure} onOpen={openViewer} heading={onDefer ? t.tasks.queue.materials : undefined} />
      <RequestForm
        request={request}
        manifest={manifest}
        text={text}
        busy={busy}
        onText={updateDraft}
        onAnswer={answer}
        onPick={i => reply(pickBody(i, text))}
        onDecide={approve => reply(approvalBody(approve, text))}
        onCancel={inline ? undefined : askCancel}
        onOpenMaterial={openViewer}
        defer={onDefer && <button className="btn ghost" type="button" disabled={busy} onClick={onDefer}>{t.tasks.queue.defer}</button>}
      />
      <RequestFeedback busy={busy} failure={failure} />
      {viewer && <MaterialViewer items={availableItems} activeId={viewer.id} opener={viewer.opener} onSelect={selectViewer} onClose={closeViewer} />}
      {confirmation.question}
    </article>
  );
}

type UncheckedWords = Messages['tasks']['unchecked'];

/* Each kind of what a release brings that no check covers, in the person's language. */
const UNCHECKED_TEXT: { [K in UncheckedItem['kind']]: (words: UncheckedWords, item: UncheckedItem & { kind: K }) => string } = {
  unread: (words, item) => words.unread(item.base, item.commit),
  holder_off: (words, item) => words.holderOff(item.task),
  no_candidate: (words, item) => words.noCandidate(item.task),
  checker: (words, item) => words.checker(item.task, item.commit),
  task_unread: (words, item) => words.taskUnread(item.task),
  unpinned: (words, item) => words.unpinned(item.task),
  unstarted: (words, item) => words.unstarted(item.task),
  merge: (words, item) => words.merge(item.commit),
  commit: (words, item) => words.commit(item.commit),
};

/* One thing a release brings that no check covers, in the person's language. */
function uncheckedText(t: Messages, item: UncheckedItem): string {
  return (UNCHECKED_TEXT[item.kind] as (words: UncheckedWords, item: UncheckedItem) => string)(t.tasks.unchecked, item);
}

/* What the release brings that no check covers, as Hornhoof keeps it apart from the words and the plain explanation above:
   it shows where the person approves, in every view of the card, never folded away. */
function UncheckedList({ request }: { request: WaitingRequest }) {
  const t = useT();
  const items = request.unchecked ?? [];
  if (items.length === 0) return null;
  const heading = t.tasks.unchecked.heading(items.length);
  return (
    <section className="req-unchecked" aria-label={heading}>
      <p className="req-unchecked-title">{heading}</p>
      <ul>
        {items.map((item, index) => <li key={index}>{uncheckedText(t, item)}</li>)}
      </ul>
      <p>{t.tasks.unchecked.accept}</p>
    </section>
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
  return (
    <div className="reqs">
      {requests.map(r => (
        <RequestItem key={r.id} request={r} onDone={onChanged} {...shared} />
      ))}
    </div>
  );
}
