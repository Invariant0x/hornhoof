import { describe, expect, it } from 'vitest';
import type { Term } from '../src/db/net.js';
import type { Stance } from '../src/modules/keeper/beats.js';
import type { Clocks } from '../src/modules/keeper/lease.js';
import type { Route, SyncRecord } from '../src/modules/link/relay.js';
import {
  mayTurnNormal,
  nextEntryStep,
  nextWatchStep,
  nextWindow,
  NO_WINDOW,
  promiseAnswer,
  relayBackMs,
  windowOpenMs,
  type EntryAction,
  type EntrySample,
  type Poll,
  type WatchAction,
  type WatchSample,
  type Window,
} from '../src/modules/keeper/takeover-step.js';

/* Literal milliseconds throughout, on purpose: a changed limit must fail these rows. */
const at = (mono: number, wall: number = mono): Clocks => ({ wall: 1e12 + wall, mono });

const term = (number: number, machine: string, split = false): Term => ({ number, machine, split });

const anOnRecord = (copy: string, generation: number): SyncRecord => ({ state: 'on', copy, epoch: 1, generation, at: 1 });

describe('opens and restarts the window', () => {
  const STARTED = 111;
  const answer = (state: 'held' | 'empty', generation = 7): Route => ({
    known: true,
    state,
    client: 'link-a',
    since: 0,
    generation,
    relayStarted: STARTED,
    evictionBound: 30,
    sync: { state: 'off', copy: null, epoch: 0, generation, at: null },
  });
  const replyAt = (replied: number, over: Partial<NonNullable<Poll>> = {}): Poll => ({
    sent: at(replied - 100),
    replied,
    route: answer('empty'),
    health: { up: true, relayStarted: STARTED },
    ...over,
  });
  const opened = nextWindow(NO_WINDOW, replyAt(10_000), false);
  const keptOpen = nextWindow(opened, replyAt(11_000), false);

  it('opens at the first empty reply', () => {
    expect(opened.since).toBe(10_000);
  });

  it('keeps its start on the next empty reply', () => {
    expect(keptOpen.since).toBe(10_000);
  });

  const restarts: [name: string, poll: Poll, heardLeader: boolean][] = [
    ['a held reply', replyAt(12_000, { route: answer('held') }), false],
    ['an unknown route', replyAt(12_000, { route: { known: false, why: 'slow' } }), false],
    ['the relay down', replyAt(12_000, { health: { up: false, relayStarted: null } }), false],
    ['another generation', replyAt(12_000, { route: answer('empty', 8) }), false],
    ['a reply 3 s after the last send', replyAt(13_900), false],
    ['a beat from the leader', replyAt(12_000), true],
    ['no poll', null, false],
  ];

  it.each(restarts)('starts over on %s', (_name, poll, heardLeader) => {
    expect(nextWindow(keptOpen, poll, heardLeader).since).toBeNull();
  });

  it('stays open on a reply just under 3 s after the last send', () => {
    expect(nextWindow(keptOpen, replyAt(13_899), false).since).toBe(10_000);
  });

  it('opens from nothing with no earlier send or generation to compare', () => {
    expect(nextWindow(NO_WINDOW, replyAt(3_000, { route: answer('empty', 9) }), false)).toEqual({
      since: 3_000,
      generation: 9,
      lastSent: 2_900,
      relayStarted: STARTED,
      relaySeen: 3_000,
    });
  });

  it('opens again at the next empty reply once it started over', () => {
    const closed = nextWindow(keptOpen, replyAt(12_000, { route: answer('held') }), false);
    expect(closed.since).toBeNull();
    expect(nextWindow(closed, replyAt(13_000), false).since).toBe(13_000);
  });

  it('takes a known route generation and keeps it through an unknown answer', () => {
    const next = nextWindow(keptOpen, replyAt(12_000, { route: answer('held', 8) }), false);
    expect(next.generation).toBe(8);
    expect(nextWindow(next, replyAt(13_000, { route: { known: false, why: 'unreachable' } }), false).generation).toBe(8);
  });

  it('counts the gap across a tick with no poll', () => {
    const noPoll = nextWindow(keptOpen, null, false);
    expect(noPoll.lastSent).toBe(10_900);
    expect(nextWindow(noPoll, replyAt(13_900), false).since).toBeNull();
    expect(nextWindow(noPoll, replyAt(12_900), false).since).toBe(12_900);
  });

  it('takes the first relayStarted seen as the relay just back', () => {
    expect(opened.relayStarted).toBe(STARTED);
    expect(opened.relaySeen).toBe(10_000);
  });

  it('keeps when it saw the relay while relayStarted stays', () => {
    expect(keptOpen.relaySeen).toBe(10_000);
  });

  it('sees the relay again at a new relayStarted', () => {
    const next = nextWindow(keptOpen, replyAt(12_000, { health: { up: true, relayStarted: 222 } }), false);
    expect(next.relayStarted).toBe(222);
    expect(next.relaySeen).toBe(12_000);
  });

  it('does not count a relay that was only unreachable as restarted', () => {
    const down = nextWindow(keptOpen, replyAt(12_000, { health: { up: false, relayStarted: null } }), false);
    expect(down.relayStarted).toBe(STARTED);
    expect(down.relaySeen).toBe(10_000);
    expect(nextWindow(down, replyAt(13_000), false).relaySeen).toBe(10_000);
  });

  it('sees the relay even in a reply that restarts the window', () => {
    const next = nextWindow(keptOpen, replyAt(12_000, { route: answer('held'), health: { up: true, relayStarted: 222 } }), false);
    expect(next.since).toBeNull();
    expect(next.relaySeen).toBe(12_000);
  });

  it('keeps everything but its start on a tick with no poll', () => {
    expect(nextWindow(keptOpen, null, false)).toEqual({ ...keptOpen, since: null });
  });
});

