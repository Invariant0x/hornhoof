import { describe, expect, it } from 'vitest';
import type { SyncRecord } from '../src/modules/link/relay.js';
import {
  lsnAtLeast,
  nextSyncStep,
  type CopySample,
  type Flag,
  type SyncAction,
  type SyncMemory,
  type SyncSample
} from '../src/modules/keeper/sync-step.js';

/* Literals on purpose: a changed limit must fail these rows. */
const GENERATION = 4;
const W = '0/3000000';

const copy = (name: string, number: number, o: Partial<CopySample> = {}): CopySample => ({
  machine: `m-${name}`,
  networkId: `net-${name}`,
  number,
  name: `copy_${name}_1`,
  finished: true,
  keptPaceMs: 0,
  replyAgeMs: 100,
  confirmed: '0/1000000',
  syncState: 'potential',
  ...o
});

const off = (generation = GENERATION): SyncRecord => ({ state: 'off', copy: null, epoch: 3, generation, at: 1 });
const on = (networkId: string, generation = GENERATION): SyncRecord => ({ state: 'on', copy: networkId, epoch: 3, generation, at: 1 });

const sample = (o: Partial<SyncSample> = {}): SyncSample => ({
  now: 1_000_000,
  others: [],
  listed: 0,
  setting: null,
  route: { client: 'client-a', generation: GENERATION },
  record: null,
  oldestWaitMs: null,
  slowForMs: 0,
  namedBytes5s: 5_000_000,
  ...o
});

const memory = (o: Partial<SyncMemory> = {}): SyncMemory => ({ w: null, posting: false, flag: null, checkpointed: false, blocked: false, ...o });

const first = copy('c1', 2);
const second = copy('c2', 3);
const pacing = (c: CopySample): CopySample => ({ ...c, keptPaceMs: 30_000 });
const named = (c: CopySample) => c.name;

/* One copy named by the setting, with the relay's record at the route's generation. */
const withSetting = (c: CopySample, o: Partial<SyncSample> = {}, others: CopySample[] = [c]): SyncSample =>
  sample({ others, listed: others.length, setting: named(c), record: off(), ...o });

const gives = (s: SyncSample, m: SyncMemory, action: SyncAction, flag: Flag) => {
  const got = nextSyncStep(s, m);
  expect(got.action).toEqual(action);
  expect(got.flag).toBe(flag);
};
const post = (state: 'off' | 'on', copyId?: string): SyncAction =>
  state === 'off' ? { do: 'post', state: 'off' } : { do: 'post', state: 'on', copy: copyId ?? '' };

describe('lsnAtLeast', () => {
  it.each<[string, string, string, boolean]>([
    ['equal', '0/3000000', '0/3000000', true],
    ['one below', '0/2FFFFFF', '0/3000000', false],
    ['one above', '0/3000001', '0/3000000', true],
    ['a higher segment beats a lower offset', '1/0', '0/FFFFFFFF', true],
    ['a lower segment loses to a higher offset', '0/FFFFFFFF', '1/0', false],
    ['letters in either case', '0/a0000000', '0/9FFFFFFF', true],
    ['hex, not decimal', '0/10', '0/9', true]
  ])('%s', (_name, a, b, answer) => {
    expect(lsnAtLeast(a, b)).toBe(answer);
  });
});

