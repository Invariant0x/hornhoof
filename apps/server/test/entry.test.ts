import { describe, expect, it } from 'vitest';
import type { Term } from '../src/db/net.js';
import type { Beat, Heard } from '../src/modules/keeper/beats.js';
import { Reentry } from '../src/modules/keeper/entry.js';
import type { Clocks } from '../src/modules/keeper/lease.js';
import type { Route } from '../src/modules/link/relay.js';
import type { Poll } from '../src/modules/keeper/takeover-step.js';

const A = 'a0'.repeat(16);
const B = 'b0'.repeat(16);
const CLIENT = 'acme-a0a0a0a0';
const OTHER = 'acme-b0b0b0b0';
const TERM: Term = { number: 7, machine: A, split: false };
const NEXT: Term = { number: 8, machine: A, split: false };
const clocks = (mono: number): Clocks => ({ wall: 1_000_000 + mono, mono });

/* The keeper A that led under (7, A) and holds no lease, B the copy the relay's record names, and everything it goes
   by set by the test: the clock, the route, the relay's health, what B said, and its sync controller's flag. */
function keeper() {
  const said = {
    now: 0, needed: true as boolean | null, idle: false, own: TERM as Term | null, b: B as string | null, flag: false, client: CLIENT as string | null, runs: false,
    route: { state: 'held', client: CLIENT, generation: 7 } as { state: 'held' | 'empty'; client: string | null; generation: number } | 'unknown' | 'none',
    health: { up: true, relayStarted: 100 }, promise: null as Beat['stance'] | 'silent' | null,
  };
  const answers = new Map<string, Heard>();
  const lasts = new Map<string, Heard>();
  const did: string[] = [];
  const asks: Term[] = [];
  const lines: string[] = [];
  const beat = (machine: string, stance: Beat['stance']): Beat => ({ machine, host: 'mac', stance, number: 2, reach: null, ready: true, full: false });
  const it = new Reentry({
    self: A, needed: () => said.needed, idle: () => said.idle, ownTerm: async () => said.own,
    beats: { all: () => lasts, answer: id => answers.get(id) ?? null },
    b: () => said.b,
    ask: async (_networkId, term) => {
      asks.push(term);
      if (said.promise === 'silent' || said.promise === null) return null;
      return { status: 200, body: beat(B, said.promise) };
    },
    poll: async (): Promise<Poll> => {
      if (said.route === 'none') return null;
      const route: Route = said.route === 'unknown'
        ? { known: false, why: 'unreachable' }
        : { known: true, ...said.route, since: 0, relayStarted: 100, evictionBound: 30, sync: { state: 'on', copy: B, epoch: 3, generation: said.route.generation, at: 1 } };
      return { sent: clocks(said.now), replied: said.now, route, health: said.health };
    },
    client: () => said.client,
    tunnel: { start: () => void ((said.runs = true), did.push('tunnel start')), stop: () => void ((said.runs = false), did.push('tunnel stop')), runs: () => said.runs },
    flag: () => said.flag,
    follow: async () => void did.push('follow'),
    now: () => clocks(said.now),
    log: line => lines.push(line),
  });
  /* B's answer to a beat this keeper sent a moment ago. */
  const answered = (stance: Beat['stance']) => {
    const heard = { beat: beat(B, stance), at: said.now, sent: clocks(said.now - 100) };
    answers.set(B, heard);
    lasts.set(B, heard);
  };
  const hears = (machine: string, stance: Beat['stance']) => void lasts.set(machine, { beat: beat(machine, stance), at: said.now, sent: null });
  /* One look a second, for that many seconds. */
  const seconds = async (count: number) => {
    for (let n = 0; n < count; n++) {
      said.now += 1000;
      await it.tick();
    }
  };
  return { it, said, did, asks, lines, answered, hears, seconds };
}

