import type { Term } from '../../db/net.js';
import type { Route, SyncRecord } from '../link/relay.js';
import type { Stance } from './beats.js';
import { withinLease, type Clocks } from './lease.js';
import { TermShape } from './sql-words.js';

/* What the keepers decide when the machine that leads stops answering, each as a pure function of what the keeper
   saw: when a copy may take the company's name, when it asks the CEO instead, and how a keeper that led and holds no
   lease comes back in or follows. Every time here is of the keeper's clock that never jumps, in ms, unless it says
   otherwise. */

/* No beat from the leader, and no answer of it at the company's link, for this long. */
export const SILENT_MS = 20_000;
/* The company's name free at hornhoof.org for this long. */
export const EMPTY_MS = 12_000;
/* This long since hornhoof.org was first seen after it started. */
export const RELAY_BACK_MS = 25_000;
/* A poll's send to the next poll's reply: at this much the window starts over. */
export const GAP_MS = 3_000;
/* The leader's last beat that said it leads with its commits waiting for this copy is no older than this. */
export const SYNC_BEAT_MS = 100_000;
/* The copy commits wait for silent this long: a keeper that led goes by hornhoof.org instead. */
export const UNREACHED_MS = 3_000;
export const ASK_AGAIN_MS = 2_000;
/* A takeover's time for the name and the nonce. */
export const TAKE_MS = 30_000;
/* The CEO's word to go on from a copy holds this long. */
export const CEO_KEEP_MS = 600_000;

/* One look at hornhoof.org: the route of the company's name and the relay's health. sent: when it went out. replied:
   when both answers were there. Null: no poll could be sent or answered this tick. */
export type Poll = { sent: Clocks; replied: number; route: Route; health: { up: boolean; relayStarted: number | null } } | null;

/* How long the company's name has been free in a row, as one keeper saw it. since: the first reply that said empty,
   null while the window is shut. generation: the route's, as last known. lastSent: when the last poll went out.
   relayStarted: the start of hornhoof.org's relay as it last said; relaySeen: when this keeper first saw that start. */
export type Window = { since: number | null; generation: number | null; lastSent: number | null; relayStarted: number | null; relaySeen: number | null };
export const NO_WINDOW: Window = { since: null, generation: null, lastSent: null, relayStarted: null, relaySeen: null };

/* The window after one more poll. It opens at the first reply that says the name is free, and starts over on anything
   that could hide a leader: no poll, a relay that is down, a route that cannot be told, a held name, another
   generation, a poll that came late, or a beat from the leader. A start of the relay not seen before counts as the
   relay just back, the first one too. */
export function nextWindow(w: Window, p: Poll, heardLeader: boolean): Window {
  if (!p) return { ...w, since: null };
  const started = p.health.relayStarted;
  const relaySeen = started !== null && started !== w.relayStarted ? p.replied : w.relaySeen;
  const route = p.route.known ? p.route : null;
  const late = w.lastSent !== null && p.replied - w.lastSent >= GAP_MS;
  const over = !p.health.up || !route || route.state === 'held' || (w.generation !== null && route.generation !== w.generation) || late || heardLeader;
  return { since: over ? null : (w.since ?? p.replied), generation: route ? route.generation : w.generation, lastSent: p.sent.mono, relayStarted: started ?? w.relayStarted, relaySeen };
}

export function windowOpenMs(w: Window, now: number): number {
  return w.since === null ? 0 : now - w.since;
}

export function relayBackMs(w: Window, now: number): number {
  return w.relaySeen === null ? 0 : now - w.relaySeen;
}

/* What a copy that watches the leader sees at one tick. started: when this watcher began. held: the last known route
   answer says the name is held. leader: the machine its copy follows. heard: the newest beat from the leader, either
   way. linkAnswered: the newest probe at the link the leader's machine answered. syncBeat: the newest beat from the
   leader that said it leads normally with its commits waiting for this machine. record: the relay's word on which
   copy holds every change. routeGeneration: the generation the route reports. ready: its copy holds every table and
   its database never led. holds: an update promise or a planned switch's offer holds. ceo: when the CEO said to go on
   from this copy. */
