import { describe, expect, it } from 'vitest';
import { CheckCoordinator } from '../src/modules/nodes/check-slots-queue.js';
import type { CheckQueueReply } from '@hornhoof/protocol';

const a = '10000000-0000-4000-8000-000000000001';
const b = '10000000-0000-4000-8000-000000000002';
const c = '10000000-0000-4000-8000-000000000003';
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('physical machine admission across subscription nodes', () => {
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
