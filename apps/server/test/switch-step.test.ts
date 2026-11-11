import { describe, expect, it } from 'vitest';
import {
  ABORTED_KEEP_MS, BEHIND_MS, GO_LOOK_MS, MOVE_WAIT_MS, nextHandStep, nextTakeStep, OTHERS_WAIT_MS, SWITCH_MS, takeState,
  type Handing, type HandSample, type TakeSample, type TakeState, type Taking,
} from '../src/modules/keeper/switch-step.js';

const A = 'a0a0a0a0'.repeat(4);
const B = 'b0b0b0b0'.repeat(4);
const C = 'c0c0c0c0'.repeat(4);
const D = 'd0d0d0d0'.repeat(4);
const SWITCH = '0f0f0f0f-0000-4000-8000-00000000000a';
const OTHER = '0f0f0f0f-0000-4000-8000-00000000000b';
const T0 = 1_000_000;
const DEADLINE = T0 + SWITCH_MS;
/* The last moment a go may be sent: the target needs what is left to take the link and promote. */
const CUT = DEADLINE - BEHIND_MS;
const TERM = { number: 7, machine: A, split: false };

const handing = (over: Partial<Handing> = {}): Handing => ({
  switch: SWITCH, to: { machine: 'b', networkId: B, hostname: 'b-host' }, term: TERM, at: T0, deadline: DEADLINE, phase: 'offered', fenced: false, w: null, copies: null, slot: null, reason: null, ...over,
});
const move = (over: Partial<NonNullable<HandSample['move']>> = {}): NonNullable<HandSample['move']> => ({ request: SWITCH, networkId: B, state: 'preparing', askedAt: T0, endedAt: null, ...over });
const READY = { numbered: true, data: true, named: true, onStored: true, pace: true };
const hand = (over: Partial<HandSample> = {}): HandSample => ({
  now: T0, handing: null, move: null, target: READY, leads: true, updating: false, offer: null, wConfirmedAt: null, othersAtW: [], othersOnline: [], state: null, ...over,
});
const stopped = (over: Partial<Handing> = {}) => handing({ phase: 'stopped', fenced: true, w: '0/3000000', ...over });
const going = (over: Partial<Handing> = {}) => handing({ phase: 'go', fenced: true, w: '0/3000000', copies: [C], ...over });
const NONE = { do: 'none' };

