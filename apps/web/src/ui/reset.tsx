import { useEffect, useState } from 'react';
import { Phrase, useT, type Messages } from '../i18n';
import { everyVisible } from '../guard';
import { keepUnits } from './units';

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

/* The words of a reset as its language writes them, the time in them one piece that reads left to right, each number on
   one line with its unit. */
export function ResetWords({ at, now }: { at: string | null; now: number }) {
  const t = useT();
  const duration = resetDurationAt(t, at, now);
  return duration ? <Phrase words={t.subs.resetsIn} values={[<bdi dir="ltr">{keepUnits(duration)}</bdi>]} /> : <>{t.subs.resetUnknown}</>;
}

/* A reset's line of its own: its words whole, in their own direction, so a page laid out right to left keeps their order. */
export function ResetTime({ at, now }: { at: string | null; now: number }) {
  return <bdi><ResetWords at={at} now={now} /></bdi>;
}
