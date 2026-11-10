import { describe, expect, it } from 'vitest';
import type { Term } from '../src/db/net.js';
import { nextLeaseStep, type Clocks, type Held, type LeaseStep } from '../src/modules/keeper/lease.js';
import type { Route, SyncRecord } from '../src/modules/link/relay.js';
import {
  nextEntryStep,
  nextWatchStep,
  nextWindow,
  NO_WINDOW,
  type EntryAction,
  type EntrySample,
  type Poll,
  type Window,
} from '../src/modules/keeper/takeover-step.js';

/* Spec section 4's rows, each a script replayed second by second, as the keeper will. Second 0 is when the row's trouble
   starts. A span "0 to 5" holds for seconds 0 to 4. */

const STARTED_BEFORE = 1_000;
const STARTED_AFTER = 2_000;
const FIRST_SECOND = -300;

const clocksAt = (ms: number): Clocks => ({ wall: 1e12 + ms, mono: ms });

/* Polls go out a moment before the second's reply, so that a second's gap is not the gap of a poll on time. */
const sendOf = (second: number): number => second * 1000 - 100;

type Health = NonNullable<Poll>['health'];
type Answer = { state: 'held' | 'empty'; generation: number } | 'unknown';

type Script = {
  self?: string;
  ready?: boolean;
  /* The last second replayed, 300 unless said otherwise. */
  until?: number;
  beats?: (second: number) => boolean;
  link?: (second: number) => boolean;
  /* Whether the leader's beat of that second says lead, normal, sync on this copy. */
  saysSync?: (second: number) => boolean;
  route: (second: number) => Answer;
  health?: (second: number) => Health;
  record?: (second: number) => SyncRecord;
  holds?: (second: number) => boolean;
  ceo?: number;
  replied?: (second: number) => number;
};

const held = (generation: number): Answer => ({ state: 'held', generation });
const empty = (generation: number): Answer => ({ state: 'empty', generation });
const heldUntilEmptyAt = (from: number, generation = 7) => (second: number): Answer => (second < from ? held(7) : empty(generation));

const on = (copy: string, generation: number): SyncRecord => ({ state: 'on', copy, epoch: 1, generation, at: 1 });
const off = (generation: number): SyncRecord => ({ state: 'off', copy: null, epoch: 1, generation, at: 1 });

const UP: Health = { up: true, relayStarted: STARTED_BEFORE };
const BACK: Health = { up: true, relayStarted: STARTED_AFTER };
const DOWN: Health = { up: false, relayStarted: null };
const downUntil = (end: number) => (second: number): Health => {
  if (second < 0) return UP;
  return second < end ? DOWN : BACK;
};
/* What answers while the relay is down, and what it says once it is back. */
const unknownUntil = (end: number, then: Answer) => (second: number): Answer => (second < end ? 'unknown' : then);

const always = (): boolean => true;
const never = (): boolean => false;
const untilZero = (second: number): boolean => second <= 0;

function routeAt(second: number, script: Script, record: SyncRecord): Route {
  const answer = second < 0 ? held(7) : script.route(second);
  if (answer === 'unknown') return { known: false, why: 'unreachable' };
  return { known: true, ...answer, client: 'link-a', since: 0, relayStarted: STARTED_BEFORE, evictionBound: 30, sync: record };
}

/* The watcher's side: its window and its question, from the route, the relay's health, the beats, the link and the record.
   A take ends the replay, since the keeper exits to take. */
