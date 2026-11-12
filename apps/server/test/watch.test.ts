import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { Term } from '../src/db/net.js';
import type { Beat, Heard } from '../src/modules/keeper/beats.js';
import type { Clocks } from '../src/modules/keeper/lease.js';
import type { Taking } from '../src/modules/keeper/switch-step.js';
import { FOLLOWED_FILE, readFollowed, Watcher, writeFollowed } from '../src/modules/keeper/watch.js';
import type { Route, SyncRecord } from '../src/modules/link/relay.js';

const A = 'a0'.repeat(16);
const B = 'b0'.repeat(16);
const C = 'c0'.repeat(16);
const S = 1000;
const WALL = 1_700_000_000_000;
const TERM: Term = { number: 7, machine: A, split: false };
const clocks = (mono: number): Clocks => ({ wall: WALL + mono, mono });
const on = (copy: string, generation = 7): SyncRecord => ({ state: 'on', copy, epoch: 3, generation, at: 1 });

/* The copy B, which follows A under (7, A), with the relay, the link and A's beats as the test scripts them by the
   second. A beats each second from -300 with "I lead, normal, commits wait for B", and stops after 0 unless said. */
function watching(script: {
  beats?: (t: number) => boolean; route?: (t: number) => { state: 'held' | 'empty'; generation: number }; record?: (t: number) => SyncRecord;
  up?: (t: number) => boolean; holds?: boolean; ready?: boolean; lost?: boolean; followed?: Term | null; onTake?: (w: Watcher) => void;
  /* From that second on the leader's keeper beats on with no lease, and says its disk is full. */
  idleFrom?: number;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-watch-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  if (script.followed !== null) writeFollowed(dir, script.followed ?? TERM);
  const said = { t: -301 };
  const lasts = new Map<string, Heard>();
  const takes: { at: number; taking: Taking }[] = [];
  const polls: number[] = [];
  const probes: number[] = [];
  const asks: { at: number; on: boolean }[] = [];
  const lines: string[] = [];
  const leads: Beat = { machine: A, host: 'debian', stance: { kind: 'lead', term: TERM, lease: 'normal', sync: B, until: 0 }, number: 1, reach: null, ready: true, full: false };
  const own = (): Beat => ({ machine: B, host: 'mac', stance: it.stance(), number: 2, reach: null, ready: true, full: false });
  const it: Watcher = new Watcher({
    dir, self: { networkId: B },
    link: () => ({ name: 'acme', key: 'k'.repeat(32) }),
    relay: {
      route: async (): Promise<Route> => {
        polls.push(said.t);
        const seen = (script.route ?? ((t: number) => ({ state: t >= 25 ? ('empty' as const) : ('held' as const), generation: 7 })))(said.t);
        return { known: true, ...seen, client: null, since: 0, relayStarted: 100, evictionBound: 30, sync: (script.record ?? (() => on(B)))(said.t) };
      },
      health: async () => ({ up: script.up?.(said.t) ?? true, relayStarted: 100 }),
    },
    probe: async nonce => (probes.push(said.t), (script.beats ?? ((t: number) => t <= 0))(said.t) && !(script.idleFrom !== undefined && said.t >= script.idleFrom) ? { machine: A, nonce } : null),
    beats: { last: id => lasts.get(id) ?? null, all: () => lasts },
    beat: own,
    /* Its maker wrote down which machine the copy was made on; the link may name nobody by now. */
    leader: () => ({ networkId: A }),
    ready: () => script.ready ?? true, holds: () => script.holds ?? false, reach: () => '2026-11-11T11:59:58.000Z',
    take: async taking => {
      script.onTake?.(it);
      takes.push({ at: said.t, taking });
    },
    ask: flag => void asks.push({ at: said.t, on: flag }),
    ceo: () => null,
    now: () => clocks(said.t * S),
    log: line => lines.push(line),
  });
  /* The seconds up to that one, a look each. */
  const until = async (second: number) => {
    while (said.t < second) {
      said.t += 1;
      const idle = script.idleFrom !== undefined && said.t >= script.idleFrom;
      if ((script.beats ?? ((t: number) => t <= 0))(said.t) && !script.lost) lasts.set(A, { beat: idle ? { ...leads, stance: { kind: 'idle', term: TERM }, full: true } : leads, at: said.t * S, sent: null });
      await it.tick();
      /* The answer of the probe sent in this look is there by the next. */
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };
  return { it, dir, said, takes, asks, lines, until, lasts, leads, polls, probes };
}

describe('the copy that watches the machine it follows', () => {
  it('takes over once the leader is gone', async () => {
    const w = watching();
    await w.until(36);
    expect([w.takes, w.asks, w.it.attempting(), w.it.stance()]).toEqual([[], [], false, { kind: 'follow', term: TERM }]);
    await w.until(60);
    expect(w.takes).toHaveLength(1);
    expect(w.takes[0]!.at).toBe(37);
    const { taking } = w.takes[0]!;
    expect(taking).toMatchObject({
      from: { networkId: A }, term: TERM, phase: 'go', kind: 'takeover', at: WALL + 37 * S, deadline: WALL + 67 * S, w: null, copies: null, slots: null, why: null,
      heard: WALL, reach: '2026-11-11T11:59:58.000Z', full: false, generation: 7,
    });
    expect(taking.switch).toMatch(/^[0-9a-f-]{36}$/);
    /* From the turn it decided it is attempting, and looks no more. */
    expect([w.it.attempting(), w.it.stance()]).toEqual([true, { kind: 'attempting' }]);
  });

  it('says it is cut off while the leader answers at the link and not its beats', async () => {
    /* No beat of the leader ever reaches this copy, and the leader holds the name and answers there. */
    const w = watching({ beats: () => true, lost: true, route: () => ({ state: 'held', generation: 7 }) });
    await w.until(-290);
    expect(w.it.cut()).toBe(false);
    await w.until(-270);
    expect([w.it.cut(), w.takes, w.asks]).toEqual([true, [], []]);
    expect(w.it.relayUp()).toBe(true);
    /* Without hornhoof.org this machine is the one that is cut off, and it knows. */
    const alone = watching({ up: () => false });
    expect(alone.it.relayUp()).toBeNull();
    await alone.until(10);
    expect([alone.it.relayUp(), alone.takes, alone.asks]).toEqual([false, [], []]);
    /* A leader that is gone altogether cuts nobody off. */
    const gone = watching();
    await gone.until(30);
    expect(gone.it.cut()).toBe(false);
  });

  it('asks the CEO when it may lack changes, and stops asking when the leader is back', async () => {
    const w = watching({ record: () => on(C), beats: t => t <= 0 || t >= 60 });
    await w.until(59);
    expect([w.takes, w.asks]).toEqual([[], [{ at: 37, on: true }]]);
    await w.until(70);
    expect(w.asks).toEqual([{ at: 37, on: true }, { at: 60, on: false }]);
    expect(w.lines).toEqual(['This copy may lack changes; asking the CEO.', 'The question is gone.']);
  });

  it('keeps the question through a relay blip', async () => {
    const w = watching({ record: () => on(C), up: t => t < 45 || t > 46 });
    await w.until(120);
    expect([w.takes, w.asks]).toEqual([[], [{ at: 37, on: true }]]);
  });

  it('takes nothing while the name is held, however long the leader is silent', async () => {
    /* No beat of the leader ever came, as after a restart of this keeper with the leader's keeper down and its link client still on. */
    const w = watching({ lost: true, beats: () => false, route: () => ({ state: 'held', generation: 7 }) });
    await w.until(120);
    expect([w.takes, w.asks]).toEqual([[], []]);
  });

  it('takes over from a leader whose keeper beats on without a lease', async () => {
    /* The leader's disk filled: its lease lapsed and its name went, while its keeper still says each second that it
       would lead. That is not the leader leading. */
    const w = watching({ beats: () => true, idleFrom: 1 });
    await w.until(60);
    expect(w.takes).toHaveLength(1);
    expect(w.takes[0]!.at).toBe(37);
    /* It took over from a leader that said its disk is full, last heard leading at 0. */
    expect(w.takes[0]!.taking).toMatchObject({ kind: 'takeover', full: true, heard: WALL });
  });

  it('counts a promise it gave as hearing the leader', async () => {
    const w = watching({ beats: () => true, idleFrom: 1, route: t => ({ state: t >= 1 ? 'empty' : 'held', generation: 7 }) });
    await w.until(18);
    /* The leader asks for the next term a moment before this copy would take over, and gets it: for twenty seconds
       from then this copy takes nothing, so the lease the leader takes on that promise is never met by a takeover. */
    expect(w.it.promise(A, { term: { number: 8, machine: A, split: false } })).toMatchObject({ body: { stance: { kind: 'follow', term: { number: 8 } } } });
    await w.until(37);
    expect(w.takes).toEqual([]);
    await w.until(45);
    expect(w.takes.map(take => take.at)).toEqual([38]);
  });

  it('tries again when it could not write the takeover down', async () => {
    let fails = 1;
    const w = watching({ onTake: () => { if (fails-- > 0) throw new Error('the folder cannot be written'); } });
    await w.until(60);
    /* The first try failed: it is not attempting on nothing, and takes over once its checks hold again. */
    expect(w.takes).toHaveLength(1);
    expect(w.takes[0]!.at).toBeGreaterThan(37);
    expect(w.it.attempting()).toBe(true);
    expect(w.lines.some(line => line.startsWith('The keeper could not watch the machine that leads'))).toBe(true);
  });

  it('asks hornhoof.org seldom while the leader is heard', async () => {
    const w = watching({ beats: () => true });
    await w.until(0);
    /* Once a minute, to know the relay's start; and nothing through the company's link. */
    expect(w.polls.length).toBeLessThanOrEqual(6);
    expect(w.polls.length).toBeGreaterThanOrEqual(4);
    expect(w.probes).toEqual([]);
    /* The leader falls silent: within a few seconds it asks each second. */
    const gone = watching();
    await gone.until(20);
    expect(gone.polls.filter(t => t > 4).length).toBe(16);
    expect(gone.probes.filter(t => t > 4).length).toBeGreaterThanOrEqual(15);
  });

  it('watches nothing while a promise holds or its copy is not ready', async () => {
    for (const quiet of [{ holds: true }, { ready: false }]) {
      const w = watching(quiet);
      await w.until(120);
      expect([w.takes, w.asks], JSON.stringify(quiet)).toEqual([[], []]);
    }
  });

  it('grants nothing once it decided', async () => {
    let answer: { status: number; body: unknown } | null = null;
    const w = watching({ onTake: watcher => void (answer = watcher.promise(A, { term: { number: 8, machine: A, split: false } })) });
    await w.until(40);
    expect(answer).toMatchObject({ status: 200, body: { machine: B, stance: { kind: 'attempting' } } });
    expect(readFollowed(w.dir)).toEqual(TERM);
  });

  it('promises the next term to the machine it follows', () => {
    const w = watching();
    const next = { number: 8, machine: A, split: false };
    expect(w.it.promise(A, { term: next })).toMatchObject({ status: 200, body: { stance: { kind: 'follow', term: next } } });
    expect([readFollowed(w.dir), w.it.followed()]).toEqual([next, next]);
    /* Another machine, a term that is not above the one kept, and a split one get no grant: it says what it follows. */
    for (const [from, term] of [[C, { number: 9, machine: C, split: false }], [A, { number: 8, machine: A, split: false }], [A, { number: 7, machine: A, split: false }], [A, { number: 9, machine: A, split: true }]] as const) {
      expect(w.it.promise(from, { term }), JSON.stringify(term)).toMatchObject({ status: 200, body: { stance: { kind: 'follow', term: next } } });
      expect(readFollowed(w.dir)).toEqual(next);
    }
    for (const body of [{}, null, 'x']) expect(w.it.promise(A, body)).toEqual({ status: 400, body: { ok: false } });
    /* A copy that wrote down no term it follows promises nothing. */
    const blank = watching({ followed: null });
    expect(blank.it.promise(A, { term: next })).toMatchObject({ status: 200, body: { stance: { kind: 'follow', term: null } } });
    expect(readFollowed(blank.dir)).toBeNull();
    /* Nor one whose note cannot be read. */
    writeFileSync(join(w.dir, FOLLOWED_FILE), '{');
    expect(readFollowed(w.dir)).toBeNull();
  });

  it("follows the leader's term", () => {
    const w = watching({ followed: null });
    const lead = (machine: string, number: number): Beat => ({ ...w.leads, machine, stance: { kind: 'lead', term: { number, machine, split: false }, lease: 'normal', sync: null, until: 0 } });
    w.it.heard(A, lead(A, 5));
    expect(readFollowed(w.dir)).toEqual({ number: 5, machine: A, split: false });
    /* Only the machine it watches says what it follows, and only a term above the one it keeps. */
    w.it.heard(C, lead(C, 9));
    w.it.heard(A, lead(A, 4));
    w.it.heard(A, { ...w.leads, stance: { kind: 'idle', term: { number: 9, machine: A, split: false } } });
    expect(w.it.followed()).toEqual({ number: 5, machine: A, split: false });
    w.it.heard(A, lead(A, 6));
    expect([w.it.followed()?.number, w.it.stance()]).toEqual([6, { kind: 'follow', term: { number: 6, machine: A, split: false } }]);
  });
});
