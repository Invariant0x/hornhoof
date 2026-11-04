import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ProgramServerMessage } from '@hornhoof/protocol/program-operator';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { NodeHub, nodeIdentity } from '../src/modules/nodes/hub.js';
import { receiveOperatorReply, requestOperatorScreen, requestOperatorKey } from '../src/modules/program-operator/rpc.js';

function fixture() {
  const sent: ProgramServerMessage[] = [];
  const hub = new NodeHub({ pingMs: 60000, onClose: async () => {}, onMessage: async () => {} });
  onTestFinished(() => hub.stop());
  const target = { id: randomUUID(), agentId: randomUUID(), jobId: randomUUID(), instance: randomUUID(), nodeId: randomUUID(), capability: randomUUID() };
  const node = nodeIdentity(target.nodeId);
  const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {}, send: (raw: string) => sent.push(JSON.parse(raw)) });
  hub.attach(node, socket as unknown as WebSocket);
  socket.emit('message', JSON.stringify({ type: 'hello', version: 'new', loggedIn: true, running: [], programOperatorV1: true }));
  hub.greet(node, true);
  return { ctx: { hub }, target, node, sent };
}

it('accepts a screen only from the requested node, agent, job and physical instance', async () => {
  const c = fixture();
  const pending = requestOperatorScreen(c.ctx, c.target);
  const command = c.sent[0]!;
  if (command.type !== 'program.screen_get') throw new Error('No screen command.');
  const response = { type: 'program.screen' as const, agentKey: command.agentKey, jobId: command.jobId, instance: command.instance, request: command.request, result: 'ok' as const, reason: null, snapshot: randomUUID(), generation: 1, state: 'pre_work' as const, keysAllowed: true, protected: false, cols: 80, rows: 24, cells: 'A theme.' };
  expect(receiveOperatorReply(c.ctx, nodeIdentity(randomUUID()), response)).toBe(false);
  expect(receiveOperatorReply(c.ctx, c.node, { ...response, instance: randomUUID() })).toBe(false);
  expect(receiveOperatorReply(c.ctx, c.node, { ...response, agentKey: randomUUID() })).toBe(false);
  expect(receiveOperatorReply(c.ctx, c.node, { ...response, jobId: randomUUID() })).toBe(false);
  expect(receiveOperatorReply(c.ctx, c.node, response)).toBe(true);
  expect(await pending).toEqual(response);
  expect(receiveOperatorReply(c.ctx, c.node, response)).toBe(false);
});

it('never falls back to terminal input for an old node', async () => {
  const c = fixture();
  vi.spyOn(c.ctx.hub, 'hasProgramOperator').mockReturnValue(false);
  expect(await requestOperatorScreen(c.ctx, c.target)).toBeNull();
  expect(c.sent).toEqual([]);
});

it('ends an uncertain key request without retrying it or accepting a late result', async () => {
  vi.useFakeTimers(); onTestFinished(() => { vi.useRealTimers(); });
  const c = fixture();
  const input = { snapshot: randomUUID(), generation: 1, action: randomUUID(), key: 'Enter' as const };
  const pending = requestOperatorKey(c.ctx, c.target, input);
  const prepare = c.sent[0]!;
  if (prepare.type !== 'program.key_prepare') throw new Error('No key preparation.');
  const lease = randomUUID();
  expect(receiveOperatorReply(c.ctx, c.node, { type: 'program.key_prepared', agentKey: prepare.agentKey, jobId: prepare.jobId, instance: prepare.instance, action: input.action, result: 'ok', reason: null, lease })).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(c.sent[1]).toMatchObject({ type: 'program.key_send', lease });
  await vi.advanceTimersByTimeAsync(3000);
  expect(await pending).toBeNull();
  expect(c.sent).toHaveLength(2);
  expect(receiveOperatorReply(c.ctx, c.node, { type: 'program.key_result', agentKey: c.target.agentId, jobId: c.target.jobId, instance: c.target.instance, action: input.action, result: 'applied', reason: null })).toBe(false);
});


it.each(['refused', 'missing-lease'])('never sends a key after preparation is %s', async mode => {
  const c = fixture();
  const input = { snapshot: randomUUID(), generation: 1, action: randomUUID(), key: 'Enter' as const };
  const pending = requestOperatorKey(c.ctx, c.target, input);
  expect(receiveOperatorReply(c.ctx, c.node, { type: 'program.key_prepared', agentKey: c.target.agentId, jobId: c.target.jobId, instance: c.target.instance, action: input.action, result: mode === 'refused' ? 'refused' : 'ok', reason: mode === 'refused' ? 'program_busy' : null, lease: null })).toBe(true);
  expect(await pending).toMatchObject({ result: 'refused', reason: mode === 'refused' ? 'program_busy' : 'node_unavailable' });
  expect(c.sent).toHaveLength(1);
});

it.each(['false', 'throws'])('ends failed screen transport promptly (%s)', async failure => {
  const c = fixture();
  vi.spyOn(c.ctx.hub, 'send').mockImplementation(() => {
    if (failure === 'throws') throw new Error('Socket closed');
    return false;
  });
  expect(await requestOperatorScreen(c.ctx, c.target)).toBeNull();
});

it('does not register a second waiter or retry preparation for a pending action identity', async () => {
  vi.useFakeTimers(); onTestFinished(() => { vi.useRealTimers(); });
  const c = fixture();
  const input = { snapshot: randomUUID(), generation: 1, action: randomUUID(), key: 'Enter' as const };
  const pending = requestOperatorKey(c.ctx, c.target, input);
  expect(await requestOperatorKey(c.ctx, c.target, input)).toMatchObject({ result: 'refused', reason: 'node_unavailable' });
  expect(c.sent).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await pending).toMatchObject({ result: 'refused', reason: 'node_unavailable' });
});
