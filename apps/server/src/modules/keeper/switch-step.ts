import type { Term } from '../../db/net.js';

/* The decisions of a planned switch, as two pure functions: what the keeper that hands the server over does next, and
   what the keeper that takes it does next. No clock, file or database here: each is given a sample of what its keeper
   saw and answers one act. */

/* The deadline of a switch: the offer's time plus this. */
export const SWITCH_MS = 60_000;
export const OFFER_WAIT_MS = 5_000;
/* How long the other copies are waited for after the target confirmed W. */
export const OTHERS_WAIT_MS = 10_000;
/* The target must have confirmed W this long before the deadline: what is left is its time to take the link and
   promote. */
export const BEHIND_MS = 10_000;
/* A request that prepared this long fails as expired, and a failed one is forgotten this long after it ended. */
export const MOVE_WAIT_MS = 86_400_000;
export const ABORTED_KEEP_MS = 600_000;
/* A keeper looks once in this long, so the last look before go would come too late sends it with the copies that are
   there by then. */
export const GO_LOOK_MS = 1_000;

export type MoveReason = 'no_answer' | 'not_ready' | 'behind' | 'no_link' | 'expired' | 'left';

/* What the keeper that hands over wrote down. switch: the request's id. fenced: the front door closed and the lease
   fenced, in this phase. w: where its log ended once it was fenced. copies: the other copies that reached W. slot: the
   slot the new leader made for this machine. */
export type Handing = {
  switch: string; to: { machine: string; networkId: string; hostname: string }; term: Term; at: number; deadline: number;
  phase: 'offered' | 'stopped' | 'go' | 'followed' | 'aborted'; fenced: boolean; w: string | null; copies: string[] | null; slot: string | null; reason: MoveReason | null;
};

/* What the target answers when asked of a switch. follow: the term the old leader leads again under. */
export type TakeState =
  | { state: 'none' }
  | { state: 'offered' | 'go'; switch: string }
  | { state: 'leading'; switch: string; term: Term; slots: Record<string, string> }
  | { state: 'aborted'; switch: string; follow: Term; why: 'no_link' | null };

/* One look of the keeper that hands over. target: the machine the request names, null once it left. offer: what became
   of the offer this keeper sent. wConfirmedAt: when the target's slot was first seen at or past W. othersOnline: the
   other copies that are ready and read; othersAtW: those of them whose slot confirmed W. state: the target's answer,
   null while none came. */
export type HandSample = {
  now: number; handing: Handing | null;
  move: { request: string; networkId: string; state: 'preparing' | 'switching' | 'failed'; askedAt: number; endedAt: number | null } | null;
  target: { numbered: boolean; data: boolean; named: boolean; onStored: boolean; pace: boolean } | null;
  leads: boolean; updating: boolean; offer: 'waiting' | 'accepted' | 'refused' | 'silent' | null;
  wConfirmedAt: number | null; othersAtW: string[]; othersOnline: string[]; state: TakeState | null;
};

/* abort and reenter write the phase aborted with the reason; fail marks the request failed; send_go sends the stored
   go again. */
export type HandAction =
  | { do: 'none' } | { do: 'offer' } | { do: 'stop' } | { do: 'fence' } | { do: 'read_w' }
  | { do: 'go'; copies: string[] } | { do: 'send_go' } | { do: 'abort'; reason: MoveReason }
  | { do: 'reenter'; reason: MoveReason } | { do: 'ask' } | { do: 'follow'; slot: string }
  | { do: 'fail'; reason: MoveReason } | { do: 'forget' };

const NONE = { do: 'none' } as const;

/* With nothing written down: a request waits for its target to be the copy commits wait for, and ends when it waited
   a day or its target left: its row is gone, or it has no number any more. A machine with a number that holds no copy
   yet is being given one, since the request is stored before the ranking that gives its machine the data. */
function requested(s: HandSample): HandAction {
  const { move, target, now } = s;
  if (!move) return NONE;
  if (move.state === 'failed') return move.endedAt !== null && now - move.endedAt > MOVE_WAIT_MS ? { do: 'forget' } : NONE;
  if (move.state === 'switching') return { do: 'fail', reason: 'no_answer' };
  if (now - move.askedAt > MOVE_WAIT_MS) return { do: 'fail', reason: 'expired' };
  if (!target || !target.numbered) return { do: 'fail', reason: 'left' };
  return s.leads && !s.updating && target.data && target.named && target.onStored && target.pace ? { do: 'offer' } : NONE;
}

/* Stopped: the fence first, then W, then the target at W, then the other copies for a while. A go is sent while the
   target has its time left before the deadline, and never after: past that moment the switch is given up. */
function stopped(s: HandSample, handing: Handing): HandAction {
  if (!handing.fenced) return { do: 'fence' };
  if (handing.w === null) return { do: 'read_w' };
  const last = handing.deadline - BEHIND_MS;
  if (s.now > last || (s.wConfirmedAt === null && s.now >= last)) return { do: 'abort', reason: 'behind' };
  if (s.wConfirmedAt === null) return NONE;
  const all = s.othersOnline.every(copy => s.othersAtW.includes(copy));
  return all || s.now >= s.wConfirmedAt + OTHERS_WAIT_MS || s.now >= last - GO_LOOK_MS ? { do: 'go', copies: s.othersAtW } : NONE;
}

