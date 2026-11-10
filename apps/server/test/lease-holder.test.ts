import { describe, expect, it } from 'vitest';
import { LeaseHolder } from '../src/modules/keeper/lease-holder.js';
import { LEASE_MS, type Clocks } from '../src/modules/keeper/lease.js';
import { fakeLease } from './fake-lease.js';

const T0: Clocks = { wall: 1e12, mono: 5e3 };

/* A holder on clocks only the test moves, with what the updater says given by the test too. */
function holder(lease: ReturnType<typeof fakeLease> | null = fakeLease(), pruneEveryMs = 60_000) {
  let now = T0;
  let busy: boolean | null = false;
  const lines: string[] = [];
  const h = new LeaseHolder({ lease, updaterBusy: () => busy, now: () => now, pruneEveryMs, log: line => lines.push(line) });
  return {
    h, lines, lease,
    /* Both clocks go on by the same time, as on a machine that neither sleeps nor has its clock set. */
    after: (ms: number) => { now = { wall: now.wall + ms, mono: now.mono + ms }; },
    clocks: (wall: number, mono: number) => { now = { wall: now.wall + wall, mono: now.mono + mono }; },
    updater: (says: boolean | null) => { busy = says; },
    methods: () => (lease?.calls ?? []).map(call => call.method),
  };
}

