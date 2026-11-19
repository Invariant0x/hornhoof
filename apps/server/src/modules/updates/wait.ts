import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, tasks, updateWaits } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { loggable } from '../../errors.js';
import { enqueueTurn, pumpWaiting } from '../conversation/queue.js';
import { workingCount } from '../events/store.js';
import { reasonOf } from '../keeper/machine-keys.js';
import { lostTurn } from '../tasks/silent.js';
import { lastTurnSigns } from '../tasks/turn-signs.js';
import { notStep } from '../tools/steps.js';
import type { NamedTurn, UpdateCalledOff, UpdateRequest, UpdateWaiting } from './control.js';
import { holdTurns } from './drain.js';

/* While an update waits for the agents, the working count is checked when it changes and this often besides. */
const IDLE_CHECK_MS = 30_000;
/* An update handed over restarts Hornhoof within minutes; one that did not keeps no turns waiting longer. */
const HELD_AFTER_MS = 10 * 60_000;
/* How long an update waits for the agents unless its request says otherwise: the company starts no new turn meanwhile. */
export const IDLE_WAIT_MINUTES = 30;
const HAND_OVER_FAILED = 'Could not hand the waiting update to the updater.';

type WaitRow = typeof updateWaits.$inferSelect;
type Wait = Pick<WaitRow, 'id' | 'companyId' | 'request' | 'since' | 'until'>;
/* The wait this app watches while it leads, and what stops the watching. */
type Armed = { wait: Wait; stop: () => void };
type CallingOff = { reason: UpdateCalledOff['reason']; turns: NamedTurn[]; error?: string };
type Ending = { outcome: 'handed_over' | 'replaced' } | ({ outcome: 'called_off' } & CallingOff);
type RunningTurn = NamedTurn & { id: string; lost: boolean };

/* From here the request file and then the updater's own status say that an update is out, so its claim is let go. */
export function sendToUpdater(ctx: Ctx, request: UpdateRequest): void {
  const { id, ...rest } = request;
  ctx.updater.request(rest, id);
  ctx.updater.free(id);
}

/* The company's running turns, a turn Hornhoof heard nothing of for ten minutes marked lost, neither a report of its
   program nor an event of its work: nothing tells when that one ends, so no update waits for it. */
async function runningTurns(ctx: Ctx, companyId: string, nowMs: number): Promise<RunningTurn[]> {
  const rows = await ctx.db
    .select({ id: jobs.id, kind: jobs.kind, startedAt: jobs.startedAt, createdAt: jobs.createdAt, agent: agents.name, task: tasks.number })
    .from(jobs)
    .innerJoin(agents, eq(agents.id, jobs.agentId))
    .leftJoin(tasks, eq(tasks.id, jobs.taskId))
    .where(and(eq(jobs.companyId, companyId), eq(jobs.status, 'running'), notStep))
    .orderBy(asc(jobs.createdAt));
  const signs = await lastTurnSigns(ctx, rows.filter(row => row.kind === 'conversation').map(row => row.id));
  return rows.map(row => ({ id: row.id, agent: row.agent, task: row.task, lost: row.kind === 'conversation' && lostTurn(ctx, row, nowMs, signs.get(row.id)) }));
}

const named = (turns: RunningTurn[], lost: boolean): NamedTurn[] => turns.filter(turn => turn.lost === lost).map(({ agent, task }) => ({ agent, task }));
const turnList = (turns: NamedTurn[]): string => turns.map(turn => (turn.task ? `${turn.agent} (#${turn.task})` : turn.agent)).join(', ') || 'none';

function calledOffText(called: UpdateCalledOff, wait: Wait): string {
  const why =
    called.reason === 'failed'
      ? `Hornhoof could not go on with it: ${called.error ?? 'no reason was given.'}`
      : `the agents did not finish within ${Math.round((wait.until.getTime() - wait.since.getTime()) / 60_000)} minutes.`;
  return (
    `Hornhoof called off the update to ${called.version}: ${why} No running work was stopped, and new turns start again. ` +
    `Still running: ${turnList(called.turns)}. Retry when work finishes. Check the affected turns and how they can resume before choosing an immediate update with whenIdle false.`
  );
}

