import { describe, expect, it } from 'vitest';
import { computerState, latestHost, NO_PARTS, Reservations, runBlock } from '../src/modules/testruns/capacity.js';
import { forRun, together } from '../src/modules/testruns/load.js';

const load = (host: string, at = 0, hostLoad = 1) => ({ cpus: 8, load: 0, memFree: 12, memTotal: 16, tests: 0, jobs: 0, host, hostCpus: 16, hostLoad, hostMemFree: 12, hostMemory: 16, at });
const place = (key: string, host: string) => ({ key, load: load(host), busy: false, usage: NO_PARTS });
const need = { memoryBytes: 4, cores: 2 };

describe('host capacity', () => {
  it('keeps the assigned node resources while counting jobs and tests of all machine nodes', () => {
    const own = { ...load('linux', 1), cpus: 4, load: 1, memFree: 2, memTotal: 4, jobs: 3, tests: 2 };
    const sibling = { ...load('linux', 2, 7), cpus: 16, load: 4, memFree: 12, memTotal: 16, jobs: 6, tests: 5 };
    expect(forRun(own, together([own, sibling]))).toMatchObject({ cpus: 4, load: 1, memFree: 2, memTotal: 4, jobs: 9, tests: 7, hostLoad: 7 });
  });

  it('takes no resource report from a sibling when the assigned node has none', () => {
    expect(forRun(null, load('linux'))).toBeNull();
  });

  it('reserves memory and cores across a computer and leaves other computers free', () => {
    const slots = new Reservations();
    const one = place('container', 'linux');
    slots.take(one, { memoryBytes: 9, cores: 3 });
    const sibling = slots.room(place('builtin', 'linux'));
    expect(sibling.usage).toEqual({ parts: 1, memoryBytes: 9, cores: 3 });
    expect(runBlock(sibling, need)).toBe('memory');
    expect(runBlock(slots.room(one), need)).toBe('node');
    expect(runBlock(slots.room(place('mac', 'mac')), need)).toBeNull();
  });

  it('counts a persisted running computer even when its node has not connected', () => {
    const state = computerState(place('two', 'linux'), [{ key: 'one', load: null, computer: 'host:linux', ...need }], []);
    expect(state).toMatchObject({ busy: false, usage: { ...need, parts: 1 } });
  });

  it('keeps an occupied place exclusive even when its host has room for another part', () => {
    const one = place('one', 'linux');
    const state = computerState(one, [{ ...one, ...need }], []);
    expect(runBlock(state, need)).toBe('node');
  });

  it('counts each active part once when both its place and computer match', () => {
    const one = place('one', 'linux');
    const state = computerState(one, [{ ...one, ...need }, { ...place('two', 'linux'), ...need }], []);
    expect(state.usage).toEqual({ parts: 2, memoryBytes: 8, cores: 4 });
  });

  it('keeps older places without a host separate', () => {
    const one = { key: 'one', load: { cpus: 8, load: 0, memFree: 12, memTotal: 16, tests: 0, jobs: 0 }, busy: false, usage: NO_PARTS };
    const two = { ...one, key: 'two' };
    const slots = new Reservations();
    slots.take(one, need);
    expect(slots.room(two).usage).toEqual(NO_PARTS);
    expect(computerState(two, [{ ...one, ...need }], [])).toMatchObject({ busy: false, usage: NO_PARTS });
  });

  it('takes the newest host report, leaving the container figures intact and ignoring another host', () => {
    const one = place('one', 'linux');
    expect(latestHost(one, [load('linux', 10, 6), null, load('linux', 20, 14), load('mac', 30, 0)])).toMatchObject({ cpus: 8, load: 0, hostLoad: 14, hostCpus: 16 });
  });
});
