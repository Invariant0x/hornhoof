import { describe, expect, it } from 'vitest';
import type { Term } from '../src/db/net.js';
import { nextLeaseStep, type Clocks, type Held } from '../src/modules/keeper/lease.js';
import type { Route, SyncRecord } from '../src/modules/link/relay.js';
import { NO_WINDOW, nextEntryStep, nextWatchStep, nextWindow, type EntrySample, type Poll, type Window } from '../src/modules/keeper/takeover-step.js';

/* The rows of what can happen to the machine that leads, each replayed second by second through the keepers' pure
   decisions: from the side of a copy that watches, and from the side of the leader itself. A is the leader, B the copy
   its commits wait for, C a third machine that keeps a copy. Times are seconds; the leader goes quiet at 0. */
const A = 'a0'.repeat(16);
const B = 'b0'.repeat(16);
const C = 'c0'.repeat(16);
const S = 1000;
const clocks = (mono: number): Clocks => ({ wall: 1_700_000_000_000 + mono, mono });

type Seen = { state: 'held' | 'empty'; generation: number } | 'unknown';
type Script = {
  /* Whether the leader's beat is heard at that second, and its answer at the link; both stop after 0 unless said. */
  beats?: (t: number) => boolean;
  link?: (t: number) => boolean;
  /* The copy the leader's beat names as the one its commits wait for. */
  syncSaid?: (t: number) => string | null;
  route?: (t: number) => Seen;
  health?: (t: number) => { up: boolean; relayStarted: number | null };
  record?: (t: number) => SyncRecord | null;
  holds?: (t: number) => boolean;
  ready?: boolean;
  /* The second the CEO says to go on from this copy. */
  ceo?: number;
  /* How much later than its send the poll of that second is answered, in ms. */
  late?: (t: number) => number;
  self?: string;
  until?: number;
};

const on = (copy: string, generation: number): SyncRecord => ({ state: 'on', copy, epoch: 3, generation, at: 1 });
const OFF: SyncRecord = { state: 'off', copy: null, epoch: 3, generation: 7, at: 1 };
const RELAY = { up: true, relayStarted: 100 };
const emptyFrom = (from: number, generation = 7) => (t: number): Seen => (t >= from ? { state: 'empty', generation } : { state: 'held', generation });

/* The copy's watch from second -300, when it saw the relay's start and began to hear the leader each second. The
   second of its first question and of its takeover, with the takeover's kind. */
function replay(script: Script): { ask: number | null; take: number | null; kind: string | null } {
  const self = script.self ?? B;
  const quietAfter = (t: number) => t <= 0;
  let window: Window = NO_WINDOW;
  let [heard, linkAnswered, syncBeat]: (number | null)[] = [null, null, null];
  let [held, generation]: [boolean, number | null] = [true, null];
  let asked = false;
  let busyUntil = -Infinity;
  const out = { ask: null as number | null, take: null as number | null, kind: null as string | null };
  for (let t = -300; t <= (script.until ?? 300); t++) {
    const now = t * S;
    const beat = (script.beats ?? quietAfter)(t);
    if (beat) {
      heard = now;
      if ((script.syncSaid ?? (() => B))(t) === self) syncBeat = now;
    }
    if ((script.link ?? script.beats ?? quietAfter)(t)) linkAnswered = now;
    /* One poll a second, unless the last one is still on its way. */
    let poll: Poll = null;
    if (now >= busyUntil) {
      const seen = (script.route ?? (() => ({ state: 'held', generation: 7 }) as Seen))(t);
      const route: Route = seen === 'unknown'
        ? { known: false, why: 'unreachable' }
        : { known: true, state: seen.state, client: seen.state === 'held' ? 'acme-a0a0a0a0' : null, since: 0, generation: seen.generation, relayStarted: 100, evictionBound: 30, sync: OFF };
      const replied = now + (script.late?.(t) ?? 0);
      busyUntil = replied > now ? replied : -Infinity;
      poll = { sent: clocks(now), replied, route, health: (script.health ?? (() => RELAY))(t) };
      if (route.known) [held, generation] = [route.state === 'held', route.generation];
    }
    window = nextWindow(window, poll, beat);
    const record = (script.record ?? (() => on(B, 7)))(t);
    const step = nextWatchStep(
      {
        now: poll ? poll.replied : now, started: -300 * S, window, held, leader: A, heard, linkAnswered, syncBeat, record, routeGeneration: generation, self,
        ready: script.ready ?? true, holds: script.holds?.(t) ?? false, ceo: script.ceo !== undefined && t >= script.ceo ? script.ceo * S : null,
      },
      asked,
    );
    if (step.action.do === 'ask') {
      asked = true;
      out.ask ??= t;
    }
    if (step.action.do === 'unask') asked = false;
    if (step.action.do === 'take') return { ...out, take: t, kind: step.action.kind };
  }
  return out;
}

