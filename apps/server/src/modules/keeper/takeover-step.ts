import type { Term } from '../../db/net.js';
import type { Route, SyncRecord } from '../link/relay.js';
import { parseTerm, type Stance } from './beats.js';
import { withinLease, type Clocks } from './lease.js';

/* Checks 1 and 2: no beat from the leader either way, and no probe answered by it, this long. */
export const SILENT_MS = 20_000;
/* Check 4: the name empty, with nothing to doubt it, this long. */
export const EMPTY_MS = 12_000;
/* Check 3: a live leader's frpc registers again within seconds of a relay's restart, so until then "empty" says nothing of it. */
export const RELAY_BACK_MS = 25_000;
/* From a poll's send to the next poll's reply. A gap this long means nobody watched the relay in between, so the window cannot vouch for it. */
export const GAP_MS = 3_000;
/* Check 5: the leader's last "normal, sync on" beat. */
export const SYNC_BEAT_MS = 100_000;
/* B silent this long: the old leader goes by the relay. */
export const UNREACHED_MS = 3_000;
export const ASK_AGAIN_MS = 2_000;
/* A takeover's deadline for the name and the nonce. */
export const TAKE_MS = 30_000;
/* The CEO's "Go on from" holds this long. */
export const CEO_KEEP_MS = 600_000;

/* Null: no poll could be sent or answered this tick. replied: monotonic ms once both answers came. */
export type Poll = { sent: Clocks; replied: number; route: Route; health: { up: boolean; relayStarted: number | null } } | null;
export type Window = { since: number | null; generation: number | null; lastSent: number | null; relayStarted: number | null; relaySeen: number | null };
export const NO_WINDOW: Window = { since: null, generation: null, lastSent: null, relayStarted: null, relaySeen: null };

/* Monotonic ms throughout. held: the last known route answer says held. heard: the newest beat from the leader either way.
   linkAnswered: the newest probe at the link answered by the leader's machine. syncBeat: the newest beat from the leader
   saying lead, normal, sync = self. holds: the update promise or a planned switch's offer. */
export type WatchSample = {
  now: number;
  started: number;
  window: Window;
  held: boolean;
  leader: string | null;
  heard: number | null;
  linkAnswered: number | null;
  syncBeat: number | null;
  record: SyncRecord | null;
  routeGeneration: number | null;
  self: string;
  ready: boolean;
  holds: boolean;
  ceo: number | null;
};
export type WatchAction = { do: 'none' } | { do: 'take'; kind: 'takeover' | 'ceo' } | { do: 'ask' } | { do: 'unask' };

/* latest: the highest term in any beat heard (lead, follow and idle) and its own. b: the copy the record names "on" at the
   keeper's generation, when it last answered (monotonic) and its newest answer. asked: when it last asked B's promise
   (monotonic). route: the last known answer, its client the maker of its generation, held or empty. registering: the
   generation it saw when it started its own registration (an entry's register, or Task 5's Taking.generation), else null.
   tunnel: its link frpc runs. flag: its sync controller's flag is not null. */
export type EntrySample = {
  now: Clocks;
  needed: boolean;
  self: string;
  ownTerm: Term | null;
  latest: Term | null;
  b: { networkId: string; answered: number | null; answer: { stance: Stance; sent: Clocks } | null } | null;
  asked: number | null;
  window: Window;
  route: { state: 'held' | 'empty'; client: string | null; generation: number; sent: Clocks } | null;
  registering: number | null;
  client: string;
  tunnel: boolean;
  flag: boolean;
};
export type EntryAction =
  | { do: 'wait'; why: string }
  | { do: 'take'; sent: Clocks; term: Term }
  | { do: 'ask'; term: Term }
  | { do: 'register'; generation: number | null }
  | { do: 'stop' }
  | { do: 'follow' };

function emptyAtSameGeneration(w: Window, route: Route): boolean {
  if (!route.known || route.state !== 'empty') return false;
  return w.generation === null || route.generation === w.generation;
}

function repliedInTime(w: Window, replied: number): boolean {
  return w.lastSent === null || replied - w.lastSent < GAP_MS;
}

/* Taken even from a reply that closes the window: a relay that restarted did so whatever it now says of the name. */
function sightOfRelay(w: Window, p: NonNullable<Poll>): Pick<Window, 'relayStarted' | 'relaySeen'> {
  const started = p.health.relayStarted;
  if (started === null || started === w.relayStarted) return { relayStarted: w.relayStarted, relaySeen: w.relaySeen };
  return { relayStarted: started, relaySeen: p.replied };
}