/* The orchestrator hears of it, as it runs updates for the CEO and may have asked for this one. */
async function tellOrchestrator(ctx: Ctx, companyId: string, text: string): Promise<void> {
  const [orchestrator] = await ctx.db.select(idOnly(agents)).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt)));
  if (!orchestrator) return;
  const detail = { en: 'update called off', ru: 'обновление отменено' };
  await enqueueTurn(ctx, { companyId, agentId: orchestrator.id, prompt: text, createdBy: null, message: { personId: null, text, notification: { source: 'service', tasks: [], detail } } });
}

/* The update that waits for a company's agents to finish, and the company's turns held meanwhile and for a while after.
   The wait lives in update_waits: this app only watches it while it leads, and every way it ends is written there, as
   handed over, replaced by a later request or called off with its reason. A step-down or a restart leaves it as it was,
   and the next lead takes it up again. */
export class UpdateWait {
  private armed: Armed | null = null;
  /* What looks at the wait this often while the app leads, and takes up one nobody watches. */
  private ticker: NodeJS.Timeout | null = null;
  /* What ends the hold on a company's turns once its update went to the updater. */
  private readonly heldAfterHandOver = new Map<string, NodeJS.Timeout>();
  /* Taking a wait up, starting, replacing and calling one off go one after another. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly ctx: Ctx) {}

  /* The turns are named only to the company whose update waits for them. */
  async shown(companyId: string): Promise<UpdateWaiting | null> {
    const wait = await this.open();
    if (!wait) return null;
    const turns = wait.companyId === companyId ? await runningTurns(this.ctx, companyId, this.now()) : [];
    const { version, commit } = wait.request;
    return { version, commit, since: wait.since.toISOString(), until: wait.until.toISOString(), turns: named(turns, false), lost: named(turns, true) };
  }

  /* The last update asked for, when it went to nobody; a later request, handed over or waiting, takes its place. */
  async shownCalledOff(companyId: string): Promise<UpdateCalledOff | null> {
    const [last] = await this.ctx.db.select().from(updateWaits).orderBy(desc(updateWaits.since)).limit(1);
    if (last?.companyId !== companyId || last.outcome !== 'called_off' || !last.endedAt || !last.reason) return null;
    const { version, commit } = last.request;
    return { version, commit, at: last.endedAt.toISOString(), until: last.until.toISOString(), reason: last.reason, turns: last.turns ?? [], ...(last.error ? { error: last.error } : {}) };
  }

  /* The app leads: it takes up the wait the last lead or a restart left, and looks at it from now on. */
  lead(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = setInterval(() => void this.tick(), IDLE_CHECK_MS);
    this.ticker.unref();
    void this.tick();
  }

  /* A machine that stopped leading watches no wait and holds no turns, and changes nothing of the wait either: the next
     lead takes it up. Nothing is started here, as only a leader starts turns: its minute round picks up what waits. */
  standDown(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    const companies = [...(this.armed ? [this.armed.wait.companyId] : []), ...this.heldAfterHandOver.keys()];
    this.disarm(false);
    this.heldAfterHandOver.forEach(timeout => clearTimeout(timeout));
    this.heldAfterHandOver.clear();
    for (const companyId of companies) holdTurns(this.ctx, companyId, false);
  }

  /* The update that waits holds the updater, also after a request that would have taken its place failed. */
  keepClaim(): void {
    if (this.armed) this.ctx.updater.claim('update', this.armed.wait.request.id);
  }

  /* A person or the orchestrator calls off the update that waits: it is written down with the turns that ran, and they
     go on and new ones start. */
  async cancel(): Promise<void> {
    await this.exclusive(async () => {
      const wait = await this.open();
      if (!wait) return;
      const turns = named(await runningTurns(this.ctx, wait.companyId, this.now()), false);
      await this.callOff(wait, { reason: 'cancelled', turns });
    });
  }

  /* An update that goes at once takes the place of one that waits, and is written down as handed over. The updater has
     it already, so a record that cannot be written costs a log line, not the update. */
  async handedOver(companyId: string, request: UpdateRequest): Promise<void> {
    await this.exclusive(async () => {
      const at = new Date(this.now());
      await this.ctx.db
        .transaction(async tx => {
          await tx.insert(updateWaits).values({ id: request.id, companyId, request, since: at, until: at, endedAt: at, outcome: 'handed_over' });
          await tx.update(updateWaits).set({ endedAt: at, outcome: 'replaced' }).where(and(isNull(updateWaits.endedAt), ne(updateWaits.id, request.id)));
        })
        .catch(this.logged('Could not record the update handed over at once.'));
      this.disarm(true);
    });
  }