describe('handing the server over', () => {
  it('forgets a failed request a day after it ended', () => {
    expect(nextHandStep(hand({ move: move({ state: 'failed', endedAt: T0 }), now: T0 + MOVE_WAIT_MS + 1 }))).toEqual({ do: 'forget' });
    expect(nextHandStep(hand({ move: move({ state: 'failed', endedAt: T0 }), now: T0 + MOVE_WAIT_MS }))).toEqual(NONE);
  });

  it('fails a request that prepared for a day as expired', () => {
    expect(nextHandStep(hand({ move: move(), now: T0 + MOVE_WAIT_MS + 1 }))).toEqual({ do: 'fail', reason: 'expired' });
  });

  it('fails a request whose target left, lost its place or lost the data', () => {
    for (const target of [null, { ...READY, numbered: false }, { ...READY, data: false }]) expect(nextHandStep(hand({ move: move(), target })), JSON.stringify(target)).toEqual({ do: 'fail', reason: 'left' });
  });

  it('offers once the target is named, the relay knows it and it keeps pace', () => {
    expect(nextHandStep(hand({ move: move() }))).toEqual({ do: 'offer' });
    /* Not while this machine does not lead, while an update runs, or before the copy is the one commits wait for. */
    const waits: Partial<HandSample>[] = [{ leads: false }, { updating: true }, { target: { ...READY, named: false } }, { target: { ...READY, onStored: false } }, { target: { ...READY, pace: false } }];
    for (const over of waits) expect(nextHandStep(hand({ move: move(), ...over })), JSON.stringify(over)).toEqual(NONE);
  });

  it('fails a request that was claimed and never offered', () => {
    expect(nextHandStep(hand({ move: move({ state: 'switching' }) }))).toEqual({ do: 'fail', reason: 'no_answer' });
  });

  it('does nothing with no request', () => {
    expect(nextHandStep(hand())).toEqual(NONE);
  });

  it('aborts an offer the target refused, or did not answer', () => {
    expect(nextHandStep(hand({ handing: handing(), offer: 'refused' }))).toEqual({ do: 'abort', reason: 'not_ready' });
    expect(nextHandStep(hand({ handing: handing(), offer: 'silent' }))).toEqual({ do: 'abort', reason: 'no_answer' });
    /* A keeper that started again does not know what became of its offer. */
    expect(nextHandStep(hand({ handing: handing(), offer: null }))).toEqual({ do: 'abort', reason: 'no_answer' });
  });

  it('stops once the offer is accepted, and waits for the answer until then', () => {
    expect(nextHandStep(hand({ handing: handing(), offer: 'accepted' }))).toEqual({ do: 'stop' });
    expect(nextHandStep(hand({ handing: handing(), offer: 'waiting' }))).toEqual(NONE);
  });

  it('fences again before reading W', () => {
    expect(nextHandStep(hand({ handing: stopped({ fenced: false, w: null }) }))).toEqual({ do: 'fence' });
    expect(nextHandStep(hand({ handing: stopped({ fenced: false }) }))).toEqual({ do: 'fence' });
    expect(nextHandStep(hand({ handing: stopped({ w: null }) }))).toEqual({ do: 'read_w' });
  });

  it('aborts behind when the target has not confirmed W 10 s before the deadline', () => {
    expect(nextHandStep(hand({ handing: stopped(), now: CUT - 1 }))).toEqual(NONE);
    expect(nextHandStep(hand({ handing: stopped(), now: CUT }))).toEqual({ do: 'abort', reason: 'behind' });
  });

  it('says go once the target and every other copy that is there confirmed W', () => {
    expect(nextHandStep(hand({ handing: stopped(), wConfirmedAt: T0 + 100, now: T0 + 100 }))).toEqual({ do: 'go', copies: [] });
    expect(nextHandStep(hand({ handing: stopped(), wConfirmedAt: T0 + 100, now: T0 + 200, othersOnline: [C, D], othersAtW: [D, C] }))).toEqual({ do: 'go', copies: [D, C] });
    expect(nextHandStep(hand({ handing: stopped(), wConfirmedAt: T0 + 100, now: T0 + 200, othersOnline: [C, D], othersAtW: [C] }))).toEqual(NONE);
  });

  it('says go without the copies that did not come in 10 s', () => {
    const late = { handing: stopped(), wConfirmedAt: T0 + 100, othersOnline: [C, D], othersAtW: [C] };
    expect(nextHandStep(hand({ ...late, now: T0 + 100 + OTHERS_WAIT_MS - 1 }))).toEqual(NONE);
    expect(nextHandStep(hand({ ...late, now: T0 + 100 + OTHERS_WAIT_MS }))).toEqual({ do: 'go', copies: [C] });
  });

  it('says go at the last look before the deadline leaves too little time', () => {
    const late = { handing: stopped(), wConfirmedAt: CUT - 3_000, othersOnline: [C], othersAtW: [] };
    expect(nextHandStep(hand({ ...late, now: CUT - GO_LOOK_MS - 1 }))).toEqual(NONE);
    expect(nextHandStep(hand({ ...late, now: CUT - GO_LOOK_MS }))).toEqual({ do: 'go', copies: [] });
    expect(nextHandStep(hand({ ...late, now: CUT }))).toEqual({ do: 'go', copies: [] });
  });

  it('sends go before the deadline or not at all', () => {
    for (const fenced of [true, false]) for (const w of ['0/3000000', null]) for (const wConfirmedAt of [null, T0 + 100, CUT - 1, CUT + 5]) for (const others of [[], [C]]) {
      for (const now of [T0, CUT - GO_LOOK_MS, CUT, CUT + 1, DEADLINE, DEADLINE + 60_000]) {
        const action = nextHandStep(hand({ handing: stopped({ fenced, w }), wConfirmedAt, othersOnline: [C], othersAtW: others, now }));
        if (action.do === 'go') expect(now, JSON.stringify({ fenced, w, wConfirmedAt, others })).toBeLessThanOrEqual(CUT);
        /* Past that moment nothing is left but to give the switch up, once the fence stands. */
        if (now > CUT && fenced && w) expect(action).toEqual({ do: 'abort', reason: 'behind' });
      }
    }
  });

  it('follows once the target says it leads, with the slot it made for this machine', () => {
    const leading: TakeState = { state: 'leading', switch: SWITCH, term: { number: 9, machine: B, split: false }, slots: { [A]: 'copy_a0a0a0a0a0a0a0a0_3', [C]: 'copy_c0c0c0c0c0c0c0c0_2' } };
    expect(nextHandStep(hand({ handing: going(), state: leading }))).toEqual({ do: 'follow', slot: 'copy_a0a0a0a0a0a0a0a0_3' });
    /* A record that names no slot for this machine is asked for again. */
    expect(nextHandStep(hand({ handing: going(), state: { ...leading, slots: {} } }))).toEqual({ do: 'ask' });
    expect(nextHandStep(hand({ handing: going({ phase: 'followed', slot: 'copy_a0a0a0a0a0a0a0a0_3' }) }))).toEqual({ do: 'follow', slot: 'copy_a0a0a0a0a0a0a0a0_3' });
  });

  it('leads again only on the word of the target', () => {
    const follow = { number: 8, machine: A, split: false };
    expect(nextHandStep(hand({ handing: going(), state: { state: 'aborted', switch: SWITCH, follow, why: 'no_link' } }))).toEqual({ do: 'reenter', reason: 'no_link' });
    expect(nextHandStep(hand({ handing: going(), state: { state: 'aborted', switch: SWITCH, follow, why: null } }))).toEqual({ do: 'reenter', reason: 'behind' });
    expect(nextHandStep(hand({ handing: going(), state: { state: 'none' } }))).toEqual({ do: 'reenter', reason: 'no_answer' });
  });

  it('sends go again while the target still says offered, and asks while it says nothing', () => {
    expect(nextHandStep(hand({ handing: going(), state: { state: 'offered', switch: SWITCH } }))).toEqual({ do: 'send_go' });
    expect(nextHandStep(hand({ handing: going(), state: { state: 'go', switch: SWITCH } }))).toEqual({ do: 'ask' });
    expect(nextHandStep(hand({ handing: going(), state: null }))).toEqual({ do: 'ask' });
    /* An answer about another switch is no answer about this one. */
    expect(nextHandStep(hand({ handing: going(), state: { state: 'aborted', switch: OTHER, follow: TERM, why: null } }))).toEqual({ do: 'ask' });
    expect(nextHandStep(hand({ handing: going(), state: { state: 'leading', switch: OTHER, term: TERM, slots: { [A]: 'x' } } }))).toEqual({ do: 'ask' });
  });

  it('never aborts after go', () => {
    const states: (TakeState | null)[] = [null, { state: 'offered', switch: SWITCH }, { state: 'go', switch: SWITCH }, { state: 'leading', switch: SWITCH, term: TERM, slots: { [A]: 's' } }, { state: 'leading', switch: SWITCH, term: TERM, slots: {} }];
    for (const state of states) for (const now of [T0, CUT, DEADLINE + 1, DEADLINE + 3_600_000]) for (const offer of [null, 'accepted', 'silent', 'refused'] as const) for (const wConfirmedAt of [null, T0]) for (const leads of [true, false]) {
      const action = nextHandStep(hand({ handing: going(), state, now, offer, wConfirmedAt, leads }));
      expect(['ask', 'send_go', 'follow'], JSON.stringify({ state, now, offer })).toContain(action.do);
    }
  });

  it('marks the request failed once it leads again after an abort', () => {
    expect(nextHandStep(hand({ handing: handing({ phase: 'aborted', reason: 'behind' }), leads: true }))).toEqual({ do: 'fail', reason: 'behind' });
    expect(nextHandStep(hand({ handing: handing({ phase: 'aborted', reason: 'behind' }), leads: false }))).toEqual(NONE);
  });
});

