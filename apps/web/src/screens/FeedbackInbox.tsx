import { useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { useLive } from '../tasks';
import type { InboxCard } from '../types';
import { BusyLabel } from '../ui/BusyLabel';
import { LoadFailure, useLoadFailure } from '../ui/LoadFailure';
import { FailureLine } from './Feedback';
import { RouteUnavailable, unavailableFailure } from './RouteUnavailable';

/* Only an issue page on GitHub becomes a link; anything else stays words. */
const githubPage = (url: string) => url.startsWith('https://github.com/');

type Issue = NonNullable<InboxCard['issue']>;

/* Turns a card into an issue on GitHub, and says why not when it could not. */
async function openIssue(id: string, setIssue: (issue: Issue) => void, setFailure: (failure: unknown) => void, setBusy: (busy: boolean) => void): Promise<void> {
  setBusy(true);
  setFailure(null);
  try {
    setIssue((await api.post<{ issue: Issue }>(`/api/feedback/inbox/${id}/issue`, {})).issue);
  } catch (err) {
    setFailure(err);
  }
  setBusy(false);
}

/* Which versions and machines sent it, and the error code if it has one. */
function CardFacts({ card }: { card: InboxCard }) {
  const t = useT();
  return (
    <p className="imp-meta fb-facts">
      <span>{t.inbox.versions(card.versions.join(', '))}</span>
      {card.platforms.length > 0 && <span>{t.inbox.platforms(card.platforms.join(', '))}</span>}
      {card.errorCode && <span>{t.inbox.errorCode(card.errorCode)}</span>}
    </p>
  );
}

/* The card's issue on GitHub, or the button that makes it. */
function CardIssue({ id, issue: made }: { id: string; issue: Issue | null }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [issue, setIssue] = useState(made);
  if (issue) {
    return githubPage(issue.url) ? (
      <p className="fb-issue">
        <a href={issue.url} target="_blank" rel="noopener noreferrer">{t.inbox.issued(issue.number)}</a>
      </p>
    ) : null;
  }
  return (
    <>
      <div className="entry-actions">
        <button className="btn" type="button" disabled={busy} aria-busy={busy || undefined} onClick={() => void openIssue(id, setIssue, setFailure, setBusy)}>
          <BusyLabel busy={busy} idle={t.inbox.issue} working={t.inbox.creating} />
        </button>
      </div>
      <FailureLine failure={failure} />
    </>
  );
}

/* One card: what was sent, as plain text, how many installations sent it, with which versions and machines, and its
   issue on GitHub or the button that makes it. */
function Card({ card }: { card: InboxCard }) {
  const t = useT();
  return (
    <article className={`imp fb-card fb-${card.priority}`} aria-labelledby={`fb-${card.id}`}>
      <header>
        <h3 id={`fb-${card.id}`}>{card.title}</h3>
        <p className="imp-meta">
          <span className="badge fb-kind">{t.feedback.kinds[card.kind]}</span>
          <span className="badge fb-priority">{t.inbox.priority[card.priority]}</span>
          <span>{t.inbox.number(card.number)}</span>
          <span>{t.inbox.signals(card.signals, card.installations)}</span>
        </p>
      </header>
      {card.text && <p className="fb-text">{card.text}</p>}
      <CardFacts card={card} />
      <CardIssue id={card.id} issue={card.issue} />
    </article>
  );
}

/* A card is drawn again when its issue arrives from elsewhere. */
const cardKey = (card: InboxCard) => `${card.id}:${card.issue ? card.issue.number : ''}`;

/* The cards, loading, or none yet. */
function Cards({ cards, failure }: { cards: InboxCard[] | null | undefined; failure: unknown }) {
  const t = useT();
  if (!cards) return failure === null ? <p className="muted" role="status">{t.common.loading}</p> : null;
  if (!cards.length) return <p className="muted">{t.inbox.empty}</p>;
  return (
    <div className="imps">
      {cards.map(card => (
        <Card key={cardKey(card)} card={card} />
      ))}
    </div>
  );
}

/* On Hornhoof's own installation, for people who see the whole company: what every installation sent, the most pressing
   first, repeats counted on one card. */
export function FeedbackInbox({ onHome }: { onHome: () => void }) {
  const t = useT();
  const { data: cards, failure } = useLive('/api/feedback/inbox', (b: { cards: InboxCard[] }) => b.cards, m => m.type === 'feedback');
  const shown = useLoadFailure(failure);
  if (unavailableFailure(failure)) return <RouteUnavailable onHome={onHome} />;
  return (
    <section className="tasks">
      <header className="people-head">
        <div>
          <h1>{t.inbox.title}</h1>
          <p className="muted">{t.inbox.intro}</p>
        </div>
      </header>
      <LoadFailure failure={failure} />
      <Cards cards={cards} failure={shown} />
    </section>
  );
}
