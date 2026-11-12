import { useEffect, useId, useState, type FormEvent } from 'react';
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
  return parts.length ? t.feedback.hidden(parts) : null;
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

/* The quick window for writing to Hornhoof's developers: a bug, an improvement or an idea, then exactly what goes, and
   only the press of Send sends it. inbox: this is Hornhoof's own installation, where it goes into the inbox. */
export function Feedback({ inbox, start, onClose, onSent }: { inbox: boolean; start?: FeedbackStart; onClose: () => void; onSent?: () => void }) {
  const t = useT();
  const id = useId();
  const box = useDialogClose(onClose);
  const [kind, setKind] = useState<FeedbackKind>(start?.kind ?? 'bug');
  const [title, setTitle] = useState(start?.title ?? '');
  const [text, setText] = useState(start?.text ?? '');
  const [step, setStep] = useState<Step>(start?.improvement ? 'loading' : 'write');
  const [shown, setShown] = useState<FeedbackShown | null>(null);
  const [problem, setProblem] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const written = { kind, title, text, ...(start?.improvement ? { improvement: start.improvement } : {}) };

  async function look() {
    if (!title.trim()) return setProblem(t.feedback.titleRequired);
    setProblem('');
    setFailure(null);
    setBusy(true);
    try {
      setShown(await api.post<FeedbackShown>('/api/feedback/preview', written));
      setStep('check');
    } catch (err) {
      setFailure(err);
      setStep('write');
    }
    setBusy(false);
  }

  /* A finding from its card opens on what goes. */
  useEffect(() => {
    if (start?.improvement) void look();
  }, []);

  async function send() {
    if (!shown) return;
    setFailure(null);
    setBusy(true);
    try {
      await api.post('/api/feedback', { ...written, digest: shown.digest });
      setStep('sent');
      onSent?.();
    } catch (err) {
      setFailure(err);
    }
    setBusy(false);
  }

  function next(event: FormEvent) {
    event.preventDefault();
    void look();
  }

  return (
    <div className="dialog-back" onPointerDown={event => event.target === event.currentTarget && onClose()}>
      <div className="dialog fb-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} ref={box}>
        <header>
          <h2 id={`${id}-title`}>{t.feedback.title}</h2>
          <button className="btn small ghost" type="button" aria-label={t.feedback.close} onClick={onClose}>×</button>
        </header>
        {step === 'write' && (
          <form className="form-grid" noValidate onSubmit={next}>
            <div className="field">
              <span className="label" id={`${id}-kind`}>{t.feedback.kind}</span>
              <div className="field-control">
                <div className="seg fb-kinds" role="group" aria-labelledby={`${id}-kind`}>
                  {KINDS.map(k => (
                    <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
                      {t.feedback.kinds[k]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <Field label={t.feedback.titleLabel} problem={problem || undefined}>
              {p => <input {...p} value={title} maxLength={TITLE_MAX} onChange={event => setTitle(event.target.value)} />}
            </Field>
            <Field label={t.feedback.text}>
              {p => <textarea {...p} className="fb-input" rows={6} value={text} maxLength={TEXT_MAX} onChange={event => setText(event.target.value)} />}
            </Field>
            <p className="fb-note">{t.feedback.note}</p>
            {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
            <div className="form-foot">
              <button className="btn" type="submit" disabled={busy} aria-busy={busy || undefined}>
                <BusyLabel busy={busy} idle={t.common.next} working={t.common.loading} />
              </button>
              <button className="btn ghost" type="button" onClick={onClose}>{t.common.cancel}</button>
            </div>
          </form>
        )}
        {step === 'check' && shown && (
          <>
            <WhatGoes shown={shown} inbox={inbox} />
            {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
            <div className="form-foot">
              <button className="btn" type="button" disabled={busy} aria-busy={busy || undefined} onClick={() => void send()}>
                <BusyLabel busy={busy} idle={t.feedback.send} working={t.feedback.sending} />
              </button>
              <button className="btn ghost" type="button" onClick={() => setStep('write')}>{t.common.back}</button>
            </div>
          </>
        )}
        {step === 'loading' && <p className="muted" role="status">{t.common.loading}</p>}
        {step === 'sent' && (
          <>
            <p role="status">{inbox ? t.feedback.sentInbox : t.feedback.sent}</p>
            <div className="form-foot">
              <button className="btn" type="button" onClick={onClose}>{t.common.done}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