/* After go only the target's word counts: it leads, it gave the switch up, or it never took the go. An answer about
   another switch is no answer. */
function gone(s: HandSample, handing: Handing): HandAction {
  const state = s.state && (s.state.state === 'none' || s.state.switch === handing.switch) ? s.state : null;
  if (state?.state === 'leading') {
    const slot = state.slots[handing.term.machine];
    return slot ? { do: 'follow', slot } : { do: 'ask' };
  }
  if (state?.state === 'aborted') return { do: 'reenter', reason: state.why ?? 'behind' };
  if (state?.state === 'none') return { do: 'reenter', reason: 'no_answer' };
  return state?.state === 'offered' ? { do: 'send_go' } : { do: 'ask' };
}

/* What the keeper that hands the server over does next. An abort is its own and comes only before go. */
export function nextHandStep(s: HandSample): HandAction {
  const { handing } = s;
  if (!handing) return requested(s);
  switch (handing.phase) {
    case 'offered':
      if (s.offer === 'refused') return { do: 'abort', reason: 'not_ready' };
      if (s.offer === 'silent' || s.offer === null) return { do: 'abort', reason: 'no_answer' };
      return s.offer === 'accepted' ? { do: 'stop' } : NONE;
    case 'stopped':
      return stopped(s, handing);
    case 'go':
      return gone(s, handing);
    case 'followed':
      return handing.slot ? { do: 'follow', slot: handing.slot } : { do: 'ask' };
    case 'aborted':
      return s.leads ? { do: 'fail', reason: handing.reason ?? 'no_answer' } : NONE;
  }
}

/* What the keeper that takes the server wrote down. from: the machine that offered, as its link named it leader then,
   with the name it goes by; go, abort and state are taken from it alone. slots: the slots it made at promotion. */
/* kind: a planned switch when left out; a takeover by the copy that held every confirmed change, or the CEO's choice
   of a copy to go on from. For those two: heard, when the old leader's last beat came, by the wall clock; reach, how
   far this copy's changes reached; full, whether that last beat said the leader's disk is full; generation, the
   route's generation at which its window saw the name free. */
export type Taking = {
  switch: string; from: { networkId: string; hostname?: string }; term: Term; at: number; deadline: number;
  phase: 'offered' | 'go' | 'promoted' | 'aborted'; w: string | null; copies: string[] | null; slots: Record<string, string> | null; why: 'no_link' | null;
  kind?: 'planned' | 'takeover' | 'ceo'; heard?: number | null; reach?: string | null; full?: boolean; generation?: number;
};

/* foreign: for a takeover, another registration of the company's name was seen since the window this copy decided on. */
export type TakeSample = { now: number; taking: Taking | null; termWritten: boolean; registered: boolean; probed: boolean; appLeads: boolean; foreign?: boolean };

type TakeAction =
  | { do: 'none' } | { do: 'expire' } | { do: 'register' } | { do: 'probe' } | { do: 'promote' }
  | { do: 'abort'; why: 'no_link' } | { do: 'lead' } | { do: 'done' } | { do: 'forget' };

/* What the keeper that takes the server does next. Its term written, there is no abort: it promotes, whatever the
   time. Before that, a deadline that passed ends the attempt. */
export function nextTakeStep(s: TakeSample): TakeAction {
  const { taking, now } = s;
  if (!taking) return NONE;
  switch (taking.phase) {
    case 'offered':
      return now >= taking.deadline ? { do: 'expire' } : NONE;
    case 'go':
      if (s.termWritten) return { do: 'promote' };
      /* A copy that takes over by itself never promotes once anyone registered the name since its window. */
      if ((taking.kind ?? 'planned') !== 'planned' && s.foreign) return { do: 'abort', why: 'no_link' };
      if (now >= taking.deadline) return { do: 'abort', why: 'no_link' };
      if (!s.registered) return { do: 'register' };
      return s.probed ? { do: 'promote' } : { do: 'probe' };
    case 'promoted':
      return s.appLeads ? { do: 'done' } : { do: 'lead' };
    case 'aborted':
      return now >= taking.at + ABORTED_KEEP_MS ? { do: 'forget' } : NONE;
  }
}

/* What the target answers of a switch: that it leads only by the handover it recorded, with every slot; with its term
   written and no handover yet, go, which the old leader cannot abort on. */
export function takeState(taking: Taking | null, handover: { switch: string; term: Term; slots: Record<string, string> } | null): TakeState {
  if (handover) return { state: 'leading', switch: handover.switch, term: handover.term, slots: handover.slots };
  if (!taking) return { state: 'none' };
  if (taking.phase === 'aborted') return { state: 'aborted', switch: taking.switch, follow: { number: taking.term.number + 1, machine: taking.from.networkId, split: false }, why: taking.why };
  return { state: taking.phase === 'offered' ? 'offered' : 'go', switch: taking.switch };
}
