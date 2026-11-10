import type { Term } from '../../db/net.js';
import type { LeaseStore } from './lease-store.js';
import { LEASE_MS, leaseValid, nextLeaseStep, type Clocks, type Held, type LeaseStep } from './lease.js';
import type { Mode } from './state.js';

export type LeaseHolderOptions = {
  /* Null: this keeper has no database to hold a lease in, and never leads. */
  lease: LeaseStore | null;
  /* Whether an update has the company in maintenance; null when it cannot be told now. */
  updaterBusy: () => boolean | null;
  now?: () => Clocks;
  pruneEveryMs?: number;
  log: (line: string) => void;
};

const PRUNE_EVERY_MS = 60_000;
const ENDED = 'the sessions of the app and the agents were ended, and Hornhoof only reads here until it takes a new term';
const clocksNow = (): Clocks => ({ wall: Date.now(), mono: performance.now() });
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
    return this.held?.kind === 'normal' && leaseValid(this.held, this.now()) && this.problems?.length === 0 ? 'lead' : 'read';
  }

  /* The term this machine leads or migrates under, while its lease stands. */
  term(): Term | null {
    return this.held && leaseValid(this.held, this.now()) ? this.held.term : null;
  }

  async tick(): Promise<void> {
    const busy = this.opts.updaterBusy();
    if (busy !== null) this.maintenance = busy;
    const { lease } = this.opts;
    /* A lease says this machine keeps the data alone: with another data machine listed it takes and renews none, so the
       one it holds lapses and the app reads. */
    if (!lease || this.othersHold) return;
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

  private async take(lease: LeaseStore, step: LeaseStep): Promise<void> {
    if (step.do === 'take') return this.takeTerm(lease, step);
    if (step.do === 'renew') return this.renew(lease, step);
    if (step.do === 'fence') return this.fence(lease, step.why);
  }

  private async takeTerm(lease: LeaseStore, step: Extract<LeaseStep, { do: 'take' }>): Promise<void> {
    try {
      const term = await lease.take(step.kind, new Date(step.sent.wall + LEASE_MS));
      this.held = { term, kind: step.kind, sent: step.sent };
      this.sayOnce('take', '');
      this.opts.log(`This machine leads under term ${term.number}.`);
    } catch (err) {
      this.sayOnce('take', `Could not take a lease: ${messageOf(err)}.`);
    }
  }

  private async renew(lease: LeaseStore, step: Extract<LeaseStep, { do: 'renew' }>): Promise<void> {
    const held = this.held!;
    const renewed = await lease.renew(held.term, step.kind, new Date(step.sent.wall + LEASE_MS), step.endSessions).catch(() => false);
    if (renewed) this.held = { term: held.term, kind: step.kind, sent: step.sent };
  }

  private async fence(lease: LeaseStore, why: string): Promise<void> {
    this.held = null;
    this.opts.log(`The lease ended (${why}): ${ENDED}.`);
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
