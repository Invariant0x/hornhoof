import { describe, expect, it } from 'vitest';
import type { SyncRecord } from '../src/modules/link/relay.js';
import { lsnAtLeast, nextSyncStep, PACE_FOR_MS, SAMPLE_EVERY_MS, SILENT_REPLY_MS, SLOW_BYTES, SLOW_FOR_MS, STOP_RENEW_MS, type CopySample, type SyncMemory, type SyncSample } from '../src/modules/keeper/sync-step.js';

const GENERATION = 5;
const ROUTE = { client: 'acme-ab12cd34-link', generation: GENERATION };
const C_ID = 'c0c0c0c0'.repeat(8);
const D_ID = 'd0d0d0d0'.repeat(8);
const OFF: SyncRecord = { state: 'off', copy: null, epoch: 7, generation: GENERATION, at: 100 };
const ON_C: SyncRecord = { state: 'on', copy: C_ID, epoch: 7, generation: GENERATION, at: 100 };

/* A copy that holds every table, answers, keeps pace and is where the leader was a moment ago. */
const copy = (over: Partial<CopySample> = {}): CopySample => ({
  machine: 'c', networkId: C_ID, number: 2, name: 'copy_c0c0c0c0c0c0c0c0_1', finished: true, keptPaceMs: PACE_FOR_MS, replyAgeMs: 200, confirmed: '0/3000000', syncState: 'sync', ...over,
});
const C = copy();
const D = copy({ machine: 'd', networkId: D_ID, number: 3, name: 'copy_d0d0d0d0d0d0d0d0_1' });
const sample = (over: Partial<SyncSample> = {}): SyncSample => ({ now: 0, others: [C], listed: 1, setting: null, route: ROUTE, record: OFF, oldestWaitMs: null, slowForMs: 0, namedBytes5s: 0, target: null, hold: false, ...over });
const memory = (over: Partial<SyncMemory> = {}): SyncMemory => ({ w: null, posting: false, flag: null, checkpointed: false, blocked: false, ...over });
const step = (s: Partial<SyncSample> = {}, m: Partial<SyncMemory> = {}) => nextSyncStep(sample(s), memory(m));
const said = (s: Partial<SyncSample> = {}, m: Partial<SyncMemory> = {}) => {
  const { action, flag, renew } = step(s, m);
  return { action, flag, renew };
};
const POST_OFF = { do: 'post', state: 'off' };
const NONE = { do: 'none' };
const CLEAR = { do: 'clear' };
const older = { ...OFF, generation: GENERATION - 1 };

