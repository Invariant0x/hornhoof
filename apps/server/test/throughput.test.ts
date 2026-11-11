import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { Throughput } from '../src/modules/keeper/throughput.js';

const MIB = 2 ** 20;
const HOUR = 3_600_000;

/* What the keeper's peer server has sent each machine so far, as the test says it, and a clock the test moves. */
function stand(dir = mkdtempSync(join(tmpdir(), 'hh-throughput-')), at = Date.parse('2026-11-11T12:00:00Z')) {
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const state = { now: at, sent: new Map<string, number>() };
  /* Only the test reads the counts: the keeper's own pace would read them by the real clock. */
  const throughput = new Throughput({ dir, sent: () => state.sent, now: () => state.now, tickMs: 3_600_000 });
  throughput.start();
  onTestFinished(() => throughput.stop());
  /* One read of the counts after the clock moved on, with so many more bytes sent to the machine. */
  const tick = (bytes = 0, ms = 100, machine = 'a') => {
    state.now += ms;
    state.sent.set(machine, (state.sent.get(machine) ?? 0) + bytes);
    throughput.tick();
  };
  const rate = (machine = 'a') => throughput.best(state.now)[machine]?.mbps ?? null;
  return { dir, state, throughput, tick, rate };
}

describe('how fast the leader sends to each machine', () => {
  it('measures a burst', () => {
    const s = stand();
    s.tick();
    for (let n = 0; n < 4; n++) s.tick(MIB);
    /* 4 MiB over four tenths of a second: about 84 Mbit/s, the rate while the bytes flowed. */
    expect(s.rate()).toBe(84);
    expect(s.throughput.best(s.state.now).a!.at).toBe(new Date(s.state.now).toISOString());
    expect(s.rate('b')).toBeNull();
  });

  it('needs 4 MiB in a minute', () => {
    const s = stand();
    s.tick();
    s.tick(3 * MIB);
    for (let n = 0; n < 700; n++) s.tick();
    expect(s.rate()).toBeNull();
    /* 2 MiB, and 2 MiB fifty seconds later: one minute holds both. */
    s.tick(2 * MIB);
    for (let n = 0; n < 499; n++) s.tick();
    s.tick(2 * MIB);
    expect(s.rate()).toBe(168);
  });

  it('keeps the best of the day', () => {
    const s = stand();
    s.tick();
    for (let n = 0; n < 4; n++) s.tick(MIB, 168);
    expect(s.rate()).toBe(50);
    s.tick(0, HOUR);
    for (let n = 0; n < 4; n++) s.tick(MIB, 420);
    expect(s.rate()).toBe(50);
    /* A day and an hour on, the first is no part of the day any more. */
    s.tick(0, 24 * HOUR);
    expect(s.rate()).toBe(20);
    s.tick(0, 2 * HOUR);
    expect(s.rate()).toBeNull();
  });

  it('starts from the counts it finds', () => {
    const s = stand();
    /* A peer server that has sent a hundred MiB before the first read of it. */
    s.tick(100 * MIB);
    expect(s.rate()).toBeNull();
    /* A count that drops is a new peer server: a new base, and no bytes of less than nothing. */
    s.state.sent.set('a', 5);
    s.tick();
    for (let n = 0; n < 4; n++) s.tick(MIB);
    expect(s.rate()).toBe(84);
  });

  it('times a late tick', () => {
    const s = stand();
    s.tick();
    /* One read that came four tenths of a second after the one before holds all of it. */
    s.tick(4 * MIB, 400);
    expect(s.rate()).toBe(84);
  });

  it('keeps the day across a restart', () => {
    const s = stand();
    s.tick();
    for (let n = 0; n < 4; n++) s.tick(MIB, 105);
    expect(s.rate()).toBe(80);
    s.throughput.stop();
    const again = stand(s.dir, s.state.now + HOUR);
    expect(again.rate()).toBe(80);
    again.tick();
    for (let n = 0; n < 4; n++) again.tick(MIB, 420);
    expect(again.rate()).toBe(80);
    /* Each machine by itself. */
    again.tick(0, 100, 'b');
    for (let n = 0; n < 4; n++) again.tick(MIB, 100, 'b');
    expect([again.rate('b'), again.rate()]).toEqual([84, 80]);
  });
});
