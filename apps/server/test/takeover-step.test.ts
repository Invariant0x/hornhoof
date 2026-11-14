import { describe, expect, it } from 'vitest';
import type { Term } from '../src/db/net.js';
import type { Route } from '../src/modules/link/relay.js';
import {
  ASK_AGAIN_MS, CEO_KEEP_MS, EMPTY_MS, GAP_MS, NO_WINDOW, RELAY_BACK_MS, SILENT_MS, SYNC_BEAT_MS, TAKE_MS, UNREACHED_MS,
  above, nextEntryStep, nextWatchStep, nextWindow, promiseAnswer, relayBackMs, windowOpenMs, type EntrySample, type Poll, type WatchSample, type Window,
} from '../src/modules/keeper/takeover-step.js';

const A = 'a0'.repeat(16);
const B = 'b0'.repeat(16);
const C = 'c0'.repeat(16);
const OWN_CLIENT = 'acme-a0a0a0a0';
const term = (number: number, machine = A, split = false): Term => ({ number, machine, split });
const clocks = (mono: number) => ({ wall: 1_000_000 + mono, mono });

const route = (over: Partial<Extract<Route, { known: true }>> = {}): Route => ({
  known: true, state: 'empty', client: null, since: 0, generation: 7, relayStarted: 100, evictionBound: 30, sync: { state: 'on', copy: B, epoch: 3, generation: 7, at: 1 }, ...over,
});
/* A poll sent at that moment and answered a tenth of a second later. */
const poll = (at: number, over: { route?: Route; up?: boolean; relayStarted?: number | null; replied?: number } = {}): NonNullable<Poll> => ({
  sent: clocks(at), replied: over.replied ?? at + 100, route: over.route ?? route(), health: { up: over.up ?? true, relayStarted: over.relayStarted === undefined ? 100 : over.relayStarted },
});

describe('the window in which the name is free', () => {
  it('opens and restarts the window', () => {
    expect(NO_WINDOW).toEqual({ since: null, generation: null, lastSent: null, relayStarted: null, relaySeen: null });
    /* The first reply that says empty opens it, and is the first sight of the relay's start. */
    const open = nextWindow(NO_WINDOW, poll(1000), false);
    expect(open).toEqual({ since: 1100, generation: 7, lastSent: 1000, relayStarted: 100, relaySeen: 1100 });
    /* The next empty reply a second later keeps it. */
    const kept = nextWindow(open, poll(2000), false);
    expect(kept).toEqual({ ...open, lastSent: 2000 });
    expect([windowOpenMs(kept, 13_100), relayBackMs(kept, 26_100), windowOpenMs(NO_WINDOW, 5), relayBackMs(NO_WINDOW, 5)]).toEqual([12_000, 25_000, 0, 0]);
    /* Each of these starts it over. */
    const overs: [string, Poll, boolean][] = [
      ['a held name', poll(3000, { route: route({ state: 'held', client: 'acme-b0b0b0b0' }) }), false],
      ['a route that cannot be told', poll(3000, { route: { known: false, why: 'slow' } }), false],
      ['a relay that is down', poll(3000, { up: false, relayStarted: null }), false],
      ['another generation', poll(3000, { route: route({ generation: 8 }) }), false],
      ['a reply three seconds after the last send', poll(4900, { replied: 2000 + GAP_MS }), false],
      ['a beat from the leader', poll(3000), true],
      ['no poll', null, false],
    ];
    for (const [name, p, heard] of overs) expect(nextWindow(kept, p, heard).since, name).toBeNull();
    /* Just under three seconds is no gap. */
    expect(nextWindow(kept, poll(4000, { replied: 2000 + GAP_MS - 1 }), false).since).toBe(1100);
    /* What it knows of the route and the relay stays through a poll that says less. */
    expect(nextWindow(kept, poll(3000, { up: false, relayStarted: null, route: { known: false, why: 'unreachable' } }), false)).toMatchObject({ generation: 7, relayStarted: 100, relaySeen: 1100, lastSent: 3000 });
    expect(nextWindow(kept, null, false)).toEqual({ ...kept, since: null });
    /* A start of the relay not seen before is the relay just back; the generation it then names is taken. */
    const back = nextWindow(kept, poll(3000, { relayStarted: 200, route: route({ generation: 8 }) }), false);
    expect(back).toEqual({ since: null, generation: 8, lastSent: 3000, relayStarted: 200, relaySeen: 3100 });
    expect(nextWindow(back, poll(4000, { relayStarted: 200, route: route({ generation: 8 }) }), false).since).toBe(4100);
  });
});

