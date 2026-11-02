import { describe, expect, it } from 'vitest';
import { computerState, latestHost, Reservations } from '../src/modules/testruns/capacity.js';

const load = (host: string, at = 0, hostLoad = 1) => ({ cpus: 8, load: 0, memFree: 12, memTotal: 16, tests: 0, jobs: 0, host, hostCpus: 16, hostLoad, hostMemFree: 12, hostMemory: 16, at });
const place = (key: string, host: string) => ({ key, load: load(host), busy: false, running: 0 });

describe('host capacity', () => {
  it('reserves the shared computer for its containers and built-in node, leaving another computer free', () => {
    const slots = new Reservations(1);
    const one = place('container', 'linux');
    expect(slots.busy(one)).toBe(false);
    slots.take(one);
    expect(slots.busy(place('builtin', 'linux'))).toBe(true);
    expect(slots.busy(place('mac', 'mac'))).toBe(false);
  });

  it('allows two places with two slots, keeps a place exclusive, and stops at the limit', () => {
    const slots = new Reservations(2);
    const one = place('one', 'linux');
    const two = place('two', 'linux');
    slots.take(one);
    expect(slots.busy(one)).toBe(true);
    expect(slots.busy(two)).toBe(false);
    slots.take(two);
    expect(slots.busy(place('three', 'linux'))).toBe(true);
  });

  it('counts a persisted running computer even when its node has not connected', () => {
    const state = computerState(place('two', 'linux'), [{ key: 'one', load: null, computer: 'host:linux' }], [], 1);
    expect(state).toMatchObject({ busy: true, running: 1 });
    expect(new Reservations(1).busy({ ...place('two', 'linux'), ...state })).toBe(true);
  });

  it('keeps an occupied place exclusive even when its host has room for another part', () => {
    const one = place('one', 'linux');
    const state = computerState(one, [one], [], 2);
    expect(state).toMatchObject({ busy: true, running: 1 });
    expect(new Reservations(2).busy({ ...one, ...state })).toBe(true);
  });

  it('counts each active part once when both its place and computer match', () => {
    const one = place('one', 'linux');
    const state = computerState(one, [one, place('two', 'linux')], [], 3);
    expect(state.running).toBe(2);
  });

  it('keeps older places without a host separate', () => {
    const one = { key: 'one', load: { cpus: 8, load: 0, memFree: 12, memTotal: 16, tests: 0, jobs: 0 }, busy: false, running: 0 };
    const two = { ...one, key: 'two' };
    const slots = new Reservations(1);
    slots.take(one);
    expect(slots.busy(two)).toBe(false);
    expect(computerState(two, [one], [], 1)).toMatchObject({ busy: false, running: 0 });
  });

  it('takes the newest host report, leaving the container figures intact and ignoring another host', () => {
    const one = place('one', 'linux');
    expect(latestHost(one, [load('linux', 10, 6), null, load('linux', 20, 14), load('mac', 30, 0)])).toMatchObject({ cpus: 8, load: 0, hostLoad: 14, hostCpus: 16 });
  });
});
