import { afterEach, expect, it, vi } from 'vitest';
import type { PhoneGrant, PhoneReply } from '@hornhoof/protocol';
import { PhoneExecutor, type PhoneDriver } from '../src/phones/executor.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const serial = 'USB123456';

function phone() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
  const adb: PhoneDriver = {
    connect: vi.fn(async () => 'connected' as const), pair: vi.fn(async () => 'paired' as const),
    devices: vi.fn(async () => [{ serial, status: 'device' as const, model: null }]),
    identity: vi.fn(async () => 'a'.repeat(64)), tree: vi.fn(async () => ''),
    screenshot: vi.fn(async () => Buffer.from('unreadable recorded picture')), act: vi.fn(async () => {}), type: vi.fn(async () => ({ next: 0 })),
    readiness: vi.fn(async () => []),
  };
  const replies: PhoneReply[] = [];
  const executor = new PhoneExecutor({ adb, send: message => { if (message.type === 'phone.reply') replies.push(message); } });
  const grant: PhoneGrant = { sessionId: id(1), generation: 1, binding: { phoneId: id(2), serial, hardwareKey: 'a'.repeat(64) }, expiresAt: '2026-11-17T00:00:30Z' };
  return { adb, replies, executor, grant, open: () => executor.handle({ type: 'phone.open', requestId: id(3), grant }) };
}

afterEach(() => vi.useRealTimers());

it('refuses a different device behind a registered USB serial before running an action', async () => {
  const p = phone();
  await p.open();
  expect(p.replies.at(-1)?.status).toBe('ok');
  vi.mocked(p.adb.identity).mockResolvedValue('b'.repeat(64));
  await p.executor.handle({ type: 'phone.action', requestId: id(4), sessionId: p.grant.sessionId, generation: 1, operation: { kind: 'key', key: 'home' } });
  expect(p.replies.at(-1)?.status).toBe('session_gone');
  expect(p.adb.act).not.toHaveBeenCalled();
  expect(p.adb.connect).not.toHaveBeenCalled();
  p.executor.close();
});

it('refuses an absent USB phone', async () => {
  const p = phone();
  vi.mocked(p.adb.devices).mockResolvedValue([]);
  await p.open();
  expect(p.replies.at(-1)?.status).toBe('needs_person');
  p.executor.close();
  expect(p.adb.act).not.toHaveBeenCalled();
});

it('rejects actions from a previously active session after node disconnect', async () => {
  const p = phone();
  await p.open();
  expect(p.replies.at(-1)?.status).toBe('ok');
  p.executor.close();
  await p.executor.handle({ type: 'phone.action', requestId: id(4), sessionId: p.grant.sessionId, generation: 1, operation: { kind: 'key', key: 'home' } });
  expect(p.replies.at(-1)?.status).toBe('session_gone');
  expect(p.adb.act).not.toHaveBeenCalled();
});
