import type { LeaseSync } from '../../db/net.js';
import type { SyncRecord } from '../link/relay.js';

/* How often the controller looks. */
export const SAMPLE_EVERY_MS = 250;
/* A named copy whose connection brought no new answer for this long is silent. */
export const SILENT_REPLY_MS = 2_000;
/* A commit that waits on the named copy for longer than this, seen at every look for SLOW_FOR_MS while the copy took
   fewer than SLOW_BYTES in that time, makes the copy silent too. */
export const SLOW_WAIT_MS = 1_000;
export const SLOW_FOR_MS = 5_000;
export const SLOW_BYTES = 1_048_576;
/* A copy keeps pace while it holds what the leader had written this long ago; after PACE_FOR_MS of that it may be named. */
export const PACE_MS = 5_000;
export const PACE_FOR_MS = 30_000;
/* A commit that waited this long on a copy that cannot be dropped stops the lease from being renewed. */
export const STOP_RENEW_MS = 10_000;

/* What the lease says of where a confirmed change is held: on the named copy too, on this machine alone with the relay
   knowing so, or on the only machine there is. None: no change may be confirmed. */
export type Flag = LeaseSync | null;

/* A copy as one look sees it. number: its place in the server order. name: the name of its slot and its connection.
   finished: it holds every table. keptPaceMs: for how long it has kept pace. replyAgeMs: the leader's own time since
   it last saw the copy's answer change, null with no connection. confirmed: how far its slot says it holds the
   changes. syncState: what Postgres says of its connection. */
export type CopySample = { machine: string; networkId: string; number: number; name: string; finished: boolean; keptPaceMs: number; replyAgeMs: number | null; confirmed: string | null; syncState: string | null };

/* One look. listed: the other machines that hold the data, with a copy or still without. others: those of them that
   named a copy. setting: the copy Postgres waits for with each commit, by its name, or none. route: the route of the
   company's link while this keeper's own client holds it. record: what the relay holds of who has the latest changes,
   as last read or stored. oldestWaitMs: for how long the oldest commit has waited on the named copy. slowForMs: for
   how long every look saw a commit wait over SLOW_WAIT_MS. namedBytes5s: what the named copy took in the last five
   seconds. target: the network id of the machine the server is asked to move to, when it is one of the others. hold:
   commits are to wait for no copy, as while an update's migrations run. */
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
  target: string | null;
  hold: boolean;
  /* This machine leads now: it holds its lease and is not handing the server over. */
  leads: boolean;
};

/* What the controller keeps between looks. w: how far the leader had written once the setting held. posting: an answer
   of the relay is on its way. checkpointed: a checkpoint ended since the setting was made. blocked: the lease is not
   renewed. */
export type SyncMemory = { w: string | null; posting: boolean; flag: Flag; checkpointed: boolean; blocked: boolean };

export type SyncAction =
  | { do: 'none' }
  | { do: 'post'; state: 'off' }
  | { do: 'post'; state: 'on'; copy: string }
  | { do: 'set'; name: string }
  | { do: 'clear' }
  | { do: 'checkpoint' }
  | { do: 'read_w' };

/* Two positions in the write-ahead log, 'X/Y' as Postgres writes them, compared as the 64-bit numbers they are. */
export function lsnAtLeast(a: string, b: string): boolean {
  const number = (lsn: string): bigint => {
    const [high, low] = lsn.split('/');
    return (BigInt(`0x${high}`) << 32n) | BigInt(`0x${low}`);
  };
  return number(a) >= number(b);
}

const NONE: SyncAction = { do: 'none' };
const POST_OFF: SyncAction = { do: 'post', state: 'off' };
const CLEAR: SyncAction = { do: 'clear' };

export type DropReason = 'silent' | 'slow';

/* Why commits stop waiting on a named copy: either its connection brought no new answer in SILENT_REPLY_MS, or commits
   waited over SLOW_WAIT_MS at every look for SLOW_FOR_MS while the copy took fewer than SLOW_BYTES. */
export function dropReason(copy: CopySample, s: SyncSample): DropReason | null {
  if (copy.replyAgeMs === null || copy.replyAgeMs > SILENT_REPLY_MS) return 'silent';
  return s.slowForMs >= SLOW_FOR_MS && s.namedBytes5s < SLOW_BYTES ? 'slow' : null;
}

function silent(copy: CopySample, s: SyncSample): boolean {
  return dropReason(copy, s) !== null;
}

/* The lowest-numbered copy that holds every table and has kept pace long enough to be named. */
function best(s: SyncSample): CopySample | undefined {
  return s.others.filter(copy => copy.finished && copy.keptPaceMs >= PACE_FOR_MS).sort((a, b) => a.number - b.number)[0];
}