function replay(script: Script): string[] {
  const self = script.self ?? 'b';
  const beats = script.beats ?? untilZero;
  const link = script.link ?? untilZero;
  const saysSync = script.saysSync ?? always;
  const decisions: string[] = [];
  let window: Window = NO_WINDOW;
  let asked = false;
  let known: Extract<Route, { known: true }> | null = null;
  let heard: number | null = null;
  let linkAnswered: number | null = null;
  let syncBeat: number | null = null;
  for (let second = FIRST_SECOND; second <= (script.until ?? 300); second++) {
    const now = second * 1000;
    const record = script.record?.(second) ?? on('b', 7);
    const route = routeAt(second, script, record);
    const hearsLeader = beats(second);
    if (route.known) known = route;
    if (hearsLeader) heard = now;
    if (hearsLeader && saysSync(second)) syncBeat = now;
    if (link(second)) linkAnswered = now;
    const poll: Poll = {
      sent: clocksAt(sendOf(second)),
      replied: script.replied?.(second) ?? now,
      route,
      health: script.health?.(second) ?? UP,
    };
    window = nextWindow(window, poll, hearsLeader);
    const { action } = nextWatchStep(
      {
        now,
        started: FIRST_SECOND * 1000,
        window,
        held: known?.state === 'held',
        leader: 'a',
        heard,
        linkAnswered,
        syncBeat,
        record: known?.sync ?? null,
        routeGeneration: known?.generation ?? null,
        self,
        ready: script.ready ?? true,
        holds: script.holds?.(second) ?? false,
        ceo: script.ceo !== undefined && second >= script.ceo ? script.ceo * 1000 : null,
      },
      asked,
    );
    if (action.do === 'take') return [...decisions, `take ${action.kind} at ${second}`];
    if (action.do === 'ask') asked = true;
    if (action.do === 'unask') asked = false;
    if (action.do !== 'none') decisions.push(`${action.do} at ${second}`);
  }
  return decisions;
}

const ANOTHER_COPY = { self: 'c', saysSync: never };

const switchedOff: Script = { route: heldUntilEmptyAt(25) };

const relayDown = (end: number): Script => ({
  health: downUntil(end),
  route: unknownUntil(end, empty(7)),
});

const CRASH_EVERY_S = 15;
const crashed = (second: number): boolean => second >= 0 && second % CRASH_EVERY_S >= CRASH_EVERY_S - 5;
const generationAt = (second: number): number => 7 + Math.floor(Math.max(second, 0) / CRASH_EVERY_S);

describe("section 4's rows, from the copy's side", () => {
  const rows: [name: string, script: Script, decisions: string[]][] = [
    ['Leader switched off', switchedOff, ['take takeover at 37']],
    ['A relay that frees names at once', { route: heldUntilEmptyAt(1) }, ['take takeover at 20']],
    ['A relay that frees them after 30 s', { route: heldUntilEmptyAt(30) }, ['take takeover at 42']],
    ['Leader loses internet, copy elsewhere', { route: heldUntilEmptyAt(25) }, ['take takeover at 37']],
    ['Leader loses internet, copy in the same home', { beats: always, health: downUntil(Infinity), route: () => 'unknown' }, []],
    [
      "Leader's Docker quits for 8 s",
      {
        beats: second => second <= 0 || second >= 8,
        link: second => second <= 0 || second >= 8,
        route: second => (second < 8 ? empty(7) : held(8)),
        record: second => on('b', second < 8 ? 7 : 8),
      },
      [],
    ],
    [
      'Keeper crash-loops',
      {
        beats: second => !crashed(second),
        link: second => !crashed(second),
        route: second => (crashed(second) ? empty(generationAt(second)) : held(generationAt(second))),
        record: second => on('b', generationAt(second)),
      },
      [],
    ],
    ['Leader laptop sleeps', switchedOff, ['take takeover at 37']],
    [
      'Relay restarts',
      {
        beats: always,
        link: always,
        health: downUntil(5),
        route: unknownUntil(5, held(8)),
        record: second => on('b', second < 5 ? 7 : 8),
      },
      [],
    ],
    ['Relay restarts as the leader dies', relayDown(5), ['take takeover at 30']],
    ['Relay down 60 s, the leader dies in it', relayDown(60), ['take takeover at 85']],
    ['Relay down 75 s, the leader dies in it', relayDown(75), ['ask at 100']],
    ['Relay down 90 s, the leader dies in it', relayDown(90), ['ask at 115']],
    ['Leader and sync copy stop together, seen from a third', { ...ANOTHER_COPY, route: heldUntilEmptyAt(25) }, ['ask at 37']],
    ['Their home loses the internet, seen from a third elsewhere', { ...ANOTHER_COPY, route: heldUntilEmptyAt(25) }, ['ask at 37']],
    ['An "on" record of an older generation', { route: heldUntilEmptyAt(25), record: () => on('b', 6) }, ['ask at 37']],
    ['The leader\'s last "sync on" beat is old', { route: heldUntilEmptyAt(25), saysSync: second => second < -200 }, ['ask at 37']],
    [
      'A generation change in the window',
      {
        route: second => {
          if (second < 25) return held(7);
          return empty(second < 30 ? 7 : 8);
        },
        record: second => on('b', second < 30 ? 7 : 8),
      },
      ['take takeover at 43'],
    ],
    /* The plan accepts 42 or later: the late reply closes the window, and the next reply opens it again at 31. */
    ['A late poll', { route: heldUntilEmptyAt(25), replied: second => (second === 30 ? sendOf(29) + 3_500 : second * 1000) }, ['take takeover at 43']],
    [
      'Update promise holds until 600, migrations',
      { until: 700, route: heldUntilEmptyAt(25), holds: second => second < 600, record: () => off(7) },
      ['ask at 600'],
    ],
    ["A planned switch's offer holds", { route: heldUntilEmptyAt(25), holds: always }, []],
    ['A copy still being made', { route: heldUntilEmptyAt(25), ready: false }, []],
    ['The CEO says go on at 40, the record names another', { route: heldUntilEmptyAt(25), record: () => on('c', 7), ceo: 40 }, ['ask at 37', 'take ceo at 40']],
    /* Review focus: the question neither flaps on a relay blip nor stays once the leader is back. */
    [
      'The question stays through a relay blip and goes when the leader is heard',
      {
        beats: second => second <= 0 || second >= 120,
        route: second => (second >= 50 && second < 53 ? 'unknown' : heldUntilEmptyAt(25)(second)),
        health: second => (second >= 50 && second < 53 ? DOWN : UP),
        record: () => off(7),
      },
      ['ask at 37', 'unask at 120'],
    ],
  ];

  it.each(rows)('%s', (_name, script, decisions) => {
    expect(replay(script)).toEqual(decisions);
  });
});