const NOW = 400_000;
const steady: Window = { since: NOW - EMPTY_MS, generation: 7, lastSent: NOW - 1000, relayStarted: 100, relaySeen: NOW - RELAY_BACK_MS };
/* A copy for which every check holds: it takes over. */
const watch = (over: Partial<WatchSample> = {}): WatchSample => ({
  now: NOW, started: 0, window: steady, held: false, leader: A, heard: NOW - SILENT_MS, linkAnswered: NOW - SILENT_MS, syncBeat: NOW - SYNC_BEAT_MS + 1,
  record: { state: 'on', copy: B, epoch: 3, generation: 7, at: 1 }, routeGeneration: 7, self: B, ready: true, holds: false, ceo: null, ...over,
});

describe('the copy that watches the leader', () => {
  it('watches by the five checks', () => {
    expect([SILENT_MS, EMPTY_MS, RELAY_BACK_MS, GAP_MS, SYNC_BEAT_MS, TAKE_MS, CEO_KEEP_MS]).toEqual([20_000, 12_000, 25_000, 3_000, 100_000, 30_000, 600_000]);
    expect(nextWatchStep(watch(), false)).toEqual({ action: { do: 'take', kind: 'takeover' }, why: 'checks 1-5' });
    const quiet: [Partial<WatchSample>, string][] = [
      [{ ready: false }, 'not watching'], [{ holds: true }, 'not watching'], [{ leader: null }, 'not watching'],
      [{ held: true }, 'the name is held'],
      [{ heard: NOW - SILENT_MS + 1 }, 'heard the leader'],
      [{ linkAnswered: NOW - SILENT_MS + 1 }, 'the leader answers at the link'],
      /* A watcher that began less than twenty seconds ago has heard nobody yet, which is no silence. */
      [{ heard: null, started: NOW - SILENT_MS + 1 }, 'heard the leader'],
      [{ linkAnswered: null, started: NOW - SILENT_MS + 1 }, 'heard the leader'],
    ];
    for (const [over, why] of quiet) {
      expect(nextWatchStep(watch(over), false), JSON.stringify(over)).toEqual({ action: { do: 'none' }, why });
      /* A question that stands goes with each of them. */
      expect(nextWatchStep(watch(over), true), JSON.stringify(over)).toEqual({ action: { do: 'unask' }, why });
    }
    expect(nextWatchStep(watch({ heard: null, linkAnswered: null }), false).action).toEqual({ do: 'take', kind: 'takeover' });
    /* The window: not open long enough, or the relay back too short a time. A question that stands is kept. */
    for (const window of [{ ...steady, since: NOW - EMPTY_MS + 1 }, { ...steady, since: null }, { ...steady, relaySeen: NOW - RELAY_BACK_MS + 1 }, { ...steady, relaySeen: null }]) {
      for (const asked of [false, true]) expect(nextWatchStep(watch({ window }), asked), JSON.stringify(window)).toEqual({ action: { do: 'none' }, why: 'window' });
    }
    /* Check 5: with any of it missing, the copy may lack changes and asks, once. */
    const lacks: Partial<WatchSample>[] = [
      { record: null }, { record: { state: 'off', copy: null, epoch: 3, generation: 7, at: 1 } }, { record: { state: 'on', copy: C, epoch: 3, generation: 7, at: 1 } },
      { record: { state: 'on', copy: B, epoch: 3, generation: 6, at: 1 } }, { routeGeneration: null }, { routeGeneration: 8 },
      { syncBeat: null }, { syncBeat: NOW - SYNC_BEAT_MS },
    ];
    for (const over of lacks) {
      expect(nextWatchStep(watch(over), false), JSON.stringify(over)).toEqual({ action: { do: 'ask' }, why: 'may lack changes' });
      expect(nextWatchStep(watch(over), true), JSON.stringify(over)).toEqual({ action: { do: 'none' }, why: 'may lack changes' });
      /* The CEO said to go on from it, not more than ten minutes ago, and the leader was not heard since. */
      const gone = { heard: NOW - CEO_KEEP_MS - 1000, linkAnswered: NOW - CEO_KEEP_MS - 1000 };
      expect(nextWatchStep(watch({ ...over, ...gone, ceo: NOW - CEO_KEEP_MS + 1 }), true)).toEqual({ action: { do: 'take', kind: 'ceo' }, why: 'the CEO said go on' });
      expect(nextWatchStep(watch({ ...over, ...gone, ceo: NOW - CEO_KEEP_MS }), true).action).toEqual({ do: 'none' });
      /* A leader that was heard after his word, by a beat or at the link, may hold what he never saw: he is asked again. */
      expect(nextWatchStep(watch({ ...over, ...gone, heard: NOW - SILENT_MS, ceo: NOW - SILENT_MS - 1 }), false).action).toEqual({ do: 'ask' });
      expect(nextWatchStep(watch({ ...over, ...gone, linkAnswered: NOW - SILENT_MS, ceo: NOW - SILENT_MS - 1 }), true).action).toEqual({ do: 'none' });
      expect(nextWatchStep(watch({ ...over, heard: null, linkAnswered: null, ceo: NOW - 1 }), true).action).toEqual({ do: 'take', kind: 'ceo' });
    }
    /* The CEO's word takes nothing while a check of the first four does not hold. */
    expect(nextWatchStep(watch({ record: null, ceo: NOW, held: true }), true).action).toEqual({ do: 'unask' });
    expect(nextWatchStep(watch({ record: null, ceo: NOW, window: { ...steady, since: null } }), true).action).toEqual({ do: 'none' });
  });
});

