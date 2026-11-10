import type { Term } from '../../db/net.js';

/* The deadline: the offer's time plus this. */
export const SWITCH_MS = 60_000;
export const OFFER_WAIT_MS = 5_000;
/* The other copies get this long after B confirmed W. */
export const OTHERS_WAIT_MS = 10_000;
/* B must confirm W this long before the deadline, so that go reaches it in time. */
export const BEHIND_MS = 10_000;
/* A request that stays preparing this long fails as expired, and a failed one is forgotten this long after its end. */
export const MOVE_WAIT_MS = 86_400_000;
export const ABORTED_KEEP_MS = 600_000;

export type MoveReason = 'no_answer' | 'not_ready' | 'behind' | 'no_link' | 'expired' | 'left';

/* switch is the request's id; fenced means the front door closed and LeaseStore.fence() returned, in this phase. */
export type Handing = {
  switch: string;
  to: { machine: string; networkId: string; hostname: string };
  term: Term;
  at: number;
  deadline: number;
  phase: 'offered' | 'stopped' | 'go' | 'followed' | 'aborted';
  fenced: boolean;
  w: string | null;
  copies: string[] | null;
  slot: string | null;
  reason: MoveReason | null;
};

export type TakeState =
  | { state: 'none' }
  | { state: 'offered' | 'go'; switch: string }
  | { state: 'leading'; switch: string; term: Term; slots: Record<string, string> }
  | { state: 'aborted'; switch: string; follow: Term; why: 'no_link' | null };

/* self is this keeper's own network id, the key of its slot in B's answer.
   wConfirmedAt: when B's slot was first seen at or past W. othersOnline: the other copies whose copy_state is ready and
   that have a walsender. othersAtW: those of them whose slot confirmed W. state: B's answer for this switch, null while
   none came. */
export type HandSample = {
  now: number;
  self: string;
  handing: Handing | null;
  move: { request: string; networkId: string; state: 'preparing' | 'switching' | 'failed'; askedAt: number; endedAt: number | null } | null;
  target: { numbered: boolean; data: boolean; named: boolean; onStored: boolean; pace: boolean } | null;
  leads: boolean;
  updating: boolean;
  offer: 'waiting' | 'accepted' | 'refused' | 'silent' | null;
  wConfirmedAt: number | null;
  othersAtW: string[];
  othersOnline: string[];
  state: TakeState | null;
};

/* abort and reenter write the phase aborted with the reason; fail marks the request failed and, from aborted, removes
   handing.json; send_go sends the stored go again. */
export type HandAction =
  | { do: 'none' }
  | { do: 'offer' }
  | { do: 'stop' }
  | { do: 'fence' }
  | { do: 'read_w' }
  | { do: 'go'; copies: string[] }
  | { do: 'send_go' }
  | { do: 'abort'; reason: MoveReason }
  | { do: 'reenter'; reason: MoveReason }
  | { do: 'ask' }
  | { do: 'follow'; slot: string }
  | { do: 'fail'; reason: MoveReason }
  | { do: 'forget' };

const NONE: HandAction = { do: 'none' };
const fail = (reason: MoveReason): HandAction => ({ do: 'fail', reason });
const abort = (reason: MoveReason): HandAction => ({ do: 'abort', reason });

function waitingToOffer(s: HandSample): boolean {
  const t = s.target;
  return s.leads && !s.updating && t !== null && t.named && t.onStored && t.pace;
}

function targetGone(t: HandSample['target']): boolean {
  return t === null || !t.numbered || !t.data;
}

function stepWithoutHanding(s: HandSample): HandAction {
  const move = s.move;
  if (move === null) return NONE;
  if (move.state === 'failed') {
    return move.endedAt !== null && s.now - move.endedAt > MOVE_WAIT_MS ? { do: 'forget' } : NONE;
  }
  if (move.state === 'switching') return fail('no_answer');
  if (s.now - move.askedAt > MOVE_WAIT_MS) return fail('expired');
  if (targetGone(s.target)) return fail('left');
  return waitingToOffer(s) ? { do: 'offer' } : NONE;
}

const OFFER_ANSWERS: Record<NonNullable<HandSample['offer']>, HandAction> = {
  refused: abort('not_ready'),
  silent: abort('no_answer'),
  accepted: { do: 'stop' },
  waiting: NONE
};

function stepOffered(s: HandSample): HandAction {
  return s.offer === null ? abort('no_answer') : OFFER_ANSWERS[s.offer];
}

function stepStopped(s: HandSample, h: Handing): HandAction {
  if (!h.fenced) return { do: 'fence' };
  if (h.w === null) return { do: 'read_w' };
  const cutoff = h.deadline - BEHIND_MS;
  if (s.wConfirmedAt === null) return s.now >= cutoff ? abort('behind') : NONE;
  const everyoneIn = s.othersOnline.every((id) => s.othersAtW.includes(id));
  const waitedEnough = s.now >= s.wConfirmedAt + OTHERS_WAIT_MS;
  return everyoneIn || waitedEnough || s.now >= cutoff ? { do: 'go', copies: s.othersAtW } : NONE;
}

