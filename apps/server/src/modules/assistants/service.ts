import { setTimeout as sleep } from 'node:timers/promises';
import type { Ctx } from '../../app.js';
import { assistants } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { loggable } from '../../errors.js';
import type { StreamMessage } from '../events/bus.js';
import { eventsAfter, sweepEvents, type AssistantEventView } from './events.js';
import { collectReplies, type Told } from './replies.js';
import { tellRequests } from './requests.js';
import { Wakes } from './wake.js';

const SWEEP_MS = 60 * 60_000;
/* What the company's stream says that may change what an assistant waits for: an agent's words or turn, or a request. */
const FOR_REPLIES = new Set<StreamMessage['type']>(['agent_event', 'working']);
const FOR_REQUESTS = new Set<StreamMessage['type']>(['requests', 'task', 'org']);

type Work = { replies: boolean; requests: boolean };
const NOTHING: Work = { replies: false, requests: false };

/* One company's passes over what its assistants wait for: one at a time, and what is asked for while one runs is done
   once, after it. */
class Passes {
  private chain: Promise<void> = Promise.resolve();
  private want: Work = NOTHING;
  private queued = false;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly off: (() => void)[];

  constructor(
    private readonly service: Assistants,
    private readonly ctx: Ctx,
    private readonly companyId: string,
  ) {
    this.off = [
      ctx.bus.subscribe(companyId, m => this.ask({ replies: FOR_REPLIES.has(m.type), requests: FOR_REQUESTS.has(m.type) })),
      ctx.bus.onAccessChange(companyId, () => this.ask({ replies: false, requests: true })),
    ];
  }

  ask(work: Work): void {
    if (this.stopped || (!work.replies && !work.requests)) return;
    this.want = { replies: this.want.replies || work.replies, requests: this.want.requests || work.requests };
    if (this.queued) return;
    this.queued = true;
    this.chain = this.chain.then(() => this.pass());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const off of this.off) off();
    clearTimeout(this.timer);
    await this.chain;
  }

  /* Once the passes asked for so far have ended, the ones asked for while they ran among them. */
  async idle(): Promise<void> {
    for (let seen = this.chain; ; seen = this.chain) {
      await seen;
      if (seen === this.chain) return;
    }
  }

  private async pass(): Promise<void> {
    const work = this.want;
    this.want = NOTHING;
    this.queued = false;
    if (this.stopped) return;
    try {
      if (work.replies) this.later((await collectReplies(this.ctx, this.companyId, this.service.told, this.service.replyGraceMs)).again);
      if (work.requests) await tellRequests(this.ctx, this.companyId, this.service.told);
    } catch (err) {
      if (!this.stopped) this.ctx.log.warn({ error: loggable(err), companyId: this.companyId }, 'Could not pass on what an assistant waits for.');
    }
  }

  /* An answer whose end waits for its grace is looked at again once the grace is over. */
  private later(ms: number | null): void {
    clearTimeout(this.timer);
    if (ms === null || this.stopped) return;
    this.timer = setTimeout(() => this.ask({ replies: true, requests: false }), ms);
    this.timer.unref();
  }
}

/* What Hornhoof does for assistants while it runs: it collects what agents answer them, tells them of the requests that wait
   for their owners, keeps what it told as their events, and wakes them when something new is there. It stops and starts
   again as often as asked, as a server in a network gets and loses the lead: each start begins anew from the database. */
export class Assistants {
  /* How long the end of an answer waits after its turn, for a turn that goes on from it; a test puts its own here. */
  replyGraceMs = 30_000;
  /* The longest wait of a long poll that hears nothing; a test puts its own here. */
  pause = (ms: number, signal: AbortSignal): Promise<void> => sleep(ms, undefined, { signal }).catch(() => {});
  readonly wakes: Wakes;
  private started = false;
  /* Starts and stops one after another, so a start never meets a stop that is still going. */
  private turn: Promise<void> = Promise.resolve();
  private readonly companies = new Map<string, Passes>();
  private readonly ears = new Map<string, Set<() => void>>();
  private sweeper: NodeJS.Timeout | undefined;