const NOTHING = { ask: null, take: null, kind: null };
const takes = (at: number) => ({ ask: null, take: at, kind: 'takeover' });
const asks = (at: number) => ({ ask: at, take: null, kind: null });

describe("what the copy does in each row of the leader's troubles", () => {
  it('takes over when the leader is switched off, sleeps or loses the internet', () => {
    /* The name is held until the relay notices, 25 s here, and then free. */
    expect(replay({ route: emptyFrom(25) })).toEqual(takes(37));
    /* A relay that frees names at once: the leader's silence is what it waits for. */
    expect(replay({ route: emptyFrom(1) })).toEqual(takes(20));
    expect(replay({ route: emptyFrom(30) })).toEqual(takes(42));
  });

  it('takes nothing while the leader is heard or the name is held', () => {
    /* The leader lost the internet and the copy sits in the same home: its beats go on, and the relay cannot be asked. */
    expect(replay({ beats: () => true, link: t => t <= 0, route: t => (t > 0 ? 'unknown' : { state: 'held', generation: 7 }) })).toEqual(NOTHING);
    /* The leader's Docker quits for eight seconds. */
    expect(replay({ beats: t => t <= 0 || t >= 8, route: t => (t > 0 && t < 8 ? { state: 'empty', generation: 7 } : { state: 'held', generation: t >= 8 ? 8 : 7 }) })).toEqual(NOTHING);
    /* Its keeper falls and comes back every fifteen seconds, five seconds down each time, under a new generation each. */
    const down = (t: number) => t > 0 && t % 15 < 5;
    expect(replay({ beats: t => !down(t), route: t => (down(t) ? { state: 'empty', generation: 7 + Math.floor(t / 15) } : { state: 'held', generation: 7 + Math.max(0, Math.ceil(t / 15)) }) })).toEqual(NOTHING);
    /* The relay restarts while the leader works on. */
    const restarting = { health: (t: number) => (t >= 0 && t < 5 ? { up: false, relayStarted: null } : { up: true, relayStarted: t >= 5 ? 200 : 100 }) };
    expect(replay({ ...restarting, beats: () => true, route: t => (t >= 0 && t < 5 ? 'unknown' : { state: 'held', generation: t >= 5 ? 8 : 7 }) })).toEqual(NOTHING);
  });

  it('waits out a relay that restarted before it takes the name', () => {
    const backAt = (from: number) => ({
      health: (t: number) => (t >= 0 && t < from ? { up: false, relayStarted: null } : { up: true, relayStarted: t >= from ? 200 : 100 }),
      route: (t: number): Seen => (t >= 0 && t < from ? 'unknown' : t >= from ? { state: 'empty', generation: 7 } : { state: 'held', generation: 7 }),
    });
    /* The leader dies as the relay restarts: 25 s after the relay is back. */
    expect(replay(backAt(5))).toEqual(takes(30));
    expect(replay(backAt(60))).toEqual(takes(85));
    /* Down for longer, the leader's last word that this copy holds every change is too old: the CEO is asked. */
    expect(replay(backAt(75))).toEqual(asks(100));
    expect(replay(backAt(90))).toEqual(asks(115));
  });

  it('asks the CEO when it may lack changes', () => {
    /* The leader and the copy its commits wait for stop together, or their home loses the internet, seen from a third machine. */
    expect(replay({ self: C, route: emptyFrom(25) })).toEqual(asks(37));
    /* The record that names this copy is of an older generation than the route. */
    expect(replay({ route: emptyFrom(25), record: () => on(B, 6) })).toEqual(asks(37));
    /* The leader's beats stopped saying its commits wait for this copy 200 s before it went quiet. */
    expect(replay({ route: emptyFrom(25), syncSaid: t => (t >= -200 ? null : B) })).toEqual(asks(37));
    /* The leader dies in an update with migrations, while its copies hold their promise to wait: the record is off. */
    expect(replay({ route: emptyFrom(25), record: () => OFF, holds: t => t < 600, until: 700 })).toEqual(asks(600));
    /* The CEO says to go on from this copy three seconds after it asked. */
    expect(replay({ self: C, route: emptyFrom(25), ceo: 40 })).toEqual({ ask: 37, take: 40, kind: 'ceo' });
  });

  it('starts its window over when the generation changes or a poll comes late', () => {
    /* Someone registered and left again inside the window; the record names this copy at the new generation. */
    expect(replay({ route: t => (t < 25 ? { state: 'held', generation: 7 } : { state: 'empty', generation: t < 30 ? 7 : 8 }), record: t => on(B, t < 30 ? 7 : 8) })).toEqual(takes(43));
    /* The poll of second 30 is answered three and a half seconds late: nothing is taken at 37. */
    const late = replay({ route: emptyFrom(25), late: t => (t === 30 ? 3500 : 0) });
    expect([late.ask, late.kind]).toEqual([null, 'takeover']);
    expect(late.take).toBeGreaterThanOrEqual(42);
  });

  it('does not watch while it holds a promise, takes part in a switch, or has no whole copy', () => {
    expect(replay({ route: emptyFrom(25), holds: () => true })).toEqual(NOTHING);
    expect(replay({ route: emptyFrom(25), ready: false })).toEqual(NOTHING);
  });
});

