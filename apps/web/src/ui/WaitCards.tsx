import { useState } from 'react';
import { errorText, useLanguage, useT, type Messages } from '../i18n';
import { sawCard } from '../tasks';
import type { WaitCard } from '../types';
import { clock } from './subscription';

/* What a card is called, and what it says in the person's language, from what Hornhoof kept of it. */
function cardWords(t: Messages, card: WaitCard): { title: string; text: string } {
  const words = t.tasks.cards, number = card.number ?? 0;
  if (card.about === 'release_tag' && card.tag && card.turn) return { title: words.tagTitle, text: words.tag(card.tag.version, card.turn.number, card.tag.why) };
  if (card.about === 'turn_summary' && card.turn) return { title: words.summaryTitle(card.turn.number), text: words.summary(card.turn.number, card.turn.version, t.tracker.side.turns) };
  if (card.about === 'goal_risk') return { title: words.goalTitle, text: words.goal(number) };
  if (card.about === 'final_review') return { title: words.stillOpenTitle, text: words.stillOpen(number) };
  return { title: words.lateTitle, text: words.late(number, card.kind ? words.waitsFor[card.kind] : null) };
}

/* One card: what it is about, when it came, the task it is on and that the person saw it. */
function Card({ card, onOpenTask, onSeen }: { card: WaitCard; onOpenTask: (id: string) => void; onSeen: () => void }) {
  const t = useT();
  const { language } = useLanguage();
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const { title, text } = cardWords(t, card);
  const seen = () => {
    setBusy(true);
    setFailure(null);
    sawCard(card.id).then(onSeen, err => setFailure(err)).finally(() => setBusy(false));
  };
  return (
    <section className={`wait-card ${card.about}`} aria-label={title}>
      <h3>{title}</h3>
      <p>{text}</p>
      <small className="muted">{clock(language, card.at)}</small>
      <div className="entry-actions">
        {card.taskId && <button className="btn small" type="button" onClick={() => onOpenTask(card.taskId!)}>{t.tasks.cards.open}</button>}
        <button className="btn small ghost" type="button" disabled={busy} onClick={seen}>{t.tasks.cards.seen}</button>
      </div>
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </section>
  );
}

/* The cards kept for the person, newest first. */
export function WaitCards({ cards, onOpenTask, onSeen }: { cards: WaitCard[]; onOpenTask: (id: string) => void; onSeen: () => void }) {
  return <>{cards.map(card => <Card key={card.id} card={card} onOpenTask={onOpenTask} onSeen={onSeen} />)}</>;
}
