import { describe, expect, it } from 'vitest';
import { pickMachine, type Spot } from '../src/modules/testruns/pick.js';

const GIB = 1024 ** 3;
const spot = (key: string, over: Partial<Spot> = {}, load: Partial<NonNullable<Spot['load']>> = {}): Spot => ({
  key,
  lent: true,
  reaches: true,
  busy: false,
  load: { cpus: 8, load: 4, memFree: 8 * GIB, memTotal: 16 * GIB, tests: 0, jobs: 0, ...load },
  ...over,
});
const NEED = 4 * GIB;

describe('picking a machine for a test run', () => {
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
    expect(pickMachine([...left, spot('fits', {}, { load: 7.5, memFree: 4 * GIB })], NEED)?.key).toBe('fits');
  });
});
