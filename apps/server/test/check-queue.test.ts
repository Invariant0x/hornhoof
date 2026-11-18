import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { CheckCoordinator } from '../src/modules/nodes/check-slots-queue.js';
import { LOAD_MS, type CheckQueueReply } from '@hornhoof/protocol';

const a = '10000000-0000-4000-8000-000000000001';
const b = '10000000-0000-4000-8000-000000000002';
const c = '10000000-0000-4000-8000-000000000003';
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('physical machine admission across subscription nodes', () => {
  it('starts two weighted parts on one 8-core host and keeps a five-core check waiting', async () => {
    const sent: CheckQueueReply[] = [];
    const queue = new CheckCoordinator({ warmupMs: 0, now: () => 0, send: (_node, reply) => { sent.push(reply); } });
    onTestFinished(() => queue.close());
    queue.node('normal', 'home-api', { cpus: 8, load: 0 });
    queue.node('builtin', 'home-api', { cpus: 8, load: 0 });
    queue.acquire('normal', { type: 'check.acquire', id: a, label: 'browser part' }, 2);
    queue.acquire('builtin', { type: 'check.acquire', id: b, label: 'another browser part' }, 2);
    queue.acquire('normal', { type: 'check.acquire', id: c, label: 'author check' });
    await tick();
    expect(queue.inspect('builtin')).toMatchObject({ holders: [{ request: { id: a } }, { request: { id: b } }], queue: [{ request: { id: c } }] });
    expect(sent.filter(reply => reply.state === 'running').map(reply => reply.id)).toEqual([a, b]);
    queue.release('builtin', b);
    await tick();
    expect(sent.filter(reply => reply.state === 'running').map(reply => reply.id)).toEqual([a, b, c]);
  });

  it('reads holders and FIFO waiters without admitting, releasing or changing a claim', async () => {
    vi.useFakeTimers({ now: 1000 });
    onTestFinished(() => { vi.useRealTimers(); });
    const sent: CheckQueueReply[] = [];
    const queue = new CheckCoordinator({ warmupMs: 0, send: (_node, reply) => { sent.push(reply); } });
    onTestFinished(() => queue.close());
    queue.node('one', 'host', { cpus: 1, load: 0 });
    queue.node('two', 'host', { cpus: 1, load: 0 });
    queue.acquire('one', { type: 'check.acquire', id: a, label: 'first' });
    await tick();
    vi.setSystemTime(2000);
    queue.acquire('two', { type: 'check.acquire', id: b, label: 'second' });
    queue.acquire('two', { type: 'check.acquire', id: c, label: 'third' });
    await tick();
    const before = [...sent];
    const view = queue.inspect('two')!;
    expect(view).toMatchObject({ capacity: 1, holders: [{ node: 'one', request: { id: a }, queuedAt: 1000, startedAt: 1000 }], queue: [{ request: { id: b }, position: 1, queuedAt: 2000 }, { request: { id: c }, position: 2 }] });
    view.holders[0]!.request.label = 'changed copy';
    expect(queue.inspect('one')!.holders[0]!.request.label).toBe('first');
    expect(sent).toEqual(before);
    queue.release('one', a); await tick();
    expect(queue.inspect('two')).toMatchObject({ holders: [{ request: { id: b }, startedAt: 2000 }], queue: [{ request: { id: c }, position: 1 }] });
    queue.release('two', b); queue.release('two', c); await tick();
    expect(queue.inspect('two')).toEqual({ capacity: 1, holders: [], queue: [] });
    expect(queue.inspect('unknown')).toBeNull();
  });

  it('refuses a request without a registered machine instead of leaving its caller waiting', () => {
    const sent: CheckQueueReply[] = [];
    const queue = new CheckCoordinator({ warmupMs: 0, send: (_node, reply) => { sent.push(reply); } });
    queue.acquire('unknown', { type: 'check.acquire', id: a, label: 'check' });
    expect(sent).toEqual([{ type: 'check.state', id: a, state: 'ended', position: 0 }]);
    queue.close();
  });

  it('does not refresh an old load measurement when the same node asks for a slot', async () => {
    const sent: CheckQueueReply[] = [];
    const queue = new CheckCoordinator({ warmupMs: 0, now: () => 90_000, send: (_node, reply) => { sent.push(reply); } });
    queue.node('one', 'host', { cpus: 10, load: 0, at: 0 });
    queue.acquire('one', { type: 'check.acquire', id: a, label: 'check' });
    await tick();
    expect(sent).toEqual([{ type: 'check.state', id: a, state: 'ended', position: 0 }]);
    queue.close();
  });
  it('shares FIFO slots across nodes and prevents another node from releasing them', async () => {
    const sent: { node: string; reply: CheckQueueReply }[] = [];
    const queue = new CheckCoordinator({ warmupMs: 0, send: (node, reply) => { sent.push({ node, reply }); } });
    queue.node('one', 'host', { cpus: 1, load: 0 });
    queue.node('two', 'host', { cpus: 1, load: 0 });
    queue.acquire('one', { type: 'check.acquire', id: a, label: 'project A' });
    queue.acquire('two', { type: 'check.acquire', id: b, label: 'project B' });
    queue.acquire('two', { type: 'check.acquire', id: c, label: 'coverage' });
    await tick();
    expect(sent.filter(s => s.reply.state === 'running').map(s => s.reply.id)).toEqual([a]);
    expect(sent).toContainEqual({ node: 'two', reply: { type: 'check.state', id: b, state: 'queued', position: 1 } });
    expect(sent).toContainEqual({ node: 'two', reply: { type: 'check.state', id: c, state: 'queued', position: 2 } });
    queue.release('two', a); await tick();
    expect(sent.filter(s => s.reply.state === 'running')).toHaveLength(1);
    queue.release('one', a); await tick();
    expect(sent.filter(s => s.reply.state === 'running').map(s => s.reply.id)).toEqual([a, b]);
    queue.release('two', c); queue.release('two', b); await tick();
    expect(sent.filter(s => s.reply.state === 'running').map(s => s.reply.id)).toEqual([a, b]);
    queue.close();
  });

  it('keeps machines independent and treats only a live queued job as waiting', async () => {
    const queue = new CheckCoordinator({ warmupMs: 0, send: () => {} });
    queue.node('one', 'host-A', { cpus: 1, load: 0 });
    queue.node('two', 'host-B', { cpus: 1, load: 0 });
    queue.acquire('one', { type: 'check.acquire', id: a, label: 'build' });
    queue.acquire('one', { type: 'check.acquire', id: b, label: 'check', jobId: c });
    queue.acquire('two', { type: 'check.acquire', id: c, label: 'other host' });
    await tick();
    expect(queue.waiting(c)).toBe(true);
    queue.lost('one');
    expect(queue.waiting(c)).toBe(false);
    queue.close();
  });

  it('revokes stale leases and holds their slots through the cleanup grace', async () => {
    let now = 0;
    const sent: CheckQueueReply[] = [];
    const queue = new CheckCoordinator({ warmupMs: 0, now: () => now, send: (_node, reply) => { sent.push(reply); } });
    queue.node('one', 'host', { cpus: 1, load: 0 });
    queue.acquire('one', { type: 'check.acquire', id: a, label: 'running' });
    await tick();
    now = 90_000;
    queue.refresh(); await tick();
    expect(sent).toContainEqual({ type: 'check.state', id: a, state: 'ended', position: 0 });
    queue.node('two', 'host', { cpus: 1, load: 0 });
    queue.acquire('two', { type: 'check.acquire', id: b, label: 'next' });
    await tick();
    expect(sent.filter(reply => reply.state === 'running').map(reply => reply.id)).toEqual([a]);
    queue.release('one', a); await tick();
    expect(sent.filter(reply => reply.state === 'running').map(reply => reply.id)).toEqual([a, b]);
    queue.close();
  });
});

