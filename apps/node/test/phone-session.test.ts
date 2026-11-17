import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhoneGrant } from '@hornhoof/protocol';
import { PhoneSessions } from '../src/phones/sessions.js';

const grant: PhoneGrant = {
  sessionId: '11111111-1111-4111-8111-111111111111', generation: 1,
  binding: { phoneId: '22222222-2222-4222-8222-222222222222', serial: '192.168.1.80:5555', transport: 'network', endpoint: '192.168.1.80:5555', hardwareKey: 'a'.repeat(64) },
  expiresAt: '2026-11-16T12:00:30.000Z',
};

describe('the execution node owns one fenced session for a phone', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('accepts a live grant and refuses a second borrower of the same serial', () => {
    const sessions = new PhoneSessions();
    expect(() => sessions.open(grant)).not.toThrow();
    expect(() => sessions.open({ ...grant, sessionId: '33333333-3333-4333-8333-333333333333', generation: 2 })).toThrow('phone_busy');
    sessions.close();
  });

  it('fences a revoked grant even when Stop arrived before the delayed open message', () => {
    const sessions = new PhoneSessions();
    sessions.fence(grant.binding.serial, 2);
    expect(() => sessions.open(grant)).toThrow('phone_session_gone');
    expect(() => sessions.open({ ...grant, generation: 2 })).toThrow('phone_session_gone');
    sessions.open({ ...grant, generation: 3 });
    sessions.close();
  });

  it('revokes a running command immediately, rejects queued commands and fences a late result', async () => {
    const sessions = new PhoneSessions();
    sessions.open(grant);
    let entered!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    let finish!: () => void;
    let signal!: AbortSignal;
    const first = sessions.use(grant.sessionId, 1, async state => {
      signal = state.signal;
      entered();
      await new Promise<void>(resolve => { finish = resolve; });
      return 'a late screenshot';
    });
    const firstResult = expect(first).rejects.toThrow('phone_session_gone');
    await running;
    let touched = false;
    const queued = sessions.use(grant.sessionId, 1, async () => { touched = true; });
    const queuedResult = expect(queued).rejects.toThrow('phone_session_gone');
    sessions.revoke(grant.sessionId, 1);
    expect(signal.aborted).toBe(true);
    expect(() => sessions.open({ ...grant, generation: 2 })).toThrow('phone_busy');
    finish();
    await firstResult;
    await queuedResult;
    expect(touched).toBe(false);
    expect(() => sessions.open(grant)).toThrow('phone_session_gone');
    sessions.open({ ...grant, generation: 2 });
    sessions.close();
  });

  it('expires on virtual time, renews only the current generation and closes on disconnect', async () => {
    const sessions = new PhoneSessions();
    sessions.open(grant);
    expect(sessions.renew(grant.sessionId, 0, '2026-11-16T12:00:50.000Z')).toBe(false);
    expect(sessions.renew(grant.sessionId, 1, '2026-11-16T12:00:50.000Z')).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(sessions.use(grant.sessionId, 1, async () => 'live')).resolves.toBe('live');
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(sessions.use(grant.sessionId, 1, async () => 'late')).rejects.toThrow('phone_session_gone');
    sessions.open({ ...grant, generation: 2, expiresAt: '2026-11-16T12:01:00.000Z' });
    sessions.close();
    await expect(sessions.use(grant.sessionId, 2, async () => 'late')).rejects.toThrow('phone_session_gone');
  });
});
