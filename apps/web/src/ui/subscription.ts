import { currentLimits } from '@hornhoof/protocol';
import type { Language, Messages } from '../i18n';
import { PROVIDER_NAMES } from '../providers';
import type { Limits, PlanStatus, SubView } from '../types';

/* A compatible API goes by the name it was given, as the address it answers at names no product. */
const keyName = (s: SubView) => s.provider === 'custom_api' ? s.label : PROVIDER_NAMES[s.provider];
export const subName = (t: Messages, s: SubView) => s.kind === 'api_key' ? t.subs.keyEnding(keyName(s), s.last4 ?? '') : PROVIDER_NAMES[s.provider];
/* The name the list and a card show, by the sign of how the connection is paid: a plan by its provider and tier, as Claude
   Max, though the machine tells the tier in small letters; a key by its provider and how the key ends. */
export const shortName = (t: Messages, s: SubView) => s.kind === 'api_key'
  ? t.subs.keyShort(keyName(s), s.last4 ?? '')
  : [PROVIDER_NAMES[s.provider], s.tier && s.tier.charAt(0).toUpperCase() + s.tier.slice(1)].filter(Boolean).join(' ');
export const MAIN_WINDOWS = ['five_hour', 'seven_day'];
/* Plans that sign in once in a terminal on one machine; Hornhoof then passes the sign-in to the owner's others. */
export const TERMINAL_SIGNIN = new Set(['claude', 'codex']);
const until = (w: Limits['windows'][number]) => w.resetsAt ? Date.parse(w.resetsAt) : Infinity;
const snapshotAt = (s: Pick<SubView, 'limitsUpdatedAt'>, now: number) => s.limitsUpdatedAt === undefined ? new Date(now) : s.limitsUpdatedAt;

export const currentPlanLimits = (s: Pick<SubView, 'limits' | 'limitsUpdatedAt'>, now: number) => currentLimits(s.limits, snapshotAt(s, now), now);

const fullestWindow = (windows: Limits['windows']) => [...windows].sort((a, b) => (b.utilization ?? -1) - (a.utilization ?? -1))[0];

type LimitState = { reached: boolean; resetsAt: string | null };

/* Rejection lasts until every blocking window resets. Unknown shares can block too. */
function partState(part: Pick<Limits, 'status' | 'windows'> | null): LimitState {
  const windows = part?.windows ?? [];
  const open = windows.filter(w => w.utilization === null || w.utilization >= 1).sort((a, b) => until(b) - until(a));
  const top = open[0] ?? fullestWindow(windows);
  return { reached: part?.status === 'rejected', resetsAt: top?.resetsAt ?? null };
}

/* A plan that keeps its limits by model group is at its limit only while every group is, until the first of them starts
   over; a group at its limit holds only the turns on its own models. */
export function limitState(limits: Limits | null, now: number, updatedAt?: string | Date | null): LimitState {
  const current = updatedAt === undefined ? limits : currentLimits(limits, updatedAt, now);
  const groups = current?.groups ?? [];
  if (!groups.length) return partState(current);
  const each = groups.map(partState);
  if (!each.every(g => g.reached)) return { reached: false, resetsAt: null };
  const first = each.map(g => g.resetsAt).sort((a, b) => (a ? Date.parse(a) : Infinity) - (b ? Date.parse(b) : Infinity))[0];
  return { reached: true, resetsAt: first ?? null };
}

export function stateOf(s: SubView, now: number) {
  if (s.status === 'waiting_machine') return 'waiting_machine';
  if (!s.online) return s.kind === 'api_key' ? 'builtin_offline' : 'offline';
  if (s.status !== 'ready') return s.status;
  return s.kind === 'personal' && limitState(s.limits, now, snapshotAt(s, now)).reached ? 'limit' : 'ready';
}

export function windowUsage(s: SubView, name: string, now: number): number | null {
  if (s.kind === 'api_key') return null;
  return currentPlanLimits(s, now)?.windows.find(w => w.name === name)?.utilization ?? null;
}

export function clock(language: Language, iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  const today = at.toDateString() === new Date().toDateString();
  const parts: Intl.DateTimeFormatOptions = today ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' };
  return new Intl.DateTimeFormat(language, parts).format(at);
}

export function unknownLimitData(t: Messages, language: Language, s: Pick<SubView, 'limitsUpdatedAt' | 'online' | 'status'>): string {
  const at = clock(language, s.limitsUpdatedAt ?? null);
  return s.online === false && s.status !== 'waiting_machine' ? t.subs.offlineLimit(at) : t.subs.unknown(at);
}

/* What keeps a plan from working on one of its machines, if anything. */
export function waitsThere(t: Messages, on: { online: boolean; status: PlanStatus }): string | null {
  if (!on.online) return t.subs.waitsThere.offline;
  return on.status === 'ready' ? null : t.subs.waitsThere[on.status];
}

export function planStateOnMachine(t: Messages, language: Language, on: { online: boolean; status: PlanStatus }, limits: Limits | null, now: number, updatedAt?: string | Date | null): string {
  const waiting = waitsThere(t, on);
  if (waiting) return waiting;
  const limit = limitState(limits, now, updatedAt);
  return limit.reached ? t.cards.limitUntil(clock(language, limit.resetsAt)) : t.cards.ready;
}

const WINDOW_MINUTES: Record<string, number> = { five_hour: 300, one_day: 1440, seven_day: 10080 };

/* A window's name in two parts: its number with its unit, which reads left to right as one piece in either direction, and
   the words after it, as ", Opus". A name with no number is all words. */
export function windowParts(t: Messages, name: string): [piece: string, words: string] {
  if (name === 'month') return ['', t.subs.month];
  const model = /^seven_day_([a-z]+)$/.exec(name)?.[1];
  if (model) return [t.subs.days(7), `, ${model[0]!.toUpperCase()}${model.slice(1)}`];
  const minutes = WINDOW_MINUTES[name] ?? Number(/^(\d+)_minutes$/.exec(name)?.[1]);
  if (!minutes) return ['', name.replaceAll('_', ' ')];
  if (minutes % 1440 === 0) return [t.subs.days(minutes / 1440), ''];
  return [minutes % 60 === 0 ? t.subs.hours(minutes / 60) : t.subs.minutes(minutes), ''];
}

export const windowName = (t: Messages, name: string): string => windowParts(t, name).join('');