  /* The wait is written before it starts, together with the end of the one it replaces, so a failure leaves the earlier
     one waiting as it was. The wait has a deadline, so turns that do not end never hold the company. */
  async sendWhenIdle(companyId: string, request: UpdateRequest, minutes = IDLE_WAIT_MINUTES): Promise<void> {
    await this.exclusive(async () => {
      const since = this.now();
      const wait: Wait = { id: request.id, companyId, request, since: new Date(since), until: new Date(since + minutes * 60_000) };
      await this.ctx.db.transaction(async tx => {
        await tx.insert(updateWaits).values(wait);
        await tx.update(updateWaits).set({ endedAt: wait.since, outcome: 'replaced' }).where(and(isNull(updateWaits.endedAt), ne(updateWaits.id, request.id)));
      });
      this.disarm(true);
      this.arm(wait, since);
    });
    await this.check(request).catch(this.logged(HAND_OVER_FAILED));
  }

  private now(): number {
    return this.ctx.clock();
  }

  private logged(message: string): (err: unknown) => void {
    return err => this.ctx.log.error({ error: loggable(err) }, message);
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async open(): Promise<WaitRow | undefined> {
    const [wait] = await this.ctx.db.select().from(updateWaits).where(isNull(updateWaits.endedAt)).orderBy(desc(updateWaits.since)).limit(1);
    return wait;
  }

  /* Ends the wait once: false when it had ended already. */
  private async end(id: string, ending: Ending, at = new Date(this.now())): Promise<boolean> {
    const ended = await this.ctx.db
      .update(updateWaits)
      .set({ endedAt: at, ...ending })
      .where(and(eq(updateWaits.id, id), isNull(updateWaits.endedAt)))
      .returning({ id: updateWaits.id });
    return ended.length > 0;
  }

  private wanted(request: UpdateRequest): boolean {
    return this.armed?.wait.request.id === request.id;
  }

  /* No new turn starts meanwhile, so the running ones can end. */
  private arm(wait: Wait, now: number): void {
    const { companyId, request } = wait;
    const tryCheck = () => this.check(request).catch(this.logged(HAND_OVER_FAILED));
    const unsubscribe = this.ctx.bus.subscribe(companyId, m => m.type === 'working' && m.working === 0 && void tryCheck());
    const deadline = setTimeout(() => void (this.wanted(request) && this.giveUp(wait).catch(this.logged('Could not call off the waiting update.'))), Math.max(0, wait.until.getTime() - now));
    deadline.unref();
    this.armed = { wait, stop: () => (unsubscribe(), clearTimeout(deadline)) };
    holdTurns(this.ctx, companyId, true);
  }

  /* release: the turns held for the update start again; an update handed over keeps them for the restart. */
  private disarm(release: boolean, id?: string): void {
    const armed = this.armed;
    if (!armed || (id !== undefined && armed.wait.id !== id)) return;
    this.armed = null;
    armed.stop();
    this.ctx.updater.free(armed.wait.request.id);
    if (release) this.letTurnsGo(armed.wait.companyId);
  }

  private async tick(): Promise<void> {
    if (this.armed) await this.check(this.armed.wait.request).catch(this.logged(HAND_OVER_FAILED));
    else await this.resume().catch(this.logged('Could not take up the waiting update.'));
  }

  /* The wait a step-down or a restart left. One the updater took before its end was written is over; one the updater
     cannot take, as a restore or another update holds it, goes to nobody. Any other waits on, and a deadline that passed
     meanwhile ends it at the first check. */
  private async resume(): Promise<void> {
    const request = await this.exclusive(async () => {
      if (this.armed) return null;
      const wait = await this.open();
      if (!wait) return null;
      if (this.ctx.updater.status()?.id === wait.id || this.ctx.updater.requested() === wait.id) {
        await this.end(wait.id, { outcome: 'handed_over' });
        return null;
      }
      const holder = this.ctx.updater.claim('update', wait.id);
      if (holder) {
        const error = holder === 'restore' ? 'a restore runs.' : 'another update runs.';
        await this.callOff(wait, { reason: 'failed', turns: named(await runningTurns(this.ctx, wait.companyId, this.now()), false), error: `the updater cannot take it, as ${error}` });
        return null;
      }
      this.arm(wait, this.now());
      return wait.request;
    });
    if (request) await this.check(request);
  }

  /* An update goes once its deadline passed only if the agents finished meanwhile; before it, as soon as they finish. */
  private async check(request: UpdateRequest): Promise<void> {
    const armed = this.armed;
    if (armed?.wait.request.id !== request.id) return;
    if (this.now() >= armed.wait.until.getTime()) return this.giveUp(armed.wait);
    await this.handOverIfIdle(request);
  }

  /* Idle once no turn runs but those it does not wait for. */
  private async idle(companyId: string): Promise<boolean> {
    const lost = (await runningTurns(this.ctx, companyId, this.now())).filter(turn => turn.lost).map(turn => turn.id);
    return (await workingCount(this.ctx.db, companyId, undefined, false, lost)) === 0;
  }

  /* The request is still the one waiting after the count, since a person may call it off, ask for another or the app may
     stop leading meanwhile. It stops waiting only once the updater has it. */
  private async handOverIfIdle(request: UpdateRequest): Promise<void> {
    const companyId = this.armed?.wait.companyId;
    if (!companyId || !this.wanted(request) || !(await this.idle(companyId)) || !this.wanted(request)) return;
    sendToUpdater(this.ctx, request);
    this.disarm(false);
    this.holdAfterHandOver(companyId);
    await this.end(request.id, { outcome: 'handed_over' }).catch(this.logged('Could not record the update handed over.'));
  }

  /* At its deadline an update goes only if the agents finished. Otherwise it is called off and nothing that runs stops: an
     update now would cut turns short that nobody agreed to cut, while a later update loses nothing. A failure to read
     the turns or to write it down leaves it waiting, and the next check tries again. */
  private async giveUp(wait: Wait): Promise<void> {
    let failure: string | undefined;
    await this.handOverIfIdle(wait.request).catch((err: unknown) => {
      this.logged(HAND_OVER_FAILED)(err);
      failure = reasonOf(err);
    });
    if (!this.wanted(wait.request)) return;
    const turns = named(await runningTurns(this.ctx, wait.companyId, this.now()), false);
    if (!this.wanted(wait.request)) return;
    /* With no turn left to wait for, it was the hand-over that failed. */
    const calling: CallingOff = failure && turns.length === 0 ? { reason: 'failed', turns, error: failure } : { reason: 'deadline', turns };
    await this.exclusive(() => this.callOff(wait, calling));
  }

  /* No check of this app hands it over once this starts. Its turns go, and when it cannot be written down it stays
     waiting in update_waits, where the next check takes it up again. The orchestrator hears of it unless a person or the
     orchestrator called it off themselves. */
  private async callOff(wait: Wait, calling: CallingOff): Promise<void> {
    const at = new Date(this.now());
    this.disarm(true, wait.id);
    if (!(await this.end(wait.id, { outcome: 'called_off', ...calling }, at))) return;
    const { version, commit } = wait.request;
    const called: UpdateCalledOff = { version, commit, at: at.toISOString(), until: wait.until.toISOString(), ...calling };
    this.ctx.log.warn({ version, reason: calling.reason, turns: calling.turns, error: calling.error }, 'Called off the update that waited for the agents.');
    if (calling.reason !== 'cancelled') await tellOrchestrator(this.ctx, wait.companyId, calledOffText(called, wait));
  }

  private holdAfterHandOver(companyId: string): void {
    clearTimeout(this.heldAfterHandOver.get(companyId));
    const timeout = setTimeout(() => {
      this.heldAfterHandOver.delete(companyId);
      if (this.armed?.wait.companyId !== companyId) this.letTurnsGo(companyId);
    }, HELD_AFTER_MS);
    timeout.unref();
    this.heldAfterHandOver.set(companyId, timeout);
  }

  private letTurnsGo(companyId: string): void {
    holdTurns(this.ctx, companyId, false);
    void pumpWaiting(this.ctx).catch(this.logged('Could not start the turns held for an update.'));
  }
}
