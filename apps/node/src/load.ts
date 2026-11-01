import { readFileSync, statfsSync } from 'node:fs';
import { availableParallelism, cpus as processors, freemem, loadavg, totalmem } from 'node:os';

export type MachineLoad = {
  cpus: number;
  load: number;
  memFree: number;
  memTotal: number;
  cpuModel?: string;
  diskFree?: number;
  diskTotal?: number;
  hostCpus?: number;
  hostMemory?: number;
};

type Disk = { free: number; total: number };

/* Where the numbers come from; tests pass their own. The installer tells a node in a smaller system than its machine,
   Docker's on a Mac, what the machine has: HORNHOOF_HOST_CPU, HORNHOOF_HOST_CPUS and HORNHOOF_HOST_MEMORY. */
type Sources = {
  read?: (path: string) => string | null;
  cpus?: number;
  load?: number;
  free?: number;
  total?: number;
  cpuModel?: string;
  dir?: string;
  disk?: () => Disk | null;
  env?: Record<string, string | undefined>;
};

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

const positive = (text: string | undefined) => (text && /^\d+$/.test(text.trim()) && Number(text) > 0 ? Number(text) : null);

/* The space of the disk a folder is on that a program of this user can still fill. */
const diskOf = (path: string) => (): Disk | null => {
  try {
    const s = statfsSync(path);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
};

/* The machine as a test run meets it: its processors, the load average over the last minute, and the memory a new program
   can get. On Linux that is MemAvailable, which counts the cache the system drops when asked, and a container with a
   memory limit gets at most what is left under it. */
export function machineLoad({
  read = readText,
  cpus = availableParallelism(),
  load = loadavg()[0]!,
  free,
  total,
  cpuModel = processors()[0]?.model ?? '',
  dir = process.cwd(),
  disk = diskOf(dir),
  env = process.env,
}: Sources = {}): MachineLoad {
  const meminfo = read('/proc/meminfo') ?? '';
  let memTotal = kilobytes(meminfo, 'MemTotal') ?? total ?? totalmem();
  let memFree = kilobytes(meminfo, 'MemAvailable') ?? free ?? freemem();
  const limit = bytes(read('/sys/fs/cgroup/memory.max'));
  if (limit !== null && limit < memTotal) {
    memTotal = limit;
    memFree = Math.min(memFree, Math.max(0, limit - (bytes(read('/sys/fs/cgroup/memory.current')) ?? 0)));
  }
  /* Node says "unknown" where the system names no processor, as Linux on arm64 does in Docker on a Mac. */
  const own = /^unknown$/i.test(cpuModel.trim()) ? '' : cpuModel.trim();
  const model = (env.HORNHOOF_HOST_CPU?.trim() || own).slice(0, 200);
  const space = disk();
  const hostCpus = positive(env.HORNHOOF_HOST_CPUS);
  const hostMemory = positive(env.HORNHOOF_HOST_MEMORY);
  return {
    cpus: Math.max(1, cpus),
    load: Math.max(0, Math.round(load * 100) / 100),
    memFree: Math.min(memFree, memTotal),
    memTotal,
    ...(model ? { cpuModel: model } : {}),
    ...(space ? { diskFree: Math.min(space.free, space.total), diskTotal: space.total } : {}),
    ...(hostCpus && hostCpus <= 4096 ? { hostCpus } : {}),
    ...(hostMemory ? { hostMemory } : {}),
  };
}
