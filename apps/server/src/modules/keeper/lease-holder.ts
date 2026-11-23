import type { LeaseKind, LeaseSync, Term } from '../../db/net.js';
import type { LeaseStore } from './lease-store.js';
import { lateTickMs, LEASE_MS, leaseValid, nextLeaseStep, type Clocks, type Held, type LeaseStep } from './lease.js';
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
  /* What a lease goes by once another machine holds a copy that finished. needed: whether one does, null while that
     cannot be told yet, and then nothing is taken. proof: when the newest proof was sent. ended: why the lease must
     end now. entry: what lets this keeper take a lease when it holds none, with the term to take. clear: called at
     each take. Without it, and while none is needed, a lease is taken and renewed as on a machine that keeps the data
     alone. */
  proofs?: { needed(): boolean | null; proof(): Clocks | null; ended(): string | null; entry(): { sent: Clocks; term: Term } | null; clear(): void };
  /* The fsync p99 this machine measured of its disk, none before it has one: a tick may come later on a slow disk. */
  fsyncP99?: () => number | null;
  /* Whether no other machine could lead now. A late tick then ends nothing, since no stall here can make two leaders.
     Without it another could, and a late tick ends the lease. */
  sole?: () => boolean;
};

/* What Postgres says when its disk is full. */
const DISK_FULL = '53100';
const isDiskFull = (err: unknown): boolean => {
  const coded = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return coded?.code === DISK_FULL || coded?.cause?.code === DISK_FULL;
};

const PRUNE_EVERY_MS = 60_000;
const ENDED = 'the sessions of the app and the agents were ended, and Hornhoof only reads here until it takes a new term';
const clocksNow = (): Clocks => ({ wall: Date.now(), mono: performance.now() });

/* Holds this machine's lease in the database, a tick at a time, and says from it what the app may do: lead only under a
   normal lease that still stands by both clocks and with every fence seen to hold. A call to the database that fails
   changes nothing here, so a lease nobody could renew lapses by itself. */
export class LeaseHolder {
  private held: Held | null = null;
  /* The last term this keeper held a lease under in this run; none before its first. */
  private termHeld: Term | null = null;
  private last: Clocks | null = null;
  private maintenance = false;
  /* What the last look at the fences found. Null until the first look: nothing is known to hold yet. */
  private problems: string[] | null = null;
  private prunedAt: number | null = null;
  private pruning = false;
  private othersHold = false;
  /* The last write of the lease failed for a full disk. */
  private diskFull = false;
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

  /* The lease that stands now: its term, its kind, and when it ends by the wall clock; none while none stands. */
  standing(): { term: Term; kind: LeaseKind; until: number } | null {
    if (!this.held || !leaseValid(this.held, this.now())) return null;
    return { term: this.held.term, kind: this.held.kind, until: this.held.sent.wall + LEASE_MS };
  }

  /* Whether the last write of the lease failed for a full disk. */
  full(): boolean {
    return this.diskFull;
  }

  /* The term of the last lease this keeper held, standing or not. */
  lastTerm(): Term | null {
    return this.held?.term ?? this.termHeld;
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
    const needed = this.opts.proofs ? this.opts.proofs.needed() : false;
    /* Whether a proof is needed is not known yet: nothing is taken on a guess. */
    if (needed === null && this.held === null) {
      this.last = now;
      return;
    }
    const proofs = needed === false ? null : this.opts.proofs!;
    const step = nextLeaseStep({
      now, last: this.last, held: this.held, maintenance: this.maintenance,
      lateMs: this.lateMs(),
      ...(proofs ? { proof: proofs.proof(), ended: this.held ? proofs.ended() : null, entry: this.held ? undefined : proofs.entry() } : {}),
    });
    this.last = now;
    await this.take(lease, step);
    this.startPrune(lease, now);
  }

  /* How late a tick may come now: without limit where no other machine could lead, else by the disk as measured. */
  private lateMs(): number {
    if (this.opts.sole?.()) return Number.POSITIVE_INFINITY;
    return lateTickMs(this.opts.fsyncP99?.() ?? null);
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
      const term = step.term ? await lease.take(step.kind, new Date(step.sent.wall + LEASE_MS), flag, step.term) : await lease.take(step.kind, new Date(step.sent.wall + LEASE_MS), flag);
      this.held = { term, kind: step.kind, sent: step.sent };
      this.termHeld = term;
      this.diskFull = false;
      /* What was proved before this take proves nothing of the new lease. */
      this.opts.proofs?.clear();
      this.sayOnce('take', '');
      this.opts.log(`This machine leads under term ${term.number}.`);
    } catch (err) {
      this.diskFull = isDiskFull(err);
      this.sayOnce('take', `Could not take a lease: ${messageOf(err)}.`);
    }
  }

  private async renew(lease: LeaseStore, step: Extract<LeaseStep, { do: 'renew' }>, flag: LeaseSync): Promise<void> {
    const held = this.held!;
    const renewed = await lease.renew(held.term, step.kind, new Date(step.sent.wall + LEASE_MS), step.endSessions, flag).catch((err: unknown) => {
      this.diskFull = isDiskFull(err);
      this.sayOnce('renew', `Could not renew the lease: ${messageOf(err)}.`);
      return false;
    });
    if (!renewed) return;
    this.held = { term: held.term, kind: step.kind, sent: step.sent };
    this.diskFull = false;
    this.sayOnce('renew', '');
  }

  private async fence(lease: LeaseStore, why: string): Promise<void> {
    this.held = null;
    this.opts.log(`The lease ended (${why}): ${ENDED}.`);
    this.opts.onEnd?.();
    /* A fence that cannot be written ends nothing early, and nothing late either: the lease it would end has lapsed. */
    await lease.fence().catch((err: unknown) => {
      if (isDiskFull(err)) this.diskFull = true;
    });
  }

  /* Runs journal pruning asynchronously on the background connection so slow pruning never blocks lease ticks. */
  private startPrune(lease: LeaseStore, now: Clocks): void {
    this.prunedAt ??= now.mono;
    if (this.maintenance || this.pruning || now.mono - this.prunedAt < (this.opts.pruneEveryMs ?? PRUNE_EVERY_MS)) return;
    this.prunedAt = now.mono;
    this.pruning = true;
    void lease.prune().then(
      () => this.sayOnce('prune', ''),
      (err: unknown) => this.sayOnce('prune', `Could not prune the journal: ${messageOf(err)}.`),
    ).finally(() => {
      this.pruning = false;
    });
  }

  /* Says a line when it differs from the last of its kind; an empty line only forgets that one. */
  private sayOnce(kind: string, line: string): void {
    if (this.said.get(kind) === line) return;
    this.said.set(kind, line);
    if (line) this.opts.log(line);
  }
}
