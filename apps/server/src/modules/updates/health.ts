import { sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, companies } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { enqueueTurn } from '../conversation/queue.js';
import { busyAgentIds, operationsWatchers, pickOpsRecipient, when } from '../tasks/silent.js';
import { UPDATER_SILENT_MS, type UpdaterSilent } from './control.js';

const SILENT_MINUTES = UPDATER_SILENT_MS / 60_000;
const states = new WeakMap<Ctx, { silent: string | null }>();
const chains = new WeakMap<Ctx, Promise<void>>();

/* Current silent-updater state, or null when the updater heartbeat is fresh or absent. */
export function updaterSilent(ctx: Pick<Ctx, 'updater' | 'clock'>, now = new Date(ctx.clock())): UpdaterSilent | null {
  const since = ctx.updater.silentSince(now.getTime());
  return since ? { since: since.toISOString() } : null;
}

/* Stable incident key per company and outage start second, deduplicating ticks and restarts. */
export function updaterSilentCase(companyId: string, since: string): string {
  return `updater-silent:${companyId}:${Math.floor(Date.parse(since) / 1000)}`;
}

function silentAlertText(since: string): string {
  return (
    `Hornhoof: updater is silent since ${when(since)} (${since}), older than ${SILENT_MINUTES} minutes. ` +
    'Updates and backup steps that rely on the updater cannot run until its heartbeat is fresh again. ' +
    'Check the updater process and control folder on the server machine; this warning clears automatically once it answers again.'
  );
}

/* Uses the partial index agent_events_failure_case via the non-null predicate. */
async function alreadySent(ctx: Pick<Ctx, 'db'>, caseId: string): Promise<boolean> {
  const [seen] = await ctx.db
    .select(idOnly(agentEvents))
    .from(agentEvents)
    .where(sql`${agentEvents.data}->>'failureCase' is not null and ${agentEvents.data}->>'failureCase' = ${caseId}`)
    .limit(1);
  return Boolean(seen);
}

async function notifyCompany(ctx: Ctx, companyId: string, since: string, busy: ReadonlySet<string>): Promise<void> {
  const caseId = updaterSilentCase(companyId, since);
  if (await alreadySent(ctx, caseId)) return;
  const to = pickOpsRecipient(await operationsWatchers(ctx, companyId), '', busy);
  if (!to) return;
  const text = silentAlertText(since);
  await enqueueTurn(ctx, {
    companyId,
    agentId: to.id,
    prompt: text,
    createdBy: null,
    message: {
      personId: null,
      text,
      failureCase: caseId,
      notification: { source: 'failure', tasks: [], detail: { en: 'updater silent', ru: 'служба обновления молчит' } },
    },
  });
}

function publishUpdates(ctx: Pick<Ctx, 'bus'>, companyIds: readonly string[]): void {
  for (const companyId of companyIds) ctx.bus.publish(companyId, { type: 'updates', spot: { departmentId: null } });
}

function recordTransition(ctx: Ctx, prevSince: string | null, nextSince: string | null, companyIds: readonly string[]): void {
  states.set(ctx, { silent: nextSince });
  if (nextSince) ctx.log.warn({ since: nextSince, thresholdMs: UPDATER_SILENT_MS }, 'The updater heartbeat is stale.');
  else ctx.log.info({ previousSince: prevSince }, 'The updater heartbeat is fresh again.');
  publishUpdates(ctx, companyIds);
}

async function notifyAll(ctx: Ctx, companyIds: readonly string[], since: string): Promise<void> {
  const busy = await busyAgentIds(ctx);
  for (const companyId of companyIds) await notifyCompany(ctx, companyId, since, busy);
}

async function runHealthCheck(ctx: Ctx, now: Date): Promise<void> {
  const nextSince = updaterSilent(ctx, now)?.since ?? null;
  const prevSince = states.get(ctx)?.silent ?? null;
  if (!nextSince && !prevSince) return;
  const companyIds = (await ctx.db.select(idOnly(companies)).from(companies)).map(c => c.id);
  if (nextSince !== prevSince) recordTransition(ctx, prevSince, nextSince, companyIds);
  if (nextSince && companyIds.length) await notifyAll(ctx, companyIds, nextSince);
}

/* Serialized per context so entry sweeps and minute ticks never race on the same incident. */
export function checkUpdaterHealth(ctx: Ctx, now = new Date(ctx.clock())): Promise<void> {
  const prev = chains.get(ctx) ?? Promise.resolve();
  const run = prev.then(() => runHealthCheck(ctx, now));
  chains.set(ctx, run.catch(() => undefined));
  return run;
}