/* #1060: home-api sent its load every 20 s, but the server handled the frames late, one by one in the node's queue and
   behind the shared pump of test runs, and ended the leases of a machine it heard all along. A lease counts from the
   last frame that came from the machine; one that truly says nothing for 90 s still loses its leases. */
describe('a lease counts from when the machine was last heard', () => {
  it('keeps the lease of a machine heard while its load waits to be handled, and ends the one of a silent machine', async () => {
    let now = 0;
    const heard = new Map<string, number>([['home', 0], ['quiet', 0]]);
    const sent: { node: string; reply: CheckQueueReply }[] = [];
    const queue = new CheckCoordinator({ warmupMs: 0, now: () => now, heard: node => heard.get(node) ?? null, send: (node, reply) => { sent.push({ node, reply }); } });
    queue.node('home', 'host-A', { cpus: 10, load: 0, at: 0 });
    queue.node('quiet', 'host-B', { cpus: 10, load: 0, at: 0 });
    queue.acquire('home', { type: 'check.acquire', id: a, label: 'part 4' });
    queue.acquire('quiet', { type: 'check.acquire', id: b, label: 'part 2' });
    await tick();
    /* Frames come from home every 20 s and wait to be handled; quiet sends none. Another machine's load is handled. */
    for (now = 20_000; now <= 180_000; now += 20_000) {
      heard.set('home', now);
      queue.node('other', 'host-C', { cpus: 10, load: 0, at: now });
      await tick();
    }
    const ended = sent.filter(s => s.reply.state === 'ended').map(s => s.node);
    expect(ended).toEqual(['quiet']);
    /* The late load of home, measured long ago, is handled at last: what was heard since keeps its lease. */
    queue.node('home', 'host-A', { cpus: 10, load: 0, at: 0 });
    queue.acquire('home', { type: 'check.acquire', id: c, label: 'part 3' });
    await tick();
    expect(sent.filter(s => s.reply.state === 'ended').map(s => s.node)).toEqual(['quiet']);
    expect(sent).toContainEqual({ node: 'home', reply: { type: 'check.state', id: c, state: 'running', position: 0 } });
    queue.close();
  });
});

