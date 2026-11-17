import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { writePrivately } from './machine-keys.js';
import { DAY_MS } from './round-trips.js';

const THROUGHPUT_TICK_MS = 100;
/* A sliding minute of reads. */
const THROUGHPUT_SLOTS = 600;
const THROUGHPUT_MIN_BYTES = 4 * 2 ** 20;
/* In the keeper's folder: each machine's best rate of each hour, for a week. */
const THROUGHPUT_FILE = 'throughput.json';
/* A rate read from what flows anyway says the link is at least that fast, so the best stands for as long as the
   online share looks back: a day of changes trickling to a copy does not replace what making the copy showed. */
const THROUGHPUT_KEEP_MS = 7 * DAY_MS;
const MINUTE_MS = THROUGHPUT_SLOTS * THROUGHPUT_TICK_MS;
const HOUR_MS = 3_600_000;

const Kept = z.record(z.string(), z.record(z.string(), z.object({ mbps: z.number().int().min(0), at: z.string() })));
type Kept = z.infer<typeof Kept>;
type Slot = { bytes: number; ms: number; at: number };

/* How fast the leader's peer server sends to each machine, from what it sends anyway: the copy's stream, a backup, an
   app's answer. No transfer is made to measure. The rate is that of the time the bytes flowed in, never a minute's
   average, and it counts only once a minute held 4 MiB, since less says little of a link. The best of each hour is kept
   for a week, also across a restart. */
export class Throughput {
  private timer: NodeJS.Timeout | undefined;
  private readonly base = new Map<string, number>();
  private readonly slots = new Map<string, Slot[]>();
  private kept: Kept = {};
  private last: number | null = null;

  constructor(private readonly opts: { dir: string; sent: () => ReadonlyMap<string, number>; now?: () => number; tickMs?: number }) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private file(): string {
    return join(this.opts.dir, THROUGHPUT_FILE);
  }

  /* Reads what the week before a restart held; a file of another shape is no file. */
  start(): void {
    try {
      const read = Kept.safeParse(JSON.parse(readFileSync(this.file(), 'utf8')));
      if (read.success) this.kept = read.data;
    } catch {
      /* None yet. */
    }
    this.prune(this.now());
    this.stop();
    this.timer = setInterval(() => this.tick(), this.opts.tickMs ?? THROUGHPUT_TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /* One read of the counts. A machine's first read, or a count lower than its last, as of a new peer server, only says
     where its count stands. */
  tick(): void {
    const now = this.now();
    const ms = this.last === null ? 0 : now - this.last;
    this.last = now;
    let changed = false;
    for (const [machine, count] of this.opts.sent()) {
      const before = this.base.get(machine);
      this.base.set(machine, count);
      if (before === undefined || count < before) continue;
      const slots = this.slots.get(machine) ?? [];
      this.slots.set(machine, slots);
      slots.push({ bytes: count - before, ms, at: now });
      while (slots.length > 0 && slots[0]!.at <= now - MINUTE_MS) slots.shift();
      changed = this.note(machine, slots, now) || changed;
    }
    if (changed) this.save();
  }

  /* The rate of the minute now, when it holds enough, into the best of its hour. Whether that best changed. */
  private note(machine: string, slots: Slot[], now: number): boolean {
    const carried = slots.filter(slot => slot.bytes > 0);
    const bytes = carried.reduce((sum, slot) => sum + slot.bytes, 0);
    const ms = carried.reduce((sum, slot) => sum + slot.ms, 0);
    if (bytes < THROUGHPUT_MIN_BYTES || ms <= 0) return false;
    const mbps = Math.round((bytes * 8) / (ms / 1000) / 1e6);
    const hour = String(Math.floor(now / HOUR_MS) * HOUR_MS);
    const hours = (this.kept[machine] ??= {});
    if ((hours[hour]?.mbps ?? -1) >= mbps) return false;
    hours[hour] = { mbps, at: new Date(now).toISOString() };
    return true;
  }

  private prune(now: number): void {
    for (const [machine, hours] of Object.entries(this.kept)) {
      for (const [hour, best] of Object.entries(hours)) if (Date.parse(best.at) < now - THROUGHPUT_KEEP_MS) delete hours[hour];
      if (Object.keys(hours).length === 0) delete this.kept[machine];
    }
  }

  private save(): void {
    this.prune(this.now());
    try {
      writePrivately(this.file(), JSON.stringify(this.kept));
    } catch {
      /* The week is still held here; the next change writes it. */
    }
  }

  /* Each machine's best rate of the last week, with the moment it was measured. */
  best(now: number): Record<string, { mbps: number; at: string }> {
    this.prune(now);
    return Object.fromEntries(
      Object.entries(this.kept).map(([machine, hours]) => [machine, Object.values(hours).reduce((best, one) => (one.mbps > best.mbps ? one : best))]),
    );
  }
}
