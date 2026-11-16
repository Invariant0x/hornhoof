import { createHash } from 'node:crypto';
import { and, count, desc, eq, inArray, sql, sum } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { limiter, type Attempts } from '../../auth/limit.js';
import { companies, feedbackInbox, feedbackSignals, FEEDBACK_KINDS } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { cleaned, TEXT_MAX, TITLE_MAX, type IssueLink, type Report, type Shown } from './report.js';

/* On Hornhoof's own installation: the one list every installation's reports come to. A report like one already there
   counts as one more signal on its card, from its installation; the priority follows from the kind and how many
   installations sent it. */

type Kind = (typeof FEEDBACK_KINDS)[number];
export type Priority = 'high' | 'normal' | 'low';

const HOUR = 60 * 60 * 1000;
/* What one installation may send in an hour, and how many new cards all of them may open in an hour together, so made-up
   installations cannot fill the list. */
export const REPORTS_PER_HOUR = 10;
export const NEW_CARDS_PER_HOUR = 200;
/* Every signal consumes the shared budget, even when its report repeats an existing card under a made-up installation. */
const SIGNALS_PER_HOUR = 2000;
/* What a card keeps of the versions and machines its signals came with. */
const KEPT = 20;
/* How many cards are listed, the latest signalled first, before they go in the order of priority. */
const LISTED = 500;

/* A bug many installations have comes first; then any other bug and anything many asked for; then the rest. */
export function priorityOf(kind: Kind, installations: number): Priority {
  if (kind === 'bug' && installations >= 3) return 'high';
  if (kind === 'bug' || installations >= 3) return 'normal';
  return 'low';
}
const RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

/* Repeats are told by their kind, error code and title written plainly: lowercase, every run of other characters one
   space, every number the same. */
export function fingerprintOf(kind: Kind, errorCode: string | null, title: string): string {
  const plain = title.normalize('NFKC').toLowerCase().replace(/\p{N}+/gu, '0').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return createHash('sha256').update(`${kind}\n${errorCode ?? ''}\n${plain}`).digest('hex');
}

/* Counted on the server's clock, which tests move. */
type SignalAttempt = { at: number; signals: number };
type Limits = { perInstallation: Attempts; newCards: Attempts; signals: SignalAttempt[] };
const kept = new WeakMap<object, Limits>();
function limitsOf(ctx: object): Limits {
  const found = kept.get(ctx) ?? { perInstallation: limiter({ max: REPORTS_PER_HOUR, windowMs: HOUR }), newCards: limiter({ max: NEW_CARDS_PER_HOUR, windowMs: HOUR }), signals: [] };
  kept.set(ctx, found);
  return found;
}
function within(attempts: Attempts, key: string, now: number): void {
  const { allowed, retryAfterS } = attempts(key, now);
  if (!allowed) throw new ApiError(429, 'too_many', 'Too many reports came from here. Wait, then send again.', 'too_many_attempts', { retryAfterS });
}

/* Reserve a batch whole before any state keyed by the claimed installation is allocated. A refusal names when enough
   earlier signals leave the rolling hour to fit this batch, without consuming any of the remaining budget. */
function withinSignals(limits: Limits, signals: number, now: number): void {
  const recent = limits.signals.filter(attempt => attempt.at > now - HOUR);
  limits.signals = recent;
  let excess = recent.reduce((total, attempt) => total + attempt.signals, signals) - SIGNALS_PER_HOUR;
  if (excess > 0) {
    let until = now;
    for (const attempt of recent) {
      excess -= attempt.signals;
      until = attempt.at + HOUR;
      if (excess <= 0) break;
    }
    const retryAfterS = Math.ceil((until - now) / 1000);
    throw new ApiError(429, 'too_many', 'Too many signals came this hour. Wait, then send again.', 'too_many_attempts', { retryAfterS });
  }
  recent.push({ at: now, signals });
}

const merged = (a: string[], b: string[]) => [...new Set([...a, ...b])].sort().slice(0, KEPT);

/* A report's title as the inbox keeps it, and what tells its repeats: the same on every installation that sent it. */
const titleOf = (report: Pick<Shown, 'title'>) => cleaned(report.title).text.slice(0, TITLE_MAX) || '-';
export const fingerprintOfReport = (report: Pick<Shown, 'kind' | 'title'> & { facts: Pick<Shown['facts'], 'errorCode'> }) => fingerprintOf(report.kind, report.facts.errorCode, titleOf(report));
const issueOf = (card: { issueNumber: number | null; issueUrl: string | null }): IssueLink | null => (card.issueNumber !== null && card.issueUrl ? { number: card.issueNumber, url: card.issueUrl } : null);

