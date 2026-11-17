import { createHmac, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { outboundAccounts, outboundAttempts, outboundChannels, outboundDailyUsage } from '../src/db/schema.js';
import { minuteRound } from '../src/modules/agents/timers.js';
import { reserveDispatch } from '../src/modules/outbound/core.js';
import { outboundRound } from '../src/modules/outbound/dispatcher.js';
import { smtpAdapter } from '../src/modules/outbound/smtp.js';
import { as, until } from './helpers.js';
import { EVENT_KEY, FROM, NEVER, SIGNING_KEY, closeKept, frozenOf, hookWay, keep, liveSenders, liveWebhook, rotateTo, settleAs, smtpSettings, smtpWay, submitByTool } from './outbound-live-world.js';
import { hookReceiver, scriptedSmtp, silentPort, smtpReceiver, subjectOf, wordsOf, type HookRequest } from './outbound-receivers.js';
import { closedPort } from './closed-port.js';
import { QUIET, anAccountOf, dispatched, world, type World } from './outbound-world.js';

/* The whole way, from an agent's tool to bytes on a real wire and back. Control receivers on this machine, synthetic secrets. */
afterEach(closeKept);

const attemptsOf = (w: World, messageId: string) => w.c.db.select().from(outboundAttempts).where(eq(outboundAttempts.messageId, messageId));
const round = (w: World, senders = liveSenders()) => outboundRound(w.ctx, new Date(), senders);
const LATER = () => new Date(Date.now() + 6 * 60_000);
const takes = (request: HookRequest) => ({ status: 200, body: JSON.stringify({ attemptId: JSON.parse(request.body).attemptId, receipt: 'receipt-41' }) });
/* The senders' waits go by a clock the test moves. */
const stillClock = () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  onTestFinished(() => { vi.useRealTimers(); });
};

