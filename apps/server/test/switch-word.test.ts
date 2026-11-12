import { describe, expect, it } from 'vitest';
import { LOST_MS, switchWord, type SwitchSample } from '../src/modules/keeper/switch-word.js';

const NOW = Date.parse('2026-11-12T14:05:00.000Z');
const [A, B, C] = ['machine-a', 'machine-b', 'machine-c'];
const sample = (over: Partial<SwitchSample>): SwitchSample => ({
  now: NOW, kind: 'follow', self: B, handingTo: null, leads: false, leader: A, lastLeader: A, lastSync: B, lostSince: null, cut: false, question: false, ...over,
});
const still = (self: string) => ({ self, moving: false, from: null, to: null, since: null, cut: false, question: false });
const STILL = still(B);

describe('what a keeper says of where the company moves', () => {
  it('says a planned switch moves to the machine it hands the server to', () => {
    expect(switchWord(sample({ kind: 'handing', self: A, handingTo: C, since: NOW - 4000 }))).toEqual({ ...still(A), moving: true, from: A, to: C, since: new Date(NOW - 4000).toISOString() });
  });

  it('says it moves here until the machine that takes it leads', () => {
    expect(switchWord(sample({ kind: 'taking', self: B, leads: false, lastLeader: A }))).toEqual({ ...STILL, moving: true, from: A, to: B });
    expect(switchWord(sample({ kind: 'taking', self: B, leads: true, lastLeader: A }))).toEqual(STILL);
  });

  it('says nothing moves on the machine that leads', () => {
    expect(switchWord(sample({ kind: 'lead', self: A, leader: null, lostSince: NOW - 1000 }))).toEqual(still(A));
    /* A keeper that does not know its own machine yet names nobody. */
    expect(switchWord(sample({ kind: 'lead', self: '' }))).toEqual({ ...STILL, self: null });
  });

  it.each(['follow', 'worker'] as const)('says a %s that lost the leader where the company goes', kind => {
    const lost = { kind, leader: null, lostSince: NOW - 10_000 };
    const since = new Date(NOW - 10_000).toISOString();
    /* To the copy the leader's commits waited for. */
    expect(switchWord(sample({ ...lost, self: C, lastSync: B }))).toEqual({ ...still(C), moving: true, from: A, to: B, since });
    /* Nobody it knows, when that copy is the machine it lost, or when it never heard of one. */
    expect(switchWord(sample({ ...lost, self: C, lastSync: A }))).toEqual({ ...still(C), moving: true, from: A, to: null, since });
    expect(switchWord(sample({ ...lost, self: C, lastSync: null }))).toEqual({ ...still(C), moving: true, from: A, to: null, since });
    /* Not for ever, and not while a leader is named. */
    expect(switchWord(sample({ ...lost, lostSince: NOW - LOST_MS + 1 })).moving).toBe(true);
    expect(switchWord(sample({ ...lost, lostSince: NOW - LOST_MS }))).toEqual(STILL);
    expect(switchWord(sample({ kind, leader: A, lostSince: NOW - 10_000 }))).toEqual(STILL);
    expect(switchWord(sample({ kind, leader: null, lostSince: null }))).toEqual(STILL);
  });

  it('passes on that the copy is cut off, and that it asks a question', () => {
    /* A copy that is cut off names the leader it cannot reach. */
    expect(switchWord(sample({ cut: true }))).toEqual({ ...STILL, cut: true, from: A });
    expect(switchWord(sample({ cut: true, leader: null, lastLeader: C, lostSince: null }))).toEqual({ ...STILL, cut: true, from: C });
    expect(switchWord(sample({ question: true, leader: null, lostSince: NOW - 1000 }))).toMatchObject({ moving: true, question: true });
    expect(switchWord(sample({ kind: 'handing', self: A, handingTo: C, cut: true, question: true }))).toMatchObject({ moving: true, cut: true, question: true });
  });
});
