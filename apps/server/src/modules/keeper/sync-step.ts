import type { LeaseSync } from '../../db/net.js';
import type { SyncRecord } from '../link/relay.js';

export const SAMPLE_EVERY_MS = 250;
export const SILENT_REPLY_MS = 2_000;
export const SLOW_WAIT_MS = 1_000;
export const SLOW_FOR_MS = 5_000;
export const SLOW_BYTES = 1_048_576;
export const PACE_MS = 1_000;
export const PACE_FOR_MS = 30_000;
export const STOP_RENEW_MS = 10_000;

export type Flag = LeaseSync | null;

/* confirmed: the slot's LSN. replyAgeMs: the leader's monotonic ms since it saw reply_time change, null with no
   walsender. syncState: pg_stat_replication.sync_state. */
export type CopySample = {
  machine: string;
  networkId: string;
  number: number;
  name: string;
  finished: boolean;
  keptPaceMs: number;
  replyAgeMs: number | null;
  confirmed: string | null;
  syncState: string | null;
};

/* listed: the other live data rows, finished or not. others: those of them with a copy name. setting: the name in
   synchronous_standby_names, or null. record: the relay's record as last read or stored. */
export type SyncSample = {
  now: number;
  others: CopySample[];
  listed: number;
  setting: string | null;
  route: { client: string; generation: number } | null;
  record: SyncRecord | null;
  oldestWaitMs: number | null;
  slowForMs: number;
  namedBytes5s: number;
};

export type SyncMemory = { w: string | null; posting: boolean; flag: Flag; checkpointed: boolean; blocked: boolean };

export type SyncAction =
  | { do: 'none' }
  | { do: 'post'; state: 'off' }
  | { do: 'post'; state: 'on'; copy: string }
  | { do: 'set'; name: string }
  | { do: 'clear' }
  | { do: 'checkpoint' }
  | { do: 'read_w' };

type Decision = { action: SyncAction; flag: Flag };

const NONE: SyncAction = { do: 'none' };
const POST_OFF: SyncAction = { do: 'post', state: 'off' };

/* 'X/Y' positions as one 64-bit number, X the high half. */
const lsnValue = (lsn: string): bigint => {
  const [high = '0', low = '0'] = lsn.split('/');
  return (BigInt(`0x${high}`) << 32n) | BigInt(`0x${low}`);
};

export function lsnAtLeast(a: string, b: string): boolean {
  return lsnValue(a) >= lsnValue(b);
}

function offStored(s: SyncSample): boolean {
  return s.record !== null && s.record.state === 'off' && s.route !== null && s.record.generation === s.route.generation;
}

function onStored(s: SyncSample, c: CopySample): boolean {
  return s.record !== null && s.record.state === 'on' && s.record.copy === c.networkId && s.route !== null && s.record.generation === s.route.generation;
}

/* Silent by its replies, or by moving fewer bytes than SLOW_BYTES while commits have waited over SLOW_WAIT_MS for
   SLOW_FOR_MS; a copy that keeps receiving a big transaction is slow, not silent. */
function silent(s: SyncSample, c: CopySample): boolean {
  if (c.replyAgeMs === null || c.replyAgeMs > SILENT_REPLY_MS) return true;
  return s.slowForMs >= SLOW_FOR_MS && s.namedBytes5s < SLOW_BYTES;
}

const keptPace = (c: CopySample): boolean => c.finished && c.keptPaceMs >= PACE_FOR_MS;

function lowestAtPace(others: CopySample[]): CopySample | null {
  return others.filter(keptPace).reduce<CopySample | null>((best, c) => (best === null || c.number < best.number ? c : best), null);
}

function overtakenBy(c: CopySample, others: CopySample[]): boolean {
  return others.some((o) => o.number < c.number && keptPace(o));
}

/* Off goes to the relay first; only when it is stored may the setting be cleared. */
function dropSync(s: SyncSample): Decision {
  return offStored(s) ? { action: { do: 'clear' }, flag: 'relay_off' } : { action: POST_OFF, flag: 'copy' };
}

function decideAlone(s: SyncSample): Decision {
  if (s.setting !== null) return dropSync(s);
  const left = s.record !== null && s.record.state === 'on';
  return { action: left ? POST_OFF : NONE, flag: 'alone' };
}

function barrierStep(c: CopySample, m: SyncMemory): SyncAction {
  if (c.syncState !== 'sync') return NONE;
  return m.checkpointed ? { do: 'read_w' } : { do: 'checkpoint' };
}

function decideNamed(s: SyncSample, m: SyncMemory, c: CopySample): Decision {
  if (m.w === null) return { action: barrierStep(c, m), flag: 'copy' };
  const confirmed = c.confirmed !== null && lsnAtLeast(c.confirmed, m.w);
  const action: SyncAction = confirmed && !onStored(s, c) ? { do: 'post', state: 'on', copy: c.networkId } : NONE;
  return { action, flag: 'copy' };
}

function decideSetting(s: SyncSample, m: SyncMemory, setting: string): Decision {
  const c = s.others.find((o) => o.name === setting);
  if (c === undefined || silent(s, c) || overtakenBy(c, s.others)) return dropSync(s);
  return decideNamed(s, m, c);
}

function decideUnset(s: SyncSample): Decision {
  if (!offStored(s)) return { action: POST_OFF, flag: null };
  const next = lowestAtPace(s.others);
  return { action: next === null ? NONE : { do: 'set', name: next.name }, flag: 'relay_off' };
}

function decide(s: SyncSample, m: SyncMemory): Decision {
  if (m.posting) return { action: NONE, flag: m.flag };
  if (s.listed === 0) return decideAlone(s);
  return s.setting === null ? decideUnset(s) : decideSetting(s, m, s.setting);
}

/* Blocked once commits have waited STOP_RENEW_MS on a copy that cannot be dropped yet. It lifts only when off is stored
   or the named copy answers, since the sessions ending at lease end would otherwise lift it with the wait. */
function nextBlocked(s: SyncSample, blocked: boolean): boolean {
  if (offStored(s)) return false;
  if (s.setting === null) return blocked;
  const c = s.others.find((o) => o.name === s.setting);
  const answering = c !== undefined && !silent(s, c);
  if (blocked) return !answering;
  return !answering && s.oldestWaitMs !== null && s.oldestWaitMs >= STOP_RENEW_MS;
}

/* A set or a clear changes what the barrier waits on, so W and the checkpoint are taken again; a post is in flight until
   the controller hears its answer. */
function nextMemory(m: SyncMemory, d: Decision, blocked: boolean): SyncMemory {
  const resets = d.action.do === 'set' || d.action.do === 'clear';
  return {
    w: resets ? null : m.w,
    checkpointed: resets ? false : m.checkpointed,
    posting: m.posting || d.action.do === 'post',
    flag: d.flag,
    blocked
  };
}

export function nextSyncStep(s: SyncSample, m: SyncMemory): { action: SyncAction; flag: Flag; memory: SyncMemory; renew: boolean } {
  const d = decide(s, m);
  const blocked = nextBlocked(s, m.blocked);
  return { action: d.action, flag: d.flag, memory: nextMemory(m, d, blocked), renew: !blocked };
}
