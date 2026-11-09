import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { expect, it, onTestFinished } from 'vitest';
import type { WebSocket } from 'ws';
import { NodeHub, nodeIdentity, parseOperatorNodeMessage } from '../src/modules/nodes/hub.js';
import { until } from './helpers-basic.js';

it('validates operator evidence, capability and optional delivery identities without changing old frames', () => {
  const hello = { type: 'hello', version: 'old', loggedIn: true, running: [], programOperatorV1: true };
  expect(parseOperatorNodeMessage(JSON.stringify(hello))).toMatchObject(hello);
  expect(parseOperatorNodeMessage(JSON.stringify({ ...hello, programOperatorV1: 'true' }))).toBeNull();
  const frame = { type: 'program.delivery', agentKey: randomUUID(), jobId: randomUUID(), instance: randomUUID(), evidenceId: randomUUID(), ordinal: 0, deliveryId: randomUUID(), deliveryOrdinal: 1, kind: 'assignment', phase: 'attempt', elapsedMs: 0, wordsDigest: 'a'.repeat(64) };
  expect(parseOperatorNodeMessage(JSON.stringify(frame))).toEqual(frame);
  expect(parseOperatorNodeMessage(JSON.stringify({ ...frame, elapsedMs: -1 }))).toBeNull();
});

it('keeps screen replies out of an evidence queue that waits for them and drops capability on replacement', async () => {
  let release!: () => void;
  const wait = new Promise<void>(done => { release = done; });
  const seen: string[] = [];
  /* No round of pings comes during the test: the longest wait a timer takes. */
  const hub = new NodeHub({ pingMs: 2_147_483_647, onClose: async () => {}, onMessage: async (_id, frame) => { if (frame.type === 'status') await wait; if (frame.type === 'program.key_result') release(); seen.push(frame.type); } });
  onTestFinished(() => hub.stop());
  const node = nodeIdentity(randomUUID());
  const socket = () => Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} });
  const first = socket(); hub.attach(node, first as unknown as WebSocket);
  expect(hub.hasProgramOperator(node)).toBe(false);
  first.emit('message', JSON.stringify({ type: 'hello', version: 'new', loggedIn: true, running: [], programOperatorV1: true }));
  hub.greet(node, true);
  expect(hub.hasProgramOperator(node)).toBe(true);
  first.emit('message', JSON.stringify({ type: 'status', loggedIn: true, limits: null }));
  first.emit('message', JSON.stringify({ type: 'program.key_result', agentKey: randomUUID(), jobId: randomUUID(), instance: randomUUID(), action: randomUUID(), result: 'refused', reason: 'program_busy' }));
  await until(() => seen.length === 3);
  expect(seen).toEqual(['program.key_result', 'hello', 'status']);
  hub.attach(node, socket() as unknown as WebSocket); hub.greet(node, true);
  expect(hub.hasProgramOperator(node)).toBe(false);
});
