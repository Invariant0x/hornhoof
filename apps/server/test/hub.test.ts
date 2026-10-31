import { EventEmitter } from 'node:events';
import type { NodeMessage } from '@hornhoof/protocol';
import type { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
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
});