describe('nextSyncStep: the table', () => {
  it('posting: none, with the flag it had', () => {
    gives(withSetting(first), memory({ posting: true, flag: 'copy' }), { do: 'none' }, 'copy');
    gives(sample({ listed: 0 }), memory({ posting: true, flag: 'alone' }), { do: 'none' }, 'alone');
  });

  it('listed 0, setting set, off stored: clear, relay_off', () => {
    gives(sample({ setting: 'copy_x_1', record: off() }), memory(), { do: 'clear' }, 'relay_off');
  });

  it('listed 0, setting set, off not stored: post off, copy', () => {
    gives(sample({ setting: 'copy_x_1', record: on('net-x') }), memory(), post('off'), 'copy');
  });

  it('listed 0, record on: post off, alone', () => {
    gives(sample({ record: on('net-gone') }), memory(), post('off'), 'alone');
  });

  it('listed 0: none, alone', () => {
    gives(sample({ record: off() }), memory(), { do: 'none' }, 'alone');
    gives(sample({ record: null }), memory(), { do: 'none' }, 'alone');
  });

  it('setting names no listed copy, off stored: clear, relay_off', () => {
    gives(sample({ others: [first], listed: 1, setting: 'copy_gone_1', record: off() }), memory(), { do: 'clear' }, 'relay_off');
  });

  it('setting names no listed copy, off not stored: post off, copy', () => {
    gives(sample({ others: [first], listed: 1, setting: 'copy_gone_1', record: null }), memory(), post('off'), 'copy');
  });

  it('setting C, C silent, off stored: clear, relay_off', () => {
    gives(withSetting({ ...first, replyAgeMs: null }), memory(), { do: 'clear' }, 'relay_off');
  });

  it('setting C, C silent, off not stored: post off, copy', () => {
    gives(withSetting({ ...first, replyAgeMs: null }, { record: on(first.networkId) }), memory(), post('off'), 'copy');
  });

  it('setting C, a lower-numbered finished copy kept pace 30 s, off stored: clear, relay_off', () => {
    const lower = pacing(copy('c0', 1));
    gives(withSetting(first, {}, [first, lower]), memory(), { do: 'clear' }, 'relay_off');
  });

  it('setting C, a lower-numbered finished copy kept pace 30 s, off not stored: post off, copy', () => {
    const lower = pacing(copy('c0', 1));
    gives(withSetting(first, { record: null }, [first, lower]), memory(), post('off'), 'copy');
  });

  it('a lower-numbered copy that kept pace 29.999 s does not displace C', () => {
    const lower = { ...copy('c0', 1), keptPaceMs: 29_999 };
    gives(withSetting(first, {}, [first, lower]), memory(), { do: 'none' }, 'copy');
  });

  it('a lower-numbered copy that is not finished does not displace C', () => {
    const lower = { ...pacing(copy('c0', 1)), finished: false };
    gives(withSetting(first, {}, [first, lower]), memory(), { do: 'none' }, 'copy');
  });

  it('a higher-numbered copy that kept pace does not displace C', () => {
    gives(withSetting(first, {}, [first, pacing(second)]), memory(), { do: 'none' }, 'copy');
  });

  it('setting C, w null, C is not in sync: none, copy', () => {
    gives(withSetting({ ...first, syncState: 'potential' }), memory(), { do: 'none' }, 'copy');
  });

  it('setting C, w null, C in sync, not checkpointed: checkpoint, copy', () => {
    gives(withSetting({ ...first, syncState: 'sync' }), memory(), { do: 'checkpoint' }, 'copy');
  });

  it('setting C, w null, C in sync, checkpointed: read_w, copy', () => {
    gives(withSetting({ ...first, syncState: 'sync' }), memory({ checkpointed: true }), { do: 'read_w' }, 'copy');
  });

  it('setting C, C confirmed W, on C not stored: post on C, copy', () => {
    const c = { ...first, confirmed: W, syncState: 'sync' };
    gives(withSetting(c), memory({ w: W, checkpointed: true }), post('on', c.networkId), 'copy');
  });

  it('setting C, C behind W: none, copy', () => {
    const c = { ...first, confirmed: '0/2FFFFFF', syncState: 'sync' };
    gives(withSetting(c), memory({ w: W, checkpointed: true }), { do: 'none' }, 'copy');
  });

  it('setting C, C confirmed W, on C stored: none, copy', () => {
    const c = { ...first, confirmed: W, syncState: 'sync' };
    gives(withSetting(c, { record: on(c.networkId) }), memory({ w: W, checkpointed: true }), { do: 'none' }, 'copy');
  });

  it('setting C, the slot has no confirmed position yet: none, copy', () => {
    const c = { ...first, confirmed: null, syncState: 'sync' };
    gives(withSetting(c), memory({ w: W, checkpointed: true }), { do: 'none' }, 'copy');
  });

  it('off stored, a finished copy kept pace 30 s: set it, relay_off', () => {
    const s = sample({ others: [pacing(first)], listed: 1, record: off() });
    gives(s, memory(), { do: 'set', name: first.name }, 'relay_off');
  });

  it('off stored, sets the lowest-numbered of the copies that kept pace', () => {
    const s = sample({ others: [pacing(second), pacing(first)], listed: 2, record: off() });
    gives(s, memory(), { do: 'set', name: first.name }, 'relay_off');
  });

  it('off stored, skips a lower-numbered copy that did not keep pace long enough', () => {
    const slow = { ...copy('c0', 1), keptPaceMs: 29_999 };
    const s = sample({ others: [slow, pacing(second)], listed: 2, record: off() });
    gives(s, memory(), { do: 'set', name: second.name }, 'relay_off');
  });

  it('off stored, a copy that is not finished is not set even when it kept pace', () => {
    const s = sample({ others: [{ ...pacing(first), finished: false }], listed: 1, record: off() });
    gives(s, memory(), { do: 'none' }, 'relay_off');
  });

  it('off stored, no copy at pace: none, relay_off', () => {
    gives(sample({ others: [first], listed: 1, record: off() }), memory(), { do: 'none' }, 'relay_off');
  });

  it('otherwise: post off, no flag', () => {
    gives(sample({ others: [first], listed: 1, record: null }), memory(), post('off'), null);
    gives(sample({ others: [first], listed: 1, record: on('net-x') }), memory(), post('off'), null);
  });

  it('off stored at an older generation is not stored: post off, no flag', () => {
    gives(sample({ others: [first], listed: 1, record: off(3) }), memory(), post('off'), null);
  });

  it('with no route, off is not stored', () => {
    gives(sample({ others: [first], listed: 1, record: off(), route: null }), memory(), post('off'), null);
  });
});

