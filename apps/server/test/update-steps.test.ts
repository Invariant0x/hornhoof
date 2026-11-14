import { describe, expect, it } from 'vitest';
import { ANSWER_MS, nextUpdateStep, PROMISE_AGAIN_MS, PROMISE_MS, W_WAIT_MS, type UpdateMemory, type UpdateSample } from '../src/modules/keeper/update-steps.js';

const C = 'c0'.repeat(16);
const D = 'd0'.repeat(16);
const W = '0/3000000';
const NOW = 1_000_000;

const status = (over: Partial<NonNullable<UpdateSample['status']>> = {}): NonNullable<UpdateSample['status']> => ({ id: 'u1', version: '0.19.0', state: 'running', step: 'promise', migrations: 2, restore: false, ...over });
/* What the keeper wrote down of this update once it promised to both copies. */
const memory = (over: Partial<UpdateMemory> = {}): UpdateMemory => ({
  id: 'u1', version: '0.19.0', migrations: 2, promised: [C, D], promisedAt: NOW, answered: false, w: null, wAt: null, stopped: false, stopAcks: [], settled: false, dropped: false, ...over,
});
const sample = (over: Partial<UpdateSample> = {}): UpdateSample => ({
  now: NOW, status: status(), memory: memory(), online: [C, D], answers: null, inFlight: false, maintenance: false, leads: false, atW: [], held: false, ...over,
});
const step = (over: Partial<UpdateSample> = {}) => nextUpdateStep(sample(over));
/* An update that reached its dump: both copies promised, the lease in maintenance, W read. */
const dumping = (over: Partial<UpdateSample> = {}, more: Partial<UpdateMemory> = {}) =>
  step({ status: status({ step: 'backup' }), maintenance: true, memory: memory({ answered: true, w: W, wAt: NOW, ...more }), ...over });

const NONE = { do: 'none' };

