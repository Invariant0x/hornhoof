import { describe, expect, it } from 'vitest';
import {
  nextUpdateStep,
  type UpdateAction,
  type UpdateMemory,
  type UpdateSample
} from '../src/modules/keeper/update-steps.js';

/* Literals on purpose: a changed limit must fail these rows. */
const NOW = 5_000_000;
const MIN = 60_000;

const memoryOf = (o: Partial<UpdateMemory> = {}): UpdateMemory => ({
  id: 'u1',
  version: '1.2.3',
  migrations: 2,
  promised: ['c1', 'c2'],
  promisedAt: NOW - 1000,
  answered: true,
  w: null,
  wAt: null,
  stopped: false,
  stopAcks: [],
  settled: false,
  dropped: false,
  ...o
});

const statusOf = (o: Partial<NonNullable<UpdateSample['status']>> = {}): NonNullable<UpdateSample['status']> => ({
  id: 'u1',
  version: '1.2.3',
  state: 'running',
  step: 'install',
  migrations: 2,
  restore: false,
  ...o
});

const sample = (o: Partial<UpdateSample> = {}): UpdateSample => ({
  now: NOW,
  status: statusOf(),
  memory: memoryOf(),
  online: ['c1', 'c2'],
  answers: null,
  hosts: { c1: 'Mac', c2: 'Studio' },
  inFlight: false,
  maintenance: true,
  leads: true,
  atW: [],
  held: false,
  ...o
});

/* A sample in the middle of step backup, W read, nothing settled. */
const atW = (o: Partial<UpdateSample> = {}, m: Partial<UpdateMemory> = {}): UpdateSample =>
  sample({ status: statusOf({ step: 'backup' }), memory: memoryOf({ w: '0/3000000', wAt: NOW - 1000, ...m }), ...o });

const asking = (o: Partial<UpdateSample> = {}, m: Partial<UpdateMemory> = {}): UpdateSample =>
  sample({ status: statusOf({ step: 'promise' }), memory: memoryOf({ answered: false, ...m }), ...o });

const gives = (s: UpdateSample, a: UpdateAction) => expect(nextUpdateStep(s)).toEqual(a);
const none: UpdateAction = { do: 'none' };

describe('updates: no running update', () => {
  it('ends a kept memory once the status is not running and this keeper leads', () => {
    for (const state of ['done', 'failed', 'rolled_back'] as const) gives(sample({ status: statusOf({ state }) }), { do: 'end' });
  });

  it('ends a kept memory when the status is gone and this keeper leads', () => {
    gives(sample({ status: null }), { do: 'end' });
  });

  it('keeps the memory until this keeper leads', () => {
    gives(sample({ status: statusOf({ state: 'done' }), leads: false }), none);
    gives(sample({ status: null, leads: false }), none);
  });

  it('does nothing with no memory and no running update', () => {
    gives(sample({ status: statusOf({ state: 'done' }), memory: null }), none);
    gives(sample({ status: null, memory: null }), none);
  });
});

describe('updates: a running update with no memory of its own', () => {
  it('promises to the copies online when the step is promise and there is no memory', () => {
    gives(sample({ status: statusOf({ step: 'promise' }), memory: null, online: ['c1', 'c3'] }), { do: 'promise', to: ['c1', 'c3'] });
  });

  it('promises to the copies online when the memory is of another update', () => {
    gives(sample({ status: statusOf({ step: 'promise' }), memory: memoryOf({ id: 'old' }), online: ['c9'] }), { do: 'promise', to: ['c9'] });
  });

  it('promises to nobody when no copy is online', () => {
    gives(sample({ status: statusOf({ step: 'promise' }), memory: null, online: [] }), { do: 'promise', to: [] });
  });

  it('does nothing for an update begun by an updater of before this plan', () => {
    for (const step of ['pull', 'backup', 'install', 'health', 'rollback', 'finished'] as const) {
      gives(sample({ status: statusOf({ step }), memory: null }), none);
      gives(sample({ status: statusOf({ step }), memory: memoryOf({ id: 'old' }) }), none);
    }
  });
});

