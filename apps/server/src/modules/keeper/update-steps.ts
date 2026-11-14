import type { UpdaterStatus } from '../updates/control.js';

/* What the keeper of the machine that leads does for an update while other machines keep copies, as one pure function:
   it has the copies promise to wait, tells the updater when its dump holds everything the copies confirmed, keeps
   commits from waiting for a copy while migrations run, and drops the copies' slots before a database is put back. No
   clock, file or database here: it is given a sample of what its keeper saw and answers one act. */

/* For how long the copies are told the company is updating, from each promise on. */
export const PROMISE_MS = 900_000;
export const PROMISE_AGAIN_MS = 300_000;
/* How long one copy has to answer a promise. */
export const ANSWER_MS = 10_000;
/* How long the copies have to confirm where the leader's log ended before the dump. */
export const W_WAIT_MS = 60_000;

/* What the keeper keeps of the update it works on. promised: the copies it asked, by network id. answered: the updater
   has its answer. w: where the log ended once the app was stopped. stopped: the copies were told to stop applying.
   stopAcks: those that said they did. settled: the updater was told whether its dump may go on. dropped: the slots
   went, before a restore. */
export type UpdateMemory = {
  id: string; version: string; migrations: number | null; promised: string[]; promisedAt: number; answered: boolean;
  w: string | null; wAt: number | null; stopped: boolean; stopAcks: string[]; settled: boolean; dropped: boolean;
};

/* One look. online: the copies that are in step now. answers: what each promised copy said to the last promise, once
   all came or their time ran out. inFlight: a request to the copies is out. maintenance: the lease is in maintenance,
   so the app's sessions ended. atW: the promised copies whose slot holds memory.w. held: commits wait for no copy, and
   the relay knows. */
export type UpdateSample = {
  now: number;
  status: { id: string; version: string; state: UpdaterStatus['state']; step: UpdaterStatus['step']; migrations: number | null; restore: boolean } | null;
  memory: UpdateMemory | null;
  online: string[];
  answers: Record<string, 'ok' | 'refused' | 'silent'> | null;
  inFlight: boolean; maintenance: boolean; leads: boolean; atW: string[]; held: boolean;
};

/* answer: what the updater is told of the promise; a no names the first copy that did not promise. */
export type UpdateAction =
  | { do: 'none' } | { do: 'promise'; to: string[] } | { do: 'answer'; ok: boolean; why: { copy: string; said: 'refused' | 'silent' } | null }
  | { do: 'promise_again' } | { do: 'begin' } | { do: 'stop_copies' } | { do: 'settle'; ok: boolean }
  | { do: 'drop_slots' } | { do: 'end' };

const NONE = { do: 'none' } as const;

/* The dump waits for the copies: once every one holds W it may go on, after the copies stopped where migrations are to
   run; a copy that does not get there within a minute ends the update with nothing changed. */
function settling(s: UpdateSample, m: UpdateMemory, migrations: number | null): UpdateAction | null {
  if (m.w === null || m.settled) return null;
  const all = m.promised.every(copy => s.atW.includes(copy));
  /* A company whose data only this machine keeps has nobody to stop, and no migration needs the copies stopped when
     none is to run. */
  const stops = migrations !== 0 && m.promised.length > 0;
  if (all && stops && !m.stopped) return { do: 'stop_copies' };
  if (all && !stops) return { do: 'settle', ok: true };
  const acked = m.promised.every(copy => m.stopAcks.includes(copy));
  if (m.stopped && all && acked && s.held) return { do: 'settle', ok: true };
  if (m.wAt !== null && s.now >= m.wAt + W_WAIT_MS) return { do: 'settle', ok: false };
  return m.stopped && !acked && !s.inFlight ? { do: 'stop_copies' } : null;
}

/* The first row that fits, as the plan's table has them. */
export function nextUpdateStep(s: UpdateSample): UpdateAction {
  const { status } = s;
  if (!status || status.state !== 'running') return s.memory && s.leads ? { do: 'end' } : NONE;
  const memory = s.memory?.id === status.id ? s.memory : null;
  /* An update whose updater asked nothing, as one of a build before, runs without the keeper. */
  if (!memory) return status.step === 'promise' ? { do: 'promise', to: s.online } : NONE;
  if (status.step === 'promise') {
    if (memory.answered) return NONE;
    if (s.answers === null) return s.inFlight ? NONE : { do: 'promise', to: memory.promised };
    const failed = memory.promised.find(copy => s.answers![copy] !== 'ok');
    return failed === undefined ? { do: 'answer', ok: true, why: null } : { do: 'answer', ok: false, why: { copy: failed, said: s.answers[failed] === 'refused' ? 'refused' : 'silent' } };
  }
  if (memory.promised.length > 0 && s.now >= memory.promisedAt + PROMISE_AGAIN_MS) return { do: 'promise_again' };
  if (status.step === 'backup' && s.maintenance && memory.w === null) return { do: 'begin' };
  const settle = settling(s, memory, status.migrations);
  if (settle) return settle;
  return status.restore && !memory.dropped ? { do: 'drop_slots' } : NONE;
}
