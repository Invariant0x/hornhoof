import { describe, expect, it } from 'vitest';
import type { LeaseKind } from '../src/db/net.js';
import { leaseValid, nextLeaseStep, type Clocks, type Held, type LeaseStep } from '../src/modules/keeper/lease.js';

const t0: Clocks = { wall: 1e12, mono: 5e3 };

// Offsets from t0 in milliseconds, wall clock first. Literals on purpose: a changed limit must fail these rows.
const at = (wall: number, mono: number = wall): Clocks => ({ wall: t0.wall + wall, mono: t0.mono + mono });

const holding = (kind: LeaseKind, sent: Clocks = t0): Held => ({ term: { number: 1, machine: 'a', split: false }, kind, sent });
const normalLease = holding('normal');
const maintenanceLease = holding('maintenance');

const take = (kind: LeaseKind): LeaseStep => ({ do: 'take', kind });
const fence = (why: string): LeaseStep => ({ do: 'fence', why });
const renew = (kind: LeaseKind, endSessions = false): LeaseStep => ({ do: 'renew', kind, endSessions });

type Row = [name: string, held: Held | null, last: Clocks | null, now: Clocks, maintenance: boolean, step: LeaseStep];

const picksThisStep = (_name: string, held: Held | null, last: Clocks | null, now: Clocks, maintenance: boolean, step: LeaseStep) => {
  expect(nextLeaseStep({ now, last, held, maintenance })).toEqual(step);
};

describe('leaseValid', () => {
  const rows: [name: string, held: Held | null, now: Clocks, valid: boolean][] = [
    ['nothing held', null, at(0), false],
    ['just sent', normalLease, at(0), true],
    ['9.9 s after on both clocks', normalLease, at(9900), true],
    ['just short of 10 s on both clocks', normalLease, at(9999), true],
    ['exactly 10 s after on the wall clock alone', normalLease, at(10000, 0), false],
    ['exactly 10 s after on the monotonic clock alone', normalLease, at(0, 10000), false],
    ['10 s after on the monotonic clock while the wall clock went back', normalLease, at(-5000, 10000), false],
    // Only the tick's check ends these two, which is why nextLeaseStep looks at the tick before the lease.
    ['the wall clock gone back, the monotonic clock within', normalLease, at(-1500, 2000), true],
    ['8 s after, a late tick for the keeper but not yet the end of the lease', normalLease, at(8000), true]
  ];

  it.each(rows)('%s', (_name, held, now, valid) => {
    expect(leaseValid(held, now)).toBe(valid);
  });
});

