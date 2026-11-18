import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { PhoneReply, toolPrivacy, type PhoneTypingIssue } from '@hornhoof/protocol';
import { expect, it, vi } from 'vitest';
import type { Ctx } from '../src/app.js';
import { phoneAction } from '../src/modules/phones/queue.js';
import { registerPhoneTools } from '../src/modules/phones/tools.js';

vi.mock('../src/modules/phones/queue.js', () => ({ phoneAction: vi.fn() }));

const id = '22222222-2222-4222-8222-222222222222';
const capture = { width: 0, height: 0, elements: [] };

const outcomes: PhoneTypingIssue[] = [
  { kind: 'typing_failed', reason: 'phone_adb_failed' },
  { kind: 'typing_unverified' },
  { kind: 'typing_dropped', missing: [{ start: 2, count: 1 }] },
  { kind: 'typing_mismatch' },
];

it.each(outcomes)('passes the $kind typing outcome through the phone action tool', async typing => {
  const server = new McpServer({ name: 'phone-test', version: '1' });
  const client = new Client({ name: 'phone-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const reply: PhoneReply = { type: 'phone.reply', requestId: id, status: 'failed', typing, ...(typing.kind === 'typing_failed' ? {} : { capture: { jpeg: null, ...capture } }) };
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
    expect(JSON.parse(block.text)).toEqual({ status: 'failed', capture: value, typing });
    expect(PhoneReply.safeParse(reply).success).toBe(true);
    expect((await client.listTools()).tools.find(tool => tool.name === 'phone_action')?.description).toContain('line breaks with Enter');
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
});