const taking = (over: Partial<Taking> = {}): Taking => ({ switch: SWITCH, from: { networkId: A }, term: TERM, at: T0, deadline: DEADLINE, phase: 'offered', w: null, copies: null, slots: null, why: null, ...over });
const take = (over: Partial<TakeSample> = {}): TakeSample => ({ now: T0, taking: null, termWritten: false, registered: false, probed: false, appLeads: false, ...over });
const told = (over: Partial<Taking> = {}) => taking({ phase: 'go', w: '0/3000000', copies: [C], ...over });

describe('taking the server over', () => {
  it('does nothing with no offer', () => {
    expect(nextTakeStep(take())).toEqual(NONE);
  });

  it('ends an offer at its deadline', () => {
    expect(nextTakeStep(take({ taking: taking(), now: DEADLINE - 1 }))).toEqual(NONE);
    expect(nextTakeStep(take({ taking: taking(), now: DEADLINE }))).toEqual({ do: 'expire' });
  });

  it('takes the link, checks it, and promotes', () => {
    expect(nextTakeStep(take({ taking: told() }))).toEqual({ do: 'register' });
    expect(nextTakeStep(take({ taking: told(), registered: true }))).toEqual({ do: 'probe' });
    expect(nextTakeStep(take({ taking: told(), registered: true, probed: true }))).toEqual({ do: 'promote' });
  });

  it('never promotes after the deadline unless the term is written', () => {
    expect(nextTakeStep(take({ taking: told(), now: DEADLINE, registered: true, probed: true }))).toEqual({ do: 'abort', why: 'no_link' });
    expect(nextTakeStep(take({ taking: told(), now: DEADLINE + 60_000 }))).toEqual({ do: 'abort', why: 'no_link' });
    /* Its term written, there is no way back: it goes on, whatever the time and whatever a restart forgot. */
    expect(nextTakeStep(take({ taking: told(), now: DEADLINE + 60_000, termWritten: true }))).toEqual({ do: 'promote' });
  });

  it('leads once promoted, and is done once its app leads', () => {
    expect(nextTakeStep(take({ taking: told({ phase: 'promoted' }) }))).toEqual({ do: 'lead' });
    expect(nextTakeStep(take({ taking: told({ phase: 'promoted' }), appLeads: true }))).toEqual({ do: 'done' });
  });

  it('keeps an abort for ten minutes', () => {
    const aborted = told({ phase: 'aborted', why: 'no_link', at: T0 });
    expect(nextTakeStep(take({ taking: aborted, now: T0 + ABORTED_KEEP_MS - 1 }))).toEqual(NONE);
    expect(nextTakeStep(take({ taking: aborted, now: T0 + ABORTED_KEEP_MS }))).toEqual({ do: 'forget' });
  });
});

