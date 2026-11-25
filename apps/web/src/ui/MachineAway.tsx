import { useLanguage, useT } from '../i18n';
import type { CopyGaveUpCard, CopySchemaFailureCard, MachineAwayCard } from '../types';
import { clock } from './subscription';

/* A machine with agents on it that went away, in words for the person who can switch it on. Nothing here waits for an answer:
   the card closes by itself when the machine is back, and one line says when. */
function Away({ card }: { card: MachineAwayCard }) {
  const t = useT();
  const { language } = useLanguage();
  const title = t.tasks.machineAway(card.hostname, card.owner?.name ?? null);
  const names = card.important.map(a => `${t.tasks.machineAwayKinds[a.kind]} ${a.name}`).join(', ');
  return (
    <section className="machine-away" aria-label={title}>
      <h3>{title}</h3>
      <p>{t.tasks.machineAwaySince(clock(language, card.since)!, card.agents)}</p>
      {names && <p>{t.tasks.machineAwayImportant(names)}</p>}
      <p>{t.tasks.machineAwayDo}</p>
    </section>
  );
}

function Back({ card }: { card: MachineAwayCard }) {
  const t = useT();
  const { language } = useLanguage();
  return <p className="muted">{t.tasks.machineBack(card.hostname, clock(language, card.back)!)}</p>;
}

export function MachineAway({ machines }: { machines: MachineAwayCard[] }) {
  return (
    <>
      {machines.map(card => (card.back ? <Back key={card.id} card={card} /> : <Away key={card.id} card={card} />))}
    </>
  );
}

export function CopySchemaFailure({ card }: { card: CopySchemaFailureCard }) {
  const t = useT();
  const { language } = useLanguage();
  const title = t.tasks.copySchemaFailure(card.hostname);
  const since = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(card.since));
  return (
    <section className="machine-away" aria-label={title}>
      <h3>{title}</h3>
      <p>{t.tasks.copySchemaFailureSince(card.attempt, since)}</p>
      <p>{t.tasks.copySchemaFailureDo}</p>
    </section>
  );
}

/* A copy of the company's data that its machine's keeper gave up: why, since when, and what the person can do. */
function CopyGaveUp({ card }: { card: CopyGaveUpCard }) {
  const t = useT();
  const { language } = useLanguage();
  const title = t.tasks.copyGaveUp(card.hostname);
  const since = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(card.since));
  return (
    <section className="machine-away" aria-label={title}>
      <h3>{title}</h3>
      <p>{card.why === 'failed' ? t.tasks.copyGaveUpFailed(card.attempts, since) : card.why === 'slow' ? t.tasks.copyGaveUpSlow(since) : t.tasks.copyGaveUpLate(since)}</p>
      <p>{card.why === 'failed' ? t.tasks.copyGaveUpDo : t.tasks.copyGaveUpPathDo}</p>
    </section>
  );
}

export function CopyGaveUps({ cards }: { cards: CopyGaveUpCard[] }) {
  return <>{cards.map(card => <CopyGaveUp key={card.id} card={card} />)}</>;
}

export function CopySchemaFailures({ cards }: { cards: CopySchemaFailureCard[] }) {
  return (
    <>
      {cards.map(card => <CopySchemaFailure key={card.id} card={card} />)}
    </>
  );
}