describe('windowOpenMs and relayBackMs', () => {
  const window: Window = { since: 4_000, generation: 7, lastSent: 9_000, relayStarted: 1, relaySeen: 2_000 };

  it('say how long since each began', () => {
    expect(windowOpenMs(window, 10_000)).toBe(6_000);
    expect(relayBackMs(window, 10_000)).toBe(8_000);
  });

  it('say 0 before each began', () => {
    expect(windowOpenMs(NO_WINDOW, 10_000)).toBe(0);
    expect(relayBackMs(NO_WINDOW, 10_000)).toBe(0);
  });

  it('count from a start at 0, which is not the same as none', () => {
    expect(windowOpenMs({ ...window, since: 0 }, 10_000)).toBe(10_000);
    expect(relayBackMs({ ...window, relaySeen: 0 }, 10_000)).toBe(10_000);
  });
});

describe('watches by the five checks', () => {
  const NOW = 500_000;
  const openWindow: Window = { since: NOW - 12_000, generation: 7, lastSent: NOW - 1_000, relayStarted: 1, relaySeen: NOW - 25_000 };
  /* Every limit stands just past its edge, so that this sample takes over and one millisecond back in any row decides it. */
  const takesOver: WatchSample = {
    now: NOW,
    started: NOW - 20_000,
    window: openWindow,
    held: false,
    leader: 'a',
    heard: NOW - 20_000,
    linkAnswered: NOW - 20_000,
    syncBeat: NOW - 99_999,
    record: anOnRecord('b', 7),
    routeGeneration: 7,
    self: 'b',
    ready: true,
    holds: false,
    ceo: null,
  };

  const quietRows: [name: string, change: Partial<WatchSample>, why: string][] = [
    ['a copy not finished', { ready: false }, 'not watching'],
    ['the promise or an offer holding', { holds: true }, 'not watching'],
    ['no leader to watch', { leader: null }, 'not watching'],
    ['the name held', { held: true }, 'the name is held'],
    ['a beat 19.999 s ago', { heard: NOW - 19_999 }, 'heard the leader'],
    ['a watcher that started 19.999 s ago and heard nothing', { started: NOW - 19_999, heard: null }, 'heard the leader'],
    ['a watcher that started 19.999 s ago and heard long before', { started: NOW - 19_999, heard: NOW - 100_000 }, 'heard the leader'],
    ['a link answer 19.999 s ago', { linkAnswered: NOW - 19_999 }, 'the leader answers at the link'],
  ];

  it.each(quietRows)('stays quiet on %s', (_name, change, why) => {
    expect(nextWatchStep({ ...takesOver, ...change }, false)).toEqual({ action: { do: 'none' }, why });
  });

  it.each(quietRows)('takes the question back on %s', (_name, change, why) => {
    expect(nextWatchStep({ ...takesOver, ...change }, true)).toEqual({ action: { do: 'unask' }, why });
  });

  const windowRows: [name: string, change: Partial<Window>][] = [
    ['no window', { since: null }],
    ['a window open 11.999 s', { since: NOW - 11_999 }],
    ['the relay never seen', { relaySeen: null }],
    ['the relay back 24.999 s', { relaySeen: NOW - 24_999 }],
  ];

  it.each(windowRows)('waits, with no answer either way, on %s', (_name, change) => {
    const sample = { ...takesOver, window: { ...openWindow, ...change } };
    expect(nextWatchStep(sample, false)).toEqual({ action: { do: 'none' }, why: 'window' });
  });

  it.each(windowRows)('keeps the question through a window that starts over: %s', (_name, change) => {
    const sample = { ...takesOver, window: { ...openWindow, ...change } };
    expect(nextWatchStep(sample, true)).toEqual({ action: { do: 'none' }, why: 'window' });
  });

  const takesRows: [name: string, change: Partial<WatchSample>, asked: boolean][] = [
    ['every check holding', {}, false],
    ['a question already asked', {}, true],
    ['a leader never heard, long since the start', { heard: null, linkAnswered: null, started: NOW - 20_000 }, false],
    ['the CEO having spoken too, which needs no term by him', { ceo: NOW - 1_000 }, false],
  ];

  it.each(takesRows)('takes over on %s', (_name, change, asked) => {
    expect(nextWatchStep({ ...takesOver, ...change }, asked)).toEqual({ action: { do: 'take', kind: 'takeover' }, why: 'checks 1-5' });
  });

  const mayLack: [name: string, change: Partial<WatchSample>][] = [
    ['no record', { record: null }],
    ['a record off', { record: { ...anOnRecord('b', 7), state: 'off' } }],
    ['a record naming another copy', { record: anOnRecord('c', 7) }],
    ['a record of an older generation', { record: anOnRecord('b', 6) }],
    ['no known route generation', { routeGeneration: null }],
    ['no beat ever saying sync on it', { syncBeat: null }],
    ['the last such beat 100 s ago', { syncBeat: NOW - 100_000 }],
  ];

  it.each(mayLack)('asks the CEO on %s', (_name, change) => {
    expect(nextWatchStep({ ...takesOver, ...change }, false)).toEqual({ action: { do: 'ask' }, why: 'may lack changes' });
  });

  it.each(mayLack)('asks once on %s', (_name, change) => {
    expect(nextWatchStep({ ...takesOver, ...change }, true)).toEqual({ action: { do: 'none' }, why: 'may lack changes' });
  });

  const lacking = { record: anOnRecord('c', 7) };
  const ceoRows: [name: string, ceo: number, asked: boolean, action: WatchAction, why: string][] = [
    ['just now', NOW, false, { do: 'take', kind: 'ceo' }, 'the CEO said go on'],
    ['after the question', NOW - 1_000, true, { do: 'take', kind: 'ceo' }, 'the CEO said go on'],
    ['9 minutes 59.999 s ago', NOW - 599_999, true, { do: 'take', kind: 'ceo' }, 'the CEO said go on'],
    ['10 minutes ago', NOW - 600_000, true, { do: 'none' }, 'may lack changes'],
  ];

  it.each(ceoRows)('goes on as the CEO said %s', (_name, ceo, asked, action, why) => {
    expect(nextWatchStep({ ...takesOver, ...lacking, ceo }, asked)).toEqual({ action, why });
  });

  /* A CEO's answer that reaches a copy whose checks do not hold yet must wait for them, and must not lapse meanwhile. */
  it('holds the CEO back until checks 1 to 4 do', () => {
    const early = { ...takesOver, ...lacking, ceo: NOW - 1_000, window: { ...openWindow, since: NOW - 11_999 } };
    expect(nextWatchStep(early, true)).toEqual({ action: { do: 'none' }, why: 'window' });
    expect(nextWatchStep({ ...early, heard: NOW - 1_000 }, true)).toEqual({ action: { do: 'unask' }, why: 'heard the leader' });
    expect(nextWatchStep({ ...early, held: true }, true)).toEqual({ action: { do: 'unask' }, why: 'the name is held' });
  });
});

