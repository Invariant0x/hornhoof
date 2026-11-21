import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { errorText, Phrase, useLanguage, useT } from '../i18n';
import type { Question, QuestionView } from '../types';
import { useConfirmAction } from './ConfirmAction';
import { clock } from './subscription';

/* While a question stands it is looked at this often; else this seldom, since only a machine that lost the one it
   follows ever asks. */
const ASKING_MS = 5_000;
const QUIET_MS = 30_000;

/* A machine that never said its name is told by the start of its id. */
const named = (host: string, networkId: string) => host || networkId.slice(0, 8);

/* Under the top bar, on a machine that keeps a copy of the company's data: when the machine that led stopped
   answering and the copies may lack changes, the question of which copy to go on from, or to wait. Everyone reads it;
   the CEO alone answers, from their own session. While nothing is asked, what else there is to say stands there.
   again: turns true when the machine's keeper says a question stands, so it is read at once. */
export function RecoveryQuestion({ children, again = false }: { children?: ReactNode; again?: boolean }) {
  const t = useT();
  const { language } = useLanguage();
  const [view, setView] = useState<QuestionView | null>(null);
  const [busy, setBusy] = useState(false);
  /* The question the CEO told a copy to go on from, by when it was first asked: the machine that takes the server is
     away from the page for a while, so its buttons give way to a line that says what happens. */
  const [went, setWent] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const confirmation = useConfirmAction();

  /* A server from before copies never answers, and so asks nothing; a look that fails changes nothing, so a question
     that stands stays while the machine is away for a moment. */
  const look = useCallback(() => api.get<QuestionView>('/api/network/question').then(setView, () => undefined), []);
  const asking = Boolean(view?.question);
  useEffect(() => {
    void look();
    const timer = setInterval(() => void look(), asking ? ASKING_MS : QUIET_MS);
    return () => clearInterval(timer);
  }, [look, asking, again]);

  const question = view?.question;
  if (!question) return <>{children}</>;
  const q = t.question;
  const { copies } = question;
  const leader = named(question.leader.host, question.leader.networkId);
  const heard = clock(language, question.leader.heard);

  const sendWait = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await api.post('/api/network/question/wait', {});
      setWent(null);
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
      await look();
    }
  };

  const sendGoOn = async (copy: Question['copies'][number]) => {
    setBusy(true);
    setFailure(null);
    try {
      await api.post('/api/network/question/go-on', { networkId: copy.networkId, reach: copy.reach });
      setWent(question.since);
    } finally {
      setBusy(false);
      await look();
    }
  };

  const askGoOn = (copy: Question['copies'][number]) => {
    const host = named(copy.host, copy.networkId);
    const reach = clock(language, copy.reach);
    const words = q.confirm;
    setFailure(null);
    confirmation.ask({
      title: words.title,
      effect: reach
        ? <Phrase words={words.effectAt} values={[<bdi>{host}</bdi>, <bdi>{reach}</bdi>]} />
        : <Phrase words={words.effect} values={[<bdi>{host}</bdi>]} />,
      warnings: [q.warning(leader)],
      final: true,
      danger: true,
      yes: words.yes,
      working: words.working,
      onYes: () => sendGoOn(copy),
    });
  };

  const goOn = (copy: Question['copies'][number]) => {
    const reach = clock(language, copy.reach);
    return copies.length === 1 ? q.goOn(reach) : q.goOnAt(reach, named(copy.host, copy.networkId));
  };
  const only = copies[0];
  return (
    <div className="update-banner question-banner glass" role="group" aria-label={q.title}>
      <p dir="auto">{copies.length === 1 && only ? q.oneCopy(leader, heard, named(only.host, only.networkId), clock(language, only.reach)) : q.moreCopies(leader, heard)}</p>
      {question.waiting && new Date(question.waiting).getTime() > Date.now() && <p dir="auto">{q.waiting(leader)}</p>}
      {went === question.since ? (
        <p dir="auto">{q.goingOn}</p>
      ) : view.canAnswer ? (
        <>
          <div className="entry-actions" role="group" aria-label={q.answers}>
            {copies.map(copy => (
              <button key={copy.networkId} className="btn" type="button" disabled={busy} onClick={() => askGoOn(copy)}>{goOn(copy)}</button>
            ))}
            <button className="btn ghost" type="button" disabled={busy} onClick={() => void sendWait()}>{q.wait(leader)}</button>
          </div>
          <p className="question-note" dir="auto">{q.warning(leader)}</p>
        </>
      ) : (
        <p className="question-note" dir="auto">{q.ceoOnly}</p>
      )}
      {confirmation.question}
      {failure !== null && <p className="alert" role="alert"><span dir="auto">{errorText(t, failure)}</span></p>}
    </div>
  );
}