export type WatchSample = {
  now: number; started: number; window: Window; held: boolean; leader: string | null; heard: number | null; linkAnswered: number | null; syncBeat: number | null;
  record: SyncRecord | null; routeGeneration: number | null; self: string; ready: boolean; holds: boolean; ceo: number | null;
};
type WatchAction = { do: 'none' } | { do: 'take'; kind: 'takeover' | 'ceo' } | { do: 'ask' } | { do: 'unask' };

/* The copy takes the server over only when the leader has been silent both ways, the name free and the relay steady
   long enough, and the relay's record, at the route's generation, names this copy as the one that holds every
   confirmed change, as the leader's own beats said not long ago. With all but that last, it asks the CEO, who may
   say to go on from it; his word holds for ten minutes, and only while the leader was not heard after it. asked: its
   question stands. */
export function nextWatchStep(s: WatchSample, asked: boolean): { action: WatchAction; why: string } {
  const quiet = (why: string): { action: WatchAction; why: string } => ({ action: asked ? { do: 'unask' } : { do: 'none' }, why });
  if (!s.ready || s.holds || s.leader === null) return quiet('not watching');
  if (s.held) return quiet('the name is held');
  /* A watcher that just began has heard nothing yet, which is no silence. */
  if (s.now - Math.max(s.heard ?? s.started, s.started) < SILENT_MS) return quiet('heard the leader');
  if (s.now - Math.max(s.linkAnswered ?? s.started, s.started) < SILENT_MS) return quiet('the leader answers at the link');
  if (windowOpenMs(s.window, s.now) < EMPTY_MS || relayBackMs(s.window, s.now) < RELAY_BACK_MS) return { action: { do: 'none' }, why: 'window' };
  const named = s.record?.state === 'on' && s.record.copy === s.self && s.routeGeneration !== null && s.record.generation === s.routeGeneration;
  if (named && s.syncBeat !== null && s.now - s.syncBeat < SYNC_BEAT_MS) return { action: { do: 'take', kind: 'takeover' }, why: 'checks 1-5' };
  /* The CEO's word is for the leader as it was gone when he gave it: a leader heard since, by a beat or at the link,
     may have taken changes he never saw, so the word counts no more and he is asked again. */
  const since = Math.max(s.heard ?? -Infinity, s.linkAnswered ?? -Infinity);
  if (s.ceo !== null && s.ceo > since && s.now - s.ceo < CEO_KEEP_MS) return { action: { do: 'take', kind: 'ceo' }, why: 'the CEO said go on' };
  return { action: asked ? { do: 'none' } : { do: 'ask' }, why: 'may lack changes' };
}

/* What a leading keeper without a lease sees at one tick. needed: another machine holds a copy that finished, so a
   lease takes a proof. ownTerm: the term of its own database's state. latest: the highest term in any beat it heard
   and its own. b: the copy the relay's record names as holding every change at this keeper's generation, when it last
   answered and its newest answer. asked: when this keeper last asked b for its promise. route: the last known answer
   about the company's name, its client the maker of its generation, held or empty. registering: the generation it
   saw when it started its own registration. client: its own link client's id. tunnel: its link client runs. flag:
   its sync controller has a flag to lead under. gaveUp: the machine whose client registered the name last says now,
   in a beat, that it follows: it took the name and gave the server up. */
export type EntrySample = {
  now: Clocks; needed: boolean; self: string; ownTerm: Term | null; latest: Term | null;
  b: { networkId: string; answered: number | null; answer: { stance: Stance; sent: Clocks } | null } | null;
  asked: number | null; window: Window;
  route: { state: 'held' | 'empty'; client: string | null; generation: number; sent: Clocks } | null;
  registering: number | null; client: string; tunnel: boolean; flag: boolean; gaveUp: boolean;
};
type EntryAction =
  | { do: 'wait'; why: string } | { do: 'take'; sent: Clocks; term: Term } | { do: 'ask'; term: Term }
  | { do: 'register'; generation: number | null } | { do: 'stop' } | { do: 'follow' };

