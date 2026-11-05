import type { Ctx } from '../../app.js';
import { loggable } from '../../errors.js';
import { pumpWaiting } from '../conversation/queue.js';
import { workingCount } from '../events/store.js';
import type { UpdateRequest, UpdaterView } from './control.js';
import { holdTurns } from './drain.js';

/* While an update waits for the agents, the working count is checked when it changes and this often besides. */
const IDLE_CHECK_MS = 30_000;
/* An update handed over restarts Hornhoof within minutes; one that did not keeps no turns waiting longer. */
const HELD_AFTER_MS = 10 * 60_000;

type Waiting = { companyId: string; request: UpdateRequest; stop: () => void };

export function sendToUpdater(ctx: Ctx, request: UpdateRequest): void {
  const { id, ...rest } = request;
  ctx.updater.request(rest, id);
}

/* The update that waits for a company's agents to finish, and the company's turns held meanwhile and for a while after. */
export class UpdateWait {
  private waiting: Waiting | null = null;
  /* What ends the hold on a company's turns once its update went to the updater. */
  private readonly heldAfterHandOver = new Map<string, NodeJS.Timeout>();

  constructor(private readonly ctx: Ctx) {}

  shown(): UpdaterView['waiting'] {
    return this.waiting && { version: this.waiting.request.version, commit: this.waiting.request.commit };
  }

  /* release: the turns held for the update start again; an update handed over keeps them for the restart. */
  callOff(release = true): void {
    this.waiting?.stop();
    if (this.waiting && release) this.letTurnsGo(this.waiting.companyId);
    this.waiting = null;
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
     taking the server down. */
  async sendWhenIdle(companyId: string, request: UpdateRequest): Promise<void> {
    const tryCheck = () => this.handOverIfIdle(companyId, request).catch(err => this.ctx.log.error({ error: loggable(err) }, 'Could not hand the waiting update to the updater.'));
    const unsubscribe = this.ctx.bus.subscribe(companyId, m => m.type === 'working' && m.working === 0 && void tryCheck());
    const timer = setInterval(() => void tryCheck(), IDLE_CHECK_MS);
    timer.unref();
    this.waiting = { companyId, request, stop: () => (unsubscribe(), clearInterval(timer)) };
    /* No new turn starts meanwhile, so the running ones can end. */
    holdTurns(this.ctx, companyId, true);
    await tryCheck();
  }

  private wanted(request: UpdateRequest): boolean {
    return this.waiting?.request.id === request.id;
  }

  /* The request is still the one waiting after the count, since a person may call it off, ask for another or the app may
     stop leading meanwhile. It stops waiting only once the updater has it. */
  private async handOverIfIdle(companyId: string, request: UpdateRequest): Promise<void> {
    if (!this.wanted(request) || (await workingCount(this.ctx.db, companyId)) > 0 || !this.wanted(request)) return;
    sendToUpdater(this.ctx, request);
    this.callOff(false);
    this.holdAfterHandOver(companyId);
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
    void pumpWaiting(this.ctx).catch(err => this.ctx.log.error({ error: loggable(err) }, 'Could not start the turns held for an update.'));
  }
}