export function nextWindow(w: Window, p: Poll, heardLeader: boolean): Window {
  if (p === null) return { ...w, since: null };
  const stays = !heardLeader && p.health.up && emptyAtSameGeneration(w, p.route) && repliedInTime(w, p.replied);
  return {
    since: stays ? (w.since ?? p.replied) : null,
    generation: p.route.known ? p.route.generation : w.generation,
    lastSent: p.sent.mono,
    ...sightOfRelay(w, p),
  };
}

const elapsedSince = (from: number | null, now: number): number => (from === null ? 0 : now - from);

export function windowOpenMs(w: Window, now: number): number {
  return elapsedSince(w.since, now);
}

export function relayBackMs(w: Window, now: number): number {
  return elapsedSince(w.relaySeen, now);
}

/* Check 3 and check 4, which the old leader's way back through the relay needs as much as a copy's takeover does. */
function windowStands(w: Window, now: number): boolean {
  return windowOpenMs(w, now) >= EMPTY_MS && relayBackMs(w, now) >= RELAY_BACK_MS;
}

const within = (stamp: number | null, now: number, limitMs: number): boolean => stamp !== null && now - stamp < limitMs;

const quiet = (asked: boolean, why: string): { action: WatchAction; why: string } => ({ action: asked ? { do: 'unask' } : { do: 'none' }, why });

/* What was heard before this watcher started counts as heard when it started, so that a restart never reads as silence. */
function quietMs(s: WatchSample, stamp: number | null): number {
  return s.now - Math.max(stamp ?? s.started, s.started);
}

function watching(s: WatchSample): boolean {
  return s.ready && !s.holds && s.leader !== null;
}

/* Check 5: only the copy the relay's record names "on", at the route's generation, and whose leader lately said so too,
   holds every confirmed change. */
function holdsEveryChange(s: WatchSample): boolean {
  const named = s.record?.state === 'on' && s.record.copy === s.self && s.record.generation === s.routeGeneration;
  return named && within(s.syncBeat, s.now, SYNC_BEAT_MS);
}

/* The window's row is not quiet: a window that starts over on a relay blip must not take the question back. */
export function nextWatchStep(s: WatchSample, asked: boolean): { action: WatchAction; why: string } {
  if (!watching(s)) return quiet(asked, 'not watching');
  if (s.held) return quiet(asked, 'the name is held');
  if (quietMs(s, s.heard) < SILENT_MS) return quiet(asked, 'heard the leader');
  if (quietMs(s, s.linkAnswered) < SILENT_MS) return quiet(asked, 'the leader answers at the link');
  if (!windowStands(s.window, s.now)) return { action: { do: 'none' }, why: 'window' };
  if (holdsEveryChange(s)) return { action: { do: 'take', kind: 'takeover' }, why: 'checks 1-5' };
  if (within(s.ceo, s.now, CEO_KEEP_MS)) return { action: { do: 'take', kind: 'ceo' }, why: 'the CEO said go on' };
  return { action: asked ? { do: 'none' } : { do: 'ask' }, why: 'may lack changes' };
}

/* Terms are ordered by (number, machine id). */
function above(term: Term, other: Term | null): boolean {
  if (other === null) return true;
  return term.number > other.number || (term.number === other.number && term.machine > other.machine);
}

const isSplit = (s: EntrySample): boolean => s.ownTerm?.split ?? false;

/* Split as its own term, since only the turning normal of a term by the CEO may make the successor of a split term unsplit. */
function nextTerm(s: EntrySample): Term {
  const highest = Math.max(s.ownTerm?.number ?? 0, s.latest?.number ?? 0);
  return { number: highest + 1, machine: s.self, split: isSplit(s) };
}

const wait = (why: string): EntryAction => ({ do: 'wait', why });

/* The sync controller's flag, which a split term goes without. */
const mayTake = (s: EntrySample): boolean => s.flag || isSplit(s);

function whenNotNeeded(s: EntrySample): EntryAction | null {
  return s.needed ? null : { do: 'take', sent: s.now, term: nextTerm(s) };
}

function aNewerTermElsewhere(s: EntrySample): boolean {
  return s.latest !== null && s.latest.machine !== s.self && above(s.latest, s.ownTerm);
}

/* Held or empty: either way someone registered after it, so its own lease would overlap theirs. */
function routeMadeByAnother(s: EntrySample): boolean {
  return s.route !== null && s.route.client !== null && s.route.client !== s.client;
}

