import { describe, expect, it } from 'vitest';
import { machineLoad } from '../src/load.js';

const GIB = 1024 ** 3;
const files = (all: Record<string, string>) => (path: string) => all[path] ?? null;

describe("a node's machine load", () => {
  it('counts the memory Linux can give a new program, with the cache it can drop', () => {
    const read = files({ '/proc/meminfo': 'MemTotal:       16777216 kB\nMemFree:         1048576 kB\nMemAvailable:    8388608 kB\n', '/sys/fs/cgroup/memory.max': 'max\n' });
    expect(machineLoad({ read, cpus: 8, load: 2.5 })).toEqual({ cpus: 8, load: 2.5, memFree: 8 * GIB, memTotal: 16 * GIB });
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
    expect(machineLoad({ read: () => null, cpus: 10, load: 1, free: 6 * GIB, total: 32 * GIB })).toEqual({ cpus: 10, load: 1, memFree: 6 * GIB, memTotal: 32 * GIB });
  });

  it('reads this machine without help', () => {
    const now = machineLoad();
    expect(now.cpus).toBeGreaterThanOrEqual(1);
    expect(now.memTotal).toBeGreaterThan(0);
    expect(now.memFree).toBeLessThanOrEqual(now.memTotal);
    expect(now.load).toBeGreaterThanOrEqual(0);
  });
});