async function companyOf(ctx: Pick<Ctx, 'db'>): Promise<string> {
  const [company] = await ctx.db.select(idOnly(companies)).from(companies).where(eq(companies.singleton, true));
  if (!company) throw new ApiError(503, 'unavailable', 'This Hornhoof is not set up yet.');
  return company.id;
}

/* Takes one report into the list: a new card, or more signals on the card it repeats, one or as many repeats as it tells
   of. Its words are cleaned once more, whoever sent it. It answers with the card's number and its issue, if any. */
export async function receive(ctx: Pick<Ctx, 'db' | 'bus' | 'clock'>, report: Report): Promise<{ number: number; issue: IssueLink | null }> {
  const now = ctx.clock();
  const limits = limitsOf(ctx);
  const signals = report.repeats ?? 1;
  withinSignals(limits, signals, now);
  within(limits.perInstallation, report.installation, now);
  const companyId = await companyOf(ctx);
  const title = titleOf(report);
  const text = cleaned(report.text).text.slice(0, TEXT_MAX);
  const fingerprint = fingerprintOfReport(report);
  const at = new Date(now);
  const versions = [report.facts.version];
  const platforms = report.facts.platform;
  const taken = await ctx.db.transaction(async tx => {
    const place = and(eq(feedbackInbox.companyId, companyId), eq(feedbackInbox.fingerprint, fingerprint));
    let [card] = await tx.select().from(feedbackInbox).where(place).for('update');
    if (!card) {
      within(limits.newCards, 'all', now);
      const open = () => tx
        .insert(feedbackInbox)
        .values({ companyId, fingerprint, kind: report.kind, title, text, errorCode: report.facts.errorCode, versions, platforms, createdAt: at, updatedAt: at })
        .onConflictDoNothing()
        .returning();
      const opened = async () => (await tx.select().from(feedbackInbox).where(place).for('update'))[0];
      /* One that came at the same moment opened it meanwhile: this one counts on it. */
      [card] = await open();
      card ??= await opened();
      if (!card) {
        /* Its number was taken: a merge brought in cards with numbers this sequence had not given, so it moves past them,
           never back, as another report may hold a number it took and did not commit yet. */
        await tx.execute(sql`SELECT setval(s, GREATEST((SELECT max(number) FROM feedback_inbox), pg_sequence_last_value(s::regclass)))
          FROM pg_get_serial_sequence('feedback_inbox', 'number') AS s`);
        [card] = await open();
        card ??= await opened();
      }
    } else {
      await tx.update(feedbackInbox).set({ versions: merged(card.versions, versions), platforms: merged(card.platforms, platforms), updatedAt: at }).where(eq(feedbackInbox.id, card.id));
    }
    await tx
      .insert(feedbackSignals)
      .values({ cardId: card!.id, installation: report.installation, signals, createdAt: at, updatedAt: at })
      .onConflictDoUpdate({ target: [feedbackSignals.cardId, feedbackSignals.installation], set: { signals: sql`${feedbackSignals.signals} + ${signals}`, updatedAt: at } });
    return card!;
  });
  inboxChanged(ctx, companyId);
  return { number: taken.number, issue: issueOf(taken) };
}

/* People who see the whole company hear that the list changed. */
export const inboxChanged = (ctx: Pick<Ctx, 'bus'>, companyId: string) => ctx.bus.publish(companyId, { type: 'feedback', spot: { departmentId: null } });

/* The cards in the order to read them: by priority, then by how many installations sent each, the latest first. */
export async function listInbox(ctx: Pick<Ctx, 'db'>, companyId: string) {
  const cards = await ctx.db.select().from(feedbackInbox).where(eq(feedbackInbox.companyId, companyId)).orderBy(desc(feedbackInbox.updatedAt)).limit(LISTED);
  const counted = cards.length
    ? await ctx.db
        .select({ cardId: feedbackSignals.cardId, signals: sum(feedbackSignals.signals).mapWith(Number), installations: count() })
        .from(feedbackSignals)
        .where(inArray(feedbackSignals.cardId, cards.map(c => c.id)))
        .groupBy(feedbackSignals.cardId)
    : [];
  const of = new Map(counted.map(c => [c.cardId, c]));
  return cards
    .map(c => {
      const { signals = 0, installations = 0 } = of.get(c.id) ?? {};
      return {
        id: c.id,
        number: c.number,
        kind: c.kind,
        title: c.title,
        text: c.text,
        errorCode: c.errorCode,
        versions: c.versions,
        platforms: c.platforms,
        signals,
        installations,
        priority: priorityOf(c.kind, installations),
        firstAt: c.createdAt.toISOString(),
        lastAt: c.updatedAt.toISOString(),
        issue: issueOf(c),
      };
    })
    .sort((a, b) => RANK[a.priority] - RANK[b.priority] || b.installations - a.installations || b.lastAt.localeCompare(a.lastAt));
}
export type InboxCard = Awaited<ReturnType<typeof listInbox>>[number];
