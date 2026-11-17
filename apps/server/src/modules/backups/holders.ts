import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { machines, people } from '../../db/schema.js';
import { subnetOf } from '../network/ids.js';
import { onlineShare } from '../network/join.js';
import { bundleRows, setHolders, type BackupRow } from './records.js';
import { FORK_KEEP_MS, ROOM } from './types.js';

/* How many other machines keep each bundle. */
const HOLDERS = 3;
/* A machine takes a new bundle only when its keeper was heard from this lately, and keeps its place while heard from
   within a day. */
const FRESH_MS = 2 * 60_000;
const KEPT_MS = 24 * 3_600_000;

/* Whether two machines sit on one local network: any two of their addresses share their first three numbers. */
export function sameHome(a: string[], b: string[]): boolean {
  const homes = new Set(a.map(subnetOf).filter(home => home !== null));
  return b.some(address => homes.has(subnetOf(address) ?? ''));
}

/* home: on the leader's own network. away: known to be elsewhere. A machine that says no address is neither. */
type Candidate = { id: string; home: boolean; away: boolean; share: number; disk: number; fresh: boolean; kept: boolean };

/* Home first, then the machine that is online more, then the one with more free disk. */
const better = (a: Candidate, b: Candidate): number => Number(b.home) - Number(a.home) || b.share - a.share || b.disk - a.disk || a.id.localeCompare(b.id);

/* The machines that keep a bundle: up to three that hold none of the company's data, whose owners let them and are
   active. The ones it has stay while they still qualify and were heard from within a day; a place left goes to the
   best of the others, which must have been heard from just now and have the room. One place is off site whenever a
   machine off site qualifies, so a home lost to fire, theft or flood does not take every copy with it. id: the bundle,
   when it is one that was recorded before: a machine picked for it that still does not hold it keeps its place only
   while it could take it now, so one that never manages to fetch it does not hold a place for good.

   Two home routers often give out the same numbers, so a machine that reaches the server through the relay is off site
   whatever its address says; and one that says no address is not taken to be elsewhere. */
export async function pickHolders(db: Db, opts: { size: number; keep: string[]; now?: Date; id?: string }): Promise<string[]> {
  const now = opts.now ?? new Date();
  const live = await db.select({ machine: machines, owner: people.status }).from(machines).innerJoin(people, eq(people.id, machines.personId)).where(and(isNull(machines.revokedAt), isNotNull(machines.networkId), isNotNull(machines.role)));
  const leaders = live.filter(row => row.machine.role === 'data').flatMap(row => row.machine.addresses);
  const found = live.flatMap(({ machine, owner }) => {
    if (machine.role === 'data' || !machine.keepsBackups || owner !== 'active' || !machine.reportAt) return [];
    const silent = now.getTime() - machine.reportAt.getTime();
    const fresh = silent < FRESH_MS && (machine.diskFree ?? 0) >= ROOM * opts.size;
    const holdsOrCan = opts.id === undefined || machine.heldBackups.includes(opts.id) || fresh;
    const kept = opts.keep.includes(machine.id) && silent < KEPT_MS && holdsOrCan;
    if (!kept && !fresh) return [];
    const near = sameHome(leaders, machine.addresses);
    const relayed = machine.path === 'relay';
    return [{ id: machine.id, home: near && !relayed, away: relayed || (machine.addresses.length > 0 && !near), disk: machine.diskFree ?? 0, fresh, kept }];
  });
  const shares = await Promise.all(found.map(one => onlineShare(db, one.id, now)));
  const candidates: Candidate[] = found.map((one, at) => ({ ...one, share: shares[at] ?? 0 }));
  /* The ones it has, in the order they were given, so a look that changes nothing answers what was there. */
  const kept = candidates.filter(c => c.kept).sort((x, y) => opts.keep.indexOf(x.id) - opts.keep.indexOf(y.id)).slice(0, HOLDERS);
  const others = candidates.filter(c => !c.kept).sort(better);
  const picks = [...kept, ...others.slice(0, HOLDERS - kept.length)];
  /* None of them off site, and one off site could take a place: it takes the place of the lowest of the picks. */
  const away = candidates.filter(c => c.away && !picks.includes(c)).sort(better)[0];
  if (away && picks.length > 0 && picks.every(c => !c.away)) {
    if (picks.length < HOLDERS) picks.push(away);
    else picks[picks.indexOf([...picks].sort(better).at(-1)!)] = away;
  }
  return picks.map(c => c.id);
}

/* The bundles that are named for the machines that hold them: the newest two of the database in use that a recovery
   file opens, and every bundle of a database set aside before a merge that one opens, for 30 days from when it was
   made. */
export async function namedBundles(db: Db, now = new Date()): Promise<BackupRow[]> {
  const newest = await bundleRows(db, { limit: 2, withRecovery: true, forks: 'none' });
  return [...newest, ...(await bundleRows(db, { withRecovery: true, forks: { since: new Date(now.getTime() - FORK_KEEP_MS) } }))];
}

/* Looks again at who holds the bundles that are named: a holder that was ticked off, disconnected or silent for a day
   gives its place to the next, and so does one that still has not fetched the bundle and has no room for it or is not
   heard from now. */
export async function refreshHolders(db: Db, now = new Date()): Promise<void> {
  for (const row of await namedBundles(db, now)) {
    const holders = await pickHolders(db, { size: row.size, keep: row.holders, now, id: row.id });
    if (holders.join() !== row.holders.join()) await setHolders(db, row.id, holders);
  }
}
