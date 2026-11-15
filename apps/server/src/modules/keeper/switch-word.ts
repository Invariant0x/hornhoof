/* What a keeper says, to anyone who asks at its front door or at the company's link, of where the company's server is
   going: that it moves, from which machine and to which, since when, and whether this machine's copy is cut off or
   asks the CEO a question. Machines are named by their ids alone, since the link's door answers anyone. */

/* A machine that lost the leader says the company moves for this long; after it, nothing is said to move. */
export const LOST_MS = 120_000;
export const SWITCH_PATH = '/api/network/switch';
const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

/* The answer to a request that asks where the company moves; null for any other request. */
export function switchAnswer(req: { method?: string; url?: string }, word: () => SwitchWord): { status: number; headers: Record<string, string>; body: string } | null {
  if (req.method !== 'GET' || String(req.url).split('?')[0] !== SWITCH_PATH) return null;
  return { status: 200, headers: HEADERS, body: JSON.stringify(word()) };
}

/* self: the machine that answers. from, to: the machine the server moves from and to; while this machine's copy is
   cut off, from is the leader it cannot reach. All are machine ids. since: ISO. */
export type SwitchWord = { self: string | null; moving: boolean; from: string | null; to: string | null; since: string | null; cut: boolean; question: boolean };

/* kind: what this keeper is. self: its machine. handingTo: the machine a planned switch hands the server to. leads:
   a keeper that takes the server leads already. leader: the machine its link names as the leader now. lastLeader,
   lastSync: the leader and the copy its commits waited for, as the last hello that said it leads named them.
   lostSince: when the leader was last lost, by the wall clock in ms; null while one is named. since: when a planned
   switch or a takeover began, the same way. */
export type SwitchSample = {
  now: number; kind: 'lead' | 'handing' | 'taking' | 'follow' | 'worker'; self: string; handingTo: string | null; leads: boolean;
  leader: string | null; lastLeader: string | null; lastSync: string | null; lostSince: number | null; since?: number | null; cut: boolean; question: boolean;
};

const iso = (ms: number | null | undefined): string | null => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/* A keeper that hands the server over says it moves to the machine it hands it to; one that takes it, until it leads,
   that it moves here; a copy or a worker that lost the leader not long ago, that it moves to the copy the leader's
   commits waited for, or to nobody it knows when that copy is the machine it lost. Anything else is not a move. */
export function switchWord(o: SwitchSample): SwitchWord {
  /* A keeper that does not know its own machine's id yet names nobody in its place. */
  const self = o.self || null;
  const still = { self, moving: false, from: o.cut ? (o.leader ?? o.lastLeader) : null, to: null, since: null, cut: o.cut, question: o.question };
  if (o.kind === 'handing') return { ...still, moving: true, from: self, to: o.handingTo, since: iso(o.since) };
  if (o.kind === 'taking') return o.leads ? still : { ...still, moving: true, from: o.lastLeader, to: self, since: iso(o.since) };
  if (o.kind === 'lead') return still;
  if (o.leader !== null || o.lostSince === null || o.now - o.lostSince >= LOST_MS) return still;
  return { ...still, moving: true, from: o.lastLeader, to: o.lastSync !== null && o.lastSync !== o.lastLeader ? o.lastSync : null, since: iso(o.lostSince) };
}
