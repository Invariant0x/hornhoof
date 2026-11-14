import { useEffect, useState } from 'react';
import { useT, type Messages } from '../i18n';
import { everyVisible } from '../guard';

const MINUTE = 60_000;

export function resetDuration(t: Messages, milliseconds: number): string {
  if (milliseconds < MINUTE) return t.subs.lessThanMinute;
  const minutes = Math.floor(Math.max(0, milliseconds) / MINUTE);
  const days = Math.floor(minutes / (24 * 60));
  if (days) {
    const hours = Math.floor((minutes % (24 * 60)) / 60);
    return [t.subs.days(days), hours ? t.cards.hours(hours) : null].filter(Boolean).join(' ');
  }
  const hours = Math.floor(minutes / 60);
  if (hours) {
    const rest = minutes % 60;
    return [t.cards.hours(hours), rest ? t.cards.minutes(rest) : null].filter(Boolean).join(' ');
  }
  return t.cards.minutes(minutes);
}

export function resetDurationAt(t: Messages, iso: string | null, now: number): string | null {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) && at > now ? resetDuration(t, at - now) : null;
}

export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    return everyVisible(() => setNow(Date.now()), 1000);
  }, []);
  return now;
}

export function ResetTime({ at, now }: { at: string | null; now: number }) {
  const t = useT();
  const duration = resetDurationAt(t, at, now);
  return <span>{duration ? t.subs.resetsIn(duration) : t.subs.resetUnknown}</span>;
}
