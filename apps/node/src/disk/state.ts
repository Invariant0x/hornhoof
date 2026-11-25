import { DISK_CLEANED_MAX, type DiskPart, type DiskReport } from '@hornhoof/protocol';

export const DISK_GB = 1_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/* What a node keeps free for heavy work: a share of its disk, and never less than an amount, so the line follows the disk
   and not the machine it came with. */
export type DiskSettings = { share: number; amount: number };
export const DISK_SETTINGS: DiskSettings = { share: 0.1, amount: 20 * DISK_GB };

export function diskThreshold(total: number, { share, amount }: DiskSettings): number {
  return Math.max(Math.round(share * total), amount);
}

export const diskResume = (threshold: number): number => Math.round(threshold * 1.1);

export function diskRequired(report: Pick<DiskReport, 'free' | 'threshold' | 'low'>): number {
  return report.low && report.free >= report.threshold ? diskResume(report.threshold) : report.threshold;
}

const whole = (text: string | undefined, max: number): number | null => (text && /^\d+$/.test(text) && Number(text) <= max ? Number(text) : null);

/* The machine's owner may set the share in percent, HORNHOOF_DISK_SHARE, and the amount in decimal GB, HORNHOOF_DISK_GB. A value
   that is not a whole number in range keeps the default. */
export function diskSettings(env: Record<string, string | undefined>): DiskSettings {
  const share = whole(env.HORNHOOF_DISK_SHARE, 90);
  const amount = whole(env.HORNHOOF_DISK_GB, 4096);
  return { share: share === null ? DISK_SETTINGS.share : share / 100, amount: amount === null ? DISK_SETTINGS.amount : amount * DISK_GB };
}

/* A disk as a cleaning leaves it: what is free on it and what the node needs free there. */
export type DiskRoom = { free: number; threshold: number };

/* Whether the node takes no new checks or builds. It is low from the first cleaning after which a disk is still under its
   threshold, the same while it stays so, and has its room back once every disk has a tenth of its threshold to spare, so it
   does not go back and forth at the line. */
export class DiskLow {
  private since: string | null = null;

  after(disks: DiskRoom[], at: Date): DiskReport['low'] {
    if (this.since === null) {
      if (disks.some(d => d.free < d.threshold)) this.since = at.toISOString();
    } else if (disks.every(d => d.free >= diskResume(d.threshold))) {
      this.since = null;
    }
    return this.now;
  }

  get now(): DiskReport['low'] {
    return this.since === null ? null : { since: this.since };
  }
}

export type Removal = { part: DiskPart; bytes: number };

/* What the node removed in the last day: one entry for each part of each cleaning, newest first, the newest 50. */
export class DiskCleaned {
  private entries: DiskReport['cleaned'] = [];

  add(removals: Removal[], at: Date): void {
    const byPart = new Map<DiskPart, number>();
    for (const { part, bytes } of removals) byPart.set(part, (byPart.get(part) ?? 0) + bytes);
    const stamp = at.toISOString();
    const pass = [...byPart].filter(([, bytes]) => bytes > 0).map(([part, bytes]) => ({ part, bytes, at: stamp }));
    this.entries = [...pass, ...this.entries].slice(0, DISK_CLEANED_MAX);
  }

  list(now: Date): DiskReport['cleaned'] {
    this.entries = this.entries.filter(e => now.getTime() - Date.parse(e.at) <= DAY_MS);
    return [...this.entries];
  }
}
