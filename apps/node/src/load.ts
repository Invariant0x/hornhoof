import { readFileSync } from 'node:fs';
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os';

export type MachineLoad = { cpus: number; load: number; memFree: number; memTotal: number };

/* Where the numbers come from; tests pass their own. */
type Sources = { read?: (path: string) => string | null; cpus?: number; load?: number; free?: number; total?: number };

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

const kilobytes = (meminfo: string, field: string) => {
  const kb = new RegExp(`^${field}:\\s+(\\d+) kB`, 'm').exec(meminfo)?.[1];
  return kb ? Number(kb) * 1024 : null;
};

const bytes = (text: string | null) => (text && /^\d+\s*$/.test(text) ? Number(text.trim()) : null);

/* The machine as a test run meets it: its processors, the load average over the last minute, and the memory a new program
   can get. On Linux that is MemAvailable, which counts the cache the system drops when asked, and a container with a
   memory limit gets at most what is left under it. */
export function machineLoad({ read = readText, cpus = availableParallelism(), load = loadavg()[0]!, free, total }: Sources = {}): MachineLoad {
  const meminfo = read('/proc/meminfo') ?? '';
  let memTotal = kilobytes(meminfo, 'MemTotal') ?? total ?? totalmem();
  let memFree = kilobytes(meminfo, 'MemAvailable') ?? free ?? freemem();
  const limit = bytes(read('/sys/fs/cgroup/memory.max'));
  if (limit !== null && limit < memTotal) {
    memTotal = limit;
    memFree = Math.min(memFree, Math.max(0, limit - (bytes(read('/sys/fs/cgroup/memory.current')) ?? 0)));
  }
  return { cpus: Math.max(1, cpus), load: Math.max(0, Math.round(load * 100) / 100), memFree: Math.min(memFree, memTotal), memTotal };
}