/* Whether a term stands above another: by its number, then by its machine. Any term stands above none. */
export function above(a: Term, b: Term | null): boolean {
  return b === null || a.number > b.number || (a.number === b.number && a.machine > b.machine);
}

/* How a keeper that led and holds no lease comes back in. It follows as soon as a machine says it leads under a
   higher term, or another machine's client holds the company's name. A name that is free and was registered last by
   another machine says nothing of who leads: that machine may lead with its client down for a moment, or may have
   given the server up. Until it says which, this keeper neither follows nor leads; once it says it follows, the name
   counts as free again. With its copy answering, the keeper leads again only on that copy's promise of the next term;
   with the copy silent, only through the relay's window, on a registration of its own at exactly the generation after
   the one it saw: its own name at any later generation proves nothing, since another machine may have registered
   between. */
export function nextEntryStep(s: EntrySample): EntryAction {
  const next: Term = { number: Math.max(s.ownTerm?.number ?? 0, s.latest?.number ?? 0) + 1, machine: s.self, split: false };
  if (!s.needed) return { do: 'take', sent: s.now, term: next };
  if (s.latest && s.latest.machine !== s.self && above(s.latest, s.ownTerm)) return { do: 'follow' };
  const theirs = s.route !== null && s.route.client !== null && s.route.client !== s.client;
  if (theirs && s.route!.state === 'held') return { do: 'follow' };
  const said = s.b?.answer ?? null;
  if (said?.stance.kind === 'lead') return { do: 'follow' };
  if (theirs && !s.gaveUp) return { do: 'wait', why: 'the machine that took the name last' };
  const fresh = said && withinLease(said.sent, s.now) ? said : null;
  const promised = fresh?.stance.kind === 'follow' ? fresh.stance.term : null;
  const grant = promised && promised.machine === s.self && !promised.split && above(promised, s.ownTerm) ? promised : null;
  if (fresh && grant) {
    if (s.flag) return { do: 'take', sent: fresh.sent, term: grant };
    return s.tunnel ? { do: 'wait', why: 'the sync controller' } : { do: 'register', generation: s.route?.generation ?? null };
  }
  if (fresh?.stance.kind === 'attempting') return { do: 'wait', why: 'B is attempting' };
  if (s.tunnel) {
    const mine = s.route?.state === 'held' && s.route.client === s.client ? s.route : null;
    if (mine && s.registering !== null && mine.generation === s.registering + 1) return s.flag ? { do: 'take', sent: mine.sent, term: next } : { do: 'wait', why: 'the sync controller' };
    if (mine && (s.registering === null || mine.generation > s.registering + 1)) return { do: 'stop' };
    return { do: 'wait', why: 'registering' };
  }
  if (s.b && s.b.answered !== null && s.now.mono - s.b.answered < UNREACHED_MS) {
    return s.asked === null || s.now.mono - s.asked >= ASK_AGAIN_MS ? { do: 'ask', term: next } : { do: 'wait', why: 'asked B' };
  }
  const free = s.route?.state === 'empty' && (s.route.client === s.client || (theirs && s.gaveUp));
  if (free && windowOpenMs(s.window, s.now.mono) >= EMPTY_MS && relayBackMs(s.window, s.now.mono) >= RELAY_BACK_MS) return { do: 'register', generation: s.route!.generation };
  return { do: 'wait', why: "the relay's window" };
}

/* What a copy answers a keeper that asks it for the next term: it grants the term only to the machine whose term it
   follows, only a term of that machine above the one it follows, and never once it is taking the server itself. */
export function promiseAnswer(o: { asker: string; term: unknown; followed: Term | null; attempting: boolean }): { grant: Term } | { grant: null } {
  const asked = TermShape.safeParse(o.term);
  if (!asked.success || o.attempting || !o.followed) return { grant: null };
  const term = asked.data;
  if (term.machine !== o.asker || o.followed.machine !== o.asker || term.split !== o.followed.split || !above(term, o.followed)) return { grant: null };
  return { grant: term };
}
