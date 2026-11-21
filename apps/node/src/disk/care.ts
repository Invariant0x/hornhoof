import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskStates, type DiskReport } from '@hornhoof/protocol';
import { suspendCheckSlots } from '../check-queue.js';
import type { JobUser } from '../isolation.js';
import { agentGit } from '../task-copies.js';
import { checkTemp } from './clean.js';
import { workingCopies } from './copies.js';
import { readDockerDisk } from './docker.js';
import { DiskKeeper, type Disk } from './keeper.js';
import { recordings } from './recordings.js';
import { diskSettings } from './state.js';
import { storeDir } from './store.js';

/* How often a node looks after its disk, and how long after it starts it first does. */
export const DISK_PASS_MS = 10 * 60_000;
const FIRST_PASS_MS = 60_000;
/* The key new checks are held back by while the disk is short, beside the process groups that clean up after a check. */
const DISK_HOLD = 0;
const GB = 1024 ** 3;

const gb = (bytes: number) => `${Math.round((bytes / GB) * 10) / 10} GB`;

/* Why the node takes no new checks or builds now, or null while it has room. */
export function diskReason(report: DiskReport | null): string | null {
  if (!report?.low) return null;
  return `This machine is short of disk space: ${gb(report.free)} free, and it needs ${gb(report.threshold)} for checks and builds. It takes none until it has room again; turns go on.`;
}

type Options = {
  dir: string;
  /* The user the agents' git runs as, and its home. */
  owner: { user: JobUser | null; home: string | null };
  env?: Record<string, string | undefined>;
  /* Whether a check runs on the node now, whose files stay. */
  checking: () => boolean;
  log: (line: string) => void;
  /* The total and free space of the disk the node's folders are on, as its load reads them; null where it cannot. */
  disk: () => Disk | null | Promise<Disk | null>;
  everyMs?: number;
  firstMs?: number;
};

const readTasks = (file: string): TaskStates | null => {
  try {
    const parsed = TaskStates.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/* A node's care of its disk: a pass soon after it starts and every ten minutes, one at a time. While a pass finds the disk
   still short after cleaning, new checks and builds wait, with the reason, and turns go on. The open tasks a turn named stay
   in the node's own folder, so after a restart the finished tasks' copies of an agent with no turn still go. */
export function startDiskCare({ dir, owner, env = process.env, checking, log, disk, everyMs = DISK_PASS_MS, firstMs = FIRST_PASS_MS }: Options) {
  const file = join(dir, 'disk-tasks.json');
  let tasks = readTasks(file);
  let keeper: DiskKeeper | null = null;
  keeper = new DiskKeeper({
    disk,
    settings: diskSettings(env),
    cleaners: [
      checkTemp(dir, checking),
      workingCopies({ dir, git: agentGit(join(dir, 'work'), owner), tasks: () => tasks, store: storeDir(dir, owner), owner, aggressive: () => keeper?.low ?? false }),
      recordings(dir),
    ],
    docker: () => readDockerDisk(dir),
    log,
  });
  const activeKeeper = keeper;
  let running: Promise<void> | null = null;
  const pass = (): Promise<void> =>
    (running ??= activeKeeper
      .pass()
      .then(
        report => suspendCheckSlots(DISK_HOLD, diskReason(report)),
        (err: unknown) => log(`The disk's care failed this time: ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => {
        running = null;
      }));
  const first = setTimeout(() => void pass(), firstMs);
  const timer = setInterval(() => void pass(), everyMs);
  first.unref();
  timer.unref();
  return {
    pass,
    report: (): DiskReport | undefined => activeKeeper.report ?? undefined,
    tasks: () => tasks,
    /* The company's open tasks as a turn names them. */
    noteTasks(next: TaskStates | undefined): void {
      if (!next) return;
      tasks = next;
      try {
        writeFileSync(`${file}.next`, JSON.stringify(next), { mode: 0o600 });
        renameSync(`${file}.next`, file);
      } catch (err) {
        log(`The open tasks could not be kept for the disk's care: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    stop(): void {
      clearTimeout(first);
      clearInterval(timer);
      suspendCheckSlots(DISK_HOLD, null);
    },
  };
}
