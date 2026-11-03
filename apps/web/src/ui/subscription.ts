import type { Language, Messages } from '../i18n';
import { PROVIDER_NAMES } from '../providers';
import type { Limits, SubView } from '../types';

export const subName = (t: Messages, s: SubView) => s.kind === 'api_key' ? t.subs.keyEnding(PROVIDER_NAMES[s.provider], s.last4 ?? '') : PROVIDER_NAMES[s.provider];
export const MAIN_WINDOWS = ['five_hour', 'seven_day'];
export const startedOver = (w: Limits['windows'][number], now: number) => w.resetsAt !== null && Date.parse(w.resetsAt) <= now;
const until = (w: Limits['windows'][number]) => w.resetsAt ? Date.parse(w.resetsAt) : Infinity;

/* Rejection lasts until every blocking window resets. Unknown shares can block too. */
export function limitState(limits: Limits | null, now: number) {
  const windows = limits?.windows ?? [];
  const causes = windows.filter(w => w.utilization === null || w.utilization >= 1);
  const open = causes.filter(w => !startedOver(w, now)).sort((a, b) => until(b) - until(a));
  const reached = limits?.status === 'rejected' && (!causes.length || open.length > 0);
  const top = open[0] ?? [...windows].sort((a, b) => (b.utilization ?? -1) - (a.utilization ?? -1))[0];
  return { reached, resetsAt: top?.resetsAt ?? null };
}

export function stateOf(s: SubView, now: number) {
  if (s.status === 'waiting_machine') return 'waiting_machine';
  if (!s.online) return s.kind === 'api_key' ? 'builtin_offline' : 'offline';
  if (s.status === 'needs_login') return 'needs_login';
  return s.kind === 'personal' && limitState(s.limits, now).reached ? 'limit' : 'ready';
}

export function windowUsage(s: SubView, name: string, now: number): number | null {
  if (s.kind === 'api_key') return null;
  const window = s.limits?.windows.find(w => w.name === name);
  return window && !startedOver(window, now) ? window.utilization : null;
}

export function clock(language: Language, iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  const today = at.toDateString() === new Date().toDateString();
  const parts: Intl.DateTimeFormatOptions = today ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' };
  return new Intl.DateTimeFormat(language, parts).format(at);
}

/* What keeps a plan from working on one of its machines, if anything. */
export function waitsThere(t: Messages, on: { online: boolean; status: 'ready' | 'needs_login' }): string | null {
  if (!on.online) return t.subs.waitsThere.offline;
  return on.status === 'needs_login' ? t.subs.waitsThere.needs_login : null;
}

export function planStateOnMachine(t: Messages, language: Language, on: { online: boolean; status: 'ready' | 'needs_login' }, limits: Limits | null, now: number): string {
  const waiting = waitsThere(t, on);
  if (waiting) return waiting;
  const limit = limitState(limits, now);
  return limit.reached ? t.cards.limitUntil(clock(language, limit.resetsAt)) : t.cards.ready;
}

const WINDOW_MINUTES: Record<string, number> = { five_hour: 300, one_day: 1440, seven_day: 10080 };

export function windowName(t: Messages, name: string): string {
  if (name === 'month') return t.subs.month;
  const model = /^seven_day_([a-z]+)$/.exec(name)?.[1];
  if (model) return `${t.subs.days(7)}, ${model[0]!.toUpperCase()}${model.slice(1)}`;
  const minutes = WINDOW_MINUTES[name] ?? Number(/^(\d+)_minutes$/.exec(name)?.[1]);
  if (!minutes) return name.replaceAll('_', ' ');
  if (minutes % 1440 === 0) return t.subs.days(minutes / 1440);
  return minutes % 60 === 0 ? t.subs.hours(minutes / 60) : t.subs.minutes(minutes);
}
