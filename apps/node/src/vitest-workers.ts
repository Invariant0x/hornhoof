/* How many Vitest workers the product's tests take, wherever they are sized: a part of a test run on a node, an agent program's
   share of its machine, and the product run's own config where nothing named them. One calculation; what differs between those
   places is the share of the machine each gives it. */

import { TEST_WORKER_BYTES, vitestMemoryWorkers } from '@hornhoof/protocol';

const GIB = 2 ** 30;

/* What one worker takes, by how it runs. A part of a test run runs whole suites in forks that live long, and a fork of the
   server's tests with its PGlite database grew to about 2.5 GiB: with one per core, a machine of 16 cores and 7 GB free went to
   swap and tests ended at their limit. A check of an agent runs the few files it names, where a worker took about a gigabyte. */
export const WORKER_BYTES = { part: TEST_WORKER_BYTES, check: GIB } as const;

/* A share of a machine: the processors and the memory its tests may take, and what each of their workers takes. */
export type Share = { cpus: number; freeBytes: number; workerBytes: number };

/* As many workers as the processors of the share run and its memory holds once Vitest has its own, and at least one, for tests
   must run. */
export function vitestWorkers({ cpus, freeBytes, workerBytes }: Share): number {
  return Math.max(1, Math.min(Math.floor(cpus), vitestMemoryWorkers(freeBytes, workerBytes)));
}

/* A part's share: the processors the machine's load leaves free, one of them left for Vitest itself, and its free memory. */
export function partShare({ cpus, load, memFree }: { cpus: number; load: number; memFree: number }): Share {
  return { cpus: Math.min(cpus - 1, cpus - load), freeBytes: memFree, workerBytes: WORKER_BYTES.part };
}

const countIn = (value: string | undefined): number | null => (/^[1-9]\d*$/.test(value ?? '') ? Number(value) : null);

/* A count of workers the machine names, which comes before any share: HH_VITEST_MAX_WORKERS, else VITEST_MAX_WORKERS, a whole
   number above zero. None by anything else. */
export function namedWorkers(env: Record<string, string | undefined>): number | null {
  return countIn(env.HH_VITEST_MAX_WORKERS) ?? countIn(env.VITEST_MAX_WORKERS);
}
