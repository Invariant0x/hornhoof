import { EventEmitter } from 'node:events';
import type { NodeMessage } from '@hornhoof/protocol';
import type { WebSocket } from 'ws';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { BUILTIN, NodeHub } from '../src/modules/nodes/hub.js';

describe('the node hub', () => {
  it('takes the word that words went in at once, though a message before it still waits for that word', async () => {
    let heard!: () => void;
    const said = new Promise<void>(done => (heard = done));
    const handled: string[] = [];
    const hub = new NodeHub({
      pingMs: 60_000,
      onClose: async () => {},
      onMessage: async (_id, msg: NodeMessage) => {
        /* As a finished job waits for the words Hornhoof typed into another agent's turn. */
        if (msg.type === 'status') await said;
        if (msg.type === 'agent.said') heard();
        handled.push(msg.type);
      },
    });
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} });
    hub.attach(BUILTIN, socket as unknown as WebSocket);
    socket.emit('message', JSON.stringify({ type: 'status', loggedIn: true, limits: null }));
    socket.emit('message', JSON.stringify({ type: 'agent.said', ref: 'r1', ok: true }));
    const late = new Promise<void>((_, fail) => setTimeout(() => fail(new Error('the word waited behind the message')), 2000));
    await Promise.race([said, late]);
    await new Promise(r => setTimeout(r, 20));
    expect(handled).toEqual(['agent.said', 'status']);
  });

  it('says since when a node is away: from its socket closing, else from the first time it is asked', () => {
    const hub = new NodeHub({ pingMs: 60_000, onClose: async () => {}, onMessage: async () => {} });
    const node = { kind: 'node' as const, nodeId: 'n1' };
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} });
    hub.attach(node, socket as unknown as WebSocket);
    expect(hub.awaySince(node)).toBeNull();
    const before = Date.now();
    socket.readyState = 3;
    socket.emit('close');
    const since = hub.awaySince(node)!;
    expect(since).toBeGreaterThanOrEqual(before);
    expect(hub.awaySince(node)).toBe(since);
    /* One Hornhoof never saw, as after its own restart, is away from the first question on. */
    const other = { kind: 'node' as const, nodeId: 'n2' };
    const first = hub.awaySince(other)!;
    expect(first).toBeGreaterThanOrEqual(since);
    expect(hub.awaySince(other)).toBe(first);
    hub.attach(node, Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} }) as unknown as WebSocket);
    expect(hub.awaySince(node)).toBeNull();
    hub.stop();
  });

  it('keeps the build a node said in its hello, and says none for a node it does not know', () => {
    const hub = new NodeHub({ pingMs: 60_000, onClose: async () => {}, onMessage: async () => {} });
    const node = { kind: 'node' as const, nodeId: 'n1' };
    hub.attach(node, Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} }) as unknown as WebSocket);
    expect(hub.buildOf(node)).toBeNull();
    hub.greet(node, true, true, false, null, 'c0ffee'.padEnd(40, '0'));
    expect(hub.buildOf(node)).toBe('c0ffee'.padEnd(40, '0'));
    expect(hub.buildOf({ kind: 'node', nodeId: 'n2' })).toBeNull();
    hub.stop();
  });
});


describe('live program metadata in the hub', () => {
  it('requires a greeting, keeps snapshots isolated and coalesces update commands', () => {
    const hub = new NodeHub({ pingMs: 60_000, onClose: async () => {}, onMessage: async () => {} });
    onTestFinished(() => hub.stop());
    const sent: unknown[] = [];
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {}, send(text: string) { sent.push(JSON.parse(text)); } });
    expect(hub.programsOf(BUILTIN)).toBeNull();
    expect(hub.updatePrograms(BUILTIN)).toBe(false);
    hub.attach(BUILTIN, socket as unknown as WebSocket);
    expect(hub.takesSkillFiles(BUILTIN)).toBe(false);
    expect(hub.updatePrograms(BUILTIN)).toBe(false);
    expect(() => socket.emit('message', '{broken')).not.toThrow();
    expect(() => socket.emit('message', JSON.stringify({ type: 'unknown' }))).not.toThrow();
    const programs = [{ id: 'claude', version: '1.0.0', updating: false, failed: true }];
    socket.emit('message', JSON.stringify({ type: 'status', loggedIn: true, limits: null, programs }));
    expect(hub.programsOf(BUILTIN)).toEqual(programs);
    expect(hub.updatePrograms(BUILTIN)).toBe(false);
    hub.greet(BUILTIN);
    const snapshot = hub.programsOf(BUILTIN)!;
    snapshot[0]!.version = 'changed outside';
    expect(hub.programsOf(BUILTIN)).toEqual(programs);
    expect(hub.updatePrograms(BUILTIN)).toBe(true);
    expect(sent).toEqual([{ type: 'programs.update' }]);
    expect(hub.programsOf(BUILTIN)).toEqual([{ ...programs[0], updating: true, failed: false }]);
    expect(hub.updatePrograms(BUILTIN)).toBe(true);
    expect(sent).toHaveLength(1);
    socket.emit('message', JSON.stringify({ type: 'status', loggedIn: true, limits: null, programs: [] }));
    expect(hub.programsOf(BUILTIN)).toEqual([]);
    expect(hub.updatePrograms(BUILTIN)).toBe(false);
    socket.readyState = 3;
    expect(hub.programsOf(BUILTIN)).toBeNull();
    expect(hub.updatePrograms(BUILTIN)).toBe(false);
    const older = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} });
    hub.attach(BUILTIN, older as unknown as WebSocket);
    hub.greet(BUILTIN);
    expect(hub.programsOf(BUILTIN)).toBeNull();
    expect(hub.updatePrograms(BUILTIN)).toBe(false);
  });

  it('allows three full ping intervals for a new socket to reply', async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const ping = vi.fn();
    const hub = new NodeHub({ pingMs: 1000, onClose: async () => {}, onMessage: async () => {} });
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping, terminate });
    hub.attach(BUILTIN, socket as unknown as WebSocket);
    try {
      await vi.advanceTimersByTimeAsync(3000);
      expect(ping).toHaveBeenCalledTimes(3);
      expect(terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(terminate).toHaveBeenCalledOnce();
    } finally {
      hub.stop();
      vi.useRealTimers();
    }
  });
});
