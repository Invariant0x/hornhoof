import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStates, type DiskReport } from '@hornhoof/protocol';
import { suspendCheckSlots } from '../check-queue.js';
import type { JobUser } from '../isolation.js';
import { agentGit } from '../task-copies.js';
import { checkTemp } from './clean.js';
import { workingCopies } from './copies.js';
import { readDockerDisk } from './docker.js';
import { DiskKeeper, type Disk, type LightRoom } from './keeper.js';
import { testLeftovers } from './leftovers.js';
import { recordings } from './recordings.js';
import { DISK_REOPEN, diskSettings } from './state.js';
import { storeDir } from './store.js';

/* How often a node looks after its disk, and how long after it starts it first does. */
export const DISK_PASS_MS = 10 * 60_000;
const FIRST_PASS_MS = 60_000;
/* The keys new checks are held back by, beside the process groups that clean up after a check: DISK_HOLD holds builds, browser
   runs and the like while the disk is under its threshold; FLOOR_HOLD holds every check while it is under what a light check
   needs. */
const DISK_HOLD = 0;
const FLOOR_HOLD = -1;
/* A check that meets a refusal asks the care to look again, but not oftener than this, so a crowd of them reads the disk once. */
export const SETTLE_MS = 30_000;
const GIB = 1024 ** 3;

/* Bytes as GiB with one decimal, without the unit, which the words that use it say once. */
const gib = (bytes: number) => `${Math.round((bytes / GIB) * 10) / 10}`;

/* What a refusal says: the room the machine has and the level the work waits for, which is a tenth above its threshold once it
   is low, and what goes on. Null while it has room. */
function lack(room: { free: number; threshold: number; low: unknown } | null, how: string, work: string, after: string): string | null {
  return room?.low ? `This machine is ${how}: it has ${gib(room.free)} of the ${gib(room.threshold * DISK_REOPEN)} GiB free that ${work} wait for. ${after}` : null;
}

/* Why the node takes no new heavy work now, or null while it has room. */
export const diskReason = (report: DiskReport | null) =>
  lack(report, 'short of disk space', 'builds and browser runs', 'Types, style and test checks are not held by this. Turns go on.');

/* Why the node takes no new check at all now, or null while it has room for a light one. */
export const floorReason = (room: LightRoom | null) =>
  lack(room, 'nearly out of disk space', 'types, style and test checks', 'Nothing new starts until it has room. Turns go on.');

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
  /* The machine's temporary folder, where the test helpers leave what a killed run did not remove. */
  tmp?: string;
  /* The time, and how long after a pass a refused check may ask for another. */
  now?: () => number;
  settleMs?: number;
};

/* The folders of the users that run checks here, and of the node itself, are the ones it takes from the temporary folder. */
function leftovers(tmp: string | undefined, user: JobUser | null, checking: () => boolean) {
  const owners = [process.getuid?.(), user?.uid].filter((uid): uid is number => uid !== undefined);
  return testLeftovers({ tmp: tmp ?? tmpdir(), owners, checking });
}

/* The passes of a care, one at a time: a full pass, which a node makes every ten minutes, and a quick look, which a refused
   check asks for and which a pass of any kind ends for a while. Whoever asks while one is under way gets that one. */
function passes(keeper: DiskKeeper, log: (line: string) => void, now: () => number = Date.now, settleMs: number = SETTLE_MS) {
  const hold = (report: DiskReport | null) => {
    suspendCheckSlots(DISK_HOLD, diskReason(report), true);
    suspendCheckSlots(FLOOR_HOLD, floorReason(keeper.light));
  };
  let running: Promise<void> | null = null, quick = false, endedAt = 0;
  const run = (brief: boolean): Promise<void> => keeper.pass(brief).then(
    report => hold(report),
    (err: unknown) => log(`The disk's care failed this time: ${err instanceof Error ? err.message : String(err)}`),
  );
  const start = (job: Promise<void>): Promise<void> => {
    const next: Promise<void> = job.finally(() => {
      if (running === next) running = null;
      endedAt = now();
    });
    return (running = next);
  };
  return {
    /* A full pass waits for a quick look under way. */
    pass(): Promise<void> {
      if (running && !quick) return running;
      const after = running;
      quick = false;
      return start((after ?? Promise.resolve()).then(() => run(false)));
    },
    settle(): Promise<void> {
      if (running) return running;
      if (now() - endedAt < settleMs) return Promise.resolve();
      quick = true;
      return start(run(true));
    },
  };
}

const readTasks = (file: string): TaskStates | null => {
  try {
    const parsed = TaskStates.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/* A node's care of its disk: a pass soon after it starts and every ten minutes, one at a time. While a pass finds the disk
   still short after cleaning, new heavy work waits, and every check once not even a light one has room, with the reason, and
   turns go on. A check that meets a refusal first asks for a quick look: what the test helpers left in the temporary folder
   goes if nothing holds it, the disk is read again, and the check is refused only if it is still short. The open tasks a turn
   named stay in the node's own folder, so after a restart the finished tasks' copies of an agent with no turn still go. */
export function startDiskCare({ dir, owner, env = process.env, checking, log, disk, everyMs = DISK_PASS_MS, firstMs = FIRST_PASS_MS, tmp, now, settleMs }: Options) {
  const file = join(dir, 'disk-tasks.json');
  let tasks = readTasks(file);
  let keeper: DiskKeeper | null = null;
  keeper = new DiskKeeper({
    disk,
    settings: diskSettings(env),
    cleaners: [
      checkTemp(dir, checking, leftovers(tmp, owner.user, checking)),
      workingCopies({ dir, git: agentGit(join(dir, 'work'), owner), tasks: () => tasks, store: storeDir(dir, owner), owner, aggressive: () => keeper?.low ?? false }),
      recordings(dir),
    ],
    docker: () => readDockerDisk(dir),
    log,
  });
  const activeKeeper = keeper;
  const { pass, settle } = passes(activeKeeper, log, now, settleMs);
  const first = setTimeout(() => void pass(), firstMs);
  const timer = setInterval(() => void pass(), everyMs);
  first.unref();
  timer.unref();
  return {
    pass,
    settle,
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
      suspendCheckSlots(FLOOR_HOLD, null);
    },
  };
}
