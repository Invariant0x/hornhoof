import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/* The old build works on while images download, and while a worker that has them waits for its turn to install, so
   neither the pull nor the wait is among these. */
const BUSY_STEPS = new Set<unknown>(['backup', 'install', 'health', 'rollback']);

/* The steps of a restore in which the updater swaps the databases and starts the company on the restored one. */
const RESTORE_STEPS = new Set<unknown>(['load', 'swap', 'start']);

const StatusShape = z.object({ state: z.string(), step: z.unknown().optional() });

/* What a status file of the control folder says, as far as it can be read: null when it cannot, and no state when
   there is no such file. */
function said(dir: string, name: string): z.infer<typeof StatusShape> | { state: null; step?: undefined } | null {
  try {
    const status = StatusShape.safeParse(JSON.parse(readFileSync(join(dir, name), 'utf8')));
    return status.success ? status.data : null;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { state: null } : null;
  }
}

/* Whether an update runs now, in whatever step: the old build works on while images download, and still no server is
   moved under an update. False when the file cannot be read. */
export function updaterRunning(dir: string): boolean {
  return said(dir, 'status.json')?.state === 'running';
}

/* Whether the updater's own status file says an update has the company in maintenance. The file outlives every
   container, so a restart of anything keeps the answer. Null when it cannot be told now: only a person removes the file,
   so a missing one means no update runs, while one that cannot be read or parsed says nothing either way. */
export function updaterBusy(dir: string): boolean | null {
  const [update, restore] = [said(dir, 'status.json'), said(dir, 'restore-status.json')];
  /* A restore has the company in maintenance while the updater swaps the databases. */
  if (restore?.state === 'running' && RESTORE_STEPS.has(restore.step)) return true;
  if (!update) return null;
  return update.state === 'running' && BUSY_STEPS.has(update.step);
}
