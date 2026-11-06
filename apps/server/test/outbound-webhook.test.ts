import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import type { SealedPayload } from '../src/modules/outbound/delivery.js';
import { isPublicAddress, webhookAdapter, type WebhookAccount, type WebhookOptions } from '../src/modules/outbound/webhook.js';
import { CERT, closedPort, hookReceiver, type HookRequest } from './outbound-receivers.js';

const KEY = 'synthetic-signing-secret-9d21';
const PAYLOAD: SealedPayload = { recipient: 'buyer@example.test', subject: 'Your order', text: 'Цена 100 ₽ שלום\n<b>inert</b>\n' };
const LOCAL = { mayReach: (address: string) => address === '127.0.0.1' || address === '::1' };

const closing: (() => Promise<unknown>)[] = [];
const receiver = async (...args: Parameters<typeof hookReceiver>) => {
  const running = await hookReceiver(...args);
  closing.push(running.close);
  return running;
};
afterEach(async () => {
  await Promise.all(closing.splice(0).map(close => close()));
  vi.restoreAllMocks();
});

const account = (endpoint: string, more: Partial<WebhookAccount> = {}): WebhookAccount => ({ endpoint, signingKey: KEY, ca: CERT, ...more });
const send = (acc: WebhookAccount, options: Partial<WebhookOptions> = LOCAL, sealedPayload = PAYLOAD, attemptId = randomUUID()) => webhookAdapter(options).send({ attemptId, sealedPayload, configuredAccount: acc });
const takes = (request: HookRequest) => ({ status: 200, body: JSON.stringify({ attemptId: JSON.parse(request.body).attemptId, receipt: 'receipt-41' }) });

