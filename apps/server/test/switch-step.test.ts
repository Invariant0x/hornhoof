import { describe, expect, it } from 'vitest';
import type { Term } from '../src/db/net.js';
import {
  nextHandStep,
  nextTakeStep,
  takeState,
  type HandAction,
  type HandSample,
  type Handing,
  type MoveReason,
  type TakeAction,
  type TakeSample,
  type TakeState,
  type Taking
} from '../src/modules/keeper/switch-step.js';

/* Literals on purpose: a changed limit must fail these rows. */
const MIN = 60_000;
const DAY = 86_400_000;
const NOW = 10_000_000;
const DEADLINE = NOW + 30_000;
const SELF = 'net-a';
const TERM: Term = { number: 7, machine: 'm-a', split: false };

const handingIn = (phase: Handing['phase'], o: Partial<Handing> = {}): Handing => ({
  switch: 'sw1',
  to: { machine: 'm-b', networkId: 'net-b', hostname: 'b.hornhoof.test' },
  term: TERM,
  at: DEADLINE - MIN,
  deadline: DEADLINE,
  phase,
  fenced: true,
  w: '0/1000',
  copies: null,
  slot: null,
  reason: null,
  ...o
});

const readyTarget = { numbered: true, data: true, named: true, onStored: true, pace: true };

const hand = (o: Partial<HandSample> = {}): HandSample => ({
  now: NOW,
  self: SELF,
  handing: null,
  move: { request: 'sw1', networkId: 'net-b', state: 'preparing', askedAt: NOW - 1000, endedAt: null },
  target: readyTarget,
  leads: true,
  updating: false,
  offer: null,
  wConfirmedAt: null,
  othersAtW: [],
  othersOnline: [],
  state: null,
  ...o
});

const inPhase = (phase: Handing['phase'], o: Partial<HandSample> = {}, h: Partial<Handing> = {}): HandSample =>
  hand({ handing: handingIn(phase, h), ...o });

const stopped = (o: Partial<HandSample> = {}, h: Partial<Handing> = {}): HandSample =>
  inPhase('stopped', { wConfirmedAt: NOW - 1000, ...o }, h);

const step = (s: HandSample, a: HandAction) => expect(nextHandStep(s)).toEqual(a);
const reason = (r: MoveReason): { reason: MoveReason } => ({ reason: r });

const failedMove = (endedAt: number | null) => ({ request: 'sw1', networkId: 'net-b', state: 'failed' as const, askedAt: 0, endedAt });
const askedAgo = (ms: number, state: 'preparing' | 'switching' = 'preparing') => ({
  request: 'sw1',
  networkId: 'net-b',
  state,
  askedAt: NOW - ms,
  endedAt: null
});

describe('hands over, with no handing', () => {
  it('forgets a failed move whose end is over a day old', () => {
    step(hand({ move: failedMove(NOW - DAY - 1) }), { do: 'forget' });
  });

  it('keeps a failed move whose end is exactly a day old', () => {
    step(hand({ move: failedMove(NOW - DAY) }), { do: 'none' });
  });

  it('keeps a failed move that has no end time', () => {
    step(hand({ move: failedMove(null) }), { do: 'none' });
  });

  it('fails a request that has been preparing over a day as expired', () => {
    step(hand({ move: askedAgo(DAY + 1) }), { do: 'fail', ...reason('expired') });
  });

  it('expires a stale request before it asks whether the target is ready', () => {
    step(hand({ move: askedAgo(DAY + 1), target: null }), { do: 'fail', ...reason('expired') });
  });

  it('goes on with a request that has been preparing exactly a day', () => {
    step(hand({ move: askedAgo(DAY) }), { do: 'offer' });
  });

  it('fails left when the target is gone', () => {
    step(hand({ target: null }), { do: 'fail', ...reason('left') });
  });

  it('fails left when the target has no number', () => {
    step(hand({ target: { ...readyTarget, numbered: false } }), { do: 'fail', ...reason('left') });
  });

  it('fails left when the target is no data machine', () => {
    step(hand({ target: { ...readyTarget, data: false } }), { do: 'fail', ...reason('left') });
  });

  it('offers when this keeper leads, no update runs and the target is named, on stored and at pace', () => {
    step(hand(), { do: 'offer' });
  });

  it.each<[string, Partial<HandSample>]>([
    ['this keeper does not lead', { leads: false }],
    ['an update runs', { updating: true }],
    ['the target is not named', { target: { ...readyTarget, named: false } }],
    ['the target is not on stored', { target: { ...readyTarget, onStored: false } }],
    ['the target is not at pace', { target: { ...readyTarget, pace: false } }]
  ])('waits to offer while %s', (_why, o) => {
    step(hand(o), { do: 'none' });
  });

  it('fails no_answer for a move claimed as switching that was never offered', () => {
    step(hand({ move: askedAgo(1000, 'switching') }), { do: 'fail', ...reason('no_answer') });
  });

  it('does nothing without a move', () => {
    step(hand({ move: null }), { do: 'none' });
  });
});