describe('the next step of an update on the machine that leads', () => {
  it('updates: end when the update is over and this machine leads again', () => {
    for (const state of ['done', 'failed', 'rolled_back'] as const) expect(step({ status: status({ state, step: 'finished' }), leads: true })).toEqual({ do: 'end' });
    expect(step({ status: null, leads: true })).toEqual({ do: 'end' });
  });

  it('updates: none when no update runs', () => {
    /* Not before it leads is anything of the update ended. */
    expect(step({ status: status({ state: 'done', step: 'finished' }), leads: false })).toEqual(NONE);
    expect(step({ status: null, memory: null, leads: true })).toEqual(NONE);
    expect(step({ status: status({ state: 'failed' }), memory: null, leads: true })).toEqual(NONE);
  });

  it('updates: promise to the copies that are there when an update asks', () => {
    expect(step({ memory: null })).toEqual({ do: 'promise', to: [C, D] });
    expect(step({ memory: memory({ id: 'older' }), online: [D] })).toEqual({ do: 'promise', to: [D] });
    expect(step({ memory: null, online: [] })).toEqual({ do: 'promise', to: [] });
  });

  it('updates: none for an update that began before its keeper knew of it', () => {
    for (const at of ['pull', 'backup', 'install', 'health', 'rollback'] as const) expect([at, step({ memory: null, status: status({ step: at }), maintenance: true })]).toEqual([at, NONE]);
    expect(step({ memory: memory({ id: 'older' }), status: status({ step: 'backup' }) })).toEqual(NONE);
  });

  it('updates: none once the promise was answered', () => {
    expect(step({ memory: memory({ answered: true }), answers: { [C]: 'ok', [D]: 'ok' } })).toEqual(NONE);
  });

  it('updates: none while the copies are being asked', () => {
    expect(step({ inFlight: true })).toEqual(NONE);
  });

  it('updates: promise again to the same copies when no answer is known', () => {
    /* A keeper that started again in the middle: the copies it wrote down, not those that are there now. */
    expect(step({ online: [D] })).toEqual({ do: 'promise', to: [C, D] });
  });

  it('updates: answer ok when every copy promised', () => {
    expect(step({ answers: { [C]: 'ok', [D]: 'ok' } })).toEqual({ do: 'answer', ok: true, why: null });
  });

  it('answers ok at once with no copy', () => {
    expect(step({ memory: memory({ promised: [] }), online: [], answers: {} })).toEqual({ do: 'answer', ok: true, why: null });
  });

  it('updates: answer no when a copy did not promise, naming the first', () => {
    expect(step({ answers: { [C]: 'ok', [D]: 'silent' } })).toEqual({ do: 'answer', ok: false, why: { copy: D, said: 'silent' } });
    expect(step({ answers: { [C]: 'refused', [D]: 'silent' } })).toEqual({ do: 'answer', ok: false, why: { copy: C, said: 'refused' } });
    /* A copy that gave no answer at all counts as silent. */
    expect(step({ answers: { [C]: 'ok' } })).toEqual({ do: 'answer', ok: false, why: { copy: D, said: 'silent' } });
  });

  it('updates: promise again every five minutes while the update runs', () => {
    const installing = { status: status({ step: 'install' }), memory: memory({ answered: true, w: W, wAt: NOW, settled: true }) };
    expect(step({ ...installing, now: NOW + PROMISE_AGAIN_MS - 1 })).toEqual(NONE);
    expect(step({ ...installing, now: NOW + PROMISE_AGAIN_MS })).toEqual({ do: 'promise_again' });
    /* With no copy there is nobody to promise to. */
    expect(step({ ...installing, memory: memory({ answered: true, promised: [], settled: true }), now: NOW + PROMISE_AGAIN_MS })).toEqual(NONE);
    expect([PROMISE_MS, PROMISE_AGAIN_MS, ANSWER_MS, W_WAIT_MS]).toEqual([900_000, 300_000, 10_000, 60_000]);
  });

  it('updates: begin once the lease is in maintenance', () => {
    const backup = { status: status({ step: 'backup' }), memory: memory({ answered: true }) };
    expect(step({ ...backup, maintenance: true })).toEqual({ do: 'begin' });
    expect(step({ ...backup, maintenance: false })).toEqual(NONE);
  });

  it('updates: stop the copies once they hold W, when migrations are to run', () => {
    expect(dumping({ atW: [C, D] })).toEqual({ do: 'stop_copies' });
    /* A count that is not known counts as some. */
    expect(dumping({ atW: [C, D], status: status({ step: 'backup', migrations: null }) }, { migrations: null })).toEqual({ do: 'stop_copies' });
    expect(dumping({ atW: [C] })).toEqual(NONE);
  });

  it('updates: settle ok at W when no migration is to run', () => {
    expect(dumping({ atW: [C, D], status: status({ step: 'backup', migrations: 0 }) }, { migrations: 0 })).toEqual({ do: 'settle', ok: true });
    /* With no copy there is nothing to wait for, and nobody to stop, whatever migrations are to run. */
    expect(dumping({ atW: [], status: status({ step: 'backup', migrations: 0 }) }, { promised: [], migrations: 0 })).toEqual({ do: 'settle', ok: true });
    expect(dumping({ atW: [] }, { promised: [] })).toEqual({ do: 'settle', ok: true });
  });

  it('updates: settle ok once every copy stopped and commits wait for none', () => {
    const stopped = { stopped: true, stopAcks: [C, D] };
    expect(dumping({ atW: [C, D], held: true }, stopped)).toEqual({ do: 'settle', ok: true });
    expect(dumping({ atW: [C, D], held: false }, stopped)).toEqual(NONE);
  });

  it('updates: settle no when a copy has not confirmed W within a minute', () => {
    expect(dumping({ atW: [C], now: NOW + W_WAIT_MS - 1 })).toEqual(NONE);
    expect(dumping({ atW: [C], now: NOW + W_WAIT_MS })).toEqual({ do: 'settle', ok: false });
    /* Also when the copies hold W and one never answered the stop, or commits still wait for one. */
    expect(dumping({ atW: [C, D], held: true, now: NOW + W_WAIT_MS, inFlight: true }, { stopped: true, stopAcks: [C] })).toEqual({ do: 'settle', ok: false });
    expect(dumping({ atW: [C, D], held: false, now: NOW + W_WAIT_MS }, { stopped: true, stopAcks: [C, D] })).toEqual({ do: 'settle', ok: false });
  });

  it('updates: stop the copies again while one has not answered the stop', () => {
    expect(dumping({ atW: [C, D], held: true }, { stopped: true, stopAcks: [C] })).toEqual({ do: 'stop_copies' });
    expect(dumping({ atW: [C, D], held: true, inFlight: true }, { stopped: true, stopAcks: [C] })).toEqual(NONE);
  });

  it('updates: drop the slots before the database is put back', () => {
    const back = { status: status({ step: 'rollback', restore: true }), memory: memory({ answered: true, w: W, wAt: NOW, settled: true }) };
    expect(step(back)).toEqual({ do: 'drop_slots' });
    expect(step({ ...back, memory: memory({ answered: true, w: W, wAt: NOW, settled: true, dropped: true }) })).toEqual(NONE);
    /* Going back without a restore keeps the copies. */
    expect(step({ ...back, status: status({ step: 'rollback', restore: false }) })).toEqual(NONE);
  });

  it('updates: none otherwise', () => {
    expect(step({ status: status({ step: 'pull' }), memory: memory({ answered: true }) })).toEqual(NONE);
    expect(step({ status: status({ step: 'install' }), memory: memory({ answered: true, w: W, wAt: NOW, settled: true }) })).toEqual(NONE);
  });
});
