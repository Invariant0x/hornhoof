import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SealedPayload } from '../src/modules/outbound/delivery.js';
import { smtpAdapter, type SmtpAccount, type SmtpTimeouts } from '../src/modules/outbound/smtp.js';
import { CERT, PASSWORD, USERNAME, header, parts, scriptedSmtp, smtpReceiver, subjectOf, wordsOf } from './outbound-receivers.js';
import { closedPort } from './closed-port.js';

const FROM = 'sender@acme.test';
const PAYLOAD: SealedPayload = { recipient: 'buyer@example.test', subject: 'Your order', text: 'Plain words.\n' };

const closing: (() => Promise<unknown>)[] = [];
const receiver = async (options: Parameters<typeof smtpReceiver>[0] = {}) => {
  const running = await smtpReceiver(options);
  closing.push(running.close);
  return running;
};
const scripted = async (script: Parameters<typeof scriptedSmtp>[0]) => {
  const running = await scriptedSmtp(script);
  closing.push(running.close);
  return running;
};
afterEach(async () => {
  await Promise.all(closing.splice(0).map(close => close()));
  vi.restoreAllMocks();
});

const account = (port: number, more: Partial<SmtpAccount> = {}): SmtpAccount => ({ host: 'localhost', port, security: 'starttls', username: USERNAME, password: PASSWORD, from: FROM, ca: CERT, ...more });
const send = (acc: SmtpAccount, sealedPayload = PAYLOAD, timeouts?: Partial<SmtpTimeouts>, attemptId: string = randomUUID()) => smtpAdapter(timeouts).send({ attemptId, sealedPayload, configuredAccount: acc });