/* A state of another switch counts as none came. */
function answerOf(s: HandSample, h: Handing): TakeState | null {
  const state = s.state;
  return state !== null && state.state !== 'none' && state.switch !== h.switch ? null : state;
}

function followOwnSlot(s: HandSample, state: Extract<TakeState, { state: 'leading' }>): HandAction {
  const slot = state.slots[s.self];
  return slot === undefined ? { do: 'ask' } : { do: 'follow', slot };
}

/* After go nothing but B's word leads A back: only aborted and none, never a clock. */
function stepGo(s: HandSample, h: Handing): HandAction {
  const state = answerOf(s, h);
  if (state === null) return { do: 'ask' };
  if (state.state === 'leading') return followOwnSlot(s, state);
  if (state.state === 'aborted') return { do: 'reenter', reason: state.why ?? 'behind' };
  if (state.state === 'none') return { do: 'reenter', reason: 'no_answer' };
  return state.state === 'offered' ? { do: 'send_go' } : { do: 'ask' };
}

function stepFollowed(h: Handing): HandAction {
  return h.slot === null ? NONE : { do: 'follow', slot: h.slot };
}

function stepAborted(s: HandSample, h: Handing): HandAction {
  return s.leads ? fail(h.reason ?? 'no_answer') : NONE;
}

export function nextHandStep(s: HandSample): HandAction {
  const h = s.handing;
  if (h === null) return stepWithoutHanding(s);
  switch (h.phase) {
    case 'offered':
      return stepOffered(s);
    case 'stopped':
      return stepStopped(s, h);
    case 'go':
      return stepGo(s, h);
    case 'followed':
      return stepFollowed(h);
    case 'aborted':
      return stepAborted(s, h);
  }
}

/* from: the machine that offered, as B's link named it leader then; go, abort and state are taken from it alone.
   term is the old leader's term as the offer carried it. */
export type Taking = {
  switch: string;
  from: { networkId: string };
  term: Term;
  at: number;
  deadline: number;
  phase: 'offered' | 'go' | 'promoted' | 'aborted';
  w: string | null;
  copies: string[] | null;
  slots: Record<string, string> | null;
  why: 'no_link' | null;
};

export type TakeSample = { now: number; taking: Taking | null; termWritten: boolean; registered: boolean; probed: boolean; appLeads: boolean };

export type TakeAction =
  | { do: 'none' }
  | { do: 'expire' }
  | { do: 'register' }
  | { do: 'probe' }
  | { do: 'promote' }
  | { do: 'abort'; why: 'no_link' }
  | { do: 'lead' }
  | { do: 'done' }
  | { do: 'forget' };

const NOTHING: TakeAction = { do: 'none' };

/* Once the term is written there is no abort: only the deadline before it ends the attempt. */
function stepGoing(s: TakeSample, t: Taking): TakeAction {
  if (s.termWritten) return { do: 'promote' };
  if (s.now >= t.deadline) return { do: 'abort', why: 'no_link' };
  if (!s.registered) return { do: 'register' };
  return s.probed ? { do: 'promote' } : { do: 'probe' };
}

export function nextTakeStep(s: TakeSample): TakeAction {
  const t = s.taking;
  if (t === null) return NOTHING;
  switch (t.phase) {
    case 'offered':
      return s.now >= t.deadline ? { do: 'expire' } : NOTHING;
    case 'go':
      return stepGoing(s, t);
    case 'promoted':
      return s.appLeads ? { do: 'done' } : { do: 'lead' };
    case 'aborted':
      return s.now >= t.at + ABORTED_KEEP_MS ? { do: 'forget' } : NOTHING;
  }
}

/* Leading comes from the handover alone (recorded at promotion step 6); else none, offered, go or aborted from taking.
   A written term with no handover yet is go, which the old leader cannot abort on. An aborted switch answers with the
   term one above the old leader's, for the old leader to lead again under. */
export function takeState(taking: Taking | null, handover: { switch: string; term: Term; slots: Record<string, string> } | null): TakeState {
  if (handover !== null) return { state: 'leading', switch: handover.switch, term: handover.term, slots: handover.slots };
  if (taking === null) return { state: 'none' };
  if (taking.phase === 'offered') return { state: 'offered', switch: taking.switch };
  if (taking.phase !== 'aborted') return { state: 'go', switch: taking.switch };
  return { state: 'aborted', switch: taking.switch, follow: { ...taking.term, number: taking.term.number + 1, split: false }, why: taking.why };
}
