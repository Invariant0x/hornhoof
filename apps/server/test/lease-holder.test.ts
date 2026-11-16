import { describe, expect, it } from 'vitest';
import { LeaseHolder, type LeaseHolderOptions } from '../src/modules/keeper/lease-holder.js';
import type { Flag } from '../src/modules/keeper/sync-step.js';
import { LEASE_MS, type Clocks } from '../src/modules/keeper/lease.js';
import { fakeLease } from './fake-lease.js';

const T0: Clocks = { wall: 1e12, mono: 5e3 };

/* A holder on clocks only the test moves, with what the updater says given by the test too. */
function holder(lease: ReturnType<typeof fakeLease> | null = fakeLease(), pruneEveryMs = 60_000, sync?: LeaseHolderOptions['sync']) {
  let now = T0;
  let busy: boolean | null = false;
  const lines: string[] = [];
  const ended: number[] = [];
  const h = new LeaseHolder({ lease, updaterBusy: () => busy, now: () => now, pruneEveryMs, log: line => lines.push(line), sync, onEnd: () => void ended.push(now.wall) });
  return {
    h, lines, lease, ended,
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
    expect(k.lease!.calls[0]).toEqual({ method: 'take', args: ['normal', new Date(T0.wall + LEASE_MS), 'alone'] });
    expect(k.h.mode()).toBe('read');
    await k.h.look();
    expect(k.h.mode()).toBe('lead');
    expect(k.h.term()).toEqual({ number: 1, machine: 'machine-a', split: false });
    expect(k.lines).toEqual(['This machine leads under term 1.']);
  });

  it('takes and renews nothing while the server is handed over, and a new term after', async () => {
    const lease = fakeLease();
    const said = { hold: false };
    let now = T0;
    const lines: string[] = [];
    const ended: number[] = [];
    const h = new LeaseHolder({ lease, updaterBusy: () => false, now: () => now, log: line => lines.push(line), hold: () => said.hold, onEnd: () => void ended.push(now.wall) });
    const after = (ms: number) => void (now = { wall: now.wall + ms, mono: now.mono + ms });
    await h.tick();
    await h.look();
    expect([h.mode(), h.term()?.number]).toEqual(['lead', 1]);
    /* The keeper that hands over ended the lease itself: this one lets go of it, and asks the database nothing. */
    said.hold = true;
    const asked = lease.calls.length;
    for (let ticks = 0; ticks < 5; ticks++) {
      after(1000);
      await h.tick();
    }
    expect([h.mode(), h.term(), lease.calls.length - asked, ended]).toEqual(['read', null, 0, []]);
    /* The switch was called off: the next tick takes the next term. */
    said.hold = false;
    after(1000);
    await h.tick();
    expect([h.mode(), h.term()?.number, lease.calls.at(-1)?.method]).toEqual(['lead', 2, 'take']);
    expect(lines).toEqual(['This machine leads under term 1.', 'This machine leads under term 2.']);
  });

  it('renews on every tick, each renewal good for ten seconds from when it was sent', async () => {
    const k = holder();
    await k.h.tick();
    await k.h.look();
    k.after(1000);
    await k.h.tick();
    expect(k.lease!.calls.at(-1)).toEqual({ method: 'renew', args: [{ number: 1, machine: 'machine-a', split: false }, 'normal', new Date(T0.wall + 1000 + LEASE_MS), false, 'alone'] });
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
    expect(k.lease!.calls.at(-1)!.args.slice(1)).toEqual(['maintenance', new Date(T0.wall + 1000 + LEASE_MS), true, 'alone']);
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
    expect(k.lease!.calls.at(-1)!.args.slice(1)).toEqual(['normal', new Date(T0.wall + 4000 + LEASE_MS), false, 'alone']);
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
    /* Nothing is taken or renewed: the lease runs out, and is ended as any lease that lapsed. */
    expect(k.methods().slice(before)).toEqual(['fence']);
    expect(k.ended).toHaveLength(1);
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

  it('takes and renews its lease under the flag the sync controller gives', async () => {
    const said = { flag: 'relay_off' as Flag, renew: true };
    const k = holder(fakeLease({ othersHoldData: true }), 60_000, { flag: () => said.flag, renew: () => said.renew });
    await k.h.guard();
    await k.h.tick();
    await k.h.look();
    /* Another machine holds the data too, and the relay knows this one alone holds the latest changes: it leads. */
    expect(k.lease!.calls.find(call => call.method === 'take')!.args[2]).toBe('relay_off');
    expect(k.h.mode()).toBe('lead');
    said.flag = 'copy';
    k.after(1000);
    await k.h.tick();
    expect(k.lease!.calls.at(-1)).toMatchObject({ method: 'renew' });
    expect(k.lease!.calls.at(-1)!.args[4]).toBe('copy');
    expect(k.h.mode()).toBe('lead');
    /* The controller says the machine is alone while another one is listed: that is no flag. */
    said.flag = 'alone';
    const before = k.lease!.calls.length;
    k.after(1000);
    await k.h.tick();
    expect(k.lease!.calls.slice(before).some(call => call.method === 'renew')).toBe(false);
    expect(k.h.mode()).toBe('read');
  });

  it('takes no lease without a flag, lets it lapse while renewing is stopped, and says when it ended', async () => {
    const said = { flag: null as Flag, renew: true };
    const k = holder(fakeLease(), 60_000, { flag: () => said.flag, renew: () => said.renew });
    await k.h.tick();
    await k.h.look();
    expect(k.methods()).not.toContain('take');
    expect(k.h.mode()).toBe('read');
    said.flag = 'copy';
    k.after(1000);
    await k.h.tick();
    expect(k.h.mode()).toBe('lead');
    /* A commit has waited long on a copy that cannot be dropped: no renewal, and the lease ends by itself. */
    said.renew = false;
    for (let seconds = 0; seconds < 12; seconds++) {
      k.after(1000);
      await k.h.tick();
    }
    expect(k.methods().filter(method => method === 'renew')).toEqual([]);
    expect(k.methods()).toContain('fence');
    expect(k.h.mode()).toBe('read');
    expect(k.ended).toHaveLength(1);
    /* Nothing is taken while it stays stopped, and a term is taken again once it lifts. */
    const takes = () => k.methods().filter(method => method === 'take').length;
    const before = takes();
    k.after(1000);
    await k.h.tick();
    expect(takes()).toBe(before);
    said.renew = true;
    k.after(1000);
    await k.h.tick();
    expect(takes()).toBe(before + 1);
  });
});

