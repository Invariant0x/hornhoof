import { currentLimits, type Limits } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
/* When the plan's limit starts over, while the plan is at it: the latest reset of a full window still to come. A plan at
   its limit that says no reset holds nothing, so its turns go out and fail as before rather than wait forever. */
export function limitUntil(limits: Limits | null, updatedAt: string | Date | null, now = Date.now()): string | null {
  const current = currentLimits(limits, updatedAt, now);
  if (current?.status !== 'rejected') return null;
  const resets = current.windows.filter(w => (w.utilization === null || w.utilization >= 1) && w.resetsAt).map(w => w.resetsAt!);
  return resets.length ? resets.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
}

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

/* The plan's limits once a turn ended on a refusal for its usage limit, or null when it did not: the window it names is
   full until the time the program gives, the reset the plan said before, or a quarter of an hour. */
export function refusedLimits(output: string, limits: Limits | null, now = Date.now(), usageLimit = false): Limits | null {
  const end = output.slice(-1500);
  if (!usageLimit && !REFUSED.test(end)) return null;
  const name = /\b(?:weekly|7-day|seven-day)\b/i.test(end) ? 'seven_day' : 'five_hour';
  const known = limits?.windows.find(w => w.name === name)?.resetsAt;
  const resetsAt = againIn(end, now) ?? (known && Date.parse(known) > now ? known : new Date(now + LIMIT_PROBE_MS).toISOString());
  return { ...limits, status: 'rejected', windows: [...(limits?.windows ?? []).filter(w => w.name !== name), { name, utilization: 1, resetsAt }] };
}

/* Wakes the agent's line once its plan's limit starts over. */
export const resets = new WeakMap<Ctx, Map<string, { at: string; timer: NodeJS.Timeout }>>();