/* #1060: a machine whose connection drops for a moment keeps its leases for 90 s, and its claim once back keeps the lease it
   held. A claim to resume a lease the server no longer holds, or one from another machine, is ended, never queued anew; a
   machine that does not come back within 90 s loses its leases as before. */
describe('a machine whose connection drops keeps its leases for 90 s', () => {
  const setup = () => {
    vi.useFakeTimers({ now: 0 });
    onTestFinished(() => { vi.useRealTimers(); });
    const heard = new Map<string, number>([['home', 0], ['quiet', 0], ['other', 0]]);
    const sent: { node: string; reply: CheckQueueReply }[] = [];
    const queue = new CheckCoordinator({ warmupMs: 0, now: () => Date.now(), heard: node => heard.get(node) ?? null, send: (node, reply) => { sent.push({ node, reply }); } });
    onTestFinished(() => { queue.close(); });
    for (const [node, host] of [['home', 'host-A'], ['quiet', 'host-B'], ['other', 'host-C']]) queue.node(node!, host!, { cpus: 10, load: 0, at: 0 });
    return { heard, sent, queue, ended: () => sent.filter(s => s.reply.state === 'ended').map(s => `${s.node} ${s.reply.id}`) };
  };

  it('keeps the lease of a machine back within 90 s and answers its claim with the lease it held', async () => {
    const { heard, sent, queue, ended } = setup();
    queue.acquire('home', { type: 'check.acquire', id: a, label: 'part 4' });
    await tick();
    queue.away('home');
    await vi.advanceTimersByTimeAsync(10_000);
    heard.set('home', Date.now());
    queue.acquire('home', { type: 'check.acquire', id: a, label: 'part 4', resume: true });
    await tick();
    expect(sent.at(-1)).toEqual({ node: 'home', reply: { type: 'check.state', id: a, state: 'running', position: 0 } });
    for (let at = 20_000; at <= 200_000; at += 20_000) { await vi.advanceTimersByTimeAsync(20_000); heard.set('home', Date.now()); }
    expect(ended()).toEqual([]);
  });

  it('ends the leases of a machine away for 90 s, and its late claim, without queueing it anew', async () => {
    const { sent, queue, ended } = setup();
    queue.acquire('quiet', { type: 'check.acquire', id: b, label: 'part 2' });
    await tick();
    queue.away('quiet');
    await vi.advanceTimersByTimeAsync(89_000);
    expect(ended()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ended()).toEqual([`quiet ${b}`]);
    queue.node('quiet', 'host-B', { cpus: 10, load: 0, at: Date.now() });
    queue.acquire('quiet', { type: 'check.acquire', id: b, label: 'part 2', resume: true });
    await tick();
    expect(ended()).toEqual([`quiet ${b}`, `quiet ${b}`]);
    expect(sent.filter(s => s.reply.id === b && s.reply.state !== 'ended').map(s => s.reply.state)).toEqual(['running']);
  });

  it('ends a claim to resume a lease that another machine holds, and leaves that lease alone', async () => {
    const { sent, queue, ended } = setup();
    queue.acquire('home', { type: 'check.acquire', id: a, label: 'part 4' });
    await tick();
    queue.acquire('other', { type: 'check.acquire', id: a, label: 'part 4', resume: true });
    await tick();
    expect(ended()).toEqual([`other ${a}`]);
    expect(sent.filter(s => s.node === 'other' && s.reply.state !== 'ended')).toEqual([]);
    queue.release('other', a); await tick();
    expect(ended()).toEqual([`other ${a}`]);
  });
});