describe('the way back to leading', () => {
  it('does nothing while a lease is held or no proof is needed', async () => {
    const k = keeper();
    k.said.route = { state: 'empty', client: OTHER, generation: 8 };
    for (const [idle, needed] of [[true, true], [false, false], [false, null]] as const) {
      [k.said.idle, k.said.needed] = [idle, needed];
      await k.seconds(3);
    }
    expect([k.did, k.asks, k.it.entry(), k.lines]).toEqual([[], [], null, []]);
  });

  it("comes back in on its copy's promise", async () => {
    const k = keeper();
    k.answered({ kind: 'follow', term: TERM });
    k.said.promise = { kind: 'follow', term: NEXT };
    await k.seconds(1);
    /* It asked B for the term above every one it knows, and B granted it: the name is taken at the route's generation. */
    expect(k.asks).toEqual([NEXT]);
    await k.seconds(1);
    expect([k.did, k.it.entry()]).toEqual([['tunnel start'], null]);
    /* With the name its own client's again and no flag yet, it waits; with the flag, it has what lets it take the
       lease: B's term, by the time the ask went out. */
    await k.seconds(1);
    expect(k.it.entry()).toBeNull();
    k.said.flag = true;
    await k.seconds(1);
    expect(k.it.entry()).toEqual({ sent: clocks(1000), term: NEXT });
    expect(k.asks).toHaveLength(1);
    /* The lease taken, what led to it is used up, and the link's client stays on. */
    k.it.taken();
    expect([k.it.entry(), k.did]).toEqual([null, ['tunnel start']]);
  });

  it('asks its copy again every two seconds while it gives no promise', async () => {
    const k = keeper();
    k.said.promise = 'silent';
    for (let s = 0; s < 6; s++) {
      k.answered({ kind: 'follow', term: TERM });
      await k.seconds(1);
    }
    expect(k.asks).toHaveLength(3);
    expect(k.it.entry()).toBeNull();
    /* A copy that is taking the server itself is waited for, and promises nothing. */
    k.answered({ kind: 'attempting' });
    await k.seconds(2);
    expect(k.asks).toHaveLength(3);
    expect(k.lines.at(-1)).toBe('This machine does not lead yet: it waits for B is attempting.');
  });

  it('comes back in through the relay when its copy does not answer', async () => {
    const k = keeper();
    /* B is silent; the name is free, and this keeper's own client registered it last, at 7. */
    k.said.route = { state: 'empty', client: CLIENT, generation: 7 };
    await k.seconds(24);
    expect([k.did, k.lines]).toEqual([[], ["This machine does not lead yet: it waits for the relay's window."]]);
    /* The name free for twelve seconds, and twenty-five since the relay was first seen: it registers. */
    await k.seconds(2);
    expect(k.did).toEqual(['tunnel start']);
    /* Its own client holds the name at 8: with a flag it takes the next term, by the time that read went out. */
    k.said.route = { state: 'held', client: CLIENT, generation: 8 };
    await k.seconds(1);
    expect(k.it.entry()).toBeNull();
    k.said.flag = true;
    await k.seconds(1);
    expect(k.it.entry()).toEqual({ sent: clocks(k.said.now), term: NEXT });
  });

  it('takes no proof from its own route at another generation', async () => {
    const k = keeper();
    k.said.route = { state: 'empty', client: CLIENT, generation: 7 };
    await k.seconds(26);
    expect(k.did).toEqual(['tunnel start']);
    /* Its client holds the name at 9: someone registered between. It stops, and the window starts again. */
    k.said.route = { state: 'held', client: CLIENT, generation: 9 };
    k.said.flag = true;
    await k.seconds(1);
    expect([k.did, k.it.entry()]).toEqual([['tunnel start', 'tunnel stop'], null]);
    k.said.route = { state: 'empty', client: CLIENT, generation: 9 };
    await k.seconds(11);
    expect(k.did).toHaveLength(2);
    await k.seconds(2);
    expect(k.did).toEqual(['tunnel start', 'tunnel stop', 'tunnel start']);
  });

  it('never comes back in after someone else registered, and follows a newer leader it hears', async () => {
    const taken = keeper();
    taken.said.route = { state: 'empty', client: OTHER, generation: 8 };
    taken.said.flag = true;
    await taken.seconds(3);
    expect([taken.did, taken.it.entry()]).toEqual([['tunnel stop', 'follow'], null]);
    expect(taken.lines).toEqual(['Another machine leads now, or the name moved on; this machine follows.']);
    const heard = keeper();
    heard.hears(B, { kind: 'lead', term: { number: 9, machine: B, split: false }, lease: 'normal', sync: null, until: 0 });
    await heard.seconds(2);
    expect(heard.did).toEqual(['tunnel stop', 'follow']);
  });

  it('keeps its link client stopped while it waits', async () => {
    const k = keeper();
    k.said.route = { state: 'empty', client: CLIENT, generation: 7 };
    /* The relay's health fails every fifth poll: the name is never seen free for twelve seconds in a row. */
    for (let s = 1; s <= 60; s++) {
      k.said.health = { up: s % 5 !== 0, relayStarted: 100 };
      await k.seconds(1);
    }
    expect([k.did, k.it.entry()]).toEqual([[], null]);
    /* Nor with no link at all, or a relay that cannot be asked. */
    for (const route of ['none', 'unknown'] as const) {
      k.said.route = route;
      k.said.health = { up: true, relayStarted: 100 };
      await k.seconds(40);
    }
    expect(k.did).toEqual([]);
  });
});
