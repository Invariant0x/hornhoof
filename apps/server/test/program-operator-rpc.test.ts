import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ProgramServerMessage } from '@hornhoof/protocol/program-operator';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { NodeHub, nodeIdentity } from '../src/modules/nodes/hub.js';
import { receiveOperatorReply, requestProgramInput, requestProgramView } from '../src/modules/program-operator/rpc.js';

function fixture() {
  const sent: ProgramServerMessage[] = [];
  const hub = new NodeHub({ pingMs: 60000, onClose: async () => {}, onMessage: async () => {} });
  onTestFinished(() => hub.stop());
  const node = nodeIdentity(randomUUID());
  const program = { agentId: randomUUID(), node };
  const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {}, send: (raw: string) => sent.push(JSON.parse(raw)) });
  hub.attach(node, socket as unknown as WebSocket);
  socket.emit('message', JSON.stringify({ type: 'hello', version: 'new', loggedIn: true, running: [], programOperatorV1: true }));
  hub.greet(node, true);
  return { ctx: { hub }, program, node, sent };
}

const viewOf = (request: string, agentKey: string) => ({ type: 'program.view' as const, agentKey, request, result: 'ok' as const, reason: null, jobId: randomUUID(), instance: randomUUID(), snapshot: randomUUID(), state: 'idle' as const, tool: null, question: null, input: 'empty' as const, undelivered: false, cols: 80, rows: 24, cells: 'A theme.' });

it('accepts a view only from the node it asked, for the agent it asked about', async () => {
  const c = fixture();
  const pending = requestProgramView(c.ctx, c.program);
  const command = c.sent[0]!;
  if (command.type !== 'program.view_get') throw new Error('No view command.');
  expect(command.agentKey).toBe(c.program.agentId);
  const response = viewOf(command.request, command.agentKey);
  expect(receiveOperatorReply(c.ctx, nodeIdentity(randomUUID()), response)).toBe(false);
  expect(receiveOperatorReply(c.ctx, c.node, { ...response, agentKey: randomUUID() })).toBe(false);
  expect(receiveOperatorReply(c.ctx, c.node, { ...response, request: randomUUID() })).toBe(false);
  expect(receiveOperatorReply(c.ctx, c.node, response)).toBe(true);
  expect(await pending).toEqual(response);
  expect(receiveOperatorReply(c.ctx, c.node, response)).toBe(false);
});

it('never falls back to terminal input for an old node', async () => {
  const c = fixture();
  vi.spyOn(c.ctx.hub, 'hasProgramOperator').mockReturnValue(false);
  expect(await requestProgramView(c.ctx, c.program)).toBeNull();
  expect(await requestProgramInput(c.ctx, c.program, { action: randomUUID(), snapshot: randomUUID(), keys: ['Enter'], text: null })).toBeNull();
  expect(c.sent).toEqual([]);
});

it('sends keys and text once, and ends an input the node does not answer without retrying it or taking a late result', async () => {
  vi.useFakeTimers(); onTestFinished(() => { vi.useRealTimers(); });
  const c = fixture();
  const input = { action: randomUUID(), snapshot: randomUUID(), keys: ['C-u', 'Enter'], text: 'Go on.' };
  const pending = requestProgramInput(c.ctx, c.program, input);
  expect(c.sent).toEqual([{ type: 'program.input_send', agentKey: c.program.agentId, ...input }]);
  expect(await requestProgramInput(c.ctx, c.program, input)).toBeNull();
  expect(c.sent).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await pending).toBeNull();
  expect(receiveOperatorReply(c.ctx, c.node, { type: 'program.input_result', agentKey: c.program.agentId, action: input.action, result: 'applied', reason: null, jobId: null, instance: null, question: null })).toBe(false);
});

it('takes the result of an input from its node for its agent', async () => {
  const c = fixture();
  const action = randomUUID();
  const pending = requestProgramInput(c.ctx, c.program, { action, snapshot: randomUUID(), keys: ['Enter'], text: null });
  const result = { type: 'program.input_result' as const, agentKey: c.program.agentId, action, result: 'applied' as const, reason: null, jobId: randomUUID(), instance: randomUUID(), question: null };
  expect(receiveOperatorReply(c.ctx, nodeIdentity(randomUUID()), result)).toBe(false);
  expect(receiveOperatorReply(c.ctx, c.node, { ...result, agentKey: randomUUID() })).toBe(false);
  expect(receiveOperatorReply(c.ctx, c.node, result)).toBe(true);
  expect(await pending).toEqual(result);
});

it.each(['false', 'throws'])('ends failed view transport promptly (%s)', async failure => {
  const c = fixture();
  vi.spyOn(c.ctx.hub, 'send').mockImplementation(() => {
    if (failure === 'throws') throw new Error('Socket closed');
    return false;
  });
  expect(await requestProgramView(c.ctx, c.program)).toBeNull();
});