/* The copy of the machine the server is to move to, once it may be named: commits wait for it then, whatever its
   number, so that it holds every confirmed change when the server stops. */
function moveTarget(s: SyncSample): CopySample | undefined {
  return s.target === null ? undefined : s.others.find(copy => copy.networkId === s.target && copy.finished && copy.keptPaceMs >= PACE_FOR_MS);
}

/* The first row that fits, as the plan's table has them. A setting is cleared only once the relay stored that this
   machine alone holds the latest changes, and the relay is told that a copy holds them only once the copy holds
   everything the leader had written when the setting took hold. */
function decide(s: SyncSample, m: SyncMemory): { action: SyncAction; flag: Flag } {
  const offStored = s.route !== null && s.record?.state === 'off' && s.record.generation === s.route.generation;
  const dropped = (flag: Flag = 'copy'): { action: SyncAction; flag: Flag } => (offStored ? { action: CLEAR, flag: 'relay_off' } : { action: POST_OFF, flag });
  if (m.posting) return { action: NONE, flag: m.flag };
  /* Held: the setting goes, once the relay stored that this machine alone holds the latest changes, and no copy is
     named until the hold ends. Where this machine keeps the data alone there is nothing to hold. */
  if (s.hold && s.listed > 0) {
    if (s.setting !== null) return dropped();
    return offStored ? { action: NONE, flag: 'relay_off' } : { action: POST_OFF, flag: null };
  }
  if (s.listed === 0) {
    if (s.setting !== null) return dropped();
    return s.record?.state === 'on' ? { action: POST_OFF, flag: 'alone' } : { action: NONE, flag: 'alone' };
  }
  if (s.setting !== null) {
    const named = s.others.find(copy => copy.name === s.setting);
    if (!named || silent(named, s)) return dropped();
    const target = moveTarget(s);
    if (target && target.name !== named.name) return dropped();
    const better = best(s);
    if (better && better.number < named.number && named.networkId !== s.target) return dropped();
    if (m.w === null) {
      if (named.syncState !== 'sync') return { action: NONE, flag: 'copy' };
      return { action: m.checkpointed ? { do: 'read_w' } : { do: 'checkpoint' }, flag: 'copy' };
    }
    const onStored = s.route !== null && s.record?.state === 'on' && s.record.copy === named.networkId && s.record.generation === s.route.generation;
    if (!onStored && named.confirmed !== null && lsnAtLeast(named.confirmed, m.w)) return { action: { do: 'post', state: 'on', copy: named.networkId }, flag: 'copy' };
    return { action: NONE, flag: 'copy' };
  }
  if (offStored) {
    /* Only a machine that leads names a copy. One that hands the server over, or holds no lease, would leave the name
       behind in a database nobody writes, and the first commit there, when it takes the server again, would wait for a
       copy that is none. */
    const next = s.leads ? (moveTarget(s) ?? best(s)) : undefined;
    return { action: next ? { do: 'set', name: next.name } : NONE, flag: 'relay_off' };
  }
  return { action: POST_OFF, flag: null };
}

/* Whether the lease stays unrenewed: a commit has waited long on a copy that is silent or gone, and the relay does not
   know yet that the copy holds nothing new. It lifts only once the relay knows, or the copy answers again: the
   sessions that waited end with the lease, and that alone changes nothing. */
function blockedNow(s: SyncSample, m: SyncMemory): boolean {
  const offStored = s.route !== null && s.record?.state === 'off' && s.record.generation === s.route.generation;
  const named = s.setting === null ? undefined : s.others.find(copy => copy.name === s.setting);
  const answers = named !== undefined && !silent(named, s);
  if (offStored || answers) return false;
  if (m.blocked) return true;
  return s.setting !== null && s.oldestWaitMs !== null && s.oldestWaitMs >= STOP_RENEW_MS;
}

/* What to do after one look, the flag the lease carries from now on, what to remember, and whether to renew the lease. */
export function nextSyncStep(s: SyncSample, m: SyncMemory): { action: SyncAction; flag: Flag; memory: SyncMemory; renew: boolean } {
  const { action, flag } = decide(s, m);
  const blocked = blockedNow(s, m);
  const reset = action.do === 'set' || action.do === 'clear';
  const memory: SyncMemory = { w: reset ? null : m.w, checkpointed: reset ? false : m.checkpointed, posting: m.posting || action.do === 'post', flag, blocked };
  return { action, flag, memory, renew: !blocked };
}
