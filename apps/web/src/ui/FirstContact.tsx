import { useEffect, useState } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT, type Messages } from '../i18n';
import { Field } from './Field';
import { Markdown } from './Markdown';
import { useDialogClose } from './use-dialog-close';

const path = '/api/orchestrator/first-contact';
type Offer = keyof Messages['firstContact']['offers'];
type Answer = { status: 'queued' | 'running' | 'done' | 'failed' | 'obsolete'; replies: string[] };
type Turn = { id: string; text: string; answer: Answer | null; offer?: Offer | null };
type Contact = { offers: Offer[]; last?: Turn };

export function FirstContact({ onClose }: { onClose: () => void }) {
  const { language } = useLanguage();
  const t = useT();
  const words = t.firstContact;
  const box = useDialogClose(onClose);
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const last = turns.at(-1);
  const waiting = Boolean(last && (!last.answer || last.answer.status === 'queued' || last.answer.status === 'running'));
  const watching = waiting ? last?.id : undefined;

  useEffect(() => {
    let live = true;
    void api.get<Contact>(path).then(value => {
      if (!live) return;
      setOffers(value.offers);
      if (value.last) setTurns([value.last]);
    }, error => { if (live) setFailure(error); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!watching) return;
    let live = true;
    let next: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const answer = await api.get<Answer>(`${path}/${watching}`);
        if (!live) return;
        setFailure(null);
        setTurns(previous => previous.map(turn => turn.id === watching ? { ...turn, answer } : turn));
      } catch (error) { if (live) setFailure(error); }
      if (live) next = setTimeout(() => void read(), 1500);
    }
    void read();
    return () => { live = false; clearTimeout(next); };
  }, [watching]);

  async function send(choice: { offer: Offer } | { text: string }) {
    if (sending || waiting) return;
    setSending(true);
    setFailure(null);
    try {
      const { jobId } = await api.post<{ jobId: string }>(path, { ...choice, language, ...(last ? { replyTo: last.id } : {}) });
      setTurns(previous => previous.some(turn => turn.id === jobId) ? previous : [...previous, { id: jobId, text: 'offer' in choice ? words.offers[choice.offer] : choice.text, answer: null }]);
      setDraft('');
    } catch (error) { setFailure(error); }
    finally { setSending(false); }
  }

  return <div className="dialog-back">
    <div className="dialog first-contact" role="dialog" aria-modal="true" aria-labelledby="first-contact-title" tabIndex={-1} ref={box}>
      <header><h2 id="first-contact-title">{words.title}</h2><button type="button" className="act" onClick={onClose}>{words.close}</button></header>
      {!last && <p>{words.question}</p>}
      {!last && offers && <div className="entry-actions">
        {offers.map(offer => <button className="act" key={offer} type="button" disabled={sending} onClick={() => void send({ offer })}>{words.offers[offer]}</button>)}
      </div>}
      {!offers && failure === null && <p role="status">{t.common.loading}</p>}
      <div aria-live="polite">
        {turns.map(turn => <div key={turn.id}>
          <p className="muted" dir="auto">{turn.offer ? words.offers[turn.offer] : turn.text}</p>
          {turn.answer?.replies.map((reply, index) => <Markdown key={index} text={reply} />)}
        </div>)}
      </div>
      {waiting && <p role="status">{words.working}</p>}
      {last?.answer && !waiting && (last.answer.status !== 'done' || !last.answer.replies.length) && <p role="alert">{words.failed}</p>}
      {failure !== null && <p role="alert" className="bad">{errorText(t, failure)}</p>}
      <form onSubmit={event => { event.preventDefault(); if (draft.trim()) void send({ text: draft.trim() }); }}>
        <Field label={words.message}>{props => <textarea {...props} rows={3} value={draft} onChange={event => setDraft(event.target.value)} />}</Field>
        <div className="form-foot"><button className="btn" type="submit" disabled={!offers || sending || waiting || !draft.trim()}>{words.send}</button></div>
      </form>
    </div>
  </div>;
}
