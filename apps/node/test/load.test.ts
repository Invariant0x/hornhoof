import { describe, expect, it } from 'vitest';
import { machineLoad, programWorkers } from '../src/load.js';

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

  it("reads how many processes the machine's kernel killed for want of memory, and nothing where there is no /proc", () => {
    const read = files({ '/proc/meminfo': 'MemTotal:       16777216 kB\nMemAvailable:    8388608 kB\n', '/proc/vmstat': 'drop_slab 0\noom_kill 26\nnuma_pte_updates 0\n' });
    expect(machineLoad({ read, cpus: 16, load: 2.84 }).oomKills).toBe(26);
    expect(machineLoad({ read: () => null, cpus: 10, load: 1, free: 6 * GIB, total: 32 * GIB }).oomKills).toBeUndefined();
    expect(machineLoad({ read: files({ '/proc/vmstat': 'drop_slab 0\n' }), cpus: 10, load: 1, free: 6 * GIB, total: 32 * GIB }).oomKills).toBeUndefined();
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

  it('identifies the physical host and reports its un-clamped load and memory alongside the container load', () => {
    const base = {
      '/proc/sys/kernel/random/boot_id': 'f5cf03f6-ca13-4dd0-a96c-4214f39198fb\n',
      '/proc/cpuinfo': Array.from({ length: 16 }, (_, i) => `processor\t: ${i}\n`).join('\n'),
      '/proc/meminfo': 'MemTotal:       16777216 kB\nMemAvailable:    8388608 kB\n',
      '/sys/fs/cgroup/memory.max': `${4 * GIB}\n`,
      '/sys/fs/cgroup/memory.current': `${1 * GIB}\n`,
    };
    const first = machineLoad({ read: files(base), cpus: 4, load: 6.25, cpuModel: '', disk: () => null, env: {} });
    const second = machineLoad({ read: files({ ...base, '/sys/fs/cgroup/memory.current': `${2 * GIB}\n` }), cpus: 8, load: 6.25, cpuModel: '', disk: () => null, env: {} });
    const other = machineLoad({ read: files({ ...base, '/proc/sys/kernel/random/boot_id': '11111111-2222-3333-4444-555555555555\n' }), cpus: 4, load: 6.25, cpuModel: '', disk: () => null, env: {} });

    expect(first.host).toMatch(/^[0-9a-f]{64}$/);
    expect(first.host).not.toContain('f5cf03f6');
    expect(second.host).toBe(first.host);
    expect(other.host).not.toBe(first.host);
    expect(first).toEqual({
      cpus: 4,
      load: 6.25,
      memFree: 3 * GIB,
      memTotal: 4 * GIB,
      host: first.host,
      hostCpus: 16,
      hostLoad: 6.25,
      hostMemFree: 8 * GIB,
      hostMemory: 16 * GIB,
    });

    const withoutBootId = machineLoad({ read: files({ ...base, '/proc/sys/kernel/random/boot_id': '   \n' }), cpus: 4, load: 0.5, cpuModel: '', disk: () => null, env: {} });
    expect(withoutBootId).toEqual({ cpus: 4, load: 0.5, memFree: 3 * GIB, memTotal: 4 * GIB });
  });
});

describe("an agent program's share of its machine for tests", () => {
  it('is the share of the processors each program running there gets', () => {
    expect(programWorkers({ cpus: 10, memTotal: 32 * GIB }, 1)).toBe(10);
    expect(programWorkers({ cpus: 10, memTotal: 32 * GIB }, 4)).toBe(2);
  });

  it('holds no more Vitest workers than its share of the memory keeps once the program and Vitest itself have theirs', () => {
    expect(programWorkers({ cpus: 16, memTotal: 12 * GIB }, 2)).toBe(4);
    /* Four programs on a machine of 12.5 GB, as on the one where the system killed a program. */
    expect(programWorkers({ cpus: 10, memTotal: 12.5e9 }, 4)).toBe(1);
  });

  it('is one worker at least', () => {
    expect(programWorkers({ cpus: 4, memTotal: 8 * GIB }, 20)).toBe(1);
    expect(programWorkers({ cpus: 1, memTotal: 0 }, 1)).toBe(1);
  });
});
