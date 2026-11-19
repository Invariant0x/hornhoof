import { describe, expect, it } from 'vitest';
import { computerKey, latestHost, NO_PARTS } from '../src/modules/testruns/capacity.js';
import { freedom, pickMachine, type Spot } from '../src/modules/testruns/pick.js';

const GIB = 1024 ** 3;
const spot = (key: string, over: Partial<Spot> = {}, load: Partial<NonNullable<Spot['load']>> = {}): Spot => ({
  key,
  lent: true,
  reaches: true,
  busy: false,
  usage: NO_PARTS,
  load: { cpus: 8, load: 4, memFree: 8 * GIB, memTotal: 16 * GIB, tests: 0, jobs: 0, ...load },
  ...over,
});
const NEED = { memoryBytes: 4 * GIB, cores: 1 };

describe('picking a machine for a test run', () => {
  it('keeps an offline legacy place separate from a reported host with the same name', () => {
    const offline = { key: 'shared', load: null };
    const reported = { ...spot('other'), load: { ...spot('other').load!, host: 'shared' } };
    expect(computerKey(offline)).not.toBe(computerKey(reported));
    expect(latestHost(offline, [null])).toBeNull();
  });

  it('does not exceed a container memory limit even on a host with enough memory', () => {
    expect(pickMachine([spot('small-container', {}, { memFree: 2 * GIB, ...{ hostMemFree: 12 * GIB } })], NEED)).toBeNull();
  });

  it('treats zero host load and unknown total memory as reported, without substituting container figures', () => {
    expect(freedom({ cpus: 8, load: 4, memFree: 8 * GIB, memTotal: 16 * GIB, tests: 0, jobs: 0, ...{ hostLoad: 0, hostMemFree: 4 * GIB, hostMemory: 0 } })).toBe(1);
  });

  it('ranks free hosts by their processors and memory instead of their containers', () => {
    const container = spot('container', {}, { load: 0, ...{ hostCpus: 16, hostLoad: 12, hostMemFree: 5 * GIB, hostMemory: 16 * GIB } });
    const mac = spot('mac', {}, { load: 6, ...{ hostCpus: 12, hostLoad: 1, hostMemFree: 12 * GIB, hostMemory: 16 * GIB } });
    expect(pickMachine([container, mac], NEED)?.key).toBe('mac');
  });

  it('takes no part when host memory is short, including zero free bytes', () => {
    for (const hostMemFree of [0, 3 * GIB]) {
      expect(pickMachine([spot('container', {}, { ...{ hostMemFree } })], NEED)).toBeNull();
    }
  });

  it('takes no part on a loaded host, even when its container has idle processors', () => {
    expect(pickMachine([spot('container', {}, { load: 0, ...{ hostCpus: 16, hostLoad: 15.4 } })], NEED)).toBeNull();
  });

  it('takes the one with the most free processor and memory', () => {
    const busy = spot('busy', {}, { load: 7 });
    const free = spot('free', {}, { load: 1, memFree: 12 * GIB });
    const full = spot('full', {}, { load: 1, memFree: 5 * GIB });
    expect(pickMachine([busy, full, free], NEED)?.key).toBe('free');
  });

  it('takes the one running fewer jobs when two are about as free', () => {
    const many = spot('many', {}, { load: 2, jobs: 3 });
    const few = spot('few', {}, { load: 2.2, jobs: 1 });
    expect(pickMachine([many, few], NEED)?.key).toBe('few');
  });

  it('weighs free processors as a share, so a big busy machine can be freer than a small idle one', () => {
    const big = spot('big', {}, { cpus: 32, load: 8, memFree: 16 * GIB, memTotal: 64 * GIB });
    const small = spot('small', {}, { cpus: 2, load: 1.8, memFree: 4.5 * GIB, memTotal: 8 * GIB });
    expect(pickMachine([small, big], NEED)?.key).toBe('big');
  });

  it('leaves out a machine that is not lent, cannot reach the repository, runs a test run, is offline or has too little free memory', () => {
    const left = [
      spot('not-lent', { lent: false }, { load: 0 }),
      spot('elsewhere', { reaches: false }, { load: 0 }),
      spot('running', { busy: true }, { load: 0 }),
      spot('offline', { load: null }),
      spot('small', {}, { load: 0, memFree: 3 * GIB }),
    ];
    expect(pickMachine(left, NEED)).toBeNull();
    expect(pickMachine([...left, spot('fits', {}, { load: 7, memFree: 4 * GIB })], NEED)?.key).toBe('fits');
  });

  it('gives nothing new to a machine with fewer free cores than the part uses', () => {
    expect(pickMachine([spot('loaded', {}, { load: 7.2 })], NEED)).toBeNull();
    expect(pickMachine([spot('big', {}, { cpus: 64, load: 60 })], { ...NEED, cores: 5 })).toBeNull();
    expect(pickMachine([spot('loaded', {}, { load: 7.2 }), spot('busy', {}, { load: 7 })], NEED)?.key).toBe('busy');
  });
});
