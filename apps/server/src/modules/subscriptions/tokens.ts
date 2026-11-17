import type { TurnTokens } from '@hornhoof/protocol';
import { and, count, eq, gte, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { turnTokens } from '../../db/schema.js';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/* What the turns of a subscription used: today, in the last 7 and 30 days, and all along. turns counts them all, noData
   those whose program told no tokens. */
export type TokenSum = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; turns: number; noData: number };
export type TokenPeriods = { today: TokenSum; week: TokenSum; month: TokenSum; all: TokenSum };

const PERIODS = ['today', 'week', 'month', 'all'] as const;
const DAY_MS = 86_400_000;
export const NO_TOKENS: TokenSum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0, noData: 0 };
const noPeriods = (): TokenPeriods => ({ today: NO_TOKENS, week: NO_TOKENS, month: NO_TOKENS, all: NO_TOKENS });

const isZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/* The viewer's time zone, whose midnight starts today. */
export const TokensQuery = z.object({ zone: z.string().max(64).refine(isZone, 'zone: Not a time zone, like Europe/Moscow.').default('UTC') });

/* Midnight in the zone, on the day it is there now. */
function dayStart(now: number, zone: string): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(now))
      .map(part => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  const elapsed = ((parts.hour! * 60 + parts.minute!) * 60 + parts.second!) * 1000 + (now % 1000);
  return new Date(now - elapsed);
}

/* A turn's counts as kept: its total from the counts it told when the program gave none. */
export function tokenRow(tokens: TurnTokens | null | undefined) {
  if (!tokens) return { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, model: null };
  const told = [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite].filter((n): n is number => n !== null);
  return { inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: tokens.cacheRead, cacheWriteTokens: tokens.cacheWrite, totalTokens: tokens.total ?? told.reduce((a, n) => a + n, 0), model: tokens.model ?? null };
}

const summed = (column: AnyPgColumn) => sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);

/* Each subscription's sums since the time, of the turns the condition takes. */
async function sumsSince(db: Db, where: SQL | undefined, since: Date | null): Promise<Map<string, TokenSum>> {
  const rows = await db
    .select({
      subscriptionId: turnTokens.subscriptionId,
      input: summed(turnTokens.inputTokens),
      output: summed(turnTokens.outputTokens),
      cacheRead: summed(turnTokens.cacheReadTokens),
      cacheWrite: summed(turnTokens.cacheWriteTokens),
      total: summed(turnTokens.totalTokens),
      turns: count(),
      noData: sql<number>`count(*) filter (where ${isNull(turnTokens.totalTokens)})`.mapWith(Number),
    })
    .from(turnTokens)
    .where(and(where, since ? gte(turnTokens.at, since) : undefined))
    .groupBy(turnTokens.subscriptionId);
  return new Map(rows.map(({ subscriptionId, ...sum }) => [subscriptionId, sum]));
}

/* The sums of each of these subscriptions of the company, all of its own when none are named. */
export async function tokensBySubscription(db: Db, companyId: string, now: number, zone: string, ids?: string[]): Promise<Map<string, TokenPeriods>> {
  if (ids && !ids.length) return new Map();
  const where = and(eq(turnTokens.companyId, companyId), ids ? inArray(turnTokens.subscriptionId, ids) : undefined);
  const since = { today: dayStart(now, zone), week: new Date(now - 7 * DAY_MS), month: new Date(now - 30 * DAY_MS), all: null };
  const found = await Promise.all(PERIODS.map(period => sumsSince(db, where, since[period])));
  const out = new Map<string, TokenPeriods>();
  PERIODS.forEach((period, i) => {
    for (const [id, sum] of found[i]!) out.set(id, { ...(out.get(id) ?? noPeriods()), [period]: sum });
  });
  return out;
}

/* What each model a subscription's turns ran on used in the last 30 days, the most first; null for turns whose model is
   not known. A turn that told no tokens counts for none. */
export type ModelTokens = { model: string | null; total: number };

export async function tokensByModel(db: Db, companyId: string, subscriptionId: string, now: number): Promise<ModelTokens[]> {
  const rows = await db
    .select({ model: turnTokens.model, total: summed(turnTokens.totalTokens) })
    .from(turnTokens)
    .where(and(eq(turnTokens.companyId, companyId), eq(turnTokens.subscriptionId, subscriptionId), gte(turnTokens.at, new Date(now - 30 * DAY_MS)), isNotNull(turnTokens.totalTokens)))
    .groupBy(turnTokens.model);
  return rows.filter(row => row.total > 0).sort((a, b) => b.total - a.total || (a.model ?? '').localeCompare(b.model ?? ''));
}

const add = (a: TokenSum, b: TokenSum): TokenSum => ({
  input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
  total: a.total + b.total, turns: a.turns + b.turns, noData: a.noData + b.noData,
});

/* The sums of all these subscriptions together. */
export function together(each: Iterable<TokenPeriods>): TokenPeriods {
  let out = noPeriods();
  for (const periods of each) out = { today: add(out.today, periods.today), week: add(out.week, periods.week), month: add(out.month, periods.month), all: add(out.all, periods.all) };
  return out;
}

export const periodsOf = (found: Map<string, TokenPeriods>, id: string): TokenPeriods => found.get(id) ?? noPeriods();