describe("the leader's side", () => {
  const ownTerm: Term = { number: 7, machine: 'a', split: false };
  const nextTerm: Term = { number: 8, machine: 'a', split: false };
  const tick = (second: number): Clocks => clocksAt(second * 1000);

  /* One renewal after another, for as long as the steps allow, starting from a lease renewed at second 0. */
  function leadFor(seconds: number, proofAt: (second: number) => Clocks | null): LeaseStep[] {
    let lease: Held = { term: ownTerm, kind: 'normal', sent: tick(0) };
    const steps: LeaseStep[] = [];
    for (let second = 1; second <= seconds; second++) {
      const step = nextLeaseStep({ now: tick(second), last: tick(second - 1), held: lease, maintenance: false, proof: proofAt(second) });
      steps.push(step);
      if (step.do === 'fence') break;
      if (step.do === 'renew') lease = { ...lease, sent: step.sent };
    }
    return steps;
  }

  it('the leader keeps its lease by its copy in the same home', () => {
    const answerOf = (second: number): Clocks => tick(second - 0.5);
    const steps = leadFor(120, answerOf);
    expect(steps).toEqual(Array.from({ length: 120 }, (_, i) => ({ do: 'renew', kind: 'normal', endSessions: false, sent: answerOf(i + 1) })));
  });

  it('the leader fences within 10 s of losing the internet', () => {
    const steps = leadFor(60, () => null);
    expect(steps).toEqual([...Array.from({ length: 9 }, () => ({ do: 'none' })), { do: 'fence', why: 'no renewal for 10 s' }]);
  });

  it('a laptop that wakes with a lagging clock fences at once', () => {
    const lease: Held = { term: ownTerm, kind: 'normal', sent: tick(0) };
    const woken = { now: tick(2), last: tick(1), held: lease, maintenance: false, proof: tick(1) };
    expect(nextLeaseStep(woken).do).toBe('renew');
    expect(nextLeaseStep({ ...woken, ended: "the link answers with net-b's id" })).toEqual({ do: 'fence', why: "the link answers with net-b's id" });
  });

  const OWN_CLIENT = 'link-a';
  const restarted: EntrySample = {
    now: tick(100),
    needed: true,
    self: 'a',
    ownTerm,
    latest: ownTerm,
    b: { networkId: 'net-b', answered: null, answer: null },
    asked: null,
    window: NO_WINDOW,
    route: null,
    registering: null,
    client: OWN_CLIENT,
    tunnel: false,
    flag: false,
  };
  const bPromised = (sent: Clocks): EntrySample['b'] => ({
    networkId: 'net-b',
    answered: sent.mono + 100,
    answer: { stance: { kind: 'follow', term: nextTerm }, sent },
  });
  const ownRoute = (state: 'held' | 'empty', generation: number, second: number, client: string | null = OWN_CLIENT): EntrySample['route'] => ({
    state,
    client,
    generation,
    sent: tick(second),
  });

  const leaseFrom = (action: EntryAction, now: Clocks): LeaseStep => {
    if (action.do !== 'take') throw new Error(`expected a take, got ${action.do}`);
    return nextLeaseStep({ now, last: null, held: null, maintenance: false, entry: { sent: action.sent, term: action.term } });
  };

  it('a keeper that restarts comes back by B', () => {
    const askSent = tick(99);
    const action = nextEntryStep({ ...restarted, b: bPromised(askSent), flag: true });
    expect(action).toEqual({ do: 'take', sent: askSent, term: nextTerm });
    expect(leaseFrom(action, tick(100))).toEqual({ do: 'take', kind: 'normal', sent: askSent, term: nextTerm });
  });

  /* The first second it stops waiting for the window, seen from the second it first met the relay, and what it then does. */
  function firstMoveThroughTheWindow(generation: number): { second: number; action: EntryAction } | null {
    const answer: Route = { known: true, state: 'empty', client: OWN_CLIENT, since: 0, generation, relayStarted: STARTED_BEFORE, evictionBound: 30, sync: off(generation) };
    let window: Window = NO_WINDOW;
    for (let second = 0; second <= 60; second++) {
      window = nextWindow(window, { sent: clocksAt(sendOf(second)), replied: second * 1000, route: answer, health: UP }, false);
      const action = nextEntryStep({ ...restarted, now: tick(second), window, route: ownRoute('empty', generation, second) });
      if (action.do !== 'wait') return { second, action };
    }
    return null;
  }

  describe('a keeper that restarts while B sleeps comes back by the relay', () => {
    it('registers at 7 once the window is 12 s open and 25 s passed since the relay was first seen', () => {
      expect(firstMoveThroughTheWindow(7)).toEqual({ second: 25, action: { do: 'register', generation: 7 } });
    });

    const registering: EntrySample = { ...restarted, registering: 7, tunnel: true, flag: true };

    it('waits while the route is still empty', () => {
      expect(nextEntryStep({ ...registering, route: ownRoute('empty', 7, 99) })).toEqual({ do: 'wait', why: 'registering' });
    });

    it('takes once its own client holds the route at 8 and the flag is set', () => {
      const action = nextEntryStep({ ...registering, route: ownRoute('held', 8, 99) });
      expect(action).toEqual({ do: 'take', sent: tick(99), term: nextTerm });
      expect(leaseFrom(action, tick(100))).toEqual({ do: 'take', kind: 'normal', sent: tick(99), term: nextTerm });
    });

    it('waits for the flag while its own client holds the route at 8', () => {
      expect(nextEntryStep({ ...registering, flag: false, route: ownRoute('held', 8, 99) })).toEqual({ do: 'wait', why: 'the sync controller' });
    });

    it('stops when it holds the route at 9 instead', () => {
      expect(nextEntryStep({ ...registering, route: ownRoute('held', 9, 99) })).toEqual({ do: 'stop' });
    });
  });

  it('a keeper that re-registered after an frps restart and crashed still comes back', () => {
    expect(firstMoveThroughTheWindow(8)).toEqual({ second: 25, action: { do: 'register', generation: 8 } });
  });

  it('a takeover between the windows makes it follow', () => {
    expect(nextEntryStep({ ...restarted, route: ownRoute('empty', 8, 99, 'link-b') })).toEqual({ do: 'follow' });
  });

  describe("takes B's promise only with a flag", () => {
    const askSent = tick(99);
    const promised: EntrySample = { ...restarted, b: bPromised(askSent), route: ownRoute('empty', 7, 99) };

    it('registers first, with the flag null and the tunnel stopped', () => {
      expect(nextEntryStep(promised)).toEqual({ do: 'register', generation: 7 });
    });

    it('waits, with the tunnel running', () => {
      expect(nextEntryStep({ ...promised, tunnel: true })).toEqual({ do: 'wait', why: 'the sync controller' });
    });

    it("takes with that term and the ask's send time, with the flag set", () => {
      expect(nextEntryStep({ ...promised, tunnel: true, flag: true })).toEqual({ do: 'take', sent: askSent, term: nextTerm });
    });
  });
});