/* However old: B cannot unlead by growing silent, and following is the side that never gives two leaders. */
function bSaysItLeads(s: EntrySample): boolean {
  return s.b?.answer?.stance.kind === 'lead';
}

function whenAnotherLed(s: EntrySample): EntryAction | null {
  return aNewerTermElsewhere(s) || routeMadeByAnother(s) || bSaysItLeads(s) ? { do: 'follow' } : null;
}

function freshAnswer(s: EntrySample): { stance: Stance; sent: Clocks } | null {
  const answer = s.b?.answer ?? null;
  return answer !== null && withinLease(answer.sent, s.now) ? answer : null;
}

function grantOf(s: EntrySample): { term: Term; sent: Clocks } | null {
  const answer = freshAnswer(s);
  if (answer?.stance.kind !== 'follow' || answer.stance.term === null) return null;
  const term = answer.stance.term;
  return term.machine === s.self && above(term, s.ownTerm) && term.split === isSplit(s) ? { term, sent: answer.sent } : null;
}

function whenBGranted(s: EntrySample): EntryAction | null {
  const grant = grantOf(s);
  if (grant === null) return null;
  if (mayTake(s)) return { do: 'take', ...grant };
  return s.tunnel ? wait('the sync controller') : { do: 'register', generation: s.route?.generation ?? null };
}

function whenBAttempts(s: EntrySample): EntryAction | null {
  return freshAnswer(s)?.stance.kind === 'attempting' ? wait('B is attempting') : null;
}

function heldByOwnClient(s: EntrySample): NonNullable<EntrySample['route']> | null {
  return s.route !== null && s.route.state === 'held' && s.route.client === s.client ? s.route : null;
}

/* Only registering + 1 proves nobody registered between: its own route at a later generation proves nothing, since someone
   may have registered in between, so it stops and the window starts again. */
function onOwnRoute(s: EntrySample, route: NonNullable<EntrySample['route']>): EntryAction {
  if (s.registering === null || route.generation > s.registering + 1) return { do: 'stop' };
  if (route.generation <= s.registering) return wait('registering');
  return mayTake(s) ? { do: 'take', sent: route.sent, term: nextTerm(s) } : wait('the sync controller');
}

function whileRegistering(s: EntrySample): EntryAction | null {
  if (!s.tunnel) return null;
  const own = heldByOwnClient(s);
  return own === null ? wait('registering') : onOwnRoute(s, own);
}

function whileBAnswers(s: EntrySample): EntryAction | null {
  if (!within(s.b?.answered ?? null, s.now.mono, UNREACHED_MS)) return null;
  return within(s.asked, s.now.mono, ASK_AGAIN_MS) ? wait('asked B') : { do: 'ask', term: nextTerm(s) };
}

/* The route empty with its own client as maker means nobody registered since its own last registration. */
function byRelayWindow(s: EntrySample): EntryAction {
  if (s.route === null || s.route.state !== 'empty' || s.route.client !== s.client) return wait("the relay's window");
  return windowStands(s.window, s.now.mono) ? { do: 'register', generation: s.route.generation } : wait("the relay's window");
}

/* In the order of the plan's table: the first that speaks decides. */
const BEFORE_THE_RELAY = [whenNotNeeded, whenAnotherLed, whenBGranted, whenBAttempts, whileRegistering, whileBAnswers];

export function nextEntryStep(s: EntrySample): EntryAction {
  for (const rule of BEFORE_THE_RELAY) {
    const action = rule(s);
    if (action !== null) return action;
  }
  return byRelayWindow(s);
}

function mayPromise(term: Term, o: { asker: string; followed: Term | null; attempting: boolean }): boolean {
  if (o.followed === null || o.attempting) return false;
  return term.machine === o.asker && o.followed.machine === o.asker && above(term, o.followed) && term.split === o.followed.split;
}

export function promiseAnswer(o: { asker: string; term: unknown; followed: Term | null; attempting: boolean }): { grant: Term } | { grant: null } {
  const term = parseTerm(o.term);
  return { grant: term !== null && mayPromise(term, o) ? term : null };
}

export function mayTurnNormal(o: {
  split: boolean;
  kind: 'planned' | 'takeover' | 'ceo' | null;
  relayUp: boolean;
  holdsRoute: boolean;
  members: string[];
  following: (networkId: string) => boolean;
  live: (networkId: string) => boolean;
}): boolean {
  const everyoneFollows = o.members.every(member => o.following(member) || !o.live(member));
  return o.split && o.kind === 'ceo' && o.relayUp && o.holdsRoute && everyoneFollows;
}
