import { DISK_KEPT_MAX, DiskReport } from '@hornhoof/protocol';
import type { Cleaner, Stay } from './clean.js';
import { DiskCleaned, DiskLow, diskThreshold, type DiskSettings, type Removal } from './state.js';

export type Disk = { total: number; free: number };

type Options = {
  /* The total and free space of the disk the node's folders are on; null where it cannot be read. */
  disk: () => Disk | null | Promise<Disk | null>;
  settings: DiskSettings;
  cleaners: Cleaner[];
  now?: () => Date;
  log?: (line: string) => void;
};

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

/* The longest agent id and path the report carries. */
const AGENT_MAX = 64;
const PATH_MAX = 300;

/* What stays, as the report can carry it: a path too long keeps its end, where a person finds the copy, and an entry under a
   folder that is no agent id of Hornhoof's goes. */
function fitted(stay: Stay): Stay | null {
  if (stay.agent.length > AGENT_MAX) return null;
  return stay.path.length > PATH_MAX ? { ...stay, path: `…${stay.path.slice(-(PATH_MAX - 1))}` } : stay;
}

/* A node's care of its disk. Each pass first removes what of Hornhoof's share can come back, part by part, then measures the
   disk and each part, and finds whether the node is low: still under its threshold after the cleaning, so it takes no new
   checks or builds. A part whose cleaning or measuring fails frees nothing and is left out; the others go on. */
export class DiskKeeper {
  private readonly lowState = new DiskLow();
  private readonly removed = new DiskCleaned();
  private last: DiskReport | null = null;

  constructor(private readonly options: Options) {}

  async pass(): Promise<DiskReport | null> {
    const { cleaners, settings, now = () => new Date(), log = () => {} } = this.options;
    const removals: Removal[] = [];
    for (const cleaner of cleaners) {
      try {
        const bytes = await cleaner.clean();
        if (bytes > 0) {
          removals.push({ part: cleaner.part, bytes });
          log(`Removed ${bytes} bytes of ${cleaner.part} that can come back.`);
        }
      } catch (err) {
        log(`Could not clean ${cleaner.part}: ${why(err)}`);
      }
    }
    const at = now();
    this.removed.add(removals, at);
    const disk = await this.options.disk();
    if (!disk) return (this.last = null);
    const parts: DiskReport['parts'] = {};
    for (const cleaner of cleaners) {
      try {
        parts[cleaner.part] = await cleaner.size();
      } catch (err) {
        log(`Could not measure ${cleaner.part}: ${why(err)}`);
      }
    }
    const free = Math.min(disk.free, disk.total), threshold = diskThreshold(disk.total, settings);
    const low = this.lowState.after([{ free, threshold }], at);
    const kept = cleaners
      .flatMap(c => (c.kept?.() ?? []).flatMap(stay => {
        const fit = fitted(stay);
        return fit ? [{ part: c.part, ...fit }] : [];
      }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, DISK_KEPT_MAX);
    const report: DiskReport = { total: disk.total, free, threshold, parts, low, cleaned: this.removed.list(at), kept };
    /* The server drops a report it cannot read whole, and with it low and what went: what stays goes first instead. */
    if (!DiskReport.safeParse(report).success) {
      log('The disk report could not carry what stays; it goes without it.');
      delete report.kept;
    }
    this.last = report;
    return this.last;
  }

  /* What the last pass found, for the node's load report. */
  get report(): DiskReport | null {
    return this.last;
  }

  /* Whether the node takes no new checks or builds now. */
  get low(): boolean {
    return Boolean(this.last?.low);
  }
}