describe('hands over: offered', () => {
  it.each<[string, HandSample['offer'], HandAction]>([
    ['abort not_ready when B refused', 'refused', { do: 'abort', ...reason('not_ready') }],
    ['abort no_answer when B was silent', 'silent', { do: 'abort', ...reason('no_answer') }],
    ['stop when B accepted', 'accepted', { do: 'stop' }],
    ['abort no_answer when no offer is known, a keeper that started again', null, { do: 'abort', ...reason('no_answer') }],
    ['wait while B has not answered', 'waiting', { do: 'none' }]
  ])('%s', (_name, offer, action) => {
    step(inPhase('offered', { offer }), action);
  });
});

describe('hands over: stopped', () => {
  it('fences when the front door was not yet fenced', () => {
    step(stopped({}, { fenced: false }), { do: 'fence' });
  });

  it('fences again before reading W', () => {
    step(stopped({}, { fenced: false, w: '0/1000' }), { do: 'fence' });
    step(stopped({}, { fenced: false, w: null }), { do: 'fence' });
  });

  it('reads W once fenced', () => {
    step(stopped({}, { w: null }), { do: 'read_w' });
  });

  it('abort behind when B has not confirmed W 10 s before the deadline', () => {
    step(stopped({ wConfirmedAt: null, now: DEADLINE - 10_000 }), { do: 'abort', ...reason('behind') });
    step(stopped({ wConfirmedAt: null, now: DEADLINE - 5000 }), { do: 'abort', ...reason('behind') });
  });

  it('waits for B while there are more than 10 s to the deadline', () => {
    step(stopped({ wConfirmedAt: null, now: DEADLINE - 10_001 }), { do: 'none' });
  });

  it('go with the copies at W as soon as every online copy is at W', () => {
    step(stopped({ othersOnline: ['c1', 'c2'], othersAtW: ['c2', 'c1'] }), { do: 'go', copies: ['c2', 'c1'] });
  });

  it('go with no copies when B is the only other machine', () => {
    step(stopped({}), { do: 'go', copies: [] });
  });

  it('waits for a copy that is online and not yet at W', () => {
    step(stopped({ othersOnline: ['c1', 'c2'], othersAtW: ['c1'], wConfirmedAt: NOW - 9999 }), { do: 'none' });
  });

  it('go with the copies at W when 10 s passed since B confirmed W', () => {
    step(stopped({ othersOnline: ['c1', 'c2'], othersAtW: ['c1'], wConfirmedAt: NOW - 10_000 }), { do: 'go', copies: ['c1'] });
  });

  it('go with the copies at W when 10 s remain before the deadline', () => {
    step(stopped({ othersOnline: ['c1'], othersAtW: [], wConfirmedAt: DEADLINE - 11_000, now: DEADLINE - 10_000 }), {
      do: 'go',
      copies: []
    });
  });

  it('waits when there are more than 10 s to the deadline and the others are not in yet', () => {
    step(stopped({ othersOnline: ['c1'], othersAtW: [], wConfirmedAt: DEADLINE - 11_000, now: DEADLINE - 10_001 }), { do: 'none' });
  });

  it('never sends go before B confirmed W', () => {
    for (const now of [NOW, DEADLINE - 20_000, DEADLINE - 10_001]) {
      expect(nextHandStep(stopped({ wConfirmedAt: null, now })).do).not.toBe('go');
    }
  });

  it('sends go before the deadline or not at all', () => {
    const cutoff = DEADLINE - 10_000;
    const lateConfirmation = stopped({ wConfirmedAt: null, now: cutoff + 1 });
    expect(nextHandStep(lateConfirmation)).toEqual({ do: 'abort', ...reason('behind') });
    for (const now of [cutoff - 1, cutoff]) {
      const action = nextHandStep(stopped({ now, wConfirmedAt: now - 1 }));
      expect(action.do === 'go' ? now <= cutoff : true).toBe(true);
    }
  });
});