describe('nextSyncStep: the rules around the table', () => {
  it('never clears before off is stored', () => {
    const records = [on('net-c1', GENERATION), on('net-c1', GENERATION + 1), on('net-other', GENERATION), off(GENERATION - 1), off(GENERATION + 1), null];
    const silent = { ...first, replyAgeMs: null };
    for (const record of records)
      for (const listed of [0, 1]) {
        const s = withSetting(silent, { record, listed, others: listed === 0 ? [] : [silent] });
        expect(nextSyncStep(s, memory()).action.do).not.toBe('clear');
      }
  });

  it('posts on only past W', () => {
    const base = { ...first, syncState: 'sync' };
    const m = memory({ w: W, checkpointed: true });
    expect(nextSyncStep(withSetting({ ...base, confirmed: '0/2FFFFFF' }), m).action).toEqual({ do: 'none' });
    expect(nextSyncStep(withSetting({ ...base, confirmed: '0/3000000' }), m).action).toEqual(post('on', base.networkId));
  });

  it('posts again at a new generation', () => {
    const c = { ...first, confirmed: W, syncState: 'sync' };
    const s = withSetting(c, { record: on(c.networkId, 4), route: { client: 'client-a', generation: 5 } });
    gives(s, memory({ w: W, checkpointed: true }), post('on', c.networkId), 'copy');
  });

  it('takes no flag without the relay', () => {
    const s = sample({ others: [first], listed: 1, record: off(3), route: { client: 'client-a', generation: 4 } });
    gives(s, memory(), post('off'), null);
  });

  it('stays alone when the last copy goes', () => {
    gives(sample({ listed: 0, record: on('net-left') }), memory(), post('off'), 'alone');
  });

  it('drops a silent copy', () => {
    const drops = (o: Partial<CopySample>, extra: Partial<SyncSample>, action: SyncAction) => {
      const s = withSetting({ ...first, ...o }, { record: on(first.networkId), ...extra });
      expect(nextSyncStep(s, memory()).action).toEqual(action);
    };
    drops({ replyAgeMs: 2001 }, {}, post('off'));
    drops({ replyAgeMs: null }, {}, post('off'));
    drops({ replyAgeMs: 2000 }, {}, { do: 'none' });
    drops({}, { slowForMs: 5000, namedBytes5s: 900_000 }, post('off'));
    drops({}, { slowForMs: 5000, namedBytes5s: 1_048_575 }, post('off'));
    drops({}, { slowForMs: 5000, namedBytes5s: 2_000_000 }, { do: 'none' });
    drops({}, { slowForMs: 5000, namedBytes5s: 1_048_576 }, { do: 'none' });
    drops({}, { slowForMs: 4999, namedBytes5s: 0 }, { do: 'none' });
  });

  it('waits for the setting to hold', () => {
    const s = (syncState: string) => withSetting({ ...first, syncState });
    expect(nextSyncStep(s('potential'), memory()).action).toEqual({ do: 'none' });
    expect(nextSyncStep(s('sync'), memory()).action).toEqual({ do: 'checkpoint' });
    expect(nextSyncStep(s('sync'), memory({ checkpointed: true })).action).toEqual({ do: 'read_w' });
  });

  it('forgets w and the checkpoint after a set or a clear', () => {
    const staying = memory({ w: W, checkpointed: true, flag: 'copy' });
    const setting = nextSyncStep(sample({ others: [pacing(first)], listed: 1, record: off() }), staying);
    expect(setting.memory).toMatchObject({ w: null, checkpointed: false, flag: 'relay_off' });
    const clearing = nextSyncStep(withSetting({ ...first, replyAgeMs: null }), staying);
    expect(clearing.memory).toMatchObject({ w: null, checkpointed: false, flag: 'relay_off' });
  });

  it('keeps w and the checkpoint through every other action', () => {
    const staying = memory({ w: W, checkpointed: true });
    const c = { ...first, confirmed: W, syncState: 'sync' };
    expect(nextSyncStep(withSetting(c), staying).memory).toMatchObject({ w: W, checkpointed: true, flag: 'copy' });
    expect(nextSyncStep(sample({ others: [first], listed: 1 }), staying).memory).toMatchObject({ w: W, checkpointed: true, flag: null });
  });

  it('marks a post as in flight and nothing else', () => {
    expect(nextSyncStep(sample({ others: [first], listed: 1 }), memory()).memory.posting).toBe(true);
    expect(nextSyncStep(sample({ others: [first], listed: 1, record: off() }), memory()).memory.posting).toBe(false);
  });

  it('never clears an empty setting', () => {
    const stored = sample({ others: [], listed: 1, setting: null, record: off() });
    gives(stored, memory(), { do: 'none' }, 'relay_off');
    const unstored = sample({ others: [], listed: 1, setting: null, record: on('net-x') });
    gives(unstored, memory(), post('off'), null);
  });
});

