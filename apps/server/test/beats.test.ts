import { describe, expect, it } from 'vitest';
import type { Clocks } from '../src/modules/keeper/lease.js';
import { BEAT_MS, BEAT_WAIT_MS, Beats, parseBeat, type Beat } from '../src/modules/keeper/beats.js';
import type { Peer } from '../src/net/peer-server.js';

const A = 'a0'.repeat(16);
const B = 'b0'.repeat(16);
const ROW_A = '0f0f0f0f-0000-4000-8000-00000000000a';
const ROW_B = '0f0f0f0f-0000-4000-8000-00000000000b';
const TERM = { number: 4, machine: A, split: false };

const peerOf = (machine: string, role: Peer['role'] = 'data'): Peer => ({ machine, role, serial: '01', until: new Date(Date.now() + 60_000), address: '127.0.0.1' });
const leads: Beat = { machine: A, host: 'debian', stance: { kind: 'lead', term: TERM, lease: 'normal', sync: B, until: 5_000 }, number: 1, reach: '2026-11-11T12:00:00.000Z', ready: true, full: false };
const follows: Beat = { machine: B, host: 'mac', stance: { kind: 'follow', term: TERM }, number: 2, reach: '2026-11-11T11:59:59.000Z', ready: true, full: false };

/* Two keepers that keep data, A and B, each with a session to the other, and one clock the test moves. */
function pair() {
  const clock: Clocks = { wall: 1_000_000, mono: 500 };
  const asked: string[] = [];
  const said = { a: leads, b: follows, answer: null as null | (() => Promise<{ status: number; body: unknown } | null>) };
  const lines: string[] = [];
  const now = () => ({ ...clock });
  const b: Beats = new Beats({
    self: () => said.b, peers: () => [{ machine: ROW_A, networkId: A }], now, log: line => lines.push(line),
    ask: async (networkId, _method, path, body) => (asked.push(`b to ${networkId} ${path}`), a.handle(peerOf(ROW_B), body)),
  });
  const a: Beats = new Beats({
    self: () => said.a, peers: () => [{ machine: ROW_B, networkId: B }], now, log: line => lines.push(line),
    ask: async (networkId, _method, path, body, timeoutMs) => {
      asked.push(`a to ${networkId} ${path} ${timeoutMs}`);
      return said.answer ? said.answer() : b.handle(peerOf(ROW_A), body);
    },
  });
  return { a, b, clock, asked, said, lines };
}

describe('the beats between the machines that keep data', () => {
  it('hears each other each second', async () => {
    const p = pair();
    expect([BEAT_MS, BEAT_WAIT_MS]).toEqual([1_000, 900]);
    expect([p.a.last(B), p.a.answer(B), [...p.a.all()]]).toEqual([null, null, []]);
    await p.a.tick();
    /* B heard A's beat, and A B's answer to it, with the time A sent it. */
    expect(p.asked).toEqual([`a to ${B} /peer/beat 900`]);
    expect(p.b.last(A)).toEqual({ beat: leads, at: 500, sent: null });
    expect(p.b.answer(A)).toBeNull();
    expect(p.a.last(B)).toEqual({ beat: follows, at: 500, sent: { wall: 1_000_000, mono: 500 } });
    expect(p.a.answer(B)).toEqual(p.a.last(B));
    /* A second later B's own beat comes to A: the newest from B either way, while the last answer stays. */
    p.clock.mono += 1000;
    p.clock.wall += 1000;
    p.said.b = { ...follows, reach: '2026-11-11T12:00:00.000Z' };
    await p.b.tick();
    expect(p.a.last(B)).toEqual({ beat: p.said.b, at: 1500, sent: null });
    expect(p.a.answer(B)?.beat).toEqual(follows);
    expect(p.b.answer(A)).toEqual({ beat: leads, at: 1500, sent: { wall: 1_001_000, mono: 1500 } });
    expect([...p.a.all().keys()]).toEqual([B]);
    /* Once it stopped, it asks nobody. */
    p.a.stop();
    const before = p.asked.length;
    await p.a.tick();
    expect(p.asked.length).toBe(before);
    expect(p.lines).toEqual([]);
  });

  it('keeps one beat in flight to a machine', async () => {
    const p = pair();
    let answer!: (said: { status: number; body: unknown } | null) => void;
    p.said.answer = () => new Promise(resolve => (answer = resolve));
    const first = p.a.tick();
    await p.a.tick();
    await p.a.tick();
    expect(p.asked).toHaveLength(1);
    /* The answer counts by when its beat was sent, however late it comes. */
    p.clock.mono += 3000;
    answer({ status: 200, body: follows });
    await first;
    expect(p.a.answer(B)).toEqual({ beat: follows, at: 3500, sent: { wall: 1_000_000, mono: 500 } });
    p.said.answer = null;
    await p.a.tick();
    expect(p.asked).toHaveLength(2);
  });

  it('keeps nothing it cannot trust', async () => {
    const p = pair();
    await p.a.tick();
    const kept = p.b.last(A);
    /* A beat this keeper cannot read. */
    for (const body of [{ ...leads, stance: { kind: 'other' } }, { ...leads, machine: 'short' }, { ...leads, number: 1.5 }, { ...leads, reach: 'yesterday' }, null, 'x']) {
      expect(p.b.handle(peerOf(ROW_A), body), JSON.stringify(body)).toEqual({ status: 400, body: { ok: false } });
      expect(parseBeat(body)).toBeNull();
    }
    /* One that names another machine than the one whose certificate it came with, or comes from a worker, or from a
       machine this keeper does not list. */
    expect(p.b.handle(peerOf(ROW_A), { ...leads, machine: B })).toEqual({ status: 403, body: { ok: false } });
    expect(p.b.handle(peerOf(ROW_A, 'worker'), leads)).toEqual({ status: 403, body: { ok: false } });
    expect(p.b.handle(peerOf(ROW_B), leads)).toEqual({ status: 403, body: { ok: false } });
    expect(p.b.last(A)).toEqual(kept);
    /* An ask that comes to nothing changes nothing. */
    const heard = p.a.last(B);
    for (const answer of [null, { status: 404, body: null }, { status: 200, body: { ok: true } }, { status: 200, body: { ...follows, machine: A } }]) {
      p.said.answer = async () => answer;
      await p.a.tick();
      expect(p.a.last(B)).toEqual(heard);
    }
    p.said.answer = async () => Promise.reject(new Error('the session ended'));
    await p.a.tick();
    expect(p.a.last(B)).toEqual(heard);
  });

  it('reads every stance', () => {
    const stances = [
      { kind: 'lead', term: TERM, lease: 'maintenance', sync: null, until: 1 }, { kind: 'follow', term: null }, { kind: 'follow', term: TERM },
      { kind: 'attempting' }, { kind: 'handing', to: B }, { kind: 'idle', term: null }, { kind: 'idle', term: TERM },
    ];
    for (const stance of stances) expect(parseBeat({ ...leads, stance, number: null, reach: null })?.stance, stance.kind).toEqual(stance);
    for (const stance of [{ kind: 'lead', term: TERM, lease: 'other', sync: null, until: 1 }, { kind: 'lead', term: null, lease: 'normal', sync: null, until: 1 }, { kind: 'handing' }, { kind: 'follow' }]) {
      expect(parseBeat({ ...leads, stance }), JSON.stringify(stance)).toBeNull();
    }
  });
});
