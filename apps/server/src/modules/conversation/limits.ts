import { currentLimits, limitsForModel, modelGroup, type LimitGroup, type Limits } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
/* When the plan's limit starts over, while the plan is at it: the latest reset of a full window still to come. A plan at
   its limit that says no reset holds nothing, so its turns go out and fail as before rather than wait forever. */
export function limitUntil(limits: Limits | null, updatedAt: string | Date | null, now = Date.now()): string | null {
  const current = currentLimits(limits, updatedAt, now);
  if (current?.status !== 'rejected') return null;
  const resets = current.windows.filter(w => (w.utilization === null || w.utilization >= 1) && w.resetsAt).map(w => w.resetsAt!);
  return resets.length ? resets.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
}

/* Until when the plan is at its limit for turns on this model: by the limits of the model's group where the plan keeps them
   by group, else of the plan as a whole, whose fullest window speaks for every model. */
export const modelLimitUntil = (plan: { limits: Limits | null; limitsUpdatedAt: Date | null }, model: string | null, now = Date.now()): string | null =>
  limitUntil(limitsForModel(plan.limits, model), plan.limitsUpdatedAt, now);

/* When a window of the plan that used the share set for task turns starts over: the latest such reset still to come. */
export function budgetUntil(limits: Limits | null, budget: number | null, updatedAt: string | Date | null, now = Date.now()): string | null {
  if (budget === null || budget >= 100) return null;
  const resets = (currentLimits(limits, updatedAt, now)?.windows ?? []).filter(w => w.utilization !== null && w.utilization * 100 >= budget && w.resetsAt).map(w => w.resetsAt!);
  return resets.length ? resets.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
}

/* What a program prints at the end of its output when the plan refuses a turn for its usage limit: Kimi's 429 and its
   APIProviderQuotaExhaustedError, Codex's "hit your usage limit", Claude's "5-hour limit reached". */
export const REFUSED = /\b429\b[^\n]*\b(?:(?:usage|rate) limit|quota)|\bAPIProviderQuotaExhaustedError\b|(?:reached|hit) your (?:[\w-]+ )?usage limit|usage limit reached|\b\d+-hour limit reached/i;
/* A program that names no time is tried again after this, and held again if the plan still refuses. */
export const LIMIT_PROBE_MS = 15 * 60_000;
export const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };

export function againIn(text: string, now: number): string | null {
  const said = /try again in ([^.\n]*)/i.exec(text);
  let ms = 0;
  for (const [, n, unit] of said?.[1]?.matchAll(/(\d+)\s*([dhms])[a-z]*/gi) ?? []) ms += Number(n) * UNIT_MS[unit!.toLowerCase()]!;
  return ms ? new Date(now + ms).toISOString() : null;
}

type Window = Limits['windows'][number];

/* A part of the plan's limits with the window full until then, in place of the one it had of that name. */
function fullWindow<T extends { status: Limits['status']; windows: Window[] }>(part: T, full: Window): T {
  return { ...part, status: 'rejected', windows: [...part.windows.filter(w => w.name !== full.name), full] };
}

/* The window a refusal names: the week where its words say so, else the five hours. */
const refusedWindow = (end: string): string => (/\b(?:weekly|7-day|seven-day)\b/i.test(end) ? 'seven_day' : 'five_hour');

/* Until when a refused window is full: the time the program gives, the reset said before while it is still ahead, or a
   quarter of an hour. */
function refusedUntil(end: string, known: string | null | undefined, now: number): string {
  if (known && Date.parse(known) > now) return againIn(end, now) ?? known;
  return againIn(end, now) ?? new Date(now + LIMIT_PROBE_MS).toISOString();
}

/* The plan's limits as a whole, none yet where it told none. */
const wholePlan = (limits: Limits | null): Limits => ({ ...limits, status: limits?.status ?? 'allowed', windows: limits?.windows ?? [] });

/* The plan's limits once a turn ended on a refusal for its usage limit, or null when it did not: the window it names is
   full until the time the program gives, the reset the plan said before, or a quarter of an hour. A turn on a model of a
   known group fills that group's window, and the plan's, which speaks for its fullest group; the other groups keep theirs. */
export function refusedLimits(output: string, limits: Limits | null, now = Date.now(), usageLimit = false, model: string | null = null): Limits | null {
  const end = output.slice(-1500);
  if (!usageLimit && !REFUSED.test(end)) return null;
  const plan = wholePlan(limits);
  const name = refusedWindow(end);
  const group: LimitGroup | null = modelGroup(plan.groups, model);
  const full = { name, utilization: 1, resetsAt: refusedUntil(end, (group ?? plan).windows.find(w => w.name === name)?.resetsAt, now) };
  if (!group) return fullWindow(plan, full);
  return { ...fullWindow(plan, laterOf(plan.windows.find(w => w.name === name), full)), groups: plan.groups!.map(g => (g === group ? fullWindow(g, full) : g)) };
}

/* The plan's window speaks for its fullest group: one already full until later than the group's stays as it is. */
function laterOf(known: Window | undefined, full: Window & { resetsAt: string }): Window {
  const fullUntil = known && (known.utilization ?? 0) >= 1 && known.resetsAt ? Date.parse(known.resetsAt) : 0;
  return fullUntil > Date.parse(full.resetsAt) ? known! : full;
}

/* Wakes the agent's line once its plan's limit starts over. */
export const resets = new WeakMap<Ctx, Map<string, { at: string; timer: NodeJS.Timeout }>>();

/* Until when the plan holds this employee's turns back on that model: at its limit, or a worker's past the share set for
   tasks, by the limits of the model's group where the plan keeps them by group. Heads and the orchestrator keep
   coordinating work above that share, so it holds none of theirs. */
export function heldUntil(plan: { limits: Limits | null; limitsUpdatedAt: Date | null; budget: number | null }, kind: string, model: string): string | null {
  return modelLimitUntil(plan, model) ?? (kind === 'worker' ? budgetUntil(limitsForModel(plan.limits, model), plan.budget, plan.limitsUpdatedAt) : null);
}