describe('nextSyncStep: when renewing stops', () => {
  const silent = { ...first, replyAgeMs: null };
  const stuck = (o: Partial<SyncSample> = {}, m: Partial<SyncMemory> = {}) =>
    nextSyncStep(withSetting(silent, { record: on(first.networkId), oldestWaitMs: 10_000, ...o }), memory(m));

  it('stops renewing when sync cannot be cleared', () => {
    const got = stuck();
    expect(got.renew).toBe(false);
    expect(got.memory.blocked).toBe(true);
  });

  it('keeps renewing while the oldest wait is under 10 s', () => {
    expect(stuck({ oldestWaitMs: 9999 }).renew).toBe(true);
  });

  it('keeps renewing when nothing waits', () => {
    expect(stuck({ oldestWaitMs: null }).renew).toBe(true);
  });

  it('keeps renewing once off is stored', () => {
    expect(stuck({ record: off() }).renew).toBe(true);
  });

  it('keeps renewing while the copy keeps receiving, silent by its bytes or not', () => {
    const live = withSetting(first, { record: on(first.networkId), oldestWaitMs: 60_000 });
    expect(nextSyncStep(live, memory()).renew).toBe(true);
  });

  it('stops renewing when the setting names a copy that is not listed', () => {
    const s = sample({ others: [second], listed: 1, setting: 'copy_gone_1', record: on('net-gone'), oldestWaitMs: 10_000 });
    expect(nextSyncStep(s, memory()).renew).toBe(false);
  });

  it('does not stop for a wait with no setting', () => {
    const s = sample({ others: [first], listed: 1, record: on('net-x'), oldestWaitMs: 60_000 });
    expect(nextSyncStep(s, memory()).renew).toBe(true);
  });

  it('stays stopped until the copy answers', () => {
    const blocked = { blocked: true };
    expect(stuck({ oldestWaitMs: null }, blocked).renew).toBe(false);
    const answering = withSetting(first, { record: on(first.networkId), oldestWaitMs: null });
    expect(nextSyncStep(answering, memory(blocked)).renew).toBe(true);
    expect(stuck({ oldestWaitMs: null, record: off() }, blocked).renew).toBe(true);
  });

  it('stays stopped while the named copy is not listed', () => {
    const s = sample({ others: [second], listed: 1, setting: 'copy_gone_1', record: on('net-gone') });
    expect(nextSyncStep(s, memory({ blocked: true })).renew).toBe(false);
  });

  it('is not blocked by memory alone when nothing is wrong', () => {
    expect(nextSyncStep(sample({ others: [first], listed: 1, record: off() }), memory()).renew).toBe(true);
  });
});