describe('a message over real authenticated SMTP', () => {
  it('leaves by the server\'s own minute, once, in exactly the words frozen when it was admitted', async () => {
    const w = await world();
    const server = keep(await smtpReceiver({ secure: true }));
    const { input } = await smtpWay(w, server.port);
    const { messageId, status } = await submitByTool(w, input());
    expect(status).toBe('scheduled');
    expect(server.seen.messages).toEqual([]);
    const failures: string[] = [];
    await minuteRound(w.ctx, new Date(), what => () => failures.push(what));
    await minuteRound(w.ctx, LATER(), what => () => failures.push(what));
    expect(failures).toEqual([]);
    const frozen = await frozenOf(w, messageId);
    expect(server.seen.messages).toHaveLength(1);
    const [got] = server.seen.messages;
    expect(got).toMatchObject({ from: FROM, to: [frozen.recipient] });
    expect(subjectOf(got!.raw)).toBe(frozen.subject);
    expect(wordsOf(got!.raw).trimEnd()).toBe(frozen.text.trimEnd());
    expect(frozen.text).toContain('https://hornhoof.example/api/outbound/unsubscribe/');
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'sent' });
    expect((await attemptsOf(w, messageId))[0]!.providerReceipt).toContain('queued as 7A1');
  });

  it('never sends one that was handed over and went quiet, until a person says what became of it', async () => {
    const w = await world();
    const server = keep(await scriptedSmtp('close_after_message'));
    const { input } = await smtpWay(w, server.port);
    const first = await submitByTool(w, input());
    await round(w);
    expect(server.seen.messages).toBe(1);
    expect(await w.messageOf(first.messageId)).toMatchObject({ status: 'unknown', reasonCodes: ['delivery_unknown'] });
    const second = await submitByTool(w, input());
    await outboundRound(w.ctx, LATER(), liveSenders());
    await outboundRound(w.ctx, LATER(), liveSenders());
    expect(server.seen.messages).toBe(1);
    expect(await w.messageOf(second.messageId)).toMatchObject({ status: 'reserved' });
    const [attempt] = await attemptsOf(w, first.messageId);
    await settleAs(w, attempt!.id, 'accepted');
    expect(await w.messageOf(first.messageId)).toMatchObject({ status: 'sent' });
    await outboundRound(w.ctx, LATER(), liveSenders());
    expect(server.seen.messages).toBe(2);
  });

  it('calls a server that stops answering after the message unknown, and one that never let it in a sure failure', async () => {
    const w = await world();
    const quiet = keep(await scriptedSmtp('silent_after_message'));
    const { input } = await smtpWay(w, quiet.port);
    const { messageId } = await submitByTool(w, input());
    stillClock();
    const sending = round(w, liveSenders({ smtp: smtpAdapter({ connectMs: NEVER, greetingMs: NEVER, socketMs: NEVER, totalMs: 500 }) }));
    /* The server has the whole message and answers nothing. */
    await until(() => quiet.seen.messages === 1);
    await vi.advanceTimersByTimeAsync(500);
    await sending;
    vi.useRealTimers();
    expect(await attemptsOf(w, messageId)).toMatchObject([{ status: 'unknown' }]);

    const other = await world();
    const { input: toNobody } = await smtpWay(other, await closedPort());
    const refused = await submitByTool(other, toNobody());
    await round(other);
    expect(await attemptsOf(other, refused.messageId)).toMatchObject([{ status: 'definitely_not_accepted', safeCode: 'connect_failed' }]);
    expect((await other.c.db.select().from(outboundDailyUsage).where(eq(outboundDailyUsage.scope, 'account')))[0]).toMatchObject({ reserved: 0, definitelyFailed: 1 });
  });

  it('after a crash mid-send does not send again: its lease ends in unknown', async () => {
    const w = await world();
    const server = keep(await smtpReceiver({ secure: true }));
    const { accountId, input } = await smtpWay(w, server.port);
    expect(accountId).toBeTruthy();
    const { messageId } = await submitByTool(w, input());
    await dispatched(w, messageId, new Date(Date.now() - 10 * 60_000));
    await round(w);
    await round(w);
    expect(server.seen.connections).toBe(0);
    expect(await attemptsOf(w, messageId)).toMatchObject([{ status: 'unknown', safeCode: 'timeout' }]);
  });

  it('gets no further than a wrong password, stops the account, and goes on once it has the right one', async () => {
    const w = await world();
    const server = keep(await smtpReceiver({ secure: true }));
    const { accountId, input } = await smtpWay(w, server.port, { password: 'not-the-password' });
    const { messageId } = await submitByTool(w, input());
    await round(w);
    expect(server.seen.messages).toEqual([]);
    expect(await attemptsOf(w, messageId)).toMatchObject([{ status: 'definitely_not_accepted', safeCode: 'auth_refused' }]);
    expect((await w.c.db.select().from(outboundAccounts).where(eq(outboundAccounts.id, accountId)))[0]!.status).toBe('invalid');
    await expect(submitByTool(w, input())).rejects.toThrow('cannot send now');
    await rotateTo(w, accountId, smtpSettings(server.port));
    const next = await submitByTool(w, input());
    await round(w);
    expect(server.seen.messages).toHaveLength(1);
    expect(await w.messageOf(next.messageId)).toMatchObject({ status: 'sent' });
  });

  it('ends what was reserved before a change of settings without connecting at all', async () => {
    const w = await world();
    const server = keep(await smtpReceiver({ secure: true }));
    const { accountId, input } = await smtpWay(w, server.port);
    const { messageId } = await submitByTool(w, input());
    await reserveDispatch(w.ctx, messageId, 1);
    await rotateTo(w, accountId, smtpSettings(server.port));
    await round(w);
    expect(server.seen.connections).toBe(0);
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'cancelled', reasonCodes: ['stale_binding'] });
  });

  it('after a revocation ends what was reserved without connecting, and takes nothing new', async () => {
    const w = await world();
    const server = keep(await smtpReceiver({ secure: true }));
    const { accountId, input } = await smtpWay(w, server.port);
    const { messageId } = await submitByTool(w, input());
    await reserveDispatch(w.ctx, messageId, 1);
    expect((await w.c.app.inject({ method: 'POST', url: `/api/outbound/accounts/${accountId}/revoke`, payload: {}, ...as(w.c.ceoToken) })).statusCode).toBe(200);
    await round(w);
    expect(server.seen.connections).toBe(0);
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'cancelled', reasonCodes: ['stale_binding'] });
    await expect(submitByTool(w, input())).rejects.toThrow('cannot send now');
  });

  it('takes no message through an account its author is not bound to, whatever id it names', async () => {
    const w = await world();
    const server = keep(await smtpReceiver({ secure: true }));
    const { input } = await smtpWay(w, server.port);
    const theirs = await anAccountOf(w.c, w.channel.id, w.c.head.id, 'Theirs');
    await expect(submitByTool(w, input({ accountId: theirs.account.id }))).rejects.toThrow('bound to someone else');
    await expect(submitByTool(w, input({ accountId: randomUUID() }))).rejects.toThrow();
    await round(w);
    expect(server.seen.connections).toBe(0);
  });

  it('stops on a signed complaint coming back over the real route, and nothing more leaves', async () => {
    const w = await world({ ...QUIET, circuit: { windowHours: 24, minimumSample: 1, maxComplaints: 0, maxRefusals: 9, maxBounces: 9 } });
    const server = keep(await smtpReceiver({ secure: true }));
    const { accountId, input } = await smtpWay(w, server.port);
    const first = await submitByTool(w, input());
    await round(w);
    const [attempt] = await attemptsOf(w, first.messageId);
    const queued = await submitByTool(w, input());
    const body = JSON.stringify({ events: [{ attemptId: attempt!.id, kind: 'complaint', providerEventId: randomUUID(), occurredAt: new Date().toISOString() }] });
    const stamp = String(Math.floor(Date.now() / 1000));
    const said = await w.c.app.inject({ method: 'POST', url: `/api/outbound/accounts/${accountId}/events`, headers: { 'content-type': 'application/json', 'x-hornhoof-timestamp': stamp, 'x-hornhoof-signature': `v1=${createHmac('sha256', EVENT_KEY).update(`${stamp}.${body}`).digest('hex')}` }, payload: body });
    expect(said.json()).toEqual({ recorded: 1, repeated: 0, ignored: 0 });
    expect((await w.c.db.select().from(outboundChannels).where(eq(outboundChannels.id, w.channel.id)))[0]).toMatchObject({ status: 'stopped', stoppedReason: 'complaint_threshold' });
    await round(w);
    expect(server.seen.messages).toHaveLength(1);
    expect(await w.messageOf(queued.messageId)).toMatchObject({ status: 'scheduled', reasonCodes: ['channel_stopped'] });
  });
});

