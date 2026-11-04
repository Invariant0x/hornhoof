import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { parseOperatorServerMessage } from '../src/connection.js';

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
