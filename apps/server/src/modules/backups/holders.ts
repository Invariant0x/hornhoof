import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { machines, people } from '../../db/schema.js';
import { onlineShare } from '../network/join.js';
import { bundleRows, setHolders } from './records.js';

/* How many other machines keep each bundle. */
export const HOLDERS = 3;
/* A machine takes a new bundle only when its keeper was heard from this lately, and keeps its place while heard from
   within a day. */
const FRESH_MS = 2 * 60_000;
const KEPT_MS = 24 * 3_600_000;
/* The free disk a machine needs for a bundle, in bundles. */
const ROOM = 3;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/;
const homeOf = (address: string): string | null => {
  const parts = IPV4.exec(address);
  return parts ? `${parts[1]}.${parts[2]}.${parts[3]}` : null;
};

/* Whether two machines sit on one local network: any two of their addresses share their first three numbers. */
export function sameHome(a: string[], b: string[]): boolean {
  const homes = new Set(a.map(homeOf).filter(home => home !== null));
  return b.some(address => homes.has(homeOf(address) ?? ''));
}

type Candidate = { id: string; home: boolean; share: number; disk: number; fresh: boolean; kept: boolean };

/* Home first, then the machine that is online more, then the one with more free disk. */
const better = (a: Candidate, b: Candidate): number => Number(b.home) - Number(a.home) || b.share - a.share || b.disk - a.disk || a.id.localeCompare(b.id);

/* The machines that keep a bundle: up to three that hold none of the company's data, whose owners let them and are
   active. The ones it has stay while they still qualify and were heard from within a day; a place left goes to the
   best of the others, which must have been heard from just now and have the room. One place is off site whenever a
   machine off site qualifies, so a home lost to fire, theft or flood does not take every copy with it. */
export async function pickHolders(db: Db, opts: { size: number; keep: string[]; now?: Date }): Promise<string[]> {
  const now = opts.now ?? new Date();
  const live = await db.select({ machine: machines, owner: people.status }).from(machines).innerJoin(people, eq(people.id, machines.personId)).where(and(isNull(machines.revokedAt), isNotNull(machines.networkId), isNotNull(machines.role)));
  const leaders = live.filter(row => row.machine.role === 'data').flatMap(row => row.machine.addresses);
  const candidates: Candidate[] = [];
  for (const { machine, owner } of live) {
    if (machine.role === 'data' || !machine.keepsBackups || owner !== 'active' || !machine.reportAt) continue;
    const silent = now.getTime() - machine.reportAt.getTime();
    const kept = opts.keep.includes(machine.id) && silent < KEPT_MS;
    const fresh = silent < FRESH_MS && (machine.diskFree ?? 0) >= ROOM * opts.size;
    if (!kept && !fresh) continue;
    candidates.push({ id: machine.id, home: sameHome(leaders, machine.addresses), share: (await onlineShare(db, machine.id, now)) ?? 0, disk: machine.diskFree ?? 0, fresh, kept });
  }
  /* The ones it has, in the order they were given, so a look that changes nothing answers what was there. */
  const kept = candidates.filter(c => c.kept).sort((x, y) => opts.keep.indexOf(x.id) - opts.keep.indexOf(y.id)).slice(0, HOLDERS);
  const others = candidates.filter(c => !c.kept).sort(better);
  const picks = [...kept, ...others.slice(0, HOLDERS - kept.length)];
  /* None of them off site, and one off site could take a place: it takes the place of the lowest of the picks. */
  const away = candidates.filter(c => !c.home && !picks.includes(c)).sort(better)[0];
  if (away && picks.length > 0 && picks.every(c => c.home)) {
    if (picks.length < HOLDERS) picks.push(away);
    else picks[picks.indexOf([...picks].sort(better).at(-1)!)] = away;
  }
  return picks.map(c => c.id);
}

/* Looks again at who holds the newest two bundles that a recovery file opens: a holder that was ticked off, disconnected
   or silent for a day gives its place to the next. */
export async function refreshHolders(db: Db, now = new Date()): Promise<void> {
  for (const row of await bundleRows(db, { limit: 2, withRecovery: true })) {
    const holders = await pickHolders(db, { size: row.size, keep: row.holders, now });
    if (holders.join() !== row.holders.join()) await setHolders(db, row.id, holders);
  }
}