describe('comes back in by the rules', () => {
  const NOW = 200_000;
  const now = at(NOW);
  const own = term(7, 'a');
  const next = term(8, 'a');
  const openWindow: Window = { since: NOW - 12_000, generation: 7, lastSent: NOW - 1_000, relayStarted: 1, relaySeen: NOW - 25_000 };
  const sample: EntrySample = {
    now,
    needed: true,
    self: 'a',
    ownTerm: own,
    latest: own,
    b: null,
    asked: null,
    window: NO_WINDOW,
    route: null,
    registering: null,
    client: 'link-a',
    tunnel: false,
    flag: false,
  };

  const RELAY_WAIT: EntryAction = { do: 'wait', why: "the relay's window" };
  const ASK: EntryAction = { do: 'ask', term: next };
  const askSent = at(NOW - 500);

  /* B's answer, sent a moment ago unless said otherwise. */
  const bSays = (stance: Stance, sent: Clocks = askSent, answered: number | null = NOW - 500): EntrySample['b'] => ({
    networkId: 'net-b',
    answered,
    answer: { stance, sent },
  });
  const bSilent: EntrySample['b'] = { networkId: 'net-b', answered: null, answer: null };
  const bFollows = (followed: Term | null): EntrySample['b'] => bSays({ kind: 'follow', term: followed });
  const route = (state: 'held' | 'empty', client: string | null, generation: number): EntrySample['route'] => ({
    state,
    client,
    generation,
    sent: at(NOW - 300),
  });

  const rows: [name: string, change: Partial<EntrySample>, action: EntryAction][] = [
    /* Not needed: as plan 9 does, each tick, whatever else it heard. */
    ['not needed', { needed: false }, { do: 'take', sent: now, term: next }],
    ['not needed, above the highest term heard', { needed: false, latest: term(11, 'b') }, { do: 'take', sent: now, term: term(12, 'a') }],
    ['not needed, above its own term when that is higher', { needed: false, ownTerm: term(9, 'a'), latest: term(3, 'b') }, { do: 'take', sent: now, term: term(10, 'a') }],
    ['not needed, with no term yet', { needed: false, ownTerm: null, latest: null }, { do: 'take', sent: now, term: term(1, 'a') }],
    ['not needed, with another client on the route', { needed: false, route: route('held', 'link-b', 8) }, { do: 'take', sent: now, term: next }],

    /* Someone else led since. */
    ['a higher term of another machine', { latest: term(8, 'b') }, { do: 'follow' }],
    ['the same number from a machine that orders above', { latest: term(7, 'b') }, { do: 'follow' }],
    ['any term of another machine, with none of its own', { ownTerm: null, latest: term(1, 'b') }, { do: 'follow' }],
    ['the route held by another client', { route: route('held', 'link-b', 8) }, { do: 'follow' }],
    ['the route left empty by another client', { route: route('empty', 'link-b', 8) }, { do: 'follow' }],
    ['B saying it leads', { b: bSays({ kind: 'lead', term: term(8, 'b'), lease: 'normal', sync: null, until: 1 }) }, { do: 'follow' }],
    /* Having once led cannot be undone by the answer growing old, and following is the safe side. */
    ['B having said long ago that it leads', { b: bSays({ kind: 'lead', term: term(8, 'b'), lease: 'normal', sync: null, until: 1 }, at(NOW - 60_000), NOW - 60_000) }, { do: 'follow' }],
    ['follows over a grant from B', { latest: term(9, 'b'), b: bFollows(next), flag: true }, { do: 'follow' }],
    ['follows over its own registration', { route: route('held', 'link-b', 8), registering: 7, tunnel: true, flag: true }, { do: 'follow' }],

    /* What is not someone else leading. */
    ['no term heard or held', { ownTerm: null, latest: null }, RELAY_WAIT],
    ['no term heard', { latest: null }, RELAY_WAIT],
    ['the same number from a machine that orders below', { latest: term(7, '0') }, RELAY_WAIT],
    ['a lower number from a machine that orders above', { latest: term(6, 'b') }, RELAY_WAIT],
    ['its own higher term, a promise it holds', { latest: term(9, 'a') }, RELAY_WAIT],
    ['a route made by nobody yet', { route: route('empty', null, 0) }, RELAY_WAIT],

    /* B's promise. */
    ['B granted and the flag set', { b: bFollows(next), flag: true }, { do: 'take', sent: askSent, term: next }],
    ['B granted a split term, which needs no flag', { ownTerm: term(7, 'a', true), b: bFollows(term(8, 'a', true)) }, { do: 'take', sent: askSent, term: term(8, 'a', true) }],
    ['B granted, no flag, its frpc stopped', { b: bFollows(next), route: route('empty', 'link-a', 7) }, { do: 'register', generation: 7 }],
    ['B granted, no flag, its frpc stopped, no route known', { b: bFollows(next) }, { do: 'register', generation: null }],
    ['B granted, no flag, its frpc running', { b: bFollows(next), tunnel: true }, { do: 'wait', why: 'the sync controller' }],
    ['a grant with the ask sent 9.999 s ago', { b: bSays({ kind: 'follow', term: next }, at(NOW - 9_999)), flag: true }, { do: 'take', sent: at(NOW - 9_999), term: next }],

    /* What is not a grant, so it goes on to ask. */
    ['B following its own term, no newer', { b: bFollows(own) }, ASK],
    ['B following an older term', { b: bFollows(term(6, 'a')) }, ASK],
    ['B following a term of another machine', { b: bFollows(term(9, 'c')) }, ASK],
    ['B following no term', { b: bFollows(null) }, ASK],
    ['B granting a split term over an unsplit one', { b: bFollows(term(8, 'a', true)), flag: true }, ASK],
    ['B granting an unsplit term over a split one', { ownTerm: term(7, 'a', true), b: bFollows(next), flag: true }, { do: 'ask', term: term(8, 'a', true) }],
    ['a grant whose ask went out 10 s ago on both clocks', { b: bSays({ kind: 'follow', term: next }, at(NOW - 10_000)), flag: true }, ASK],
    ['a grant whose ask went out 10 s ago on the wall clock alone', { b: bSays({ kind: 'follow', term: next }, at(NOW - 1_000, NOW - 10_000)), flag: true }, ASK],
    ['a grant whose ask went out 10 s ago on the monotonic clock alone', { b: bSays({ kind: 'follow', term: next }, at(NOW - 10_000, NOW - 1_000)), flag: true }, ASK],

    /* B attempting. */
    ['B attempting', { b: bSays({ kind: 'attempting' }) }, { do: 'wait', why: 'B is attempting' }],
    ['B attempting, over a registration of its own', { b: bSays({ kind: 'attempting' }), route: route('held', 'link-a', 8), registering: 7, tunnel: true, flag: true }, { do: 'wait', why: 'B is attempting' }],
    ['B attempting 9.999 s ago', { b: bSays({ kind: 'attempting' }, at(NOW - 9_999)) }, { do: 'wait', why: 'B is attempting' }],
    ['B attempting 10 s ago is old news', { b: bSays({ kind: 'attempting' }, at(NOW - 10_000)) }, ASK],

    /* Its own registration. */
    ['its own client at the next generation, the flag set', { route: route('held', 'link-a', 8), registering: 7, tunnel: true, flag: true }, { do: 'take', sent: at(NOW - 300), term: next }],
    ['its own client at the next generation, a split term', { ownTerm: term(7, 'a', true), route: route('held', 'link-a', 8), registering: 7, tunnel: true }, { do: 'take', sent: at(NOW - 300), term: term(8, 'a', true) }],
    ['its own client at the next generation, no flag', { route: route('held', 'link-a', 8), registering: 7, tunnel: true }, { do: 'wait', why: 'the sync controller' }],
    ['its own client at a later generation', { route: route('held', 'link-a', 9), registering: 7, tunnel: true, flag: true }, { do: 'stop' }],
    ['its own client with no registration noted', { route: route('held', 'link-a', 8), registering: null, tunnel: true, flag: true }, { do: 'stop' }],
    ['its own client at the generation it saw', { route: route('held', 'link-a', 7), registering: 7, tunnel: true, flag: true }, { do: 'wait', why: 'registering' }],
    ['its frpc running, the route still empty', { route: route('empty', 'link-a', 7), registering: 7, tunnel: true, flag: true }, { do: 'wait', why: 'registering' }],
    ['its frpc running, no route known', { registering: 7, tunnel: true, flag: true }, { do: 'wait', why: 'registering' }],
    ['its frpc running, the route held by nobody it can name', { route: route('held', null, 8), registering: 7, tunnel: true, flag: true }, { do: 'wait', why: 'registering' }],
    ['its frpc running, B answering', { b: bFollows(own), registering: 7, tunnel: true }, { do: 'wait', why: 'registering' }],
    ['a route of its own with its frpc stopped proves nothing', { route: route('held', 'link-a', 8), registering: 7, flag: true }, RELAY_WAIT],

    /* Asking B. */
    ['B answering, never asked', { b: bFollows(own) }, ASK],
    ['B answering, asked 2 s ago', { b: bFollows(own), asked: NOW - 2_000 }, ASK],
    ['B answering, asked 1.999 s ago', { b: bFollows(own), asked: NOW - 1_999 }, { do: 'wait', why: 'asked B' }],
    ['B answered 2.999 s ago', { b: bSays({ kind: 'follow', term: own }, askSent, NOW - 2_999) }, ASK],
    ['asks above the highest term heard', { b: bFollows(own), latest: term(9, 'a') }, { do: 'ask', term: term(10, 'a') }],
    ['B answered 3 s ago goes by the relay', { b: bSays({ kind: 'follow', term: own }, askSent, NOW - 3_000) }, RELAY_WAIT],

    /* The relay's window. */
    ['the window open', { route: route('empty', 'link-a', 7), window: openWindow }, { do: 'register', generation: 7 }],
    ['B silent, the window open', { b: bSilent, route: route('empty', 'link-a', 7), window: openWindow }, { do: 'register', generation: 7 }],
    ['the window open at a later generation', { route: route('empty', 'link-a', 8), window: openWindow }, { do: 'register', generation: 8 }],
    ['the window open 11.999 s', { route: route('empty', 'link-a', 7), window: { ...openWindow, since: NOW - 11_999 } }, RELAY_WAIT],
    ['no window', { route: route('empty', 'link-a', 7), window: { ...openWindow, since: null } }, RELAY_WAIT],
    ['the relay back 24.999 s', { route: route('empty', 'link-a', 7), window: { ...openWindow, relaySeen: NOW - 24_999 } }, RELAY_WAIT],
    ['the relay never seen', { route: route('empty', 'link-a', 7), window: { ...openWindow, relaySeen: null } }, RELAY_WAIT],
    ['the route held by itself', { route: route('held', 'link-a', 7), window: openWindow }, RELAY_WAIT],
    ['the route made by nobody, the window open', { route: route('empty', null, 7), window: openWindow }, RELAY_WAIT],
    ['no route known, the window open', { window: openWindow }, RELAY_WAIT],
    ['nothing known', {}, RELAY_WAIT],
  ];

  it.each(rows)('%s', (_name, change, action) => {
    expect(nextEntryStep({ ...sample, ...change })).toEqual(action);
  });

  describe('never unsplits a term by the CEO on the way back in', () => {
    const ownSplit = term(7, 'a', true);
    const nextSplit = term(8, 'a', true);
    const ways: [name: string, change: Partial<EntrySample>, action: EntryAction][] = [
      ['not needed', { needed: false }, { do: 'take', sent: now, term: nextSplit }],
      ['by B', { b: bFollows(nextSplit) }, { do: 'take', sent: askSent, term: nextSplit }],
      ['by the relay', { route: route('held', 'link-a', 8), registering: 7, tunnel: true }, { do: 'take', sent: at(NOW - 300), term: nextSplit }],
      ['asking B', { b: bFollows(ownSplit) }, { do: 'ask', term: nextSplit }],
    ];

    it.each(ways)('%s', (_name, change, action) => {
      expect(nextEntryStep({ ...sample, ownTerm: ownSplit, latest: ownSplit, ...change })).toEqual(action);
    });
  });
});