describe('the lease the keeper holds', () => {
  it('takes a term on its first tick, and leads once every fence is seen to hold', async () => {
    const k = holder();
    expect(k.h.mode()).toBe('read');
    await k.h.tick();
    expect(k.lease!.calls[0]).toEqual({ method: 'take', args: ['normal', new Date(T0.wall + LEASE_MS)] });
    expect(k.h.mode()).toBe('read');
    await k.h.look();
    expect(k.h.mode()).toBe('lead');
    expect(k.h.term()).toEqual({ number: 1, machine: 'machine-a', split: false });
    expect(k.lines).toEqual(['This machine leads under term 1.']);
  });

  it('renews on every tick, each renewal good for ten seconds from when it was sent', async () => {
    const k = holder();
    await k.h.tick();
    await k.h.look();
    k.after(1000);
    await k.h.tick();
    expect(k.lease!.calls.at(-1)).toEqual({ method: 'renew', args: [{ number: 1, machine: 'machine-a', split: false }, 'normal', new Date(T0.wall + 1000 + LEASE_MS), false] });
    expect(k.h.mode()).toBe('lead');
  });

  it('does not lead while a fence does not hold, and says which, once', async () => {
    const k = holder(fakeLease({ problems: ['public.tasks has no journal trigger', 'max_prepared_transactions is 5, not 0'] }));
    await k.h.tick();
    await k.h.look();
    await k.h.look();
    expect(k.h.mode()).toBe('read');
    expect(k.lines).toContain('Hornhoof does not lead here until this is fixed: public.tasks has no journal trigger; max_prepared_transactions is 5, not 0.');
    expect(k.lines.filter(line => line.startsWith('Hornhoof does not lead'))).toHaveLength(1);
    k.lease!.problemsAre([]);
    await k.h.look();
    expect(k.h.mode()).toBe('lead');
  });

  it('lets its lease lapse when renewals do not commit, fences, and takes a new term', async () => {
    let commits = true;
    const k = holder(fakeLease({ renew: async () => commits }));
    await k.h.tick();
    await k.h.look();
    commits = false;
    for (let s = 0; s < 9; s++) {
      k.after(1000);
      await k.h.tick();
    }
    expect(k.h.mode()).toBe('lead');
    k.after(1000);
    await k.h.tick();
    expect(k.h.mode()).toBe('read');
    expect(k.h.term()).toBeNull();
    expect(k.methods().at(-1)).toBe('fence');
    expect(k.lines.at(-1)).toBe('The lease ended (no renewal for 10 s): the sessions of the app and the agents were ended, and Hornhoof only reads here until it takes a new term.');
    k.after(1000);
    await k.h.tick();
    expect(k.methods().at(-1)).toBe('take');
    expect(k.h.term()).toEqual({ number: 2, machine: 'machine-a', split: false });
  });

  it('fences on a tick that comes late on either clock, and on a clock set back', async () => {
    const late = holder();
    await late.h.tick();
    late.after(7000);
    await late.h.tick();
    expect(late.lines.at(-1)).toContain('The lease ended (a tick came 7 s after the one before)');
    const slept = holder();
    await slept.h.tick();
    slept.clocks(7000, 1000);
    await slept.h.tick();
    expect(slept.methods().at(-1)).toBe('fence');
    const back = holder();
    await back.h.tick();
    back.clocks(-2500, 1000);
    await back.h.tick();
    expect(back.lines.at(-1)).toContain('The lease ended (the clock went back 2.5 s)');
  });

  it('holds a maintenance lease while an update runs, ends the sessions as it begins, and goes back to a normal one', async () => {
    const k = holder();
    await k.h.tick();
    await k.h.look();
    k.updater(true);
    k.after(1000);
    await k.h.tick();
    expect(k.lease!.calls.at(-1)!.args.slice(1)).toEqual(['maintenance', new Date(T0.wall + 1000 + LEASE_MS), true]);
    expect(k.h.mode()).toBe('maintenance');
    k.after(1000);
    await k.h.tick();
    expect(k.lease!.calls.at(-1)!.args[3]).toBe(false);
    /* A status that cannot be read says nothing: the maintenance goes on. */
    k.updater(null);
    k.after(1000);
    await k.h.tick();
    expect(k.h.mode()).toBe('maintenance');
    k.updater(false);
    k.after(1000);
    await k.h.tick();
    expect(k.lease!.calls.at(-1)!.args.slice(1)).toEqual(['normal', new Date(T0.wall + 4000 + LEASE_MS), false]);
    expect(k.h.mode()).toBe('lead');
  });

  it('does not lead alone while another machine holds the data: its lease lapses, it says so once, and it leads again when that machine is gone', async () => {
    const k = holder();
    await k.h.tick();
    await k.h.look();
    expect(k.h.mode()).toBe('lead');

    k.lease!.othersHold(true);
    await k.h.guard();
    const before = k.methods().length;
    for (let second = 0; second < 11; second++) {
      k.after(1000);
      await k.h.tick();
      await k.h.guard();
    }
    expect(k.methods().slice(before)).toEqual([]);
    expect(k.h.mode()).toBe('read');
    expect(k.h.term()).toBeNull();
    expect(k.lines.filter(line => line === "Another machine holds the company's data, so this machine does not lead alone.")).toHaveLength(1);

    /* A read that fails keeps the last answer. */
    k.lease!.othersHold(null);
    await k.h.guard();
    k.after(1000);
    await k.h.tick();
    expect(k.h.mode()).toBe('read');

    k.lease!.othersHold(false);
    await k.h.guard();
    k.after(1000);
    await k.h.tick();
    k.after(1000);
    await k.h.tick();
    expect(k.h.mode()).toBe('lead');
    expect(k.h.term()).toEqual({ number: 2, machine: 'machine-a', split: false });
  });

  it('never leads without a lease store, and still says when an update has the company in maintenance', async () => {
    const k = holder(null);
    await k.h.tick();
    await k.h.look();
    expect(k.h.mode()).toBe('read');
    k.updater(true);
    await k.h.tick();
    expect(k.h.mode()).toBe('maintenance');
  });

  it('says once that it could not take a lease, and tries again on the next tick', async () => {
    let down = true;
    const k = holder(fakeLease({ take: async () => { if (down) throw new Error('the database is starting up'); return { number: 4, machine: 'machine-a', split: false }; } }));
    await k.h.tick();
    k.after(1000);
    await k.h.tick();
    expect(k.lines).toEqual(['Could not take a lease: the database is starting up.']);
    down = false;
    k.after(1000);
    await k.h.tick();
    expect(k.h.term()).toEqual({ number: 4, machine: 'machine-a', split: false });
  });

  it('prunes the journal each minute from its start, but not during an update', async () => {
    const k = holder(fakeLease(), 60_000);
    await k.h.tick();
    for (let s = 0; s < 59; s++) {
      k.after(1000);
      await k.h.tick();
    }
    expect(k.methods()).not.toContain('prune');
    k.after(1000);
    await k.h.tick();
    expect(k.methods().filter(method => method === 'prune')).toHaveLength(1);
    k.updater(true);
    for (let s = 0; s < 61; s++) {
      k.after(1000);
      await k.h.tick();
    }
    expect(k.methods().filter(method => method === 'prune')).toHaveLength(1);
  });
});