const T = clocks(NOW);
/* A keeper that led under (7, A), holds no lease, and has nothing to go by yet. */
const entry = (over: Partial<EntrySample> = {}): EntrySample => ({
  now: T, needed: true, self: A, ownTerm: term(7), latest: term(7), b: null, asked: null, window: NO_WINDOW, route: null, registering: null, client: OWN_CLIENT, tunnel: false, flag: false, gaveUp: false, ...over,
});
const answered = (stance: EntrySample['b'] extends infer X ? (X extends { answer: infer Y } ? (Y extends { stance: infer S } ? S : never) : never) : never, sentAgo = 500, heardAgo = 400): NonNullable<EntrySample['b']> => ({
  networkId: B, answered: NOW - heardAgo, answer: { stance, sent: clocks(NOW - sentAgo) },
});
const held = (generation: number, client = OWN_CLIENT): NonNullable<EntrySample['route']> => ({ state: 'held', client, generation, sent: clocks(NOW - 200) });
const empty = (generation: number, client: string | null = OWN_CLIENT): NonNullable<EntrySample['route']> => ({ state: 'empty', client, generation, sent: clocks(NOW - 200) });
const NEXT = term(8);

describe('the keeper that led and comes back in', () => {
  it('comes back in by the rules', () => {
    expect([UNREACHED_MS, ASK_AGAIN_MS]).toEqual([3_000, 2_000]);
    /* With no copy that finished, it takes its next term at once, as a machine that keeps the data alone. */
    expect(nextEntryStep(entry({ needed: false }))).toEqual({ do: 'take', sent: T, term: NEXT });
    expect(nextEntryStep(entry({ needed: false, ownTerm: null, latest: null })).do === 'take' && nextEntryStep(entry({ needed: false, ownTerm: null, latest: null }))).toMatchObject({ term: term(1) });
    /* The next term stands above everything it heard of. */
    expect(nextEntryStep(entry({ needed: false, latest: term(11) }))).toMatchObject({ term: term(12) });
    /* Another machine led since: it follows. */
    expect(nextEntryStep(entry({ latest: term(8, B) }))).toEqual({ do: 'follow' });
    expect(nextEntryStep(entry({ latest: term(7, B) }))).toEqual({ do: 'follow' });
    /* Another machine's client holds the name now: that machine is taking the server, or has it. */
    expect(nextEntryStep(entry({ route: held(8, 'acme-b0b0b0b0') }))).toEqual({ do: 'follow' });
    /* The name is free and another machine registered it last. That alone says nothing of who leads: that machine may
       have given the server up. While it does not say what it does, this keeper neither follows nor leads. */
    const lastTheirs = empty(8, 'acme-b0b0b0b0');
    const ripeWindow: Window = { since: NOW - EMPTY_MS, generation: 8, lastSent: NOW - 1000, relayStarted: 100, relaySeen: NOW - RELAY_BACK_MS };
    expect(nextEntryStep(entry({ route: lastTheirs, window: ripeWindow, flag: true, b: answered({ kind: 'follow', term: NEXT }) }))).toEqual({ do: 'wait', why: 'the machine that took the name last' });
    expect(nextEntryStep(entry({ route: lastTheirs, window: ripeWindow }))).toEqual({ do: 'wait', why: 'the machine that took the name last' });
    /* Once that machine says it follows, it gave the server up: the name counts as free for this keeper again. */
    expect(nextEntryStep(entry({ route: lastTheirs, gaveUp: true, flag: true, b: answered({ kind: 'follow', term: NEXT }) }))).toEqual({ do: 'take', sent: clocks(NOW - 500), term: NEXT });
    expect(nextEntryStep(entry({ route: lastTheirs, gaveUp: true, window: ripeWindow }))).toEqual({ do: 'register', generation: 8 });
    expect(nextEntryStep(entry({ route: lastTheirs, gaveUp: true, window: { ...ripeWindow, since: NOW - EMPTY_MS + 1 } }))).toEqual({ do: 'wait', why: "the relay's window" });
    /* A name another machine holds is followed whatever else is said. */
    expect(nextEntryStep(entry({ route: held(8, 'acme-b0b0b0b0'), gaveUp: true }))).toEqual({ do: 'follow' });
    expect(nextEntryStep(entry({ b: answered({ kind: 'lead', term: term(8, B), lease: 'normal', sync: null, until: 0 }) }))).toEqual({ do: 'follow' });
    /* Also on an answer that is old by now: B led at some time. */
    expect(nextEntryStep(entry({ b: answered({ kind: 'lead', term: term(8, B), lease: 'normal', sync: null, until: 0 }, 60_000, 60_000) }))).toEqual({ do: 'follow' });
    /* A higher term of its own it heard of is no other leader. */
    expect(nextEntryStep(entry({ latest: term(9) })).do).toBe('wait');

    /* B's promise of the next term: with a flag it takes it, by the time it sent the ask. */
    const grant = answered({ kind: 'follow', term: NEXT });
    expect(nextEntryStep(entry({ b: grant, flag: true }))).toEqual({ do: 'take', sent: clocks(NOW - 500), term: NEXT });
    expect(nextEntryStep(entry({ b: grant, route: empty(7) }))).toEqual({ do: 'register', generation: 7 });
    expect(nextEntryStep(entry({ b: grant }))).toEqual({ do: 'register', generation: null });
    expect(nextEntryStep(entry({ b: grant, tunnel: true }))).toEqual({ do: 'wait', why: 'the sync controller' });
    /* No promise: a term it follows that is not above its own, of another machine, split, or said too long ago. */
    for (const stale of [answered({ kind: 'follow', term: term(7) }), answered({ kind: 'follow', term: null }), answered({ kind: 'follow', term: term(8, A, true) }), answered({ kind: 'follow', term: NEXT }, 10_000)]) {
      expect(nextEntryStep(entry({ b: stale, flag: true, asked: NOW - 100 })), JSON.stringify(stale.answer)).toEqual({ do: 'wait', why: 'asked B' });
    }
    expect(nextEntryStep(entry({ b: answered({ kind: 'attempting' }), flag: true }))).toEqual({ do: 'wait', why: 'B is attempting' });

    /* Its own registration: the name held by its own client at exactly the generation after the one it saw. */
    const registering = { tunnel: true, registering: 7 };
    expect(nextEntryStep(entry({ ...registering, route: held(8), flag: true }))).toEqual({ do: 'take', sent: clocks(NOW - 200), term: NEXT });
    expect(nextEntryStep(entry({ ...registering, route: held(8) }))).toEqual({ do: 'wait', why: 'the sync controller' });
    /* At a later generation someone may have registered between: it stops, and the window starts again. */
    expect(nextEntryStep(entry({ ...registering, route: held(9), flag: true }))).toEqual({ do: 'stop' });
    expect(nextEntryStep(entry({ tunnel: true, registering: null, route: held(8), flag: true }))).toEqual({ do: 'stop' });
    for (const seen of [null, empty(7), held(7)]) expect(nextEntryStep(entry({ ...registering, route: seen, flag: true })), JSON.stringify(seen)).toEqual({ do: 'wait', why: 'registering' });

    /* B answers its beats: it asks B for the next term, again every two seconds. */
    const reached = answered({ kind: 'follow', term: term(7) });
    expect(nextEntryStep(entry({ b: reached }))).toEqual({ do: 'ask', term: NEXT });
    expect(nextEntryStep(entry({ b: reached, asked: NOW - ASK_AGAIN_MS }))).toEqual({ do: 'ask', term: NEXT });
    expect(nextEntryStep(entry({ b: reached, asked: NOW - ASK_AGAIN_MS + 1 }))).toEqual({ do: 'wait', why: 'asked B' });
    /* B silent for three seconds, or nobody named: it goes by the relay's window, with its own client the last to register. */
    const silent = answered({ kind: 'follow', term: term(7) }, 5_000, UNREACHED_MS);
    const ripe: Window = { since: NOW - EMPTY_MS, generation: 7, lastSent: NOW - 1000, relayStarted: 100, relaySeen: NOW - RELAY_BACK_MS };
    for (const b of [silent, null, { networkId: B, answered: null, answer: null }]) {
      expect(nextEntryStep(entry({ b, route: empty(7), window: ripe })), JSON.stringify(b)).toEqual({ do: 'register', generation: 7 });
      expect(nextEntryStep(entry({ b, route: empty(7), window: { ...ripe, since: NOW - EMPTY_MS + 1 } }))).toEqual({ do: 'wait', why: "the relay's window" });
      expect(nextEntryStep(entry({ b, route: empty(7), window: { ...ripe, relaySeen: NOW - RELAY_BACK_MS + 1 } }))).toEqual({ do: 'wait', why: "the relay's window" });
      expect(nextEntryStep(entry({ b, route: null, window: ripe }))).toEqual({ do: 'wait', why: "the relay's window" });
      /* A name nobody registered since the relay started has no maker: that is not its own. */
      expect(nextEntryStep(entry({ b, route: empty(7, null), window: ripe }))).toEqual({ do: 'wait', why: "the relay's window" });
      expect(nextEntryStep(entry({ b, route: held(7), window: ripe }))).toEqual({ do: 'wait', why: "the relay's window" });
    }
  });

  it('takes and asks no split term', () => {
    const samples = [
      entry({ needed: false }), entry({ b: answered({ kind: 'follow', term: term(7) }) }), entry({ tunnel: true, registering: 7, route: held(8), flag: true }),
      entry({ b: answered({ kind: 'follow', term: NEXT }), flag: true }),
    ];
    for (const sample of samples) {
      const step = nextEntryStep(sample);
      expect('term' in step && step.term.split, JSON.stringify(step)).toBe(false);
    }
  });
});

