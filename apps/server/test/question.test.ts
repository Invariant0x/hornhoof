import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Beat, Heard } from '../src/modules/keeper/beats.js';
import { makeQuestion, Recovery, RECOVERY_FILE } from '../src/modules/keeper/question.js';
import { CEO_KEEP_MS } from '../src/modules/keeper/takeover-step.js';

const id = (letter: string) => letter.repeat(64);
const [A, B, C, D, E, F] = ['a', 'b', 'c', 'd', 'e', 'f'].map(id) as [string, string, string, string, string, string];
const WALL = Date.parse('2026-11-12T14:05:00.000Z');
const TERM = { number: 7, machine: A, split: false };
const beat = (machine: string, host: string, over: Partial<Beat> = {}): Beat => ({
  machine, host, stance: { kind: 'follow', term: TERM }, number: null, reach: '2026-11-12T14:01:40.000Z', ready: true, full: false, ...over,
});
const heard = (b: Beat, at: number): [string, Heard] => [b.machine, { beat: b, at, sent: null }];

describe('the question to the CEO', () => {
  it('lists the copies that are up in the server order', () => {
    const now = 100_000;
    const beats = new Map([
      heard(beat(A, 'deb', { stance: { kind: 'lead', term: TERM, lease: 'normal', sync: B, until: WALL - 200_000 }, number: 1 }), now - 180_000),
      heard(beat(C, 'nuc', { number: 3, reach: '2026-11-12T14:01:00.000Z' }), now - 1000),
      heard(beat(D, 'air', { number: 2, reach: '2026-11-12T14:01:50.000Z' }), now - 4000),
      heard(beat(E, 'old', { number: 4 }), now - 6000),
      heard(beat(F, 'new', { number: 5, ready: false }), now - 500),
    ]);
    const question = makeQuestion({
      since: WALL - 30_000, leader: { networkId: A, host: 'deb' }, heard: WALL - 180_000, self: beat(B, 'mac', { number: null }), beats, now, waiting: null,
    });
    expect(question).toEqual({
      since: new Date(WALL - 30_000).toISOString(),
      leader: { networkId: A, host: 'deb', heard: new Date(WALL - 180_000).toISOString() },
      copies: [
        { networkId: D, host: 'air', number: 2, reach: '2026-11-12T14:01:50.000Z', self: false },
        { networkId: C, host: 'nuc', number: 3, reach: '2026-11-12T14:01:00.000Z', self: false },
        { networkId: B, host: 'mac', number: null, reach: '2026-11-12T14:01:40.000Z', self: true },
      ],
      waiting: null,
    });
    /* A leader never heard has no time, and a wait says until when. */
    const waits = makeQuestion({ since: WALL, leader: { networkId: A, host: '' }, heard: null, self: beat(B, 'mac'), beats: new Map(), now, waiting: WALL + 600_000 });
    expect(waits).toMatchObject({ leader: { heard: null }, copies: [{ networkId: B, self: true }], waiting: new Date(WALL + 600_000).toISOString() });
  });

  /* A keeper's part that acts on the CEO's word, with a clock the test moves and the asks it sent kept. */
  function stand(self = B, reach: string | null = '2026-11-12T14:01:40.000Z') {
    const controlDir = mkdtempSync(join(tmpdir(), 'hh-control-'));
    const clock = { wall: WALL, mono: 50_000 };
    const sent: { to: string; path: string; body: unknown }[] = [];
    const lines: string[] = [];
    const answers = new Map<string, { status: number; body: unknown } | null>();
    const recovery = new Recovery({
      controlDir, self, reach: () => reach, others: () => [C, D].filter(other => other !== self), host: networkId => ({ [B]: 'mac', [C]: 'nuc', [D]: 'air' })[networkId] ?? '',
      ask: async (to, path, body) => (sent.push({ to, path, body }), answers.has(to) ? answers.get(to)! : { status: 200, body: { ok: true } }),
      now: () => ({ ...clock }), log: line => lines.push(line),
    });
    const word = (said: object) => writeFileSync(join(controlDir, RECOVERY_FILE), JSON.stringify({ id: '0d0c3b0e-58a4-4c6e-9d5c-0f3f6a1b2c3d', by: 'p1', at: new Date(WALL).toISOString(), ...said }));
    const pass = (ms: number) => { clock.wall += ms; clock.mono += ms; };
    return { controlDir, recovery, sent, lines, answers, word, pass, there: () => existsSync(join(controlDir, RECOVERY_FILE)) };
  }

  it("goes on here on the CEO's word", async () => {
    const s = stand();
    expect(s.recovery.go()).toBeNull();
    /* Another reach than the one this copy has: the question the CEO saw is not the one that stands. */
    s.word({ goOn: B, reach: '2026-11-12T13:00:00.000Z' });
    await s.recovery.tick();
    expect(s.recovery.go()).toBeNull();
    expect(s.there()).toBe(false);
    s.word({ goOn: B, reach: '2026-11-12T14:01:40.000Z' });
    await s.recovery.tick();
    expect(s.recovery.go()).toBe(50_000);
    expect(s.there()).toBe(false);
    expect(s.sent).toEqual([]);
    expect(s.lines).toContain('The CEO chose to go on from 2026-11-12T14:01:40.000Z on mac.');
    s.pass(CEO_KEEP_MS - 1);
    expect(s.recovery.go()).toBe(50_000);
    s.pass(1);
    expect(s.recovery.go()).toBeNull();
  });

  it('passes the word to the copy named', async () => {
    const s = stand();
    s.word({ goOn: C, reach: '2026-11-12T14:01:00.000Z' });
    await s.recovery.tick();
    expect(s.sent).toEqual([{ to: C, path: '/peer/go-on', body: { reach: '2026-11-12T14:01:00.000Z' } }]);
    expect(s.recovery.go()).toBeNull();
    expect(s.lines).toContain('The CEO chose to go on from 2026-11-12T14:01:00.000Z on nuc.');
    /* The copy named takes it with its own reach, and no other. */
    const c = stand(C, '2026-11-12T14:01:00.000Z');
    expect(c.recovery.handle(B, { reach: '2026-11-12T14:01:00.000Z' })).toEqual({ status: 200, body: { ok: true } });
    expect(c.recovery.go()).toBe(50_000);
    const other = stand(C, '2026-11-12T14:01:00.000Z');
    expect(other.recovery.handle(B, { reach: '2026-11-12T14:01:40.000Z' })).toEqual({ status: 409, body: { ok: false, why: 'reach' } });
    expect(other.recovery.go()).toBeNull();
    expect(other.recovery.handle(B, { reach: 7 })).toEqual({ status: 400, body: { ok: false } });
    /* Only a machine that keeps the company's data is heard. */
    expect(other.recovery.handle('', { reach: '2026-11-12T14:01:00.000Z' })).toEqual({ status: 403, body: { ok: false } });
    /* A copy that did not answer is said, and nothing here goes on. */
    const lost = stand();
    lost.answers.set(C, null);
    lost.word({ goOn: C, reach: '2026-11-12T14:01:00.000Z' });
    await lost.recovery.tick();
    expect(lost.lines.some(line => line.includes('did not take'))).toBe(true);
  });

  it("waits on the CEO's word", async () => {
    const s = stand();
    s.word({ goOn: B, reach: '2026-11-12T14:01:40.000Z' });
    await s.recovery.tick();
    s.word({ wait: true });
    await s.recovery.tick();
    expect(s.recovery.go()).toBeNull();
    expect(s.recovery.waiting()).toBe(WALL + CEO_KEEP_MS);
    expect(s.sent).toEqual([{ to: C, path: '/peer/go-on', body: { wait: true } }, { to: D, path: '/peer/go-on', body: { wait: true } }]);
    /* A copy told so waits too, and passes nothing on. */
    const c = stand(C);
    expect(c.recovery.handle(B, { wait: true })).toEqual({ status: 200, body: { ok: true } });
    expect(c.recovery.waiting()).toBe(WALL + CEO_KEEP_MS);
    expect(c.sent).toEqual([]);
    s.pass(CEO_KEEP_MS);
    expect(s.recovery.waiting()).toBeNull();
  });

  it('drops a word that is too old to act on', async () => {
    const s = stand();
    s.word({ goOn: B, reach: '2026-11-12T14:01:40.000Z', at: new Date(WALL - CEO_KEEP_MS).toISOString() });
    await s.recovery.tick();
    expect([s.recovery.go(), s.there()]).toEqual([null, false]);
    expect(s.lines.some(line => line.includes('too old'))).toBe(true);
    s.word({ wait: true, at: 'no time at all' });
    await s.recovery.tick();
    expect(s.recovery.waiting()).toBeNull();
    /* A word counts from when the CEO gave it, not from when this keeper read it. */
    s.word({ goOn: B, reach: '2026-11-12T14:01:40.000Z', at: new Date(WALL - CEO_KEEP_MS + 1000).toISOString() });
    await s.recovery.tick();
    expect(s.recovery.go()).toBe(50_000 - CEO_KEEP_MS + 1000);
    s.pass(1000);
    expect(s.recovery.go()).toBeNull();
  });

  it('drops a word it cannot read', async () => {
    const s = stand();
    writeFileSync(join(s.controlDir, RECOVERY_FILE), '{ "goOn": ');
    await s.recovery.tick();
    expect(s.there()).toBe(false);
    expect(s.recovery.go()).toBeNull();
    expect(s.lines.some(line => line.includes('could not read'))).toBe(true);
  });
});