const TERM: Term = { number: 7, machine: A, split: false };
const NEXT: Term = { number: 8, machine: A, split: false };
const CLIENT = 'acme-a0a0a0a0';

describe('what the leader does in each row', () => {
  /* The leader's lease, a tick a second, renewed only on a proof sent after its last renewal. proofAt: the second a
     proof was sent that is known by second t, or none. */
  function lease(proofAt: (t: number) => number | null, ended: (t: number) => string | null = () => null, seconds = 60): { fencedAt: number | null; why: string | null; renewals: number } {
    let held: Held = { term: TERM, kind: 'normal', sent: clocks(0) };
    let last = clocks(0);
    let renewals = 0;
    for (let t = 1; t <= seconds; t++) {
      const now = clocks(t * S);
      const proof = proofAt(t);
      const step = nextLeaseStep({ now, last, held, maintenance: false, proof: proof === null ? null : clocks(proof * S), ended: ended(t) });
      last = now;
      if (step.do === 'fence') return { fencedAt: t, why: step.why, renewals };
      if (step.do === 'renew') {
        held = { ...held, sent: step.sent };
        renewals += 1;
      }
    }
    return { fencedAt: null, why: null, renewals };
  }

  it('keeps its lease by its copy in the same home', () => {
    /* No answer at the link, and B answers each beat: every second brings a newer proof. */
    expect(lease(t => t)).toEqual({ fencedAt: null, why: null, renewals: 60 });
  });

  it('fences within ten seconds of losing the internet', () => {
    /* The last proof was sent at 3; nothing after. */
    expect(lease(t => Math.min(t, 3))).toEqual({ fencedAt: 13, why: 'no renewal for 10 s', renewals: 3 });
    expect(lease(() => null)).toEqual({ fencedAt: 10, why: 'no renewal for 10 s', renewals: 0 });
  });

  it('fences at once when another machine answers at its link', () => {
    /* A laptop that wakes with a clock that lags: its lease still looks good, and the link is another machine's. */
    expect(lease(t => t, t => (t >= 4 ? 'another machine answers at the company link' : null))).toEqual({ fencedAt: 4, why: 'another machine answers at the company link', renewals: 3 });
  });

  const NOW = 400_000;
  const T = clocks(NOW);
  const entry = (over: Partial<EntrySample> = {}): EntrySample => ({
    now: T, needed: true, self: A, ownTerm: TERM, latest: TERM, b: null, asked: null, window: NO_WINDOW, route: null, registering: null, client: CLIENT, tunnel: false, flag: false, gaveUp: false, ...over,
  });
  const promised = { networkId: B, answered: NOW - 300, answer: { stance: { kind: 'follow' as const, term: NEXT }, sent: clocks(NOW - 600) } };

  it('comes back by its copy after a restart', () => {
    const step = nextEntryStep(entry({ b: promised, flag: true }));
    expect(step).toEqual({ do: 'take', sent: clocks(NOW - 600), term: NEXT });
    /* The lease it then takes is of that term, and counts from when the ask went out. */
    expect(nextLeaseStep({ now: T, last: null, held: null, maintenance: false, entry: { sent: clocks(NOW - 600), term: NEXT } })).toEqual({ do: 'take', kind: 'normal', sent: clocks(NOW - 600), term: NEXT });
    /* Until then it takes none. */
    expect(nextLeaseStep({ now: T, last: null, held: null, maintenance: false, entry: null })).toEqual({ do: 'none' });
  });

  it('takes the promise of its copy only with a flag', () => {
    expect(nextEntryStep(entry({ b: promised, route: { state: 'empty', client: CLIENT, generation: 7, sent: clocks(NOW - 200) } }))).toEqual({ do: 'register', generation: 7 });
    expect(nextEntryStep(entry({ b: promised, tunnel: true }))).toEqual({ do: 'wait', why: 'the sync controller' });
    expect(nextEntryStep(entry({ b: promised, tunnel: true, flag: true }))).toEqual({ do: 'take', sent: clocks(NOW - 600), term: NEXT });
  });

  it('comes back by the relay after a restart while its copy sleeps', () => {
    /* B is silent. The name is free, and this keeper's own client was the last to register it, at 7. */
    let window: Window = NO_WINDOW;
    const empty: Route = { known: true, state: 'empty', client: CLIENT, since: 0, generation: 7, relayStarted: 100, evictionBound: 30, sync: OFF };
    const steps: string[] = [];
    let registeredAt: number | null = null;
    for (let t = 0; t <= 40 && registeredAt === null; t++) {
      window = nextWindow(window, { sent: clocks(t * S), replied: t * S, route: empty, health: RELAY }, false);
      const step = nextEntryStep(entry({ now: clocks(t * S), window, route: { state: 'empty', client: CLIENT, generation: 7, sent: clocks(t * S) } }));
      steps.push(step.do);
      if (step.do === 'register') {
        expect(step.generation).toBe(7);
        registeredAt = t;
      }
    }
    /* It registers once the name was free for 12 s and 25 s passed since it first saw the relay. */
    expect([registeredAt, [...new Set(steps)]]).toEqual([25, ['wait', 'register']]);
    /* Its own client holds the name at 8: it takes the next term by the time that read went out, with a flag. */
    const mine = (generation: number) => ({ state: 'held' as const, client: CLIENT, generation, sent: clocks(NOW - 200) });
    const registering = { tunnel: true, registering: 7 };
    expect(nextEntryStep(entry({ ...registering, route: mine(8) }))).toEqual({ do: 'wait', why: 'the sync controller' });
    expect(nextEntryStep(entry({ ...registering, route: mine(8), flag: true }))).toEqual({ do: 'take', sent: clocks(NOW - 200), term: NEXT });
    /* Held by it at 9 instead, someone may have registered between: it stops, and the window starts again. */
    expect(nextEntryStep(entry({ ...registering, route: mine(9), flag: true }))).toEqual({ do: 'stop' });
  });

  it('tells its own last registration from a takeover between the windows', () => {
    /* It registered again after the relay restarted, at 8, and then crashed: the name is free and still its own. */
    expect(nextEntryStep(entry({ route: { state: 'empty', client: CLIENT, generation: 8, sent: clocks(NOW - 200) } }))).toEqual({ do: 'wait', why: "the relay's window" });
    /* The name held by B's client at 8: B took over meanwhile, and this keeper follows. */
    expect(nextEntryStep(entry({ route: { state: 'held', client: 'acme-b0b0b0b0', generation: 8, sent: clocks(NOW - 200) } }))).toEqual({ do: 'follow' });
    /* Free at 8 and last registered by B's client: B took it and let it go. Until B says what it does, this keeper
       waits; a beat of B's that says it leads makes it follow, and one that says it follows lets it come back in. */
    const lastB = { state: 'empty' as const, client: 'acme-b0b0b0b0', generation: 8, sent: clocks(NOW - 200) };
    expect(nextEntryStep(entry({ route: lastB }))).toEqual({ do: 'wait', why: 'the machine that took the name last' });
    expect(nextEntryStep(entry({ route: lastB, latest: { number: 8, machine: B, split: false } }))).toEqual({ do: 'follow' });
    expect(nextEntryStep(entry({ route: lastB, gaveUp: true, b: promised, flag: true }))).toEqual({ do: 'take', sent: clocks(NOW - 600), term: NEXT });
  });
});