describe('updates: step promise', () => {
  it('does nothing once answered', () => {
    gives(asking({ answers: { c1: 'ok', c2: 'ok' } }, { answered: true }), none);
  });

  it('does nothing while a request to the copies is out and no answers came', () => {
    gives(asking({ answers: null, inFlight: true }), none);
  });

  it('promises again to those it promised when a started-again keeper has no answer', () => {
    gives(asking({ answers: null, inFlight: false }, { promised: ['c1'] }), { do: 'promise', to: ['c1'] });
  });

  it('answers ok when every promised copy said ok', () => {
    gives(asking({ answers: { c1: 'ok', c2: 'ok' } }), { do: 'answer', ok: true, why: null });
  });

  it('answers ok at once with no copy', () => {
    gives(asking({ answers: {} }, { promised: [] }), { do: 'answer', ok: true, why: null });
  });

  it('answers no with the host of a silent copy', () => {
    gives(asking({ answers: { c1: 'ok', c2: 'silent' } }), { do: 'answer', ok: false, why: 'Studio did not answer' });
  });

  it('answers no with the host of a copy that refused', () => {
    gives(asking({ answers: { c1: 'refused', c2: 'ok' } }), { do: 'answer', ok: false, why: 'Mac did not promise to wait' });
  });

  it('gives the why of the first copy that did not say ok', () => {
    gives(asking({ answers: { c1: 'silent', c2: 'refused' } }), { do: 'answer', ok: false, why: 'Mac did not answer' });
  });

  it('counts a promised copy with no answer as silent', () => {
    gives(asking({ answers: { c1: 'ok' } }), { do: 'answer', ok: false, why: 'Studio did not answer' });
  });

  it('ignores an answer from a copy that was not promised', () => {
    gives(asking({ answers: { c1: 'ok', c2: 'silent' } }, { promised: ['c1'] }), { do: 'answer', ok: true, why: null });
  });

  it('names the copy by its id when no host is known', () => {
    gives(asking({ answers: { c1: 'silent' }, hosts: {} }, { promised: ['c1'] }), { do: 'answer', ok: false, why: 'c1 did not answer' });
  });

  it('does not promise again while asking, however late', () => {
    gives(asking({ answers: { c1: 'ok', c2: 'ok' }, now: NOW + 10 * MIN }, { answered: true }), none);
  });
});

describe('updates: promising again', () => {
  const later = (ms: number, m: Partial<UpdateMemory> = {}) => sample({ now: NOW + ms, memory: memoryOf({ promisedAt: NOW, ...m }) });

  it('promise_again 5 minutes after the last promise', () => {
    gives(later(5 * MIN), { do: 'promise_again' });
    gives(later(5 * MIN + 1), { do: 'promise_again' });
  });

  it('waits until 5 minutes passed', () => {
    gives(later(5 * MIN - 1), none);
  });

  it('has no one to promise again to', () => {
    gives(later(10 * MIN, { promised: [] }), none);
  });

  it('promises again before looking at W', () => {
    gives(atW({ now: NOW + 5 * MIN }, { promisedAt: NOW }), { do: 'promise_again' });
  });
});

describe('updates: begin', () => {
  const backup = (o: Partial<UpdateSample> = {}, m: Partial<UpdateMemory> = {}) =>
    sample({ status: statusOf({ step: 'backup' }), memory: memoryOf(m), ...o });

  it('begin in step backup once the lease is in maintenance and W is not read', () => {
    gives(backup(), { do: 'begin' });
  });

  it('waits for the maintenance lease', () => {
    gives(backup({ maintenance: false }), none);
  });

  it('does not begin in another step', () => {
    for (const step of ['pull', 'install', 'health', 'rollback'] as const) gives(sample({ status: statusOf({ step }) }), none);
  });

  it('does not read W twice', () => {
    gives(backup({}, { w: '0/3000000', wAt: NOW }), none);
  });
});

