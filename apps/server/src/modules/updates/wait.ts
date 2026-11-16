import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, tasks } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import { enqueueTurn, pumpWaiting } from '../conversation/queue.js';
import { workingCount } from '../events/store.js';
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

type Waiting = { companyId: string; request: UpdateRequest; since: number; minutes: number; stop: () => void };
type CalledOff = UpdateCalledOff & { companyId: string };
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

function calledOffText(called: CalledOff, minutes: number): string {
  return (
    `Hornhoof called off the update to ${called.version}: the agents did not finish within ${minutes} minutes. No running work was stopped, and new turns start again. ` +
    `Still running: ${turnList(called.turns)}. Ask for it again later, or, once the CEO agrees to cut those turns short, with whenIdle false.`
  );
}

/* The orchestrator hears of it, as it runs updates for the CEO and may have asked for this one. */
async function tellOrchestrator(ctx: Ctx, companyId: string, text: string): Promise<void> {
  const [orchestrator] = await ctx.db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt)));
  if (!orchestrator) return;
  const detail = { en: 'update called off', ru: 'обновление отменено' };
  await enqueueTurn(ctx, { companyId, agentId: orchestrator.id, prompt: text, createdBy: null, message: { personId: null, text, notification: { source: 'service', tasks: [], detail } } });
}

/* The update that waits for a company's agents to finish, and the company's turns held meanwhile and for a while after. */
export class UpdateWait {
  private waiting: Waiting | null = null;
  private calledOff: CalledOff | null = null;
  /* What ends the hold on a company's turns once its update went to the updater. */
  private readonly heldAfterHandOver = new Map<string, NodeJS.Timeout>();

  constructor(private readonly ctx: Ctx) {}

  /* The turns are named only to the company whose update waits for them. */
  async shown(companyId: string): Promise<UpdateWaiting | null> {
    const waiting = this.waiting;
    if (!waiting) return null;
    const turns = waiting.companyId === companyId ? await runningTurns(this.ctx, companyId, Date.now()) : [];
    const { version, commit } = waiting.request;
    const until = new Date(waiting.since + waiting.minutes * 60_000).toISOString();
    return { version, commit, since: new Date(waiting.since).toISOString(), until, turns: named(turns, false), lost: named(turns, true) };
  }

  shownCalledOff(companyId: string): UpdateCalledOff | null {
    if (this.calledOff?.companyId !== companyId) return null;
    const { version, commit, at, reason, turns } = this.calledOff;
    return { version, commit, at, reason, turns };
  }

  /* release: the turns held for the update start again; an update handed over keeps them for the restart. */
  callOff(release = true): void {
    this.calledOff = null;
    this.waiting?.stop();
    if (this.waiting) this.ctx.updater.free(this.waiting.request.id);
    if (this.waiting && release) this.letTurnsGo(this.waiting.companyId);
    this.waiting = null;
  }

  /* The update that waits holds the updater, also after a request that would have taken its place failed. */
  keepClaim(): void {
    if (this.waiting) this.ctx.updater.claim('update', this.waiting.request.id);
  }

  /* A machine that stopped leading waits for no agents and holds no turns. Nothing is started here, as only a leader
     starts turns: its minute round picks up what waits. */
  standDown(): void {
    const companies = this.waiting ? [this.waiting.companyId, ...this.heldAfterHandOver.keys()] : [...this.heldAfterHandOver.keys()];
    this.callOff(false);
    this.heldAfterHandOver.forEach(timeout => clearTimeout(timeout));
    this.heldAfterHandOver.clear();
    for (const companyId of companies) holdTurns(this.ctx, companyId, false);
  }

  /* A request that could not be written is tried again on the next check, and the failure goes to the log instead of
     taking the server down. The wait has a deadline, so turns that do not end never hold the company. */
  async sendWhenIdle(companyId: string, request: UpdateRequest, minutes = IDLE_WAIT_MINUTES): Promise<void> {
    const tryCheck = () => this.handOverIfIdle(companyId, request).catch(this.logged(HAND_OVER_FAILED));
    const unsubscribe = this.ctx.bus.subscribe(companyId, m => m.type === 'working' && m.working === 0 && void tryCheck());
    const timer = setInterval(() => void tryCheck(), IDLE_CHECK_MS);
    timer.unref();
    const deadline = setTimeout(() => void this.giveUp(request).catch(this.logged('Could not call off the waiting update.')), minutes * 60_000);
    deadline.unref();
    this.waiting = { companyId, request, since: Date.now(), minutes, stop: () => (unsubscribe(), clearInterval(timer), clearTimeout(deadline)) };
    /* No new turn starts meanwhile, so the running ones can end. */
    holdTurns(this.ctx, companyId, true);
    await tryCheck();
  }

  private logged(message: string): (err: unknown) => void {
    return err => this.ctx.log.error({ error: loggable(err) }, message);
  }

  private wanted(request: UpdateRequest): boolean {
    return this.waiting?.request.id === request.id;
  }

  /* Idle once no turn runs but those it does not wait for. */
  private async idle(companyId: string): Promise<boolean> {
    const lost = (await runningTurns(this.ctx, companyId, Date.now())).filter(turn => turn.lost).map(turn => turn.id);
    return (await workingCount(this.ctx.db, companyId, undefined, false, lost)) === 0;
  }

  /* The request is still the one waiting after the count, since a person may call it off, ask for another or the app may
     stop leading meanwhile. It stops waiting only once the updater has it. */
  private async handOverIfIdle(companyId: string, request: UpdateRequest): Promise<void> {
    if (!this.wanted(request) || !(await this.idle(companyId)) || !this.wanted(request)) return;
    sendToUpdater(this.ctx, request);
    this.callOff(false);
    this.holdAfterHandOver(companyId);
  }

  /* At its deadline an update goes only if the agents finished. Otherwise it is called off and nothing that runs stops: an
     update now would cut turns short that nobody agreed to cut, while a later update loses nothing. */
  private async giveUp(request: UpdateRequest): Promise<void> {
    const waiting = this.waiting;
    if (waiting?.request.id !== request.id) return;
    await this.handOverIfIdle(waiting.companyId, request).catch(this.logged(HAND_OVER_FAILED));
    const turns = this.wanted(request) ? await runningTurns(this.ctx, waiting.companyId, Date.now()) : [];
    if (!this.wanted(request)) return;
    this.callOff();
    const called: CalledOff = { companyId: waiting.companyId, version: request.version, commit: request.commit, at: new Date().toISOString(), reason: 'deadline', turns: named(turns, false) };
    this.calledOff = called;
    this.ctx.log.warn({ version: request.version, turns: called.turns }, 'Called off the update that waited for the agents past its deadline.');
    await tellOrchestrator(this.ctx, waiting.companyId, calledOffText(called, waiting.minutes));
  }

  private holdAfterHandOver(companyId: string): void {
    clearTimeout(this.heldAfterHandOver.get(companyId));
    const timeout = setTimeout(() => {
      this.heldAfterHandOver.delete(companyId);
      if (this.waiting?.companyId !== companyId) this.letTurnsGo(companyId);
    }, HELD_AFTER_MS);
    timeout.unref();
    this.heldAfterHandOver.set(companyId, timeout);
  }

  private letTurnsGo(companyId: string): void {
    holdTurns(this.ctx, companyId, false);
    void pumpWaiting(this.ctx).catch(this.logged('Could not start the turns held for an update.'));
  }
}