describe('a message over the signed HTTPS channel', () => {
  it('reaches its one endpoint once, signed, in exactly the words frozen when it was admitted', async () => {
    const w = await world();
    const hook = keep(await hookReceiver(takes));
    const { input } = await hookWay(w, hook.url);
    const { messageId } = await submitByTool(w, input());
    await round(w);
    await outboundRound(w.ctx, LATER(), liveSenders());
    expect(hook.seen).toHaveLength(1);
    const [request] = hook.seen;
    const [attempt] = await attemptsOf(w, messageId);
    const frozen = await frozenOf(w, messageId);
    expect(request!.url).toBe('/hook');
    expect(JSON.parse(request!.body)).toEqual({ attemptId: attempt!.id, recipient: frozen.recipient, subject: frozen.subject, text: frozen.text });
    expect(request!.headers['idempotency-key']).toBe(attempt!.id);
    const stamp = request!.headers['x-hornhoof-timestamp'] as string;
    expect(request!.headers['x-hornhoof-signature']).toBe(`v1=${createHmac('sha256', SIGNING_KEY).update(`${stamp}.${request!.body}`).digest('hex')}`);
    expect(attempt).toMatchObject({ status: 'accepted', providerReceipt: 'receipt-41' });
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'sent' });
  });

  it('after a lost answer learns the end from the receiver\'s own record, without posting again', async () => {
    const w = await world();
    const answers = { posted: 0 };
    const hook = keep(await hookReceiver(request => {
      if (request.method === 'POST') {
        answers.posted += 1;
        return 'destroy';
      }
      return { status: 200, body: JSON.stringify({ attemptId: new URL(request.url, 'https://x').searchParams.get('attempt'), receipt: 'read-back-7' }) };
    }));
    const { input } = await hookWay(w, hook.url, { readback: true });
    const { messageId } = await submitByTool(w, input());
    await round(w);
    expect(await attemptsOf(w, messageId)).toMatchObject([{ status: 'unknown' }]);
    await outboundRound(w.ctx, LATER(), liveSenders());
    expect(answers.posted).toBe(1);
    expect(await attemptsOf(w, messageId)).toMatchObject([{ status: 'accepted', providerReceipt: 'read-back-7' }]);
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'sent' });
  });

  it('with no way of asking keeps it unknown and posts nothing again', async () => {
    const w = await world();
    const hook = keep(await hookReceiver(() => 'destroy'));
    const { input } = await hookWay(w, hook.url);
    const { messageId } = await submitByTool(w, input());
    await round(w);
    await outboundRound(w.ctx, LATER(), liveSenders());
    expect(hook.seen).toHaveLength(1);
    expect(await attemptsOf(w, messageId)).toMatchObject([{ status: 'unknown', safeCode: 'connection_lost' }]);
  });

  it('calls a clear refusal a sure failure and an endpoint that does not answer unknown', async () => {
    const w = await world();
    const hook = keep(await hookReceiver(() => ({ status: 422 })));
    const { input } = await hookWay(w, hook.url);
    const refused = await submitByTool(w, input());
    await round(w);
    expect(await attemptsOf(w, refused.messageId)).toMatchObject([{ status: 'definitely_not_accepted', safeCode: 'receiver_refused' }]);

    const other = await world();
    const silent = keep(await silentPort());
    const { input: toSilence } = await hookWay(other, `https://localhost:${silent.port}/hook`);
    const lost = await submitByTool(other, toSilence());
    stillClock();
    let asked = false;
    const webhook = liveWebhook(2000);
    const sending = round(other, liveSenders({ webhook: { ...webhook, send: attempt => { asked = true; return webhook.send(attempt); } } }));
    /* The wait for the endpoint begins as its request does; the port never starts TLS, so it is never up in time. */
    await until(() => asked);
    await vi.advanceTimersByTimeAsync(2000);
    await sending;
    expect(await attemptsOf(other, lost.messageId)).toMatchObject([{ status: 'definitely_not_accepted', safeCode: 'connect_timeout' }]);
  });
});