describe('updates: the copies at W', () => {
  it('stop_copies when every promised copy is at W and migrations are to run', () => {
    gives(atW({ atW: ['c1', 'c2'] }), { do: 'stop_copies' });
  });

  it('stop_copies when migrations are unknown, null counting as not 0', () => {
    gives(atW({ atW: ['c1', 'c2'] }, { migrations: null }), { do: 'stop_copies' });
  });

  it('settle ok when every promised copy is at W and no migration is to run', () => {
    gives(atW({ atW: ['c1', 'c2'] }, { migrations: 0 }), { do: 'settle', ok: true });
  });

  it('settle ok with no copy promised', () => {
    gives(atW({}, { promised: [], migrations: 0 }), { do: 'settle', ok: true });
  });

  it('stop_copies with no copy promised and migrations to run', () => {
    gives(atW({}, { promised: [] }), { do: 'stop_copies' });
  });

  it('waits when one promised copy is behind W', () => {
    gives(atW({ atW: ['c1'] }), none);
    gives(atW({ atW: ['c1'] }, { migrations: 0 }), none);
  });

  it('settle ok when stopped, every copy at W and acked, and sync is held', () => {
    gives(atW({ atW: ['c1', 'c2'], held: true }, { stopped: true, stopAcks: ['c1', 'c2'] }), { do: 'settle', ok: true });
  });

  it('waits for the hold when stopped and acked', () => {
    gives(atW({ atW: ['c1', 'c2'], held: false }, { stopped: true, stopAcks: ['c1', 'c2'] }), none);
  });

  it('waits for the acks when stopped and held', () => {
    gives(atW({ atW: ['c1', 'c2'], held: true, inFlight: true }, { stopped: true, stopAcks: ['c1'] }), none);
  });

  it('waits for a copy that is stopped, acked and held but not at W', () => {
    gives(atW({ atW: ['c1'], held: true }, { stopped: true, stopAcks: ['c1', 'c2'] }), none);
  });

  it('settle no when a minute passed since W was read', () => {
    const read = { wAt: NOW - 1000, promisedAt: NOW + 5 * MIN };
    gives(atW({ now: NOW + 58_999 }, read), none);
    gives(atW({ now: NOW + 59_000 }, read), { do: 'settle', ok: false });
    gives(atW({ now: NOW + 5 * MIN }, read), { do: 'settle', ok: false });
  });

  it('settle no when a minute passed even if stopped and unacked', () => {
    gives(atW({ now: NOW + 60_000 }, { wAt: NOW, stopped: true, stopAcks: [] }), { do: 'settle', ok: false });
  });

  it('settles once only: nothing more after settled', () => {
    gives(atW({ now: NOW + 10 * MIN, atW: ['c1', 'c2'] }, { settled: true }), { do: 'promise_again' });
    gives(atW({ now: NOW + 1000, atW: ['c1', 'c2'] }, { settled: true, promisedAt: NOW }), none);
  });

  it('stop_copies again for a copy that has not acked, when no request is out', () => {
    gives(atW({ atW: ['c1'], inFlight: false }, { stopped: true, stopAcks: ['c1'] }), { do: 'stop_copies' });
  });

  it('does not send the stop again while a request is out', () => {
    gives(atW({ atW: ['c1'], inFlight: true }, { stopped: true, stopAcks: ['c1'] }), none);
  });

  it('does not stop copies before W is read', () => {
    gives(atW({ atW: ['c1', 'c2'], maintenance: false }, { w: null, wAt: null }), none);
  });
});

describe('updates: slots before a restore', () => {
  const restoring = (m: Partial<UpdateMemory> = {}, s: Partial<UpdateSample> = {}) =>
    sample({ status: statusOf({ step: 'rollback', restore: true }), memory: memoryOf({ ...m }), ...s });

  it('drop_slots when the update restores and the slots are not dropped', () => {
    gives(restoring(), { do: 'drop_slots' });
  });

  it('drops the slots after a settle too', () => {
    gives(restoring({ w: '0/3000000', wAt: NOW - 1000, settled: true }), { do: 'drop_slots' });
  });

  it('does it once', () => {
    gives(restoring({ dropped: true }), none);
  });

  it('does not drop slots when the update does not restore', () => {
    gives(sample({ status: statusOf({ step: 'rollback', restore: false }) }), none);
  });

  it('an unsettled wait for W takes the row before it', () => {
    gives(restoring({ w: '0/3000000', wAt: NOW - 60_000 }), { do: 'settle', ok: false });
  });
});

describe('updates: otherwise', () => {
  it('does nothing in a quiet step of a running update', () => {
    for (const step of ['pull', 'install', 'health', 'rollback', 'finished'] as const) gives(sample({ status: statusOf({ step }) }), none);
  });
});