describe('hands over: go', () => {
  const leading: TakeState = { state: 'leading', switch: 'sw1', term: { number: 9, machine: 'm-b', split: false }, slots: { 'net-a': 'slot-a', c1: 'slot-c1' } };
  const goPhase = (state: TakeState | null, o: Partial<HandSample> = {}) => inPhase('go', { state, ...o }, { copies: ['c1'] });

  it('follows with its own slot when B leads', () => {
    step(goPhase(leading), { do: 'follow', slot: 'slot-a' });
  });

  it('asks again when B leads but names no slot for this machine', () => {
    step(goPhase({ ...leading, slots: { c1: 'slot-c1' } }), { do: 'ask' });
  });

  it('reenters with B reason when B aborted for no_link', () => {
    step(goPhase({ state: 'aborted', switch: 'sw1', follow: TERM, why: 'no_link' }), { do: 'reenter', ...reason('no_link') });
  });

  it('reenters behind when B aborted without a reason', () => {
    step(goPhase({ state: 'aborted', switch: 'sw1', follow: TERM, why: null }), { do: 'reenter', ...reason('behind') });
  });

  it('reenters no_answer when B knows nothing of the switch', () => {
    step(goPhase({ state: 'none' }), { do: 'reenter', ...reason('no_answer') });
  });

  it('sends go again while B still answers offered', () => {
    step(goPhase({ state: 'offered', switch: 'sw1' }), { do: 'send_go' });
  });

  it('asks while B has not answered', () => {
    step(goPhase(null), { do: 'ask' });
  });

  it('asks when B answers go, which A cannot abort on', () => {
    step(goPhase({ state: 'go', switch: 'sw1' }), { do: 'ask' });
  });

  it('counts a state of another switch as none came', () => {
    step(goPhase({ state: 'aborted', switch: 'other', follow: TERM, why: null }), { do: 'ask' });
    step(goPhase({ ...leading, switch: 'other' }), { do: 'ask' });
    step(goPhase({ state: 'offered', switch: 'other' }), { do: 'ask' });
  });

  it('never aborts after go', () => {
    const states: (TakeState | null)[] = [
      null,
      { state: 'offered', switch: 'sw1' },
      { state: 'go', switch: 'sw1' },
      leading,
      { state: 'offered', switch: 'other' },
      { state: 'aborted', switch: 'other', follow: TERM, why: null }
    ];
    const nows = [0, NOW, DEADLINE - 1, DEADLINE, DEADLINE + 5 * MIN];
    const offers: HandSample['offer'][] = [null, 'waiting', 'accepted', 'refused', 'silent'];
    for (const state of states)
      for (const now of nows)
        for (const offer of offers)
          for (const wConfirmedAt of [null, 1]) {
            const action = nextHandStep(goPhase(state, { now, offer, wConfirmedAt }));
            expect(['ask', 'send_go', 'follow']).toContain(action.do);
          }
  });
});

describe('hands over: followed and aborted', () => {
  it('follows with the stored slot once followed', () => {
    step(inPhase('followed', {}, { slot: 'slot-a' }), { do: 'follow', slot: 'slot-a' });
  });

  it('does nothing when followed holds no slot', () => {
    step(inPhase('followed'), { do: 'none' });
  });

  it('fails the request with the stored reason once an aborted A leads again', () => {
    step(inPhase('aborted', { leads: true }, { reason: 'behind' }), { do: 'fail', ...reason('behind') });
    step(inPhase('aborted', { leads: true }, { reason: 'not_ready' }), { do: 'fail', ...reason('not_ready') });
  });

  it('fails no_answer when an aborted phase stored no reason', () => {
    step(inPhase('aborted', { leads: true }), { do: 'fail', ...reason('no_answer') });
  });

  it('waits to lead again while aborted', () => {
    step(inPhase('aborted', { leads: false }, { reason: 'behind' }), { do: 'none' });
  });
});

const taking = (phase: Taking['phase'], o: Partial<Taking> = {}): Taking => ({
  switch: 'sw1',
  from: { networkId: 'net-a' },
  term: TERM,
  at: NOW - 1000,
  deadline: NOW + 1000,
  phase,
  w: '0/1000',
  copies: [],
  slots: null,
  why: null,
  ...o
});

