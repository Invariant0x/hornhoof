import { useLanguage, useT, type Language, type Messages } from '../i18n';
import type { MachineDrain } from '../types';

/* Its deadline and next try on the 24-hour clock, as a task's wait is shown. */
const clock = (language: Language, iso: string) => new Date(iso).toLocaleTimeString(language === 'ru' ? 'ru-RU' : 'en-GB', { hour: '2-digit', minute: '2-digit' });

function drainText(t: Messages, language: Language, drain: MachineDrain): string {
  if (drain.state === 'waiting') return t.machines.drainWaiting(drain.turnsLeft, drain.partsLeft, clock(language, drain.until));
  if (drain.state === 'postponed') return t.machines.drainPostponed(clock(language, drain.retryAt));
  return t.machines.drainRestarting;
}

/* In words in a machine's card: waiting is not hanging, and a machine that restarts for an update is not a lost one. */
export function DrainLine({ drain }: { drain: MachineDrain }) {
  const t = useT();
  const { language } = useLanguage();
  return <span role="status">{drainText(t, language, drain)}</span>;
}

/* The mark of such a machine in its row and its card. */
export function DrainMark({ drain }: { drain: MachineDrain | null | undefined }) {
  const t = useT();
  const { language } = useLanguage();
  return drain ? <span className="badge old" title={drainText(t, language, drain)}>{t.machines.drainMark[drain.state]}</span> : null;
}
