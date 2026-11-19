const GIB = 2 ** 30;

/* A long-running Vitest worker for a product part, and Vitest itself before it starts the workers. */
export const TEST_WORKER_BYTES = 2.5 * GIB;
const VITEST_BYTES = GIB;

export function vitestMemoryWorkers(freeBytes: number, workerBytes = TEST_WORKER_BYTES): number {
  return Math.max(1, Math.floor((freeBytes - VITEST_BYTES) / workerBytes));
}