describe('the webhook adapter', () => {
  it('posts the exact words once to its one endpoint, signed, and reports the receipt', async () => {
    const hook = await receiver(takes);
    const attemptId = randomUUID();

    const outcome = await send(account(hook.url), LOCAL, PAYLOAD, attemptId);

    expect(outcome).toMatchObject({ kind: 'accepted', providerReceipt: 'receipt-41', acceptedAt: expect.any(String) });
    expect(hook.seen).toHaveLength(1);
    const [request] = hook.seen;
    expect(request!.method).toBe('POST');
    expect(request!.url).toBe('/hook');
    expect(JSON.parse(request!.body)).toEqual({ attemptId, recipient: PAYLOAD.recipient, subject: PAYLOAD.subject, text: PAYLOAD.text });
    expect(request!.headers['idempotency-key']).toBe(attemptId);
    const stamp = request!.headers['x-hornhoof-timestamp'] as string;
    expect(Math.abs(Date.now() / 1000 - Number(stamp))).toBeLessThan(60);
    expect(request!.headers['x-hornhoof-signature']).toBe(`v1=${createHmac('sha256', KEY).update(`${stamp}.${request!.body}`).digest('hex')}`);
  });

  it('sends only the headers it must, and never the key', async () => {
    const hook = await receiver(takes);
    const logged = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn')];

    const outcome = await send(account(hook.url));

    expect(Object.keys(hook.seen[0]!.headers).sort()).toEqual(['connection', 'content-length', 'content-type', 'host', 'idempotency-key', 'x-hornhoof-signature', 'x-hornhoof-timestamp']);
    expect(JSON.stringify(hook.seen[0])).not.toContain(KEY);
    expect(JSON.stringify(outcome)).not.toContain(KEY);
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
  });

  it('keeps a strange receipt on one line', async () => {
    const hook = await receiver(request => ({ status: 200, body: JSON.stringify({ attemptId: JSON.parse(request.body).attemptId, receipt: ' receipt\n41\u0007 ' }) }));
    expect(await send(account(hook.url))).toMatchObject({ kind: 'accepted', providerReceipt: 'receipt 41' });
  });

  it('follows no redirect, and cannot tell what the first receiver did', async () => {
    const other = await receiver(takes);
    const hook = await receiver(() => ({ status: 307, headers: { location: other.url } }));
    expect(await send(account(hook.url))).toEqual({ kind: 'unknown', safeCode: 'redirect_refused' });
    expect(hook.seen).toHaveLength(1);
    expect(other.seen).toEqual([]);
  });

  it.each([400, 401, 403, 404, 410, 413, 422, 429])('knows the message was not accepted when the receiver answers %i', async status => {
    const hook = await receiver(() => ({ status }));
    expect(await send(account(hook.url))).toEqual({ kind: 'definitely_not_accepted', safeCode: 'receiver_refused' });
  });

  describe('when it cannot tell whether the message was taken', () => {
    it.each([500, 502, 503, 504, 408, 409, 425])('says unknown for %i, as the receiver may have taken it', async status => {
      const hook = await receiver(() => ({ status }));
      expect(await send(account(hook.url))).toEqual({ kind: 'unknown', safeCode: 'receiver_error' });
      expect(hook.seen).toHaveLength(1);
    });

    it.each<[string, (request: HookRequest) => string]>([
      ['no JSON', () => 'ok'],
      ['no receipt', request => JSON.stringify({ attemptId: JSON.parse(request.body).attemptId })],
      ['an empty receipt', request => JSON.stringify({ attemptId: JSON.parse(request.body).attemptId, receipt: '' })],
      ['another attempt', () => JSON.stringify({ attemptId: randomUUID(), receipt: 'receipt-41' })],
    ])('says unknown for a success with %s', async (_name, body) => {
      const hook = await receiver(request => ({ status: 200, body: body(request) }));
      expect(await send(account(hook.url))).toEqual({ kind: 'unknown', safeCode: 'bad_receipt' });
    });

    it('says unknown for an answer too long to be a receipt', async () => {
      const hook = await receiver(request => ({ status: 200, body: JSON.stringify({ attemptId: JSON.parse(request.body).attemptId, receipt: 'r'.repeat(200_000) }) }));
      expect(await send(account(hook.url))).toEqual({ kind: 'unknown', safeCode: 'bad_receipt' });
    });

    it('says unknown when the connection dies after the words', async () => {
      const hook = await receiver(() => 'destroy');
      expect(await send(account(hook.url))).toEqual({ kind: 'unknown', safeCode: 'connection_lost' });
      expect(hook.seen).toHaveLength(1);
    });

    it('says unknown when the receiver stays silent', async () => {
      const hook = await receiver(() => 'silence');
      expect(await send(account(hook.url), { ...LOCAL, timeoutMs: 1500 })).toEqual({ kind: 'unknown', safeCode: 'timeout' });
      expect(hook.seen).toHaveLength(1);
    });
  });

  describe('knows no words left', () => {
    it('when nothing listens', async () => {
      expect(await send(account(`https://localhost:${await closedPort()}/hook`))).toEqual({ kind: 'definitely_not_accepted', safeCode: 'connect_failed' });
    });

    it('when it does not trust the certificate', async () => {
      const hook = await receiver(takes, { stranger: true });
      expect(await send(account(hook.url))).toEqual({ kind: 'definitely_not_accepted', safeCode: 'tls_refused' });
      expect(hook.seen).toEqual([]);
    });

    it('when its certificate authority is not one', async () => {
      const hook = await receiver(takes);
      expect(await send(account(hook.url, { ca: 'not a certificate' }))).toEqual({ kind: 'definitely_not_accepted', safeCode: 'tls_refused' });
      expect(hook.seen).toEqual([]);
    });

    it('for an attempt id that could not stand in a header', async () => {
      const hook = await receiver(takes);
      expect(await send(account(hook.url), LOCAL, PAYLOAD, 'a\r\nX-Other: 1')).toEqual({ kind: 'definitely_not_accepted', safeCode: 'invalid_payload' });
      expect(hook.seen).toEqual([]);
    });

    it.each(['http://localhost/hook', 'https://user:pass@localhost/hook', 'https://localhost/hook#part', 'not a url', 'ftp://localhost/hook'])('for the endpoint %s', async endpoint => {
      expect(await send(account(endpoint))).toEqual({ kind: 'definitely_not_accepted', safeCode: 'endpoint_invalid' });
    });

    it.each<[string, Partial<SealedPayload>]>([
      ['a second recipient', { recipient: 'buyer@example.test, other@example.test' }],
      ['a line break in the subject', { subject: 'Your order\r\nX-Other: 1' }],
      ['a control character in the words', { text: 'Plain\u0000words' }],
    ])('for %s', async (_name, change) => {
      const hook = await receiver(takes);
      expect(await send(account(hook.url), LOCAL, { ...PAYLOAD, ...change })).toEqual({ kind: 'definitely_not_accepted', safeCode: 'invalid_payload' });
      expect(hook.seen).toEqual([]);
    });
  });

  describe('by default reaches only public addresses', () => {
    it('refuses a name that resolves to this machine, and connects to nothing', async () => {
      const hook = await receiver(takes);
      expect(await send(account(hook.url), {})).toEqual({ kind: 'definitely_not_accepted', safeCode: 'address_refused' });
      expect(hook.seen).toEqual([]);
    });

    it.each(['127.0.0.1', '[::1]', '[::ffff:127.0.0.1]'])('refuses the address %s written in the endpoint', async address => {
      const hook = await receiver(takes);
      expect(await send(account(`https://${address}:${hook.port}/hook`), {})).toEqual({ kind: 'definitely_not_accepted', safeCode: 'address_refused' });
      expect(hook.seen).toEqual([]);
    });

    it('refuses a name when any of its addresses is refused, so a second answer cannot slip through', async () => {
      const hook = await receiver(takes);
      const mayReach = vi.fn((address: string) => address !== '127.0.0.1');
      expect(await send(account(hook.url), { mayReach })).toEqual({ kind: 'definitely_not_accepted', safeCode: 'address_refused' });
      expect(hook.seen).toEqual([]);
    });

    it.each(['127.0.0.1', '10.0.0.8', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1', '::ffff:10.0.0.8', '::ffff:127.0.0.1'])('counts %s as private', address => {
      expect(isPublicAddress(address)).toBe(false);
    });

    it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('counts %s as public', address => {
      expect(isPublicAddress(address)).toBe(true);
    });
  });

  describe('when asked again what happened', () => {
    const asking = async (answer: Parameters<typeof hookReceiver>[0], more: Partial<WebhookAccount> = { readback: true }) => {
      const hook = await receiver(answer);
      const attemptId = randomUUID();
      const outcome = await webhookAdapter({ ...LOCAL, timeoutMs: 1500 }).reconcile({ attemptId, configuredAccount: account(hook.url, more) });
      return { hook, attemptId, outcome };
    };

    it('reads the receipt from the receiver with a signed request, and posts nothing', async () => {
      const { hook, attemptId, outcome } = await asking(request => ({ status: 200, body: JSON.stringify({ attemptId: new URL(request.url, 'https://x').searchParams.get('attempt'), receipt: 'receipt-41' }) }));
      expect(outcome).toMatchObject({ kind: 'accepted', providerReceipt: 'receipt-41' });
      expect(hook.seen).toHaveLength(1);
      const [request] = hook.seen;
      expect(request!.method).toBe('GET');
      expect(request!.body).toBe('');
      const stamp = request!.headers['x-hornhoof-timestamp'] as string;
      expect(request!.headers['x-hornhoof-signature']).toBe(`v1=${createHmac('sha256', KEY).update(`${stamp}.${attemptId}`).digest('hex')}`);
    });

    it.each<[string, Parameters<typeof hookReceiver>[0]]>([
      ['the receiver has not seen it', () => ({ status: 404 })],
      ['the receiver is down', () => ({ status: 503 })],
      ['the answer names another attempt', () => ({ status: 200, body: JSON.stringify({ attemptId: randomUUID(), receipt: 'r' }) })],
      ['the connection dies', () => 'destroy'],
      ['the receiver stays silent', () => 'silence'],
    ])('keeps waiting when %s', async (_name, answer) => {
      expect((await asking(answer)).outcome).toEqual({ kind: 'pending' });
    });

    it('says it cannot tell for a receiver that offers no readback, and asks it nothing', async () => {
      const { hook, outcome } = await asking(takes, {});
      expect(outcome).toEqual({ kind: 'unknown', safeCode: 'no_readback' });
      expect(hook.seen).toEqual([]);
    });
  });
});