describe('what the target says of a switch', () => {
  const handover = { switch: SWITCH, term: { number: 9, machine: B, split: false }, slots: { [A]: 'copy_a0a0a0a0a0a0a0a0_3' } };

  it('leads only by the handover it recorded, whatever its phase', () => {
    for (const one of [null, taking(), told(), told({ phase: 'promoted' }), told({ phase: 'aborted' })]) {
      expect(takeState(one, handover)).toEqual({ state: 'leading', switch: SWITCH, term: handover.term, slots: handover.slots });
    }
  });

  it('says none, offered or go until then', () => {
    expect(takeState(null, null)).toEqual({ state: 'none' });
    expect(takeState(taking(), null)).toEqual({ state: 'offered', switch: SWITCH });
    expect(takeState(told(), null)).toEqual({ state: 'go', switch: SWITCH });
    /* Its term written and no handover yet: still go, which the old leader cannot abort on. */
    expect(takeState(told({ phase: 'promoted' }), null)).toEqual({ state: 'go', switch: SWITCH });
  });

  it('tells the old leader the term to lead again under', () => {
    expect(takeState(told({ phase: 'aborted', why: 'no_link' }), null)).toEqual({ state: 'aborted', switch: SWITCH, follow: { number: 8, machine: A, split: false }, why: 'no_link' });
    expect(takeState(taking({ phase: 'aborted' }), null)).toMatchObject({ state: 'aborted', why: null });
  });
});
