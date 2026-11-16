import type { MachineRole } from '../../db/schema.js';

/* A machine that has not reported for this long is away: its copy is said to sleep, and it is given no data to copy. */
export const REPORT_FRESH_MS = 120_000;

/* Why a machine holds no copy of the company's data. */
export type Unfit =
  | { why: 'phone' }
  | { why: 'no_core' }
  | { why: 'scope'; person: string; departments?: number }
  | { why: 'no_link' };

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

/* The first thing that keeps a machine from holding a copy, or null when nothing does: only what the machine is and
   whose it is, never what it measures. A full computer of the company with a person who sees all of it holds a copy
   at once, before it measured anything and however slow or small it is; what it measures only orders it among the
   others, and a disk that fills up while its copy is made stops that copy. */
export function unfit(m: Candidate, o: { link: boolean }): Unfit | null {
  if (m.kind !== 'computer') return { why: 'phone' };
  if (!m.networkId && !m.server) return { why: 'no_core' };
  if (!seesAll(m.owner)) return { why: 'scope', person: m.owner.name, ...(m.owner.departments === undefined ? {} : { departments: m.owner.departments }) };
  if (!o.link) return { why: 'no_link' };
  return null;
}
