import type { LeaseSync, Term } from '../../db/net.js';
import type { LeaseStore } from './lease-store.js';
import { LEASE_MS, leaseValid, nextLeaseStep, type Clocks, type Held, type LeaseStep } from './lease.js';
import type { Mode } from './state.js';
import { reasonOf as messageOf } from './machine-keys.js';

export type LeaseHolderOptions = {
  /* Null: this keeper has no database to hold a lease in, and never leads. */
  lease: LeaseStore | null;
  /* Whether an update has the company in maintenance; null when it cannot be told now. */
  updaterBusy: () => boolean | null;
  now?: () => Clocks;
  pruneEveryMs?: number;
  log: (line: string) => void;
  /* What the sync controller says: the flag a lease is taken and renewed under, none while nothing may be confirmed,
     and whether to renew at all. Without it the machine keeps the data alone, as one that has no copies does. */
  sync?: { flag(): LeaseSync | null; renew(): boolean };
  /* Called when a lease this machine held has ended. */
  onEnd?: () => void;
  /* Whether the keeper hands the server over to another machine now: it ended its lease itself, and while this holds
     none is taken or renewed. */
  hold?: () => boolean;
};

const PRUNE_EVERY_MS = 60_000;
const ENDED = 'the sessions of the app and the agents were ended, and Hornhoof only reads here until it takes a new term';
const clocksNow = (): Clocks => ({ wall: Date.now(), mono: performance.now() });

/* Holds this machine's lease in the database, a tick at a time, and says from it what the app may do: lead only under a
   normal lease that still stands by both clocks and with every fence seen to hold. A call to the database that fails
   changes nothing here, so a lease nobody could renew lapses by itself. */
export class LeaseHolder {
  private held: Held | null = null;
  private last: Clocks | null = null;
  private maintenance = false;
  /* What the last look at the fences found. Null until the first look: nothing is known to hold yet. */
  private problems: string[] | null = null;
  private prunedAt: number | null = null;
  private othersHold = false;
  /* The last line of each kind, so that a trouble that goes on is said once. */
  private readonly said = new Map<string, string>();
  private readonly now: () => Clocks;

  constructor(private readonly opts: LeaseHolderOptions) {
    this.now = opts.now ?? clocksNow;
  }

  mode(): Mode {
    if (this.maintenance) return 'maintenance';
    return this.held?.kind === 'normal' && leaseValid(this.held, this.now()) && this.problems?.length === 0 && this.flag() !== null ? 'lead' : 'read';
  }

  /* The flag a lease stands under now. Alone is untrue while another machine is listed as holding the data, and then
     counts as none: the two could else both lead. */
  private flag(): LeaseSync | null {
    const flag = this.opts.sync ? this.opts.sync.flag() : 'alone';
    return flag === 'alone' && this.othersHold ? null : flag;
  }

  /* The term this machine leads or migrates under, while its lease stands. */
  term(): Term | null {
    return this.held && leaseValid(this.held, this.now()) ? this.held.term : null;
  }

  async tick(): Promise<void> {
    const busy = this.opts.updaterBusy();
    if (busy !== null) this.maintenance = busy;
    const { lease } = this.opts;
    if (!lease) return;
    /* The keeper that hands the server over fenced the lease itself: this one lets go of it, and asks nothing until
       the switch is over. A switch that was called off leaves it to take its next term. */
    if (this.opts.hold?.()) {
      this.held = null;
      this.last = null;
      return;
    }
    const now = this.now();
    const step = nextLeaseStep({ now, last: this.last, held: this.held, maintenance: this.maintenance });
    this.last = now;
    await this.take(lease, step);
    await this.prune(lease, now);
  }

  /* Asks whether another machine holds the company's data. An answer that cannot be had keeps the last one. */
  async guard(): Promise<void> {
    const others = await this.opts.lease?.othersHoldData().catch(() => null);
    if (others === null || others === undefined) return;
    this.othersHold = others;
    this.sayOnce('alone', others ? "Another machine holds the company's data, so this machine does not lead alone." : '');
  }

  /* Looks at every fence. A look that fails keeps what the last one found. */
  async look(): Promise<void> {
    const found = await this.opts.lease?.problems().catch(() => undefined);
    if (found === undefined) return;
    this.problems = found;
    this.sayOnce('fences', found.length ? `Hornhoof does not lead here until this is fixed: ${found.join('; ')}.` : '');
  }

  /* A lease is taken and renewed only under a flag, and renewed only while the sync controller lets it: without either
     it takes none, and the one it holds lapses, so the app reads. */
  private async take(lease: LeaseStore, step: LeaseStep): Promise<void> {
    const flag = this.flag();
    const stopped = flag === null || this.opts.sync?.renew() === false;
    if (step.do === 'take') return stopped ? undefined : this.takeTerm(lease, step, flag);
    if (step.do === 'renew') return stopped ? undefined : this.renew(lease, step, flag);
    if (step.do === 'fence') return this.fence(lease, step.why);
  }

  private async takeTerm(lease: LeaseStore, step: Extract<LeaseStep, { do: 'take' }>, flag: LeaseSync): Promise<void> {
    try {
      const term = await lease.take(step.kind, new Date(step.sent.wall + LEASE_MS), flag);
      this.held = { term, kind: step.kind, sent: step.sent };
      this.sayOnce('take', '');
      this.opts.log(`This machine leads under term ${term.number}.`);
    } catch (err) {
      this.sayOnce('take', `Could not take a lease: ${messageOf(err)}.`);
    }
  }

  private async renew(lease: LeaseStore, step: Extract<LeaseStep, { do: 'renew' }>, flag: LeaseSync): Promise<void> {
    const held = this.held!;
    const renewed = await lease.renew(held.term, step.kind, new Date(step.sent.wall + LEASE_MS), step.endSessions, flag).catch(() => false);
    if (renewed) this.held = { term: held.term, kind: step.kind, sent: step.sent };
  }

  private async fence(lease: LeaseStore, why: string): Promise<void> {
    this.held = null;
    this.opts.log(`The lease ended (${why}): ${ENDED}.`);
    this.opts.onEnd?.();
    /* A fence that cannot be written ends nothing early, and nothing late either: the lease it would end has lapsed. */
    await lease.fence().catch(() => undefined);
  }

  private async prune(lease: LeaseStore, now: Clocks): Promise<void> {
    this.prunedAt ??= now.mono;
    if (this.maintenance || now.mono - this.prunedAt < (this.opts.pruneEveryMs ?? PRUNE_EVERY_MS)) return;
    this.prunedAt = now.mono;
    try {
      await lease.prune();
      this.sayOnce('prune', '');
    } catch (err) {
      this.sayOnce('prune', `Could not prune the journal: ${messageOf(err)}.`);
    }
  }

  /* Says a line when it differs from the last of its kind; an empty line only forgets that one. */
  private sayOnce(kind: string, line: string): void {
    if (this.said.get(kind) === line) return;
    this.said.set(kind, line);
    if (line) this.opts.log(line);
  }
}