describe('a lease on a disk that writes slowly', () => {
  /* A holder whose disk measured the given fsync p99, and that is told whether another machine could lead now: one that
     holds a copy that finished. */
  function slowDisk(fsyncP99Ms: number | null, sole: boolean, lease = fakeLease()) {
    let now = T0;
    const lines: string[] = [];
    const ended: number[] = [];
    const said = { sole, fsyncP99Ms };
    const h = new LeaseHolder({
      lease, updaterBusy: () => false, now: () => now, log: line => lines.push(line), onEnd: () => void ended.push(now.wall),
      fsyncP99: () => said.fsyncP99Ms, sole: () => said.sole,
    });
    const after = (ms: number) => void (now = { wall: now.wall + ms, mono: now.mono + ms });
    const count = (method: string) => lease.calls.filter(call => call.method === method).length;
    return { h, lease, lines, ended, said, after, count };
  }

  it('keeps the lease and the sessions of the only machine that could lead through late ticks and slow renewals', async () => {
    let commits = true;
    const k = slowDisk(2949, true, fakeLease({ renew: async () => commits }));
    await k.h.tick();
    await k.h.look();
    expect(k.h.mode()).toBe('lead');
    /* Each tick waits on the disk: the renewal sent at the one before commits, and the next comes 6.3 s after. */
    for (let ticks = 0; ticks < 5; ticks++) {
      k.after(6300);
      await k.h.tick();
      expect([ticks, k.h.mode(), k.h.term()?.number]).toEqual([ticks, 'lead', 1]);
    }
    /* One renewal ran out of time on the disk, and the next tick comes 8 s after: the lease still stands. */
    commits = false;
    k.after(1000);
    await k.h.tick();
    commits = true;
    k.after(8000);
    await k.h.tick();
    expect([k.h.mode(), k.h.term()?.number, k.count('fence'), k.count('endSessions'), k.ended]).toEqual(['lead', 1, 0, 0, []]);
    expect(k.lines.filter(line => line.startsWith('The lease ended'))).toEqual([]);
  });

  it('still fences where another machine holds a copy that finished, on a tick later than a slow disk explains', async () => {
    const k = slowDisk(2949, false);
    await k.h.tick();
    await k.h.look();
    /* 8 s between two ticks is what three statements at their time on this disk may take: the lease holds. */
    k.after(8000);
    await k.h.tick();
    expect([k.h.mode(), k.count('fence')]).toEqual(['lead', 0]);
    /* A tick 9.5 s late is no slow disk: the connection was lost, and the lease ends as before. */
    k.after(9500);
    await k.h.tick();
    expect([k.h.mode(), k.count('fence'), k.ended.length]).toEqual(['read', 1, 1]);
    expect(k.lines.at(-1)).toContain('The lease ended (a tick came 9.5 s after the one before)');
  });

  it('fences a late tick as before where the disk is fast and another machine holds a copy that finished', async () => {
    const k = slowDisk(30, false);
    await k.h.tick();
    k.after(7000);
    await k.h.tick();
    expect(k.lines.at(-1)).toContain('The lease ended (a tick came 7 s after the one before)');
  });

  it('ends a lease that lapsed even on the only machine that could lead, since the database no longer holds it', async () => {
    let commits = true;
    const k = slowDisk(2949, true, fakeLease({ renew: async () => commits }));
    await k.h.tick();
    await k.h.look();
    commits = false;
    for (let s = 0; s < 10; s++) {
      k.after(1000);
      await k.h.tick();
    }
    expect([k.h.mode(), k.count('fence'), k.lines.at(-1)]).toEqual(['read', 1, expect.stringContaining('The lease ended (no renewal for 10 s)')]);
  });
});

