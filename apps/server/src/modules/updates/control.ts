import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* What the updater writes about the update it runs or ran last. */
export type UpdaterStatus = {
  id: string;
  version: string;
  state: 'running' | 'done' | 'failed' | 'rolled_back';
  step: 'backup' | 'pull' | 'install' | 'health' | 'rollback' | 'finished';
  log: string;
  at: string;
};

export type UpdaterView = { present: boolean; status: UpdaterStatus | null; waiting: { version: string } | null };

/* What the app asks the updater for: the image tag to install and the version people see. */
export type UpdateRequest = { id: string; version: string; tag: string };

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
    try {
      return JSON.parse(readFileSync(join(this.dir, 'status.json'), 'utf8')) as UpdaterStatus;
    } catch {
      return null;
    }
  }

  /* Written whole and then moved, so the updater never reads half a request. */
  request(input: Omit<UpdateRequest, 'id'>, id: string = randomUUID()): string {
    const file = join(this.dir, 'request.json');
    writeFileSync(`${file}.new`, JSON.stringify({ id, ...input } satisfies UpdateRequest));
    renameSync(`${file}.new`, file);
    return id;
  }
}