describe('the promise a copy gives the machine it follows', () => {
  it('promises only the machine that led', () => {
    const asked = { asker: A, term: term(8), followed: term(7), attempting: false };
    expect(promiseAnswer(asked)).toEqual({ grant: term(8) });
    expect(promiseAnswer({ ...asked, asker: B })).toEqual({ grant: null });
    expect(promiseAnswer({ ...asked, term: term(7) })).toEqual({ grant: null });
    expect(promiseAnswer({ ...asked, term: term(6) })).toEqual({ grant: null });
    expect(promiseAnswer({ ...asked, term: term(8, B) })).toEqual({ grant: null });
    expect(promiseAnswer({ ...asked, followed: term(7, B) })).toEqual({ grant: null });
    /* A term is split exactly when the one it follows is, and no term is split in phase 1. */
    expect(promiseAnswer({ ...asked, term: term(8, A, true) })).toEqual({ grant: null });
    expect(promiseAnswer({ ...asked, attempting: true })).toEqual({ grant: null });
    expect(promiseAnswer({ ...asked, followed: null })).toEqual({ grant: null });
    for (const body of [null, 'x', { number: 8 }, { number: 8.5, machine: A, split: false }]) expect(promiseAnswer({ ...asked, term: body })).toEqual({ grant: null });
  });

  it('orders terms by number, then by machine', () => {
    expect([above(term(8), term(7)), above(term(7), term(7)), above(term(7, B), term(7, A)), above(term(7, A), term(7, B)), above(term(1), null), above(term(6, B), term(7, A))]).toEqual([true, false, true, false, true, false]);
  });
});
