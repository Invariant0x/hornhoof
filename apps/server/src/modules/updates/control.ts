import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* What the updater writes about the update it runs or ran last. */
export type UpdaterStatus = {
  id: string;
  version: string;
  commit?: string;
  state: 'running' | 'done' | 'failed' | 'rolled_back';
  step: 'backup' | 'pull' | 'install' | 'health' | 'rollback' | 'finished';
  log: string;
  at: string;
};

export type UpdaterView = { present: boolean; status: UpdaterStatus | null; waiting: { version: string; commit?: string } | null };

/* What the app asks the updater for: the image tag to install, the digest of the exact build the app read for it, the
   digests of the node and updater images of its commit, empty for one the build does not have, and the version people
   see. */
export type UpdateRequest = { id: string; version: string; commit?: string; tag: string; digest: string; nodeDigest: string; updaterDigest: string };

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

/* The app's side of the control folder it shares with the updater. */
export class UpdaterControl {
  constructor(private readonly dir: string) {}

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

  /* Written whole and then moved, so the updater never reads half a request. */
  request(input: Omit<UpdateRequest, 'id'>, id: string = randomUUID()): string {
    const file = join(this.dir, 'request.json');
    writeFileSync(`${file}.new`, JSON.stringify({ id, ...input } satisfies UpdateRequest));
    renameSync(`${file}.new`, file);
    return id;
  }
}
