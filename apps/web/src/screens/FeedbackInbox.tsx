import { useState } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import { useLive } from '../tasks';
import type { InboxCard } from '../types';
import { BusyLabel } from '../ui/BusyLabel';
import { RouteUnavailable, unavailableFailure } from './RouteUnavailable';

/* Only an issue page on GitHub becomes a link; anything else stays words. */
const githubPage = (url: string) => url.startsWith('https://github.com/');

/* One card: what was sent, as plain text, how many installations sent it, with which versions and machines, and its
   issue on GitHub or the button that makes it. */
function Card({ card }: { card: InboxCard }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [issue, setIssue] = useState(card.issue);

  async function open() {
    setBusy(true);
    setFailure(null);
    try {
      setIssue((await api.post<{ issue: NonNullable<InboxCard['issue']> }>(`/api/feedback/inbox/${card.id}/issue`, {})).issue);
    } catch (err) {
      setFailure(err);
    }
    setBusy(false);
  }

  return (
    <article className={`imp fb-card fb-${card.priority}`} aria-labelledby={`fb-${card.id}`}>
      <header>
        <h3 id={`fb-${card.id}`}>{card.title}</h3>
        <p className="imp-meta">
          <span className="badge fb-kind">{t.feedback.kinds[card.kind]}</span>
          <span className="badge fb-priority">{t.inbox.priority[card.priority]}</span>
          <span>{t.inbox.signals(card.signals, card.installations)}</span>
        </p>
      </header>
      {card.text && <p className="fb-text">{card.text}</p>}
      <p className="imp-meta fb-facts">
        <span>{t.inbox.versions(card.versions.join(', '))}</span>
        {card.platforms.length > 0 && <span>{t.inbox.platforms(card.platforms.join(', '))}</span>}
        {card.errorCode && <span>{t.inbox.errorCode(card.errorCode)}</span>}
      </p>
      {issue && githubPage(issue.url) && (
        <p className="fb-issue">
          <a href={issue.url} target="_blank" rel="noopener noreferrer">{t.inbox.issued(issue.number)}</a>
        </p>
      )}
      {!issue && (
        <div className="entry-actions">
          <button className="btn" type="button" disabled={busy} aria-busy={busy || undefined} onClick={() => void open()}>
            <BusyLabel busy={busy} idle={t.inbox.issue} working={t.inbox.creating} />
          </button>
        </div>
      )}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </article>
  );
}

/* On Hornhoof's own installation, for people who see the whole company: what every installation sent, the most pressing
   first, repeats counted on one card. */
export function FeedbackInbox({ onHome }: { onHome: () => void }) {
  const t = useT();
  const { data: cards, failure } = useLive('/api/feedback/inbox', (b: { cards: InboxCard[] }) => b.cards, m => m.type === 'feedback');
  if (unavailableFailure(failure)) return <RouteUnavailable onHome={onHome} />;
  return (
    <section className="tasks">
      <header className="people-head">
        <div>
          <h1>{t.inbox.title}</h1>
          <p className="muted">{t.inbox.intro}</p>
        </div>
      </header>
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
      {!cards && failure === null && <p className="muted" role="status">{t.common.loading}</p>}
      {cards && !cards.length && <p className="muted">{t.inbox.empty}</p>}
      {!!cards?.length && (
        <div className="imps">
          {cards.map(card => (
            <Card key={`${card.id}:${card.issue?.number ?? ''}`} card={card} />
          ))}
        </div>
      )}
    </section>
  );
}