describe('promises only the machine that led', () => {
  const rows: [name: string, o: Parameters<typeof promiseAnswer>[0], grant: Term | null][] = [
    ['the next term to the machine it follows', { asker: 'a', term: term(8, 'a'), followed: term(7, 'a'), attempting: false }, term(8, 'a')],
    ['a later term to it', { asker: 'a', term: term(12, 'a'), followed: term(7, 'a'), attempting: false }, term(12, 'a')],
    ['no term to another machine', { asker: 'b', term: term(8, 'a'), followed: term(7, 'a'), attempting: false }, null],
    ['no term named for another machine', { asker: 'a', term: term(8, 'b'), followed: term(7, 'a'), attempting: false }, null],
    ['no term to a machine it does not follow', { asker: 'c', term: term(8, 'c'), followed: term(7, 'a'), attempting: false }, null],
    ['not the term it follows', { asker: 'a', term: term(7, 'a'), followed: term(7, 'a'), attempting: false }, null],
    ['not an older term', { asker: 'a', term: term(6, 'a'), followed: term(7, 'a'), attempting: false }, null],
    ['not a split term over an unsplit one', { asker: 'a', term: term(8, 'a', true), followed: term(7, 'a'), attempting: false }, null],
    ['a split term over a split one', { asker: 'a', term: term(8, 'a', true), followed: term(7, 'a', true), attempting: false }, term(8, 'a', true)],
    ['not an unsplit term over a split one', { asker: 'a', term: term(8, 'a'), followed: term(7, 'a', true), attempting: false }, null],
    ['nothing while attempting', { asker: 'a', term: term(8, 'a'), followed: term(7, 'a'), attempting: true }, null],
    ['nothing while following no term', { asker: 'a', term: term(8, 'a'), followed: null, attempting: false }, null],
    ['nothing for what is no term', { asker: 'a', term: 'the next one', followed: term(7, 'a'), attempting: false }, null],
    ['nothing for a term with no number', { asker: 'a', term: { machine: 'a', split: false }, followed: term(7, 'a'), attempting: false }, null],
    ['nothing for no term at all', { asker: 'a', term: null, followed: term(7, 'a'), attempting: false }, null],
  ];

  it.each(rows)('%s', (_name, o, grant) => {
    expect(promiseAnswer(o)).toEqual({ grant });
  });
});

describe('turns a term by the CEO normal once everyone follows', () => {
  const all: Parameters<typeof mayTurnNormal>[0] = {
    split: true,
    kind: 'ceo',
    relayUp: true,
    holdsRoute: true,
    members: ['a', 'c'],
    following: () => true,
    live: () => true,
  };
  const silentC = (id: string): boolean => id !== 'c';

  const rows: [name: string, change: Partial<typeof all>, turns: boolean][] = [
    ['two members following', {}, true],
    ['no members left', { members: [] }, true],
    ['one member silent and live', { following: silentC }, false],
    ['one member silent and not live', { following: silentC, live: silentC }, true],
    ['the relay not answering', { relayUp: false }, false],
    ['the route not its own', { holdsRoute: false }, false],
    ['a takeover', { kind: 'takeover' }, false],
    ['a planned switch', { kind: 'planned' }, false],
    ['no handover', { kind: null }, false],
    ['a lease not split', { split: false }, false],
  ];

  it.each(rows)('%s', (_name, change, turns) => {
    expect(mayTurnNormal({ ...all, ...change })).toBe(turns);
  });
});
