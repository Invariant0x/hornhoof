import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/* The old build works on while images download, and while a worker that has them waits for its turn to install, so
   neither the pull nor the wait is among these. */
const BUSY_STEPS = new Set<unknown>(['backup', 'install', 'health', 'rollback']);

const StatusShape = z.object({ state: z.string(), step: z.unknown().optional() });

/* Whether the updater's own status file says an update has the company in maintenance. The file outlives every
   container, so a restart of anything keeps the answer. Null when it cannot be told now: only a person removes the file,
   so a missing one means no update runs, while one that cannot be read or parsed says nothing either way. */
export function updaterBusy(dir: string): boolean | null {
  try {
    const status = StatusShape.safeParse(JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')));
    if (!status.success) return null;
    return status.data.state === 'running' && BUSY_STEPS.has(status.data.step);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? false : null;
  }
}
