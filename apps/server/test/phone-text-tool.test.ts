import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { PhoneReply, toolPrivacy, type PhoneFrame, type PhoneGrant, type PhoneServerMessage, type PhoneTypingIssue } from '@hornhoof/protocol';
import { expect, it, vi } from 'vitest';
import type { Ctx } from '../src/app.js';
import { phoneAction } from '../src/modules/phones/queue.js';
import { registerPhoneTools } from '../src/modules/phones/tools.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { phoneNodeMessage, phoneRequest } from '../src/modules/phones/rpc.js';

vi.mock('../src/modules/phones/queue.js', () => ({ phoneAction: vi.fn() }));

/* The node's own phone code, loaded when the test runs: the server's type check covers server files only. */
type AdbCall = { args: string[]; input?: string; signal: AbortSignal; timeoutMs?: number };
type NodeAdb = { tree(...args: unknown[]): Promise<string>; type(...args: unknown[]): Promise<unknown> };
type NodeExecutor = { handle(message: PhoneServerMessage): Promise<void>; close(): void };
type NodePhones = {
  PhoneAdb: new (run: (call: AdbCall) => Promise<Buffer>) => NodeAdb;
  PhoneExecutor: new (deps: { adb: Record<string, unknown>; send(message: PhoneReply | PhoneFrame): void }) => NodeExecutor;
};
async function nodePhones(): Promise<NodePhones> {
  const [adb, executor] = await Promise.all([
    import(new URL('../../node/src/phones/adb.ts', import.meta.url).href) as Promise<Pick<NodePhones, 'PhoneAdb'>>,
    import(new URL('../../node/src/phones/executor.ts', import.meta.url).href) as Promise<Pick<NodePhones, 'PhoneExecutor'>>,
  ]);
  return { PhoneAdb: adb.PhoneAdb, PhoneExecutor: executor.PhoneExecutor };
}

const id = '22222222-2222-4222-8222-222222222222';
const capture = { width: 0, height: 0, elements: [] };

const outcomes: [PhoneTypingIssue, PhoneReply['status']][] = [
  [{ kind: 'typing_failed', reason: 'phone_adb_failed', next: 0 }, 'failed'],
  [{ kind: 'typing_failed', reason: 'phone_adb_failed', next: 3, check: { kind: 'typing_mismatch' } }, 'failed'],
  [{ kind: 'typing_partial', next: 4 }, 'partial'],
  [{ kind: 'typing_unverified' }, 'ok'],
  [{ kind: 'typing_dropped', missing: [{ start: 2, count: 1 }] }, 'failed'],
  [{ kind: 'typing_mismatch' }, 'failed'],
];

