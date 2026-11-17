import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* What the updater writes about the update it runs or ran last. */
export type UpdaterStatus = {
  id: string;
  version: string;
  commit?: string;
  state: 'running' | 'done' | 'failed' | 'rolled_back';
  /* wait: a worker downloaded the build and waits for its turn to install it. promise: the keeper asks the machines
     that keep copies to wait for the update. */
  step: 'backup' | 'pull' | 'promise' | 'wait' | 'install' | 'health' | 'rollback' | 'finished';
  log: string;
  at: string;
  /* How many migrations of the new build the database has not applied; null when that cannot be told. */
  migrations?: number | null;
  /* Going back puts the database of before the update in place again. */
  restore?: boolean;
};

/* What the keeper of the machine that leads answers its updater with, in the control folder, each { id, ok, why? } of
   the update it is about, written whole and then moved: whether the copies promised to wait, whether the dump holds
   everything they confirmed, and that the copies' slots went before a restore. */
export const PROMISED_FILE = 'promised.json';
export const SETTLED_FILE = 'settled.json';
export const DROPPED_FILE = 'slots-dropped.json';

/* A running turn by its agent's name and its task's number. */
export type NamedTurn = { agent: string; task: number | null };
/* An update that waits for the agents: until is when it is called off unless they finished. lost: the turns it does not
   wait for, as their node said nothing of their program for ten minutes. */
export type UpdateWaiting = { version: string; commit?: string; since: string; until: string; turns: NamedTurn[]; lost: NamedTurn[] };
/* An update that went to nobody, with the turns that still ran and until when it waited. deadline: the agents had not
   finished by then. cancelled: a person or the orchestrator called it off. failed: Hornhoof could not go on with it,
   error says why. */
export type UpdateCalledOff = { version: string; commit?: string; at: string; until: string; reason: 'deadline' | 'cancelled' | 'failed'; turns: NamedTurn[]; error?: string };
export type UpdaterView = { present: boolean; status: UpdaterStatus | null; waiting: UpdateWaiting | null; calledOff: UpdateCalledOff | null };

/* What the app asks the updater for: the image tag to install, the digest of the exact build the app read for it, the
   digests of the node and updater images of its commit, empty for one the build does not have, and the version people
   see. */
export type UpdateRequest = { id: string; version: string; commit?: string; tag: string; digest: string; nodeDigest: string; updaterDigest: string; immediate?: boolean; urgent?: boolean };

function controlJson<T>(dir: string, name: string): T | null {
  try { return JSON.parse(readFileSync(join(dir, name), 'utf8')) as T; }
  catch { return null; }
}

/* request.json survives the updater. Match its id so a later request cannot rename an older result. */
function statusWithBuild(dir: string): UpdaterStatus | null {
  const status = controlJson<UpdaterStatus>(dir, 'status.json');
  if (!status) return null;
  const request = controlJson<UpdateRequest>(dir, 'request.json');
  const commit = request?.id === status.id ? request.commit : undefined;
  return { ...status, ...(commit ? { commit } : {}) };
}

/* The updater touches alive every few seconds; older than this, it is not running. */
const ALIVE_MS = 30_000;

/* What holds the updater: an update or a restore. */
type UpdaterWork = 'update' | 'restore';
/* The steps of a restore that are the updater's own: from there its status file says the restore runs. */
const RESTORE_SWAP_STEPS = new Set<unknown>(['load', 'swap', 'start']);

/* The app's side of the control folder it shares with the updater. */
export class UpdaterControl {
  /* What was promised the updater and is not in its hands yet: an update that waits for idle or reads the registry, or
     a restore its keeper still prepares. */
  private held: { kind: UpdaterWork; id: string } | null = null;

  constructor(private readonly dir: string) {}

  /* Restores and updates share one claim on the updater, taken in one step so two asked at once never both go on. It
     claims for this id and answers null; or it answers what holds the updater and changes nothing. An update takes the
     place of an update that still waits, as it always did. */
  claim(kind: UpdaterWork, id: string): UpdaterWork | null {
    const holder = this.holder(kind);
    if (holder) return holder;
    this.held = { kind, id };
    return null;
  }

  /* Frees the claim when it is this id's. */
  free(id: string): void {
    if (this.held?.id === id) this.held = null;
  }

  claimed(): { kind: UpdaterWork; id: string } | null {
    return this.held;
  }

  private holder(asking: UpdaterWork): UpdaterWork | null {
    if (this.held && !(asking === 'update' && this.held.kind === 'update')) return this.held.kind;
    const restore = controlJson<{ state?: unknown; step?: unknown }>(this.dir, 'restore-status.json');
    if (restore?.state === 'running' && RESTORE_SWAP_STEPS.has(restore.step)) return 'restore';
    const status = controlJson<UpdaterStatus>(this.dir, 'status.json');
    if (status?.state === 'running') return 'update';
    /* A request the updater has not taken yet. */
    const waiting = controlJson<UpdateRequest>(this.dir, 'request.json');
    return asking === 'restore' && waiting?.id && waiting.id !== status?.id ? 'update' : null;
  }

  present(): boolean {
    try {
      return Date.now() - statSync(join(this.dir, 'alive')).mtimeMs < ALIVE_MS;
    } catch {
      return false;
    }
  }

  status(): UpdaterStatus | null {
    return statusWithBuild(this.dir);
  }

  /* The id of the request the updater was given last, taken or not. */
  requested(): string | null {
    return controlJson<UpdateRequest>(this.dir, 'request.json')?.id ?? null;
  }

  /* A request is taken back by its id, so one that came after it stays. An updater that waits with it sees that it is
     gone and leaves it. */
  withdraw(id: string): void {
    const file = join(this.dir, 'request.json');
    if (controlJson<UpdateRequest>(this.dir, 'request.json')?.id === id) rmSync(file, { force: true });
  }

  /* Written whole and then moved, so the updater never reads half a request. */
  request(input: Omit<UpdateRequest, 'id'>, id: string = randomUUID()): string {
    const file = join(this.dir, 'request.json');
    writeFileSync(`${file}.new`, JSON.stringify({ id, ...input } satisfies UpdateRequest));
    renameSync(`${file}.new`, file);
    return id;
  }
}