const take = (phase: Taking['phase'], o: Partial<TakeSample> = {}, t: Partial<Taking> = {}): TakeSample => ({
  now: NOW,
  taking: taking(phase, t),
  termWritten: false,
  registered: true,
  probed: true,
  appLeads: false,
  ...o
});

const took = (s: TakeSample, a: TakeAction) => expect(nextTakeStep(s)).toEqual(a);

describe('takes over', () => {
  it('does nothing without taking', () => {
    took({ ...take('go'), taking: null }, { do: 'none' });
  });

  it('expires an offer at its deadline', () => {
    took(take('offered', { now: NOW + 1000 }), { do: 'expire' });
    took(take('offered', { now: NOW + 5000 }), { do: 'expire' });
  });

  it('waits on an offer before its deadline', () => {
    took(take('offered', { now: NOW + 999 }), { do: 'none' });
  });

  it('promotes at once when the term is written, even past the deadline', () => {
    took(take('go', { termWritten: true, registered: false, probed: false }), { do: 'promote' });
    took(take('go', { termWritten: true, now: NOW + 5000 }), { do: 'promote' });
  });

  it('never promotes after the deadline unless the term is written', () => {
    took(take('go', { now: NOW + 1000 }), { do: 'abort', why: 'no_link' });
    took(take('go', { now: NOW + 1001 }), { do: 'abort', why: 'no_link' });
    took(take('go', { now: NOW + 1001, termWritten: true }), { do: 'promote' });
  });

  it('aborts no_link at the deadline even before it registered', () => {
    took(take('go', { now: NOW + 1000, registered: false, probed: false }), { do: 'abort', why: 'no_link' });
  });

  it('registers first when the link name is not registered', () => {
    took(take('go', { registered: false, probed: false }), { do: 'register' });
    took(take('go', { registered: false, probed: true }), { do: 'register' });
  });

  it('probes once registered and not yet probed', () => {
    took(take('go', { probed: false }), { do: 'probe' });
  });

  it('promotes once registered and probed before the deadline', () => {
    took(take('go', { now: NOW + 999 }), { do: 'promote' });
  });

  it('is done once promoted and the app leads', () => {
    took(take('promoted', { appLeads: true }), { do: 'done' });
  });

  it('leads once promoted and the app does not lead yet', () => {
    took(take('promoted'), { do: 'lead' });
  });

  it('forgets an aborted taking after 10 minutes', () => {
    took(take('aborted', { now: NOW - 1000 + 10 * MIN }), { do: 'forget' });
    took(take('aborted', { now: NOW - 1000 + 10 * MIN + 1 }), { do: 'forget' });
  });

  it('keeps an aborted taking for 10 minutes', () => {
    took(take('aborted', { now: NOW - 1000 + 10 * MIN - 1 }), { do: 'none' });
  });
});

describe('takeState', () => {
  const handover = { switch: 'sw1', term: { number: 9, machine: 'm-b', split: false }, slots: { 'net-a': 'slot-a' } };
  const leadingOf: TakeState = { state: 'leading', switch: 'sw1', term: handover.term, slots: handover.slots };

  it('answers none with neither a taking nor a handover', () => {
    expect(takeState(null, null)).toEqual({ state: 'none' });
  });

  it.each<Taking['phase']>(['offered', 'go', 'promoted', 'aborted'])('answers leading from the handover alone, in phase %s', (phase) => {
    expect(takeState(taking(phase), handover)).toEqual(leadingOf);
  });

  it('answers leading from the handover once the taking is gone', () => {
    expect(takeState(null, handover)).toEqual(leadingOf);
  });

  it('answers offered with the switch', () => {
    expect(takeState(taking('offered'), null)).toEqual({ state: 'offered', switch: 'sw1' });
  });

  it('answers go in phase go with no handover', () => {
    expect(takeState(taking('go'), null)).toEqual({ state: 'go', switch: 'sw1' });
  });

  it('answers go in phase promoted with no handover yet, since the term is written', () => {
    expect(takeState(taking('promoted'), null)).toEqual({ state: 'go', switch: 'sw1' });
  });

  it('answers aborted with the follow term one above the old leader term, and the reason', () => {
    const own = taking('aborted', { why: 'no_link' });
    expect(takeState(own, null)).toEqual({
      state: 'aborted',
      switch: 'sw1',
      follow: { number: 8, machine: 'm-a', split: false },
      why: 'no_link'
    });
    expect(takeState(taking('aborted'), null)).toMatchObject({ state: 'aborted', why: null });
  });
});
