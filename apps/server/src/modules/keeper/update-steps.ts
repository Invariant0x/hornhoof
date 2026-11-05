import type { UpdaterStatus } from '../updates/control.js';

/* "updating until <now + 15 min>". */
export const PROMISE_MS = 900_000;
export const PROMISE_AGAIN_MS = 300_000;
/* One copy's answer to /peer/updating. */
export const ANSWER_MS = 10_000;
export const W_WAIT_MS = 60_000;

export type UpdateMemory = {
  id: string;
  version: string;
  migrations: number | null;
  promised: string[];
  promisedAt: number;
  answered: boolean;
  w: string | null;
  wAt: number | null;
  stopped: boolean;
  stopAcks: string[];
  settled: boolean;
  dropped: boolean;
};

/* online: copies the sync controller has in sync or pace. answers: to the last promise, once every one came or
   ANSWER_MS passed, kept in memory only. hosts: the host name of each copy by network id, for the words of a refusal.
   inFlight: a request to the copies is out. maintenance: the lease's kind is maintenance, the sessions ended. atW:
   promised copies whose slot's confirmed_flush_lsn is at or past memory.w. held: SyncController.held(). stopAcks, in
   the memory: promised copies that answered 200 to { stop: true }. */
export type UpdateSample = {
  now: number;
  status: {
    id: string;
    version: string;
    state: UpdaterStatus['state'];
    /* The promise step is added to UpdaterStatus by the task that changes control.ts; the local part goes then. */
    step: UpdaterStatus['step'] | 'promise';
    migrations: number | null;
    restore: boolean;
  } | null;
  memory: UpdateMemory | null;
  online: string[];
  answers: Record<string, 'ok' | 'refused' | 'silent'> | null;
  hosts: Record<string, string>;
  inFlight: boolean;
  maintenance: boolean;
  leads: boolean;
  atW: string[];
  held: boolean;
};

export type UpdateAction =
  | { do: 'none' }
  | { do: 'promise'; to: string[] }
  | { do: 'answer'; ok: boolean; why: string | null }
  | { do: 'promise_again' }
  | { do: 'begin' }
  | { do: 'stop_copies' }
  | { do: 'settle'; ok: boolean }
  | { do: 'drop_slots' }
  | { do: 'end' };

type Status = NonNullable<UpdateSample['status']>;

const NONE: UpdateAction = { do: 'none' };

const hasAll = (needed: string[], have: string[]): boolean => needed.every((id) => have.includes(id));

/* The words for a copy that did not say ok; a copy with no answer at all counts as silent. */
function whyNot(s: UpdateSample, id: string): string {
  const host = s.hosts[id] ?? id;
  return s.answers?.[id] === 'refused' ? `${host} did not promise to wait` : `${host} did not answer`;
}

function answerStep(s: UpdateSample, m: UpdateMemory): UpdateAction {
  if (m.answered) return NONE;
  if (s.answers === null) return s.inFlight ? NONE : { do: 'promise', to: m.promised };
  const answers = s.answers;
  const failed = m.promised.find((id) => answers[id] !== 'ok');
  return failed === undefined ? { do: 'answer', ok: true, why: null } : { do: 'answer', ok: false, why: whyNot(s, failed) };
}

/* An update the keeper saw first starts by promising to the copies online; one begun by an updater of before the
   promise step is left alone. */
function beginsPromise(s: UpdateSample, status: Status): UpdateAction {
  return status.step === 'promise' ? { do: 'promise', to: s.online } : NONE;
}

/* The copies must hold W before the dump; migrations that run need them stopped first, and the dump waits for the stop
   to be acknowledged and sync to be held. */
function settleStep(s: UpdateSample, m: UpdateMemory, w: { at: number }): UpdateAction | null {
  const allAtW = hasAll(m.promised, s.atW);
  const allAcked = hasAll(m.promised, m.stopAcks);
  if (allAtW && m.migrations !== 0 && !m.stopped) return { do: 'stop_copies' };
  if (allAtW && m.migrations === 0) return { do: 'settle', ok: true };
  if (allAtW && m.stopped && allAcked && s.held) return { do: 'settle', ok: true };
  if (s.now >= w.at + W_WAIT_MS) return { do: 'settle', ok: false };
  if (m.stopped && !allAcked && !s.inFlight) return { do: 'stop_copies' };
  return null;
}

function runningStep(s: UpdateSample, status: Status, m: UpdateMemory): UpdateAction {
  if (status.step === 'promise') return answerStep(s, m);
  if (m.promised.length > 0 && s.now >= m.promisedAt + PROMISE_AGAIN_MS) return { do: 'promise_again' };
  if (status.step === 'backup' && s.maintenance && m.w === null) return { do: 'begin' };
  const settling = m.w !== null && m.wAt !== null && !m.settled ? settleStep(s, m, { at: m.wAt }) : null;
  if (settling !== null) return settling;
  return status.restore && !m.dropped ? { do: 'drop_slots' } : NONE;
}

export function nextUpdateStep(s: UpdateSample): UpdateAction {
  const status = s.status;
  if (status === null || status.state !== 'running') return s.memory !== null && s.leads ? { do: 'end' } : NONE;
  const m = s.memory;
  if (m === null || m.id !== status.id) return beginsPromise(s, status);
  return runningStep(s, status, m);
}