  constructor(private readonly ctx: Ctx) {
    this.wakes = new Wakes(ctx);
  }

  start(): Promise<void> {
    return this.inTurn(() => this.begin());
  }

  /* Lets the long polls go, and leaves nothing running: no pass, no wake, no sweep, until it starts again. */
  stop(): Promise<void> {
    return this.inTurn(() => this.end());
  }

  private inTurn(step: () => Promise<void>): Promise<void> {
    const done = this.turn.then(step);
    this.turn = done.catch(() => {});
    return done;
  }

  /* A server that cannot read its assistants still starts, without them, as it does without its Telegram bots. */
  private async begin(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.wakes.start();
    this.sweep();
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweeper.unref();
    try {
      const rows = await this.ctx.db.selectDistinct(only(assistants, 'companyId')).from(assistants);
      for (const { companyId } of rows) this.collect(companyId);
    } catch (err) {
      this.ctx.log.error({ error: loggable(err) }, 'Could not start passing on what assistants wait for.');
    }
  }

  private async end(): Promise<void> {
    this.started = false;
    clearInterval(this.sweeper);
    const passes = [...this.companies.values()];
    this.companies.clear();
    for (const ears of this.ears.values()) for (const hear of ears) hear();
    await Promise.all(passes.map(p => p.stop()));
    await this.wakes.stop();
  }

  /* Once nothing asked of it runs any more: the passes asked for and the wakes they sent. What did not go by then does not go
     for what was asked, so a test that says nothing went waits for this first. */
  async settled(): Promise<void> {
    await Promise.all([...this.companies.values()].map(passes => passes.idle()));
    await this.wakes.idle();
  }

  /* Something an assistant of this company waits for may have happened. */
  collect(companyId: string): void {
    if (!this.started) return;
    let passes = this.companies.get(companyId);
    if (!passes) this.companies.set(companyId, (passes = new Passes(this, this.ctx, companyId)));
    passes.ask({ replies: true, requests: true });
  }

  /* A new event of the assistant is kept: its long polls hear it, and while the work runs, its events address is woken. */
  readonly told: Told = (assistantId, seq, kind, worth) => {
    for (const hear of this.ears.get(assistantId) ?? []) hear();
    if (this.started) this.wakes.wake(assistantId, seq - 1, kind, worth);
  };

  /* The assistant's events after a number. When there are none yet, it waits up to ms for one, or until the asker goes. A
     stop lets it go at once; one that comes while stopped waits as usual and hears what the next start tells. */
  async read(assistantId: string, after: number, ms: number, gone: AbortSignal): Promise<AssistantEventView[]> {
    const ear = this.listen(assistantId);
    try {
      const events = await eventsAfter(this.ctx.db, assistantId, after);
      if (events.length || ms === 0) return events;
      const waited = new AbortController();
      await Promise.race([ear.heard, this.pause(ms, AbortSignal.any([gone, waited.signal]))]);
      waited.abort();
      return await eventsAfter(this.ctx.db, assistantId, after);
    } finally {
      ear.close();
    }
  }

  /* Hears the next event of the assistant. It listens before it reads, so an event kept in between is not missed. */
  private listen(assistantId: string): { heard: Promise<void>; close: () => void } {
    const ears = this.ears.get(assistantId) ?? new Set<() => void>();
    this.ears.set(assistantId, ears);
    let hear = () => {};
    const heard = new Promise<void>(done => (hear = done));
    ears.add(hear);
    return {
      heard,
      close: () => {
        ears.delete(hear);
        if (!ears.size) this.ears.delete(assistantId);
      },
    };
  }

  private sweep(): void {
    sweepEvents(this.ctx.db).catch(err => this.ctx.log.warn({ error: loggable(err) }, 'Could not take away the old events of assistants.'));
  }
}
