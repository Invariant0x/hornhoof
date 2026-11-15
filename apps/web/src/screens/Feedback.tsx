import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT, type Messages } from '../i18n';
import type { FeedbackKind, FeedbackShown } from '../types';
import { BusyLabel } from '../ui/BusyLabel';
import { Field } from '../ui/Field';
import { useDialogClose } from '../ui/use-dialog-close';

const KINDS: FeedbackKind[] = ['bug', 'improvement', 'idea'];

/* Whether this is Hornhoof's own installation, whose feedback goes into its own inbox; asked once. One that cannot say
   counts as any other installation. */
export function useFeedbackInbox(): boolean {
  const [inbox, setInbox] = useState(false);
  useEffect(() => {
    let live = true;
    api.get<{ inbox: boolean }>('/api/feedback').then(
      body => live && setInbox(body.inbox === true),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  return inbox;
}
const TITLE_MAX = 200;
const TEXT_MAX = 5000;

/* What the window starts with: empty, or a finding about Hornhoof itself from its card, which opens on what goes. */
export type FeedbackStart = { kind: FeedbackKind; title: string; text: string; improvement?: string };

type Step = 'loading' | 'write' | 'check' | 'sent';

/* What was hidden of each kind, in words, or nothing when nothing was. */
function hiddenText(t: Messages, hidden: FeedbackShown['hidden']): string | null {
  const parts = (['secret', 'email', 'address', 'path'] as const).filter(kind => hidden[kind] > 0).map(kind => t.feedback.hiddenParts[kind](hidden[kind]));
  return parts.length ? t.feedback.hidden(parts.join(', ')) : null;
}

/* Exactly what goes, as the server cleaned it, with the technical data beside it. */
function WhatGoes({ shown, inbox }: { shown: FeedbackShown; inbox: boolean }) {
  const t = useT();
  const id = useId();
  const { report } = shown;
  const words = t.feedback.facts;
  const hidden = hiddenText(t, shown.hidden);
  return (
    <section className="fb-check" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{inbox ? t.feedback.checkInbox : t.feedback.check}</h3>
      <dl className="facts">
        <dt>{words.kind}</dt>
        <dd>{t.feedback.kinds[report.kind]}</dd>
        <dt>{words.title}</dt>
        <dd>{report.title}</dd>
        {report.text && (
          <>
            <dt>{words.text}</dt>
            <dd className="fb-text">{report.text}</dd>
          </>
        )}
        <dt>{words.version}</dt>
        <dd className="fb-code">{report.facts.version}</dd>
        <dt>{words.platform}</dt>
        <dd className="fb-code">{report.facts.platform.join(', ') || t.feedback.noMachines}</dd>
        {report.facts.errorCode && (
          <>
            <dt>{words.errorCode}</dt>
            <dd className="fb-code">{report.facts.errorCode}</dd>
          </>
        )}
      </dl>
      {hidden && <p className="fb-hidden">{hidden}</p>}
    </section>
  );
}

/* A refusal in words, where there is one. */
export function FailureLine({ failure }: { failure: unknown }) {
  const t = useT();
  return failure === null ? null : <p className="alert" role="alert">{errorText(t, failure)}</p>;
}

type Moves = { setStep: (step: Step) => void; setShown: (shown: FeedbackShown) => void; setFailure: (failure: unknown) => void; setBusy: (busy: boolean) => void };

/* Asks the server what would go for what the window holds, as the server cleans it. */
async function preview(draft: FeedbackStart, moves: Moves): Promise<void> {
  moves.setFailure(null);
  moves.setBusy(true);
  try {
    moves.setShown(await api.post<FeedbackShown>('/api/feedback/preview', draft));
    moves.setStep('check');
  } catch (err) {
    moves.setFailure(err);
    moves.setStep('write');
  }
  moves.setBusy(false);
}

/* Sends what was shown, with its digest, so the server sends nothing else. */
async function deliver(draft: FeedbackStart, digest: string, moves: Moves, onSent?: () => void): Promise<void> {
  moves.setFailure(null);
  moves.setBusy(true);
  try {
    await api.post('/api/feedback', { ...draft, digest });
    moves.setStep('sent');
    onSent?.();
  } catch (err) {
    moves.setFailure(err);
  }
  moves.setBusy(false);
}

const EMPTY: FeedbackStart = { kind: 'bug', title: '', text: '' };

/* What the window holds and where it is: writing, waiting for what goes, checking it, or sent. */
function useFlow(start: FeedbackStart | undefined, onSent?: () => void) {
  const first = start ?? EMPTY;
  const [draft, setDraft] = useState<FeedbackStart>(first);
  const [step, setStep] = useState<Step>(first.improvement ? 'loading' : 'write');
  const [shown, setShown] = useState<FeedbackShown | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const moves: Moves = { setStep, setShown, setFailure, setBusy };
  /* A finding from its card opens on what goes. */
  useEffect(() => {
    if (first.improvement) void preview(first, moves);
  }, []);
  return {
    draft,
    step,
    shown,
    failure,
    busy,
    edit: (part: Partial<FeedbackStart>) => setDraft(was => ({ ...was, ...part })),
    look: () => preview(draft, moves),
    send: (digest: string) => deliver(draft, digest, moves, onSent),
    back: () => setStep('write'),
  };
}
type Flow = ReturnType<typeof useFlow>;

/* Bug, improvement or idea, one pressed. */
function KindPicker({ kind, onPick }: { kind: FeedbackKind; onPick: (kind: FeedbackKind) => void }) {
  const t = useT();
  const id = useId();
  return (
    <div className="field">
      <span className="label" id={id}>{t.feedback.kind}</span>
      <div className="field-control">
        <div className="seg fb-kinds" role="group" aria-labelledby={id}>
          {KINDS.map(k => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => onPick(k)}>
              {t.feedback.kinds[k]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* Writing: the kind, a title it needs, and what happened or what is wanted. onCancel: the Cancel beside Next, where
   the place it stands in has one. */
function WriteStep({ flow, onCancel }: { flow: Flow; onCancel?: () => void }) {
  const t = useT();
  const [problem, setProblem] = useState('');
  const { draft, busy } = flow;
  function next(event: FormEvent) {
    event.preventDefault();
    const untitled = !draft.title.trim();
    setProblem(untitled ? t.feedback.titleRequired : '');
    if (!untitled) void flow.look();
  }
  return (
    <form className="form-grid fb-form" noValidate onSubmit={next}>
      <KindPicker kind={draft.kind} onPick={kind => flow.edit({ kind })} />
      <Field label={t.feedback.titleLabel} problem={problem || undefined}>
        {p => <input {...p} value={draft.title} maxLength={TITLE_MAX} onChange={event => flow.edit({ title: event.target.value })} />}
      </Field>
      <Field label={t.feedback.text}>
        {p => <textarea {...p} className="fb-input" rows={6} value={draft.text} maxLength={TEXT_MAX} onChange={event => flow.edit({ text: event.target.value })} />}
      </Field>
      <p className="fb-note">{t.feedback.note}</p>
      <FailureLine failure={flow.failure} />
      <div className="form-foot">
        <button className="btn" type="submit" disabled={busy} aria-busy={busy || undefined}>
          <BusyLabel busy={busy} idle={t.common.next} working={t.common.loading} />
        </button>
        {onCancel && <button className="btn ghost" type="button" onClick={onCancel}>{t.common.cancel}</button>}
      </div>
    </form>
  );
}

/* Checking what goes, then Send, or Back to writing. */
function CheckStep({ flow, shown, inbox }: { flow: Flow; shown: FeedbackShown; inbox: boolean }) {
  const t = useT();
  const { busy } = flow;
  return (
    <>
      <WhatGoes shown={shown} inbox={inbox} />
      <FailureLine failure={flow.failure} />
      <div className="form-foot">
        <button className="btn" type="button" disabled={busy} aria-busy={busy || undefined} onClick={() => void flow.send(shown.digest)}>
          <BusyLabel busy={busy} idle={t.feedback.send} working={t.feedback.sending} />
        </button>
        <button className="btn ghost" type="button" onClick={flow.back}>{t.common.back}</button>
      </div>
    </>
  );
}

function SentStep({ inbox, onClose }: { inbox: boolean; onClose: () => void }) {
  const t = useT();
  return (
    <>
      <p role="status">{inbox ? t.feedback.sentInbox : t.feedback.sent}</p>
      <div className="form-foot">
        <button className="btn" type="button" onClick={onClose}>{t.common.done}</button>
      </div>
    </>
  );
}

/* The same function for the window's whole life, calling the latest onClose: a screen behind it drawn again with a new one
   does not focus the window again and take the focus from what the person types. */
export function useSteady(onClose: () => void): () => void {
  const latest = useRef(onClose);
  useEffect(() => {
    latest.current = onClose;
  });
  return useCallback(() => latest.current(), []);
}

type FormProps = { inbox: boolean; start?: FeedbackStart; onDone: () => void; onCancel?: () => void; onSent?: () => void };

/* Writing to Hornhoof's developers, wherever it stands: a bug, an improvement or an idea, then exactly what goes, and
   only the press of Send sends it. inbox: this is Hornhoof's own installation, where it goes into the inbox. onDone: the
   Done once it is sent. */
export function FeedbackForm({ inbox, start, onDone, onCancel, onSent }: FormProps) {
  const t = useT();
  const flow = useFlow(start, onSent);
  return (
    <>
      {flow.step === 'write' && <WriteStep flow={flow} onCancel={onCancel} />}
      {flow.step === 'check' && flow.shown && <CheckStep flow={flow} shown={flow.shown} inbox={inbox} />}
      {flow.step === 'loading' && <p className="muted" role="status">{t.common.loading}</p>}
      {flow.step === 'sent' && <SentStep inbox={inbox} onClose={onDone} />}
    </>
  );
}

/* The quick window for a finding about Hornhoof itself, from its card. */
export function Feedback({ inbox, start, onClose, onSent }: { inbox: boolean; start?: FeedbackStart; onClose: () => void; onSent?: () => void }) {
  const t = useT();
  const id = useId();
  const box = useDialogClose(useSteady(onClose));
  return (
    <div className="dialog-back" onPointerDown={event => event.target === event.currentTarget && onClose()}>
      <div className="dialog fb-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} ref={box}>
        <header>
          <h2 id={`${id}-title`}>{t.feedback.title}</h2>
          <button className="btn small ghost" type="button" aria-label={t.feedback.close} onClick={onClose}>×</button>
        </header>
        <FeedbackForm inbox={inbox} start={start} onDone={onClose} onCancel={onClose} onSent={onSent} />
      </div>
    </div>
  );
}