it.each(outcomes)('passes the %o typing outcome through the phone action tool with status %s', async (typing, status) => {
  const server = new McpServer({ name: 'phone-test', version: '1' });
  const client = new Client({ name: 'phone-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const reply: PhoneReply = { type: 'phone.reply', requestId: id, status, typing, ...(typing.kind === 'typing_failed' ? {} : { capture: { jpeg: null, ...capture } }) };
  vi.mocked(phoneAction).mockResolvedValueOnce(reply);
  registerPhoneTools(server, {} as Ctx, { id, companyId: id, jobId: id });
  try {
    await server.connect(a);
    await client.connect(b);
    const operation = { kind: 'text', text: 'ab\r\nc' };
    const result = CallToolResultSchema.parse(await client.callTool({ name: 'phone_action', arguments: { session: id, operation } }));
    expect(result.isError).not.toBe(true);
    const value = typing.kind === 'typing_failed' ? null : capture;
    expect(result.content).toHaveLength(1);
    const block = result.content[0];
    expect(block).toMatchObject({ type: 'text' });
    if (block?.type !== 'text') throw new Error('Expected a phone action result');
    expect(JSON.parse(block.text)).toEqual({ status, capture: value, typing });
    expect(PhoneReply.safeParse(reply).success).toBe(true);
    const description = (await client.listTools()).tools.find(tool => tool.name === 'phone_action')?.description;
    expect(description).toContain('line breaks with Enter');
    expect(description).toContain('On partial, call text again with the text from position next');
  } finally {
    await client.close();
    await server.close();
  }
});

it('keeps typing metadata in the phone privacy policy and rejects free text in that metadata', () => {
  expect(toolPrivacy('phone_action')?.secretOutput).toContain('typing');
  const base = { type: 'phone.reply', requestId: id, status: 'failed' };
  expect(PhoneReply.safeParse({ ...base, typing: { kind: 'typing_failed', reason: 'echoed password' } }).success).toBe(false);
  expect(PhoneReply.safeParse({ ...base, typing: { kind: 'typing_dropped', missing: [{ start: 0, count: 1, text: 'password' }] } }).success).toBe(false);
  expect(PhoneReply.safeParse({ ...base, status: 'partial', typing: { kind: 'typing_partial', next: 4, rest: 'password' } }).success).toBe(false);
});

it('returns a partial typing position through the server before its request timer', async () => {
  const { PhoneAdb, PhoneExecutor } = await nodePhones();
  vi.useFakeTimers({ now: 0 });
  const node = nodeIdentity(id);
  const serial = 'R58MIDENTITY';
  const grant: PhoneGrant = {
    sessionId: id, generation: 1, binding: { phoneId: id, serial, hardwareKey: 'a'.repeat(64) },
    expiresAt: new Date(30_000).toISOString(),
  };
  const text = Array.from({ length: 8 }, (_, n) => `line ${n}`).join('\n');
  const limits: (number | undefined)[] = [];
  let field = '';
  const adb = new PhoneAdb(async call => {
    const wait = async (duration: number) => {
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(duration, call.timeoutMs ?? duration)));
      if (call.timeoutMs !== undefined && call.timeoutMs < duration) throw new Error('fake adb timed out');
    };
    if (call.args.at(-1) === '/dev/tty') {
      await wait(field ? 2000 : 3000);
      return Buffer.from(`<hierarchy><node text="${field}" class="android.widget.EditText" resource-id="field" focused="true" password="false" bounds="[0,0][100,100]"/></hierarchy>`);
    }
    if (call.input?.includes('input text')) {
      limits.push(call.timeoutMs);
      await wait(limits.length === 1 ? 6000 : 12000);
      field += limits.length === 1 ? 'line 0&#10;line 1&#10;' : 'line 2&#10;line 3&#10;';
    }
    return Buffer.alloc(0);
  });
  const nodeReplies: { id: string; at: number }[] = [];
  const executor = new PhoneExecutor({
    adb: {
      connect: async () => 'connected', pair: async () => 'paired',
      devices: async () => [{ serial, status: 'device', model: null }], identity: async () => grant.binding.hardwareKey,
      tree: adb.tree.bind(adb), type: adb.type.bind(adb), screenshot: async () => Buffer.alloc(0),
      act: async () => {}, readiness: async () => [],
    },
    send(message) {
      if (message.type !== 'phone.reply') return;
      nodeReplies.push({ id: message.requestId, at: Date.now() });
      phoneNodeMessage(ctx, node, message);
    },
  });
  const ctx = {
    db: { select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => [{ id }] }) }) }) },
    hub: {
      isOnline: () => true,
      send: (_node: typeof node, message: PhoneServerMessage) => { void executor.handle(message); return true; },
    },
  } as unknown as Ctx;
  const requestId = '55555555-0000-4000-8000-000000000000';
  try {
    phoneNodeMessage(ctx, node, { type: 'hello', version: 'probe', loggedIn: true, running: [], phones: true });
    await executor.handle({ type: 'phone.open', requestId: id, grant });
    const request = phoneRequest(ctx, node, {
      type: 'phone.action', requestId, sessionId: id, generation: 1, operation: { kind: 'text', text },
    });
    await vi.advanceTimersByTimeAsync(24_000);
    expect(await request).toMatchObject({ status: 'partial', typing: { kind: 'typing_partial', next: 14 } });
    expect(limits).toEqual([6000]);
    expect(nodeReplies.find(reply => reply.id === requestId)).toEqual({ id: requestId, at: 11_000 });
  } finally {
    executor.close();
    vi.useRealTimers();
  }
});
