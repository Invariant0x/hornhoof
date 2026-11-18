import { createHash } from 'node:crypto';
import { readFileSync, statfsSync } from 'node:fs';
import { availableParallelism, cpus as processors, freemem, loadavg, totalmem } from 'node:os';
import { vitestWorkers, WORKER_BYTES } from './vitest-workers.js';

export type MachineLoad = {
  cpus: number;
  load: number;
  memFree: number;
  memTotal: number;
  cpuModel?: string;
  diskFree?: number;
  diskTotal?: number;
  host?: string;
  hostCpus?: number;
  hostLoad?: number;
  hostMemFree?: number;
  hostMemory?: number;
  /* How many processes the machine's kernel killed for want of memory since it started, where it says. */
  oomKills?: number;
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

const validCpus = (n: number | null) => (n && n <= 4096 ? n : null);

const hostHash = (text: string | null) => {
  const id = text?.trim();
  return id ? createHash('sha256').update(`hornhoof-host:${id}`).digest('hex') : null;
};

const procCpus = (cpuinfo: string | null) => (cpuinfo ? (cpuinfo.match(/^processor\s*:/gm)?.length ?? null) : null);

/* What a container can use of its machine's memory, capped by its cgroup limit when it has one. */
const containerMemory = (read: (path: string) => string | null, rawFree: number, rawTotal: number) => {
  const limit = bytes(read('/sys/fs/cgroup/memory.max'));
  if (limit === null || limit >= rawTotal) return { memFree: Math.min(rawFree, rawTotal), memTotal: rawTotal };
  const current = bytes(read('/sys/fs/cgroup/memory.current')) ?? 0;
  return { memFree: Math.min(rawFree, Math.max(0, limit - current)), memTotal: limit };
};

/* The kernel counts every process it kills for want of memory, the machine's own and a container's over its limit alike. */
const oomKills = (vmstat: string | null) => {
  const count = vmstat ? /^oom_kill (\d+)$/m.exec(vmstat)?.[1] : undefined;
  return count === undefined ? {} : { oomKills: Number(count) };
};

/* Node says "unknown" where the system names no processor, as Linux on arm64 does in Docker on a Mac. */
const processorModel = (cpuModel: string, hostCpu: string | undefined) => {
  const own = /^unknown$/i.test(cpuModel.trim()) ? '' : cpuModel.trim();
  return (hostCpu?.trim() || own).slice(0, 200);
};

/* The physical host and what is free on it across all its containers, when the kernel identifies the host. */
const hostFacts = (
  read: (path: string) => string | null,
  env: Record<string, string | undefined>,
  cpus: number,
  load: number,
  rawFree: number,
  rawTotal: number,
) => {
  const host = hostHash(read('/proc/sys/kernel/random/boot_id'));
  const envCpus = validCpus(positive(env.HORNHOOF_HOST_CPUS));
  const hostMemory = positive(env.HORNHOOF_HOST_MEMORY);
  if (!host) return { ...(envCpus ? { hostCpus: envCpus } : {}), ...(hostMemory ? { hostMemory } : {}) };
  const total = hostMemory ?? rawTotal;
  return {
    host,
    hostCpus: envCpus ?? validCpus(procCpus(read('/proc/cpuinfo'))) ?? cpus,
    hostLoad: load,
    hostMemFree: Math.min(rawFree, total),
    hostMemory: total,
  };
};

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
   memory limit gets at most what is left under it. Linux also counts the processes its kernel killed for want of memory. */
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
  const rawTotal = kilobytes(meminfo, 'MemTotal') ?? total ?? totalmem();
  const rawFree = kilobytes(meminfo, 'MemAvailable') ?? free ?? freemem();
  const model = processorModel(cpuModel, env.HORNHOOF_HOST_CPU);
  const space = disk();
  const cores = Math.max(1, cpus);
  const busy = Math.max(0, Math.round(load * 100) / 100);
  return {
    cpus: cores,
    load: busy,
    ...containerMemory(read, rawFree, rawTotal),
    ...(model ? { cpuModel: model } : {}),
    ...(space ? { diskFree: Math.min(space.free, space.total), diskTotal: space.total } : {}),
    ...hostFacts(read, env, cores, busy, rawFree, rawTotal),
    ...oomKills(read('/proc/vmstat')),
  };
}

/* An agent program with the tools it runs, its helpers inside it, takes up to about a gigabyte. */
export const PROGRAM_BYTES = 2 ** 30;

/* The Vitest workers for the tests of one of the agent programs that run on a machine: what the program's share of the
   processors and of the memory takes, once the program has its own, in workers of a check. Its helpers inherit the number,
   and each of their runs takes as many. */
export function programWorkers({ cpus, memTotal }: Pick<MachineLoad, 'cpus' | 'memTotal'>, programs: number): number {
  const sharing = Math.max(1, programs);
  return vitestWorkers({ cpus: cpus / sharing, freeBytes: memTotal / sharing - PROGRAM_BYTES, workerBytes: WORKER_BYTES.check });
}