describe('the SMTP adapter', () => {
  it.each(['starttls', 'tls'] as const)('hands the exact words once to an authenticated server over %s, and reports its receipt', async security => {
    const server = await receiver({ secure: security === 'tls' });
    const text = 'Цена 100 ₽ за месяц.\n.A line that starts with a dot\nשלום עולם, trailing spaces   \n日本語のテキスト\n' + 'long '.repeat(400) + '\n';
    const attemptId = randomUUID();

    const outcome = await send(account(server.port, { security }), { recipient: 'buyer@example.test', subject: 'Письмо о заказе שלום', text }, undefined, attemptId);

    expect(outcome).toMatchObject({ kind: 'accepted', providerReceipt: expect.stringContaining('queued as 7A1'), acceptedAt: expect.any(String) });
    expect(server.seen.logins).toEqual([USERNAME]);
    expect(server.seen.messages).toHaveLength(1);
    const [message] = server.seen.messages;
    expect(message!.from).toBe(FROM);
    expect(message!.to).toEqual(['buyer@example.test']);
    expect(wordsOf(message!.raw)).toBe(text);
    expect(subjectOf(message!.raw)).toBe('Письмо о заказе שלום');
    expect(header(parts(message!.raw).headers, 'message-id')).toContain(attemptId);
  });

  it('keeps a line that starts with a dot and sends plain text only, with nothing but its one recipient', async () => {
    const server = await receiver();
    const text = 'First line\n.dot line\n..two dots\ntrailing spaces   \nLast line\n';
    expect((await send(account(server.port), { ...PAYLOAD, text })).kind).toBe('accepted');
    const { headers } = parts(server.seen.messages[0]!.raw);
    expect(wordsOf(server.seen.messages[0]!.raw).trimEnd()).toBe(text.trimEnd());
    expect(header(headers, 'content-type')).toMatch(/^text\/plain/);
    expect(header(headers, 'bcc')).toBeUndefined();
    expect(header(headers, 'cc')).toBeUndefined();
  });

  it('refuses a wrong password without a message, and tells nobody the password', async () => {
    const server = await receiver();
    const secret = 'wrong-synthetic-secret-77a1';
    const logged = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn')];

    const outcome = await send(account(server.port, { password: secret }));

    expect(outcome).toEqual({ kind: 'definitely_not_accepted', safeCode: 'auth_refused' });
    expect(server.seen.messages).toEqual([]);
    expect(JSON.stringify(outcome)).not.toContain(secret);
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
  });

  it('never sends the password over a connection without TLS', async () => {
    const server = await receiver({ startTls: false });
    expect(await send(account(server.port))).toEqual({ kind: 'definitely_not_accepted', safeCode: 'tls_refused' });
    expect(server.seen.logins).toEqual([]);
  });

  it.each(['starttls', 'tls'] as const)('never sends the password to a server over %s whose certificate it does not trust', async security => {
    const server = await receiver({ secure: security === 'tls', stranger: true });
    expect(await send(account(server.port, { security }))).toEqual({ kind: 'definitely_not_accepted', safeCode: 'tls_refused' });
    expect(server.seen.logins).toEqual([]);
    expect(server.seen.messages).toEqual([]);
  });

  it('keeps a long or strange server reply short and on one line', async () => {
    const server = await receiver({ reply: `queued\u0007 as ${'x'.repeat(900)}` });
    const outcome = await send(account(server.port));
    expect(outcome.kind).toBe('accepted');
    const receipt = (outcome as { providerReceipt: string }).providerReceipt;
    expect(receipt).toMatch(/queued\s+as x+$/);
    expect(receipt).not.toMatch(/\p{Cc}/u);
    expect(receipt).toHaveLength(512);
  });

  it('refuses a certificate authority that is not one, and sends no password', async () => {
    const server = await receiver();
    expect(await send(account(server.port, { ca: 'not a certificate' }))).toEqual({ kind: 'definitely_not_accepted', safeCode: 'tls_refused' });
    expect(server.seen.logins).toEqual([]);
  });

  it('knows the message was not accepted when nothing listens', async () => {
    expect(await send(account(await closedPort()))).toEqual({ kind: 'definitely_not_accepted', safeCode: 'connect_failed' });
  });

  describe('knows the message was not accepted before it began', () => {
    const tlsAccount = (port: number) => account(port, { security: 'tls' });

    it('when the server closes instead of greeting', async () => {
      const server = await scripted('close_at_greeting');
      expect(await send(tlsAccount(server.port))).toEqual({ kind: 'definitely_not_accepted', safeCode: 'connect_failed' });
    });

    it('when the server never greets', async () => {
      const server = await scripted('no_greeting');
      expect(await send(tlsAccount(server.port), PAYLOAD, { greetingMs: 400 })).toEqual({ kind: 'definitely_not_accepted', safeCode: 'connect_timeout' });
    });

    it('at the overall limit, as sending had not begun', async () => {
      const server = await scripted('no_greeting');
      expect(await send(tlsAccount(server.port), PAYLOAD, { totalMs: 400 })).toEqual({ kind: 'definitely_not_accepted', safeCode: 'connect_timeout' });
    });

    it.each(['refuse_at_mail', 'refuse_at_data'] as const)('on %s', async script => {
      const server = await scripted(script);
      expect(await send(tlsAccount(server.port))).toEqual({ kind: 'definitely_not_accepted', safeCode: 'message_refused' });
      expect(server.seen.messages).toBe(0);
    });
  });

  it('knows the message was not accepted when the server refuses the recipient', async () => {
    const server = await receiver({ refuseRecipient: true });
    expect(await send(account(server.port))).toEqual({ kind: 'definitely_not_accepted', safeCode: 'recipient_refused' });
    expect(server.seen.messages).toEqual([]);
  });

  it.each([554, 451])('knows the message was not accepted when the server answers its words with %i', async refuseMessage => {
    const server = await receiver({ refuseMessage });
    expect(await send(account(server.port))).toEqual({ kind: 'definitely_not_accepted', safeCode: 'message_refused' });
  });

  describe('when it cannot tell whether the message was taken', () => {
    const tlsAccount = (port: number) => account(port, { security: 'tls' });

    it('says unknown when the connection dies after the words, and asking again sends nothing', async () => {
      const server = await scripted('close_after_message');
      const attempt = { attemptId: randomUUID(), sealedPayload: PAYLOAD, configuredAccount: tlsAccount(server.port) };
      const adapter = smtpAdapter();

      expect(await adapter.send(attempt)).toEqual({ kind: 'unknown', safeCode: 'connection_lost' });
      expect(server.seen.messages).toBe(1);

      expect(await adapter.reconcile(attempt)).toEqual({ kind: 'unknown', safeCode: 'no_readback' });
      expect(server.seen.messages).toBe(1);
    });

    it('says unknown when the server stays silent after the words', async () => {
      const server = await scripted('silent_after_message');
      expect(await send(tlsAccount(server.port), PAYLOAD, { socketMs: 1500 })).toEqual({ kind: 'unknown', safeCode: 'timeout' });
      expect(server.seen.messages).toBe(1);
    });

    it('says unknown when the answer to its words is neither yes nor no', async () => {
      const server = await scripted('odd_reply_after_message');
      expect(await send(tlsAccount(server.port))).toEqual({ kind: 'unknown', safeCode: 'connection_lost' });
      expect(server.seen.messages).toBe(1);
    });

    it('says unknown at the overall limit, whatever the socket allows', async () => {
      const server = await scripted('silent_after_message');
      expect(await send(tlsAccount(server.port), PAYLOAD, { socketMs: 60_000, totalMs: 1500 })).toEqual({ kind: 'unknown', safeCode: 'timeout' });
    });

    it('says unknown when the connection dies once sending began, as it holds no proof', async () => {
      const server = await scripted('close_at_mail');
      expect(await send(tlsAccount(server.port))).toEqual({ kind: 'unknown', safeCode: 'connection_lost' });
    });
  });

  describe('refuses before it connects', () => {
    it.each<[string, Partial<SealedPayload>]>([
      ['a second header in the recipient', { recipient: 'buyer@example.test\r\nBcc: other@example.test' }],
      ['two recipients', { recipient: 'buyer@example.test, other@example.test' }],
      ['a display name', { recipient: 'Buyer <buyer@example.test>' }],
      ['a recipient without a domain', { recipient: 'buyer' }],
      ['a second header in the subject', { subject: 'Your order\r\nBcc: other@example.test' }],
      ['a Unicode line break in the subject', { subject: 'Your order\u2028Bcc: other@example.test' }],
      ['a control character in the words', { text: 'Plain\u0000words' }],
      ['a bare carriage return in the words, which a server would change', { text: 'Plain\rwords' }],
      ['a broken character in the words, which could not go out as it is', { text: 'Plain\uD800words' }],
      ['a broken character in the subject', { subject: 'Your\uD800order' }],
      ['no words', { text: '' }],
    ])('%s', async (_name, change) => {
      const server = await receiver();
      expect(await send(account(server.port), { ...PAYLOAD, ...change })).toEqual({ kind: 'definitely_not_accepted', safeCode: 'invalid_payload' });
      expect(server.seen.connections).toBe(0);
    });

    it('an attempt id that could not stand in a header', async () => {
      const server = await receiver();
      expect(await send(account(server.port), PAYLOAD, undefined, 'a\r\nBcc: other@example.test')).toEqual({ kind: 'definitely_not_accepted', safeCode: 'invalid_payload' });
      expect(server.seen.connections).toBe(0);
    });

    it('a sender with a second header in it', async () => {
      const server = await receiver();
      expect(await send(account(server.port, { from: 'sender@acme.test\r\nBcc: other@example.test' }))).toEqual({ kind: 'definitely_not_accepted', safeCode: 'invalid_payload' });
      expect(server.seen.connections).toBe(0);
    });
  });
});