describe('nextLeaseStep', () => {
  const planTable: Row[] = [
    ['no lease on the first tick', null, null, at(0), false, take('normal')],
    ['no lease on the first tick, in maintenance', null, null, at(0), true, take('maintenance')],
    ['a tick on time', normalLease, at(0), at(1000), false, renew('normal')],
    ['a tick late on both clocks', normalLease, at(1000), at(8000), false, fence('a tick came 7 s after the one before')],
    ['a tick late on the wall clock alone', normalLease, at(1000), at(8000, 2000), false, fence('a tick came 7 s after the one before')],
    ['the wall clock back by more than a second', normalLease, at(1000), at(-1500, 2000), false, fence('the clock went back 2.5 s')],
    ['the wall clock back by less than a second', normalLease, at(1000), at(500, 2000), false, renew('normal')],
    ['10 s since the renewal on both clocks', normalLease, at(9000), at(10000), false, fence('no renewal for 10 s')],
    ['10 s since the renewal on the wall clock alone', normalLease, at(9500), at(10200, 9800), false, fence('no renewal for 10 s')],
    ['maintenance begins', normalLease, at(0), at(1000), true, renew('maintenance', true)],
    ['maintenance goes on', maintenanceLease, at(0), at(1000), true, renew('maintenance')],
    ['maintenance ends', maintenanceLease, at(0), at(1000), false, renew('normal')],
    ['no lease on a late tick', null, at(1000), at(9000), false, take('normal')]
  ];

  it.each(planTable)("picks each tick's step from the two clocks: %s", picksThisStep);

  const renewedAt = (offset: number): Held => holding('normal', at(offset));
  const boundaries: Row[] = [
    ['a gap of exactly 6 s on the monotonic clock', renewedAt(1000), at(1000), at(2000, 7000), false, renew('normal')],
    ['a gap just over 6 s on the monotonic clock', renewedAt(1000), at(1000), at(2000, 7001), false, fence('a tick came 6 s after the one before')],
    ['a gap of exactly 6 s on the wall clock', renewedAt(1000), at(1000), at(7000, 2000), false, renew('normal')],
    ['a gap just over 6 s on the wall clock', renewedAt(1000), at(1000), at(7001, 2000), false, fence('a tick came 6 s after the one before')],
    ['the wall clock back by exactly 1 s', renewedAt(5000), at(5000), at(4000, 6000), false, renew('normal')],
    ['the wall clock back by just over 1 s', renewedAt(5000), at(5000), at(3999, 6000), false, fence('the clock went back 1 s')],
    ['just short of 10 s since the renewal', normalLease, at(8000), at(9999), false, renew('normal')],
    ['exactly 10 s since the renewal on the wall clock alone', normalLease, at(8000), at(10000, 9000), false, fence('no renewal for 10 s')],
    ['exactly 10 s since the renewal on the monotonic clock alone', normalLease, at(8000), at(9000, 10000), false, fence('no renewal for 10 s')],
    ['the monotonic clock jumping while the wall clock does not', normalLease, at(1000), at(2000, 8000), false, fence('a tick came 7 s after the one before')]
  ];

  it.each(boundaries)('stands on the right side of each limit: %s', picksThisStep);

  const reasons: Row[] = [
    ['the wall gap when it is the larger', normalLease, at(1000), at(10000, 8000), false, fence('a tick came 9 s after the one before')],
    ['the monotonic gap when it is the larger', normalLease, at(1000), at(8000, 10000), false, fence('a tick came 9 s after the one before')],
    ['a gap rounded down to a tenth', normalLease, at(1000), at(8340), false, fence('a tick came 7.3 s after the one before')],
    ['a gap rounded up to a tenth', normalLease, at(1000), at(8350), false, fence('a tick came 7.4 s after the one before')],
    ['a step back rounded to a tenth', normalLease, at(1000), at(-1240, 2000), false, fence('the clock went back 2.2 s')]
  ];

  it.each(reasons)('says why it fences: %s', picksThisStep);

  // Each row here has two rules that match, and only the order says which one wins.
  const order: Row[] = [
    ['no lease comes before a late tick, in maintenance too', null, at(1000), at(9000), true, take('maintenance')],
    ['a late tick comes before the lapse', normalLease, at(1000), at(12000), false, fence('a tick came 11 s after the one before')],
    ['a clock going back comes before the lapse', normalLease, at(9000), at(7000, 10000), false, fence('the clock went back 2 s')],
    ['a late tick comes before a clock going back', normalLease, at(1000), at(-1500, 8000), false, fence('a tick came 7 s after the one before')],
    ['a late tick comes before maintenance beginning', normalLease, at(1000), at(8000), true, fence('a tick came 7 s after the one before')],
    ['a lapse comes before maintenance beginning', normalLease, at(9000), at(10000), true, fence('no renewal for 10 s')],
    ['a late tick ends a maintenance lease too', maintenanceLease, at(1000), at(8000), true, fence('a tick came 7 s after the one before')]
  ];

  it.each(order)('goes through its rules in order: %s', picksThisStep);

  const others: Row[] = [
    ['a valid lease with no earlier tick to compare', normalLease, null, at(1000), false, renew('normal')],
    ['a lapsed lease with no earlier tick to compare', normalLease, null, at(10000), false, fence('no renewal for 10 s')],
    ['a split lease going into maintenance ends the sessions as well', holding('split'), at(0), at(1000), true, renew('maintenance', true)]
  ];

  it.each(others)('%s', picksThisStep);
});