describe('running check leases reported by a live node', () => {
  async function setup() {
    vi.useFakeTimers({ now: 1000 });
    onTestFinished(() => { vi.useRealTimers(); });
    const sent: CheckQueueReply[] = [];
    const queue = new CheckCoordinator({ warmupMs: 0, send: (_node, reply) => { sent.push(reply); } });
    onTestFinished(() => queue.close());
    const machine = { cpus: 1, load: 0 };
    queue.node('one', 'host', machine);
    queue.node('two', 'host', machine);
    queue.acquire('one', { type: 'check.acquire', id: a, label: 'running' });
    queue.acquire('two', { type: 'check.acquire', id: b, label: 'waiting' });
    await tick();
    const load = (node: string, sequence: number, ids: string[], receivedAt = Date.now()) => {
      const report = { ...machine, at: Date.now(), checkLeases: { sequence, ids, receivedAt } };
      queue.node(node, 'host', report);
    };
    const holders = () => queue.inspect('one')!.holders.map(entry => entry.request.id);
    return { queue, machine, load, holders, sent };
  }

  it('ends an unheld lease of a live node so its FIFO waiter starts', async () => {
    const { load, holders, sent } = await setup();
    expect(holders()).toEqual([a]);
    vi.setSystemTime(1001 + LOAD_MS);
    load('one', 1, []);
    await tick();
    expect(holders()).toEqual([b]);
    expect(sent).toContainEqual({ type: 'check.state', id: a, state: 'ended', position: 0 });
  });

  it('keeps a grant issued between building a snapshot and its arrival, and grants within the grace', async () => {
    const snapshotBuiltBeforeGrant = { sequence: 1, ids: [] };
    const { load, holders } = await setup();
    vi.setSystemTime(1001 + 2 * LOAD_MS);
    // The grant was sent at 1000. The earlier snapshot arrived at 1001 but waited to be applied.
    load('one', snapshotBuiltBeforeGrant.sequence, snapshotBuiltBeforeGrant.ids, 1001);
    load('one', 2, [], 1000 + LOAD_MS);
    await tick();
    expect(holders()).toEqual([a]);
  });

  it('ignores an older or duplicate snapshot even when it arrives later', async () => {
    const { load, holders } = await setup();
    const earlier = 1001 + LOAD_MS;
    vi.setSystemTime(earlier + LOAD_MS);
    load('one', 2, [a]);
    load('one', 2, []);
    vi.setSystemTime(earlier + LOAD_MS + 1);
    load('one', 1, []);
    await tick();
    expect(holders()).toEqual([a]);
  });

  it('keeps a reported lease, a lease of another node, and a lease when the old node omits the list', async () => {
    const { queue, machine, load, holders } = await setup();
    vi.setSystemTime(1001 + LOAD_MS);
    load('one', 1, [a]);
    load('two', 1, []);
    queue.node('one', 'host', machine);
    await tick();
    expect(holders()).toEqual([a]);
    expect(queue.inspect('one')!.queue.map(entry => entry.request.id)).toEqual([b]);
  });
});
