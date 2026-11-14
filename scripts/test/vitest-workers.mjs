import { availableParallelism, freemem } from 'node:os';

/* Free memory each Vitest worker needs: a fork of the server suites holds a PGlite database, and with less the machine goes
   to swap, where tests end at their limit instead of failing for a reason. */
export const WORKER_MEMORY = 2.5 * 1024 ** 3;

const countIn = value => (/^[1-9]\d*$/.test(value ?? '') ? Number(value) : null);

/* How many Vitest workers a machine takes: one for each WORKER_MEMORY of free memory, never more than its cores and never
   fewer than one. A count named in HH_VITEST_MAX_WORKERS, else in VITEST_MAX_WORKERS, comes first. Free memory is what the
   process may still take, so a container's limit counts. */
export function vitestWorkers({ available = process.availableMemory?.() ?? freemem(), cores = availableParallelism(), env = process.env } = {}) {
  const named = countIn(env.HH_VITEST_MAX_WORKERS) ?? countIn(env.VITEST_MAX_WORKERS);
  if (named !== null) return named;
  return Math.max(1, Math.min(cores, Math.floor(available / WORKER_MEMORY)));
}