describe('a lease that takes a proof', () => {
  /* A holder that is told whether a proof is needed, which one it has, why its lease must end, and what lets it take one. */
  function proving() {
    const lease = fakeLease();
    let now = T0;
    const lines: string[] = [];
    const ended: number[] = [];
    const said = {
      needed: true as boolean | null, proof: null as Clocks | null, ended: null as string | null,
      entry: null as { sent: Clocks; term: { number: number; machine: string; split: boolean } } | null, cleared: 0,
    };
    const h = new LeaseHolder({
      lease, updaterBusy: () => false, now: () => now, log: line => lines.push(line), onEnd: () => void ended.push(now.wall),
      proofs: { needed: () => said.needed, proof: () => said.proof, ended: () => said.ended, entry: () => said.entry, clear: () => void (said.cleared += 1) },
    });
    const after = (ms: number) => void (now = { wall: now.wall + ms, mono: now.mono + ms });
    const count = (method: string) => lease.calls.filter(call => call.method === method).length;
    return { h, lease, lines, ended, said, after, count, now: () => now };
  }

  it('takes nothing before it knows whether a proof is needed', async () => {
    const p = proving();
    p.said.needed = null;
    await p.h.tick();
    expect(p.count('take')).toBe(0);
    /* With none needed it leads as a machine that keeps the data alone: a term of its own at once, a renewal each tick. */
    p.said.needed = false;
    await p.h.tick();
    p.after(1000);
    await p.h.tick();
    expect([p.count('take'), p.count('renew'), p.said.cleared]).toEqual([1, 1, 1]);
  });

  it('takes a lease only on what lets it come back in, under that term', async () => {
    const p = proving();
    for (let ticks = 0; ticks < 3; ticks++) {
      await p.h.tick();
      p.after(1000);
    }
    expect(p.count('take')).toBe(0);
    const sent = { wall: p.now().wall - 400, mono: p.now().mono - 400 };
    p.said.entry = { sent, term: { number: 8, machine: 'machine-a', split: false } };
    await p.h.tick();
    /* The term its copy promised, counted from when the ask went out; the proofs from before are forgotten. */
    expect(p.lease.calls.find(call => call.method === 'take')!.args).toEqual(['normal', new Date(sent.wall + LEASE_MS), 'alone', { number: 8, machine: 'machine-a', split: false }]);
    expect([p.h.term()?.number, p.said.cleared]).toEqual([8, 1]);
  });

  it('renews only on a proof sent after its last renewal, and fences ten seconds after the last', async () => {
    const p = proving();
    p.said.needed = false;
    await p.h.tick();
    await p.h.look();
    p.said.needed = true;
    /* No proof: no renewal. */
    p.after(1000);
    await p.h.tick();
    expect(p.count('renew')).toBe(0);
    /* A proof sent half a second ago: the lease stands ten seconds from then. */
    p.after(1000);
    const proof = { wall: p.now().wall - 500, mono: p.now().mono - 500 };
    p.said.proof = proof;
    await p.h.tick();
    expect(p.lease.calls.at(-1)).toMatchObject({ method: 'renew', args: [{ number: 1 }, 'normal', new Date(proof.wall + LEASE_MS), false, 'alone'] });
    /* The same proof again gives nothing new. */
    p.after(1000);
    await p.h.tick();
    expect(p.count('renew')).toBe(1);
    expect(p.h.mode()).toBe('lead');
    /* Ten seconds after it was sent, with no newer one, the lease ends. */
    for (let s = 0; s < 9 && p.ended.length === 0; s++) {
      p.after(1000);
      await p.h.tick();
    }
    expect([p.ended.length, p.count('fence'), p.h.mode(), p.lines.at(-1)]).toEqual([1, 1, 'read', expect.stringContaining('The lease ended (no renewal for 10 s)')]);
    expect(p.ended[0]! - proof.wall).toBeGreaterThanOrEqual(LEASE_MS);
    expect(p.ended[0]! - proof.wall).toBeLessThan(LEASE_MS + 1000);
  });

  it('ends its lease at once on a sign that another machine leads', async () => {
    const p = proving();
    p.said.needed = false;
    await p.h.tick();
    await p.h.look();
    p.said.needed = true;
    p.after(1000);
    p.said.proof = p.now();
    p.said.ended = 'another machine answers at the link';
    await p.h.tick();
    expect([p.count('fence'), p.ended.length, p.h.mode(), p.h.term()]).toEqual([1, 1, 'read', null]);
    expect(p.lines.at(-1)).toContain('The lease ended (another machine answers at the link)');
    /* Holding none, the sign ends nothing more. */
    p.after(1000);
    await p.h.tick();
    expect(p.count('fence')).toBe(1);
  });

  it('says when its disk is full, and ends its lease although the fence cannot be written', async () => {
    const full = Object.assign(new Error('could not extend file: No space left on device'), { code: '53100' });
    const lease = fakeLease({ renew: () => Promise.reject(full) });
    let now = T0;
    const ended: number[] = [];
    const h = new LeaseHolder({ lease, updaterBusy: () => false, now: () => now, log: () => undefined, onEnd: () => void ended.push(now.wall) });
    const after = (ms: number) => void (now = { wall: now.wall + ms, mono: now.mono + ms });
    await h.tick();
    expect(h.full()).toBe(false);
    lease.fence = () => Promise.reject(full);
    for (let s = 0; s < 11 && ended.length === 0; s++) {
      after(1000);
      await h.tick();
    }
    /* Ten seconds of renewals that could not be written: the lease is over, and whoever asks hears why. */
    expect([ended.length, h.mode(), h.full()]).toEqual([1, 'read', true]);
  });
});
