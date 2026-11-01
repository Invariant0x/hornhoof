import { describe, expect, it } from 'vitest';
import { machineLoad } from '../src/load.js';

const GIB = 1024 ** 3;
const files = (all: Record<string, string>) => (path: string) => all[path] ?? null;

describe("a node's machine load", () => {
  it('counts the memory Linux can give a new program, with the cache it can drop', () => {
    const read = files({ '/proc/meminfo': 'MemTotal:       16777216 kB\nMemFree:         1048576 kB\nMemAvailable:    8388608 kB\n', '/sys/fs/cgroup/memory.max': 'max\n' });
    expect(machineLoad({ read, cpus: 8, load: 2.5 })).toMatchObject({ cpus: 8, load: 2.5, memFree: 8 * GIB, memTotal: 16 * GIB });
  });

  it("keeps to the container's memory limit when it has one", () => {
    const read = files({
      '/proc/meminfo': 'MemTotal:       16777216 kB\nMemAvailable:    8388608 kB\n',
      '/sys/fs/cgroup/memory.max': `${4 * GIB}\n`,
      '/sys/fs/cgroup/memory.current': `${1 * GIB}\n`,
    });
    expect(machineLoad({ read, cpus: 4, load: 0.5 })).toMatchObject({ memFree: 3 * GIB, memTotal: 4 * GIB });
  });

  it('takes what the system says is free where there is no /proc', () => {
    expect(machineLoad({ read: () => null, cpus: 10, load: 1, free: 6 * GIB, total: 32 * GIB })).toMatchObject({ cpus: 10, load: 1, memFree: 6 * GIB, memTotal: 32 * GIB });
  });

  it("names the machine's processor, the disk its folder is on, and what the machine has when the node runs in a smaller system", () => {
    const read = files({ '/proc/meminfo': 'MemTotal:       8388608 kB\nMemAvailable:    4194304 kB\n' });
    const disk = () => ({ free: 120 * GIB, total: 460 * GIB });
    const env = { HORNHOOF_HOST_CPU: 'Apple M2 Pro', HORNHOOF_HOST_CPUS: '10', HORNHOOF_HOST_MEMORY: String(32 * GIB) };
    expect(machineLoad({ read, cpus: 4, load: 1, cpuModel: '', disk, env })).toEqual({
      cpus: 4,
      load: 1,
      memFree: 4 * GIB,
      memTotal: 8 * GIB,
      cpuModel: 'Apple M2 Pro',
      diskFree: 120 * GIB,
      diskTotal: 460 * GIB,
      hostCpus: 10,
      hostMemory: 32 * GIB,
    });
  });

  it('names its own processor and leaves out what it cannot tell', () => {
    const load = machineLoad({ read: () => null, cpus: 8, load: 0, free: GIB, total: 2 * GIB, cpuModel: 'AMD EPYC 7B13', disk: () => null, env: { HORNHOOF_HOST_CPUS: 'many' } });
    expect(load).toEqual({ cpus: 8, load: 0, memFree: GIB, memTotal: 2 * GIB, cpuModel: 'AMD EPYC 7B13' });
  });

  it('names no processor when the system calls it unknown, as Linux on arm64 does in Docker on a Mac', () => {
    const load = machineLoad({ read: () => null, cpus: 10, load: 0, free: GIB, total: 2 * GIB, cpuModel: 'unknown', disk: () => null, env: {} });
    expect(load).toEqual({ cpus: 10, load: 0, memFree: GIB, memTotal: 2 * GIB });
    expect(machineLoad({ read: () => null, cpus: 10, cpuModel: 'Unknown CPU', disk: () => null, env: { HORNHOOF_HOST_CPU: 'Apple M5' } }).cpuModel).toBe('Apple M5');
  });

  it('reads this machine without help', () => {
    const now = machineLoad();
    expect(now.cpus).toBeGreaterThanOrEqual(1);
    expect(now.memTotal).toBeGreaterThan(0);
    expect(now.memFree).toBeLessThanOrEqual(now.memTotal);
    expect(now.load).toBeGreaterThanOrEqual(0);
    expect(now.diskTotal).toBeGreaterThan(0);
  });
});
