import type { MachineRole } from '../../db/schema.js';

/* Docker "gets 4 GB of memory or more": a Linux VM given 4 GB reports a little less as its total. */
export const MEMORY_MIN = 3.5 * 2 ** 30;
export const DISK_SPARE = 10 * 2 ** 30;
export const FSYNC_MAX_MS = 50;
/* A machine that has not reported for this long is away: its copy is said to sleep, and it is given no data to copy. */
export const REPORT_FRESH_MS = 120_000;

/* Why a machine holds no copy of the company's data. */
export type Unfit =
  | { why: 'phone' }
  | { why: 'no_core' }
  | { why: 'scope'; person: string; departments?: number }
  | { why: 'no_link' }
  | { why: 'measuring' }
  | { why: 'memory'; memory: number }
  | { why: 'disk'; free: number; need: number }
  | { why: 'fsync'; p99: number };

/* A live machine with what decides whether it may hold the data. server: the row of the machine an app itself runs on,
   which no one joined. owner.company: its person sees the whole company; owner.departments: the places a person who
   does not is given; none for one who is switched off. owes: it stopped holding the data and has not given up
   everything it held yet, so it gets no data for now. share: how much of
   the last week it was online. pin: the place its owner's CEO gave it by hand, or 'none'. number: its place so far. */
export type Candidate = {
  id: string;
  kind: string;
  networkId: string | null;
  server: boolean;
  role: MachineRole | null;
  createdAt: Date;
  reportAt: Date | null;
  memory: number | null;
  diskFree: number | null;
  fsyncP99Ms: number | null;
  owes?: boolean;
  cores?: number | null;
  share?: number | null;
  linkRttMs?: number | null;
  linkMbps?: number | null;
  internetRttMs?: number | null;
  internetMbps?: number | null;
  pin?: string | null;
  number?: number | null;
  owner: { isOwner: boolean; company: boolean; active: boolean; name: string; departments?: number };
};

/* Only the CEO's machines and those of people who see the whole company hold its data. */
export const seesAll = (owner: Candidate['owner']): boolean => owner.active && (owner.isOwner || owner.company);

/* The first thing that keeps a machine from holding a copy, or null when nothing does. A copy needs room for three
   databases of the leader's size, since it is made again beside the old one, and some to spare. The measures are the
   last the machine reported, whatever their age: a laptop asleep when the order is scored keeps its place, and being
   away counts through how often it is online. */
export function unfit(m: Candidate, o: { dbSize: number; link: boolean; now?: Date }): Unfit | null {
  if (m.kind !== 'computer') return { why: 'phone' };
  if (!m.networkId && !m.server) return { why: 'no_core' };
  if (!seesAll(m.owner)) return { why: 'scope', person: m.owner.name, ...(m.owner.departments === undefined ? {} : { departments: m.owner.departments }) };
  if (!o.link) return { why: 'no_link' };
  if (m.memory === null || m.diskFree === null || m.fsyncP99Ms === null) return { why: 'measuring' };
  if (m.memory < MEMORY_MIN) return { why: 'memory', memory: m.memory };
  /* A machine that holds a copy has one of the three already. */
  const need = (m.role === 'data' ? 2 : 3) * o.dbSize + DISK_SPARE;
  if (m.diskFree < need) return { why: 'disk', free: m.diskFree, need };
  if (m.fsyncP99Ms >= FSYNC_MAX_MS) return { why: 'fsync', p99: m.fsyncP99Ms };
  return null;
}
