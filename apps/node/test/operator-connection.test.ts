import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { ProgramNodeMessage, ProgramServerMessage } from '@hornhoof/protocol/program-operator';
import { expect, it, onTestFinished } from 'vitest';
import { connect, parseOperatorServerMessage } from '../src/connection.js';
import { eventually } from '../../../test-support/eventually.mjs';
import { testPort } from '../../../test-support/ports.mjs';

it('accepts bounded operator messages and keeps legacy transport compatible', () => {
  const frame = { type: 'program.screen_get', agentKey: randomUUID(), jobId: randomUUID(), instance: randomUUID(), case: randomUUID(), capability: randomUUID(), request: randomUUID() };
  expect(parseOperatorServerMessage(JSON.stringify(frame))).toEqual(frame);
  expect(parseOperatorServerMessage(JSON.stringify({ ...frame, capability: '' }))).toBeNull();
  expect(parseOperatorServerMessage('{broken')).toBeNull();
  expect(parseOperatorServerMessage(JSON.stringify({ type: 'job.cancel', jobId: 'legacy' }))).toEqual({ type: 'job.cancel', jobId: 'legacy' });
});

it('preserves validated delivery metadata for live words and refuses malformed identities', () => {
  const frame = { type: 'agent.say', agentKey: 'legacy', text: 'Words.', ref: 'r', operatorDelivery: { id: randomUUID(), ordinal: 3 } };
  expect(parseOperatorServerMessage(JSON.stringify(frame))).toEqual(frame);
  expect(parseOperatorServerMessage(JSON.stringify({ ...frame, operatorDelivery: { id: 'bad', ordinal: 0 } }))).toBeNull();
  const continuation = { ...frame, operatorSourceDelivery: { id: randomUUID(), ordinal: 1 } };
  expect(parseOperatorServerMessage(JSON.stringify(continuation))).toEqual(continuation);
  expect(parseOperatorServerMessage(JSON.stringify({ ...continuation, operatorSourceDelivery: { id: 'bad', ordinal: 1 } }))).toBeNull();
});

it('preserves operator frames and delivery metadata through reconnect while close-hook errors cannot stop retries', async () => {
  const server = new WebSocketServer({ port: await testPort(), host: '127.0.0.1' });
  onTestFinished(() => server.close());
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const identity = { agentKey: randomUUID(), jobId: randomUUID(), instance: randomUUID() };
  const request = { type: 'program.screen_get' as const, ...identity, case: randomUUID(), capability: randomUUID(), request: randomUUID() };
  const words = { type: 'agent.say' as const, agentKey: identity.agentKey, text: 'Exact words.', ref: 'live', operatorDelivery: { id: randomUUID(), ordinal: 2 }, operatorSourceDelivery: { id: randomUUID(), ordinal: 1 } };
  const evidence: ProgramNodeMessage = { type: 'program.launch', ...identity, evidenceId: randomUUID(), ordinal: 0, phase: 'attempt', elapsedMs: 0 };
  const received: ProgramServerMessage[] = [], sent: { connection: number; value: unknown }[] = [];
  const sockets: import('ws').WebSocket[] = [];
  server.on('connection', socket => {
    sockets.push(socket); const connection = sockets.length;
    socket.on('message', raw => { sent.push({ connection, value: JSON.parse(String(raw)) as unknown }); });
    socket.send(JSON.stringify(request)); socket.send(JSON.stringify(words));
  });
  let closed = 0;
  const connection = connect({
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, key: 'synthetic-operator-connection',
    backoff: { firstMs: 5, maxMs: 20 }, handshakeTimeoutMs: 2_147_483_647,
    onOpen: send => { send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [] }); send(evidence); },
    onMessage: frame => { received.push(frame); },
    onClose: () => { if (++closed === 1) throw new Error('synthetic close handler failure'); },
  });
  onTestFinished(() => { connection.close(); for (const socket of sockets) socket.terminate(); });
  await eventually(() => received.length === 2 && sent.some(frame => frame.connection === 1 && JSON.stringify(frame.value) === JSON.stringify(evidence)));
  sockets[0]!.terminate();
  await eventually(() => received.length === 4 && sent.filter(frame => frame.connection === 2).length === 3);
  expect(received).toEqual([request, words, request, words]);
  expect(sent.filter(frame => frame.connection === 2).map(frame => (frame.value as { type: string }).type)).toEqual(['hello', 'node.reconnect', 'program.launch']);
  expect(sent.filter(frame => frame.connection === 2).at(-1)!.value).toEqual(evidence);
  expect(closed).toBe(1);
  connection.close();
  expect(closed).toBe(2);
});
