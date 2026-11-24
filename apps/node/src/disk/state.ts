import { DISK_CLEANED_MAX, type DiskPart, type DiskReport } from '@hornhoof/protocol';

const GIB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/* What a node keeps free: for heavy work, a share of its disk, and never less than an amount, so the line follows the disk and
   not the machine it came with; and for a light check of types, style or tests, which needs a few hundred MiB at most, only a
   few GiB, whatever the disk. A light check waits for the larger line of heavy work no more than it needs to. */
export type DiskSettings = { share: number; amount: number; light?: number };
export const DISK_LIGHT = 3 * GIB;
export const DISK_SETTINGS = { share: 0.1, amount: 20 * GIB, light: DISK_LIGHT } satisfies DiskSettings;

export function diskThreshold(total: number, { share, amount }: DiskSettings): number {
  return Math.max(Math.round(share * total), amount);
}

/* What a light check needs free: its own amount, and never more than heavy work needs, so a disk set to keep little free keeps
   it for both. */
export function lightThreshold(total: number, settings: DiskSettings): number {
  return Math.min(settings.light ?? DISK_LIGHT, diskThreshold(total, settings));
}

const whole = (text: string | undefined, max: number): number | null => (text && /^\d+$/.test(text) && Number(text) <= max ? Number(text) : null);

/* The machine's owner may set the share in percent, HORNHOOF_DISK_SHARE, the amount in GiB, HORNHOOF_DISK_GB, and the amount
   a light check needs in GiB, HORNHOOF_DISK_LIGHT_GB. A value that is not a whole number in range keeps the default. */
export function diskSettings(env: Record<string, string | undefined>): typeof DISK_SETTINGS {
  const share = whole(env.HORNHOOF_DISK_SHARE, 90);
  const amount = whole(env.HORNHOOF_DISK_GB, 4096);
  const light = whole(env.HORNHOOF_DISK_LIGHT_GB, 4096);
  return {
    share: share === null ? DISK_SETTINGS.share : share / 100,
    amount: amount === null ? DISK_SETTINGS.amount : amount * GIB,
    light: light === null ? DISK_SETTINGS.light : light * GIB,
  };
}

/* A disk as a cleaning leaves it: what is free on it and what the node needs free there. */
export type DiskRoom = { free: number; threshold: number };

/* How much more than its threshold a disk must have to count as having room again, so it does not go back and forth at the
   line: a node that waited for 20 GiB waits for 22 once it is low. */
export const DISK_REOPEN = 1.1;

/* Whether the node takes no new checks or builds. It is low from the first cleaning after which a disk is still under its
   threshold, the same while it stays so, and has its room back once every disk has a tenth of its threshold to spare, so it
   does not go back and forth at the line. */
export class DiskLow {
  private since: string | null = null;

  after(disks: DiskRoom[], at: Date): DiskReport['low'] {
    if (this.since === null) {
      if (disks.some(d => d.free < d.threshold)) this.since = at.toISOString();
    } else if (disks.every(d => d.free >= d.threshold * DISK_REOPEN)) {
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