describe('the next step of the sync controller', () => {
  it('compares positions in the log as numbers', () => {
    expect(lsnAtLeast('0/3000000', '0/3000000')).toBe(true);
    expect(lsnAtLeast('0/2FFFFFF', '0/3000000')).toBe(false);
    expect(lsnAtLeast('1/0', '0/FFFFFFFF')).toBe(true);
    expect(lsnAtLeast('A/10', '9/FFFFFFFF')).toBe(true);
    expect(SAMPLE_EVERY_MS).toBe(250);
  });

  it('does nothing while an answer of the relay is on its way', () => {
    expect(said({ setting: C.name, record: older }, { posting: true, flag: 'copy' })).toEqual({ action: NONE, flag: 'copy', renew: true });
    expect(said({ listed: 0, others: [] }, { posting: true, flag: null })).toEqual({ action: NONE, flag: null, renew: true });
  });

  it('with no other data machine: clears a setting once off is stored', () => {
    expect(said({ listed: 0, others: [], setting: C.name, record: OFF })).toEqual({ action: CLEAR, flag: 'relay_off', renew: true });
  });

  it('with no other data machine: posts off while a setting stands', () => {
    expect(said({ listed: 0, others: [], setting: C.name, record: ON_C })).toEqual({ action: POST_OFF, flag: 'copy', renew: true });
  });

  it('stays alone when the last copy goes', () => {
    expect(said({ listed: 0, others: [], record: ON_C })).toEqual({ action: POST_OFF, flag: 'alone', renew: true });
  });

  it('with no other data machine and nothing to undo: leads alone', () => {
    expect(said({ listed: 0, others: [], record: OFF })).toEqual({ action: NONE, flag: 'alone', renew: true });
    expect(said({ listed: 0, others: [], record: null, route: null })).toEqual({ action: NONE, flag: 'alone', renew: true });
  });

  it('a setting that names no listed copy: clears once off is stored, posts off before', () => {
    expect(said({ setting: 'copy_eeeeeeeeeeeeeeee_1', record: OFF })).toEqual({ action: CLEAR, flag: 'relay_off', renew: true });
    expect(said({ setting: 'copy_eeeeeeeeeeeeeeee_1', record: ON_C })).toEqual({ action: POST_OFF, flag: 'copy', renew: true });
    /* The copy is listed, and has not named this copy yet. */
    expect(said({ others: [], setting: C.name, record: ON_C })).toEqual({ action: POST_OFF, flag: 'copy', renew: true });
  });

  it('drops a silent copy', () => {
    const quiet = (over: Partial<CopySample>, more: Partial<SyncSample> = {}) => said({ others: [copy(over)], setting: C.name, record: ON_C, ...more }, { w: '0/3000000' }).action;
    expect(quiet({ replyAgeMs: SILENT_REPLY_MS + 1 })).toEqual(POST_OFF);
    expect(quiet({ replyAgeMs: SILENT_REPLY_MS })).toEqual(NONE);
    expect(quiet({ replyAgeMs: null })).toEqual(POST_OFF);
    /* It answers, and commits wait on it all the same while almost nothing reaches it. */
    expect(quiet({}, { slowForMs: SLOW_FOR_MS, namedBytes5s: 900_000 })).toEqual(POST_OFF);
    expect(quiet({}, { slowForMs: SLOW_FOR_MS, namedBytes5s: 2_000_000 })).toEqual(NONE);
    expect(quiet({}, { slowForMs: SLOW_FOR_MS - 1, namedBytes5s: 0 })).toEqual(NONE);
    expect(SLOW_BYTES).toBe(1_048_576);
    /* Once the relay knows, the setting goes. */
    expect(said({ others: [copy({ replyAgeMs: null })], setting: C.name, record: OFF })).toEqual({ action: CLEAR, flag: 'relay_off', renew: true });
  });

  it('gives the place to a lower-numbered copy that kept pace', () => {
    const lower = copy({ machine: 'b', networkId: 'b0b0b0b0'.repeat(8), number: 1 + 1, name: 'copy_b0b0b0b0b0b0b0b0_1' });
    const named = { ...D };
    expect(said({ others: [lower, named], listed: 2, setting: named.name, record: { ...ON_C, copy: D_ID } }, { w: '0/1' })).toEqual({ action: POST_OFF, flag: 'copy', renew: true });
    expect(said({ others: [lower, named], listed: 2, setting: named.name, record: OFF }, { w: '0/1' })).toEqual({ action: CLEAR, flag: 'relay_off', renew: true });
    /* One that has not kept pace long enough, or holds not every table yet, takes nobody's place. */
    for (const not of [{ keptPaceMs: PACE_FOR_MS - 1 }, { finished: false }]) {
      expect(said({ others: [{ ...lower, ...not }, named], listed: 2, setting: named.name, record: { ...ON_C, copy: D_ID } }, { w: '0/1' }).action).toEqual(NONE);
    }
  });

  it('waits for the setting to hold', () => {
    expect(said({ others: [copy({ syncState: 'potential' })], setting: C.name, record: OFF })).toEqual({ action: NONE, flag: 'copy', renew: true });
    expect(said({ setting: C.name, record: OFF })).toEqual({ action: { do: 'checkpoint' }, flag: 'copy', renew: true });
    expect(said({ setting: C.name, record: OFF }, { checkpointed: true })).toEqual({ action: { do: 'read_w' }, flag: 'copy', renew: true });
    /* A new setting, or none, starts the barrier over. */
    expect(step({ record: OFF }, { w: '0/5', checkpointed: true }).memory).toMatchObject({ w: null, checkpointed: false });
    expect(step({ listed: 0, others: [], setting: C.name, record: OFF }, { w: '0/5', checkpointed: true }).memory).toMatchObject({ w: null, checkpointed: false });
    expect(step({ setting: C.name, record: OFF }, { w: '0/5', checkpointed: true }).memory).toMatchObject({ w: '0/5', checkpointed: true });
  });

  it('posts on only past W', () => {
    const at = (confirmed: string | null) => said({ others: [copy({ confirmed })], setting: C.name, record: OFF }, { w: '0/3000000', checkpointed: true }).action;
    expect(at('0/2FFFFFF')).toEqual(NONE);
    expect(at(null)).toEqual(NONE);
    expect(at('0/3000000')).toEqual({ do: 'post', state: 'on', copy: C_ID });
  });

  it('holds once on is stored, and posts again at a new generation', () => {
    expect(said({ setting: C.name, record: ON_C }, { w: '0/3000000', checkpointed: true })).toEqual({ action: NONE, flag: 'copy', renew: true });
    expect(said({ setting: C.name, record: { ...ON_C, generation: 4 } }, { w: '0/3000000', checkpointed: true })).toEqual({ action: { do: 'post', state: 'on', copy: C_ID }, flag: 'copy', renew: true });
    /* On is stored for another copy than the one the setting names. */
    expect(said({ setting: C.name, record: { ...ON_C, copy: D_ID } }, { w: '0/3000000', checkpointed: true }).action).toEqual({ do: 'post', state: 'on', copy: C_ID });
  });

  it('names the lowest-numbered copy that kept pace, once off is stored', () => {
    expect(said({ others: [D, C], listed: 2, record: OFF })).toEqual({ action: { do: 'set', name: C.name }, flag: 'relay_off', renew: true });
    expect(said({ others: [copy({ keptPaceMs: PACE_FOR_MS - 1 })], record: OFF })).toEqual({ action: NONE, flag: 'relay_off', renew: true });
    expect(said({ others: [copy({ finished: false })], record: OFF })).toEqual({ action: NONE, flag: 'relay_off', renew: true });
  });

  it("drops the named copy for the move's target once the target kept pace", () => {
    /* C (2) is named, and the server is to move to D (3). */
    const moving = { others: [C, D], listed: 2, setting: C.name, target: D_ID };
    expect(said({ ...moving, record: OFF }, { w: '0/1' })).toEqual({ action: CLEAR, flag: 'relay_off', renew: true });
    expect(said({ ...moving, record: ON_C }, { w: '0/1' })).toEqual({ action: POST_OFF, flag: 'copy', renew: true });
    /* A target that has not kept pace long enough, or holds not every table yet, takes nobody's place. */
    for (const not of [{ keptPaceMs: PACE_FOR_MS - 1 }, { finished: false }]) {
      expect(said({ ...moving, others: [C, { ...D, ...not }], record: ON_C }, { w: '0/1' }).action).toEqual(NONE);
    }
    /* A target that is not among the copies changes nothing. */
    expect(said({ ...moving, target: 'e0e0e0e0'.repeat(8), record: ON_C }, { w: '0/1' }).action).toEqual(NONE);
  });

  it("names the move's target over a lower number", () => {
    expect(said({ others: [C, D], listed: 2, record: OFF, target: D_ID })).toEqual({ action: { do: 'set', name: D.name }, flag: 'relay_off', renew: true });
    /* Until the target kept pace, the lowest-numbered copy that did is named, as with no move. */
    expect(said({ others: [C, { ...D, keptPaceMs: PACE_FOR_MS - 1 }], listed: 2, record: OFF, target: D_ID }).action).toEqual({ do: 'set', name: C.name });
  });

  it("keeps the move's target named while a lower number keeps pace", () => {
    const named = { others: [C, D], listed: 2, setting: D.name, record: { ...ON_C, copy: D_ID } };
    expect(said({ ...named, target: D_ID }, { w: '0/1' }).action).toEqual(NONE);
    /* With the request gone, the lower number takes the place again. */
    expect(said(named, { w: '0/1' }).action).toEqual(POST_OFF);
  });

  it('hold: clears the setting once off is stored', () => {
    expect(said({ hold: true, setting: C.name, record: OFF }, { w: '0/1' })).toEqual({ action: CLEAR, flag: 'relay_off', renew: true });
  });

  it('hold: posts off while the setting stands', () => {
    expect(said({ hold: true, setting: C.name, record: ON_C }, { w: '0/1' })).toEqual({ action: POST_OFF, flag: 'copy', renew: true });
  });

  it('hold: posts off when no setting stands and the relay does not say off yet', () => {
    expect(said({ hold: true, record: ON_C })).toEqual({ action: POST_OFF, flag: null, renew: true });
    expect(said({ hold: true, record: older })).toEqual({ action: POST_OFF, flag: null, renew: true });
  });

  it('holds sync off', () => {
    /* A copy keeps pace, and still none is named while migrations run. */
    expect(said({ hold: true, record: OFF })).toEqual({ action: NONE, flag: 'relay_off', renew: true });
    expect(said({ hold: false, record: OFF })).toEqual({ action: { do: 'set', name: C.name }, flag: 'relay_off', renew: true });
    /* While an answer of the relay is on its way nothing is done, held or not. */
    expect(said({ hold: true, setting: C.name, record: OFF }, { posting: true, flag: 'copy' }).action).toEqual(NONE);
    /* Where this machine keeps the data alone there is nothing to hold. */
    expect(said({ hold: true, listed: 0, others: [], record: OFF })).toEqual({ action: NONE, flag: 'alone', renew: true });
  });

  it('never clears an empty setting', () => {
    expect(said({ others: [], listed: 1, record: OFF })).toEqual({ action: NONE, flag: 'relay_off', renew: true });
    expect(said({ others: [], listed: 1, record: older })).toEqual({ action: POST_OFF, flag: null, renew: true });
  });

  it('takes no flag without the relay', () => {
    expect(said({ record: older })).toEqual({ action: POST_OFF, flag: null, renew: true });
    expect(said({ record: null })).toEqual({ action: POST_OFF, flag: null, renew: true });
    /* Its own client does not hold the route: whatever the record says, nothing is stored for this keeper. */
    expect(said({ route: null, record: OFF })).toEqual({ action: POST_OFF, flag: null, renew: true });
  });

  it('never clears before off is stored', () => {
    const copies = [C, copy({ replyAgeMs: null }), copy({ replyAgeMs: 5000 }), copy({ syncState: 'async' })];
    const records: (SyncRecord | null)[] = [ON_C, { ...ON_C, generation: GENERATION - 1 }, { ...ON_C, copy: D_ID }, older, null];
    for (const one of copies) {
      for (const record of records) {
        for (const listed of [0, 1]) {
          for (const route of [ROUTE, null]) {
            for (const m of [memory(), memory({ w: '0/1', checkpointed: true }), memory({ blocked: true })]) {
              const { action } = nextSyncStep(sample({ others: listed ? [one] : [], listed, setting: C.name, record, route, oldestWaitMs: 20_000, slowForMs: 20_000 }), m);
              expect(action.do).not.toBe('clear');
            }
          }
        }
      }
    }
    /* And with off stored at this generation it does, whoever the setting names. */
    expect(said({ others: [copy({ replyAgeMs: null })], setting: C.name, record: OFF }).action).toEqual(CLEAR);
  });

  it('stops renewing when sync cannot be cleared', () => {
    const gone = [copy({ replyAgeMs: null })];
    expect(said({ others: gone, setting: C.name, record: ON_C, oldestWaitMs: STOP_RENEW_MS }).renew).toBe(false);
    expect(said({ others: gone, setting: C.name, record: ON_C, oldestWaitMs: STOP_RENEW_MS - 1 }).renew).toBe(true);
    expect(said({ others: gone, setting: C.name, record: OFF, oldestWaitMs: STOP_RENEW_MS }).renew).toBe(true);
    /* The copy the setting names is not listed any more. */
    expect(said({ others: [], setting: C.name, record: ON_C, oldestWaitMs: STOP_RENEW_MS }).renew).toBe(false);
    /* A commit that waits on a copy that keeps receiving, as a big one does, never stops the lease. */
    expect(said({ setting: C.name, record: ON_C, oldestWaitMs: 60_000 }, { w: '0/1' }).renew).toBe(true);
    /* While an answer of the relay is on its way the look still counts. */
    expect(said({ others: gone, setting: C.name, record: ON_C, oldestWaitMs: STOP_RENEW_MS }, { posting: true, flag: 'copy' })).toEqual({ action: NONE, flag: 'copy', renew: false });
  });

  it('stays stopped until the copy answers', () => {
    const gone = [copy({ replyAgeMs: null })];
    const stopped = step({ others: gone, setting: C.name, record: ON_C, oldestWaitMs: STOP_RENEW_MS });
    expect(stopped.renew).toBe(false);
    /* The lease ended and the sessions that waited went with it: that changes nothing. */
    const still = nextSyncStep(sample({ others: gone, setting: C.name, record: ON_C, oldestWaitMs: null }), { ...stopped.memory, posting: false });
    expect(still.renew).toBe(false);
    expect(nextSyncStep(sample({ setting: C.name, record: ON_C, oldestWaitMs: null }), { ...still.memory, posting: false }).renew).toBe(true);
    expect(nextSyncStep(sample({ others: gone, setting: C.name, record: OFF, oldestWaitMs: null }), { ...still.memory, posting: false }).renew).toBe(true);
  });

  it('remembers its flag, and that it is posting', () => {
    const posted = step({ record: older });
    expect(posted.memory).toMatchObject({ posting: true, flag: null });
    expect(step({ others: [D, C], listed: 2, record: OFF }).memory).toMatchObject({ posting: false, flag: 'relay_off' });
  });
});
