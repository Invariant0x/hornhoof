import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../src/crypto/secrets.js';
import { outboundAccounts, requests } from '../src/db/schema.js';
import { outboundRound, type Senders } from '../src/modules/outbound/dispatcher.js';
import { as } from './helpers.js';
import { dispatched, world, type World } from './outbound-world.js';

const NOON = new Date('2026-11-06T12:00:00.000Z');
/* An account's settings as the dispatcher's tests have them: enough to send over the test's own transport. */
const SMTP = { host: 'smtp.acme.example', port: 465, security: 'tls', username: 'sender@acme.example', password: 'a-password-of-the-test', from: 'sender@acme.example' };
const HELD = { kind: 'refused', reasonCodes: ['approval_required', 'restored'] };
/* The database in use was put back from a backup just now. */
const restore = (w: World) => w.c.db.execute(sql`INSERT INTO net.restores (attempt, backup, dumped_at) VALUES (gen_random_uuid(), gen_random_uuid(), now() - interval '1 day')`);
const openRequests = (w: World) => w.c.db.select().from(requests).where(eq(requests.status, 'open'));
const answerAs = (w: World, id: string, approve: boolean) => w.c.app.inject({ method: 'POST', url: `/api/requests/${id}`, payload: { approve }, ...as(w.c.ceoToken) });

describe('a message that waited to go when a backup was restored', () => {
  it('waits for a person after the restore, though the rules ask nobody, and goes when one lets it', async () => {
    const w = await world();
    const { messageId, status } = await w.submit();
    expect(status).toBe('scheduled');
    await restore(w);
    /* It may have gone out between the backup and the restore: nothing of it leaves by itself. */
    expect(await dispatched(w, messageId, NOON)).toEqual(HELD);
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'waiting_approval', reasonCodes: ['approval_required', 'restored'] });
    const [request] = await openRequests(w);
    expect(request).toMatchObject({ kind: 'approval', taskId: w.c.task.id });
    expect(request!.text).toContain('Hornhoof was restored from a backup after this message was written. It may have gone out already: check before you let it go.');
    /* Asked once, however often the dispatcher looks. */
    expect(await dispatched(w, messageId, NOON)).toEqual(HELD);
    expect(await openRequests(w)).toHaveLength(1);
    expect((await answerAs(w, request!.id, true)).statusCode).toBe(200);
    expect((await dispatched(w, messageId, NOON)).kind).toBe('begun');
  });

  it('is cancelled when the person says no', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    await restore(w);
    await dispatched(w, messageId, NOON);
    expect((await answerAs(w, (await openRequests(w))[0]!.id, false)).statusCode).toBe(200);
    await dispatched(w, messageId, NOON);
    expect((await w.messageOf(messageId)).status).toBe('cancelled');
  });

  it('takes no word a person gave before the restore', async () => {
    const w = await world();
    await w.c.setRule(w.c.ceoToken, w.c.dev.id, 'message', { mode: 'every' });
    const { messageId } = await w.submit();
    expect((await answerAs(w, (await openRequests(w))[0]!.id, true)).statusCode).toBe(200);
    await restore(w);
    expect(await dispatched(w, messageId, NOON)).toEqual(HELD);
    const again = await openRequests(w);
    expect(again).toHaveLength(1);
    expect((await answerAs(w, again[0]!.id, true)).statusCode).toBe(200);
    expect((await dispatched(w, messageId, NOON)).kind).toBe('begun');
  });

  it('asks anew with the warning where a question from before the restore was still open, and closes that one', async () => {
    const w = await world();
    await w.c.setRule(w.c.ceoToken, w.c.dev.id, 'message', { mode: 'every' });
    const { messageId } = await w.submit();
    /* Asked before the backup; the yes that let the message go was given after it and is lost with the restore. */
    const [old] = await openRequests(w);
    await restore(w);
    expect(await dispatched(w, messageId, NOON)).toEqual(HELD);
    const open = await openRequests(w);
    expect(open).toHaveLength(1);
    expect(open[0]!.id).not.toBe(old!.id);
    expect(open[0]!.text).toContain('It may have gone out already');
    const [was] = await w.c.db.select().from(requests).where(eq(requests.id, old!.id));
    expect(was).toMatchObject({ status: 'withdrawn', answer: 'Hornhoof was restored from a backup after this was asked, so it is asked again.' });
    expect(was!.answeredAt).toBeInstanceOf(Date);
    expect((await answerAs(w, open[0]!.id, true)).statusCode).toBe(200);
    expect((await dispatched(w, messageId, NOON)).kind).toBe('begun');
  });

  it('does not send on a yes to a question from before the restore', async () => {
    const w = await world();
    await w.c.setRule(w.c.ceoToken, w.c.dev.id, 'message', { mode: 'every' });
    const { messageId } = await w.submit();
    const [old] = await openRequests(w);
    await restore(w);
    /* The person finds the old question still in the queue and says yes to it, before the gateway looked again. */
    expect((await answerAs(w, old!.id, true)).statusCode).toBe(200);
    expect(await dispatched(w, messageId, NOON)).toEqual(HELD);
    const again = await openRequests(w);
    expect(again).toHaveLength(1);
    expect(again[0]!.text).toContain('It may have gone out already');
  });

  it('says in the question a person opens that the message came back with a restore', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    await restore(w);
    await dispatched(w, messageId, NOON);
    const [request] = await openRequests(w);
    const bound = await w.c.app.inject({ method: 'GET', url: `/api/requests/${request!.id}/outbound-approval`, ...as(w.c.ceoToken) });
    expect(bound.json()).toMatchObject({ kind: 'message', messageId, restored: true });
  });

  it('sends nothing in a round while a restored database has not taken its mark yet', async () => {
    const w = await world();
    await w.c.db.update(outboundAccounts).set({ configEnc: encryptSecret(JSON.stringify(SMTP), w.ctx.config.secret) }).where(eq(outboundAccounts.id, w.account.id));
    await w.submit();
    const sent: string[] = [];
    const use: Senders = {
      smtp: { send: async ({ attemptId }) => (sent.push(attemptId), { kind: 'accepted', providerReceipt: '250 ok', acceptedAt: new Date().toISOString() }), reconcile: async () => ({ kind: 'pending' }) },
      webhook: { send: async () => { throw new Error('This test sends over SMTP.'); }, reconcile: async () => ({ kind: 'pending' }) },
      deadlineMs: 2_147_483_647,
    };
    /* The app leads, and what the restore carried over could not be applied yet: nobody is served, and nothing is sent. */
    const ready = vi.spyOn(w.ctx.restores, 'ready').mockReturnValue(false);
    await outboundRound(w.ctx, NOON, use);
    expect(sent).toEqual([]);
    ready.mockReturnValue(true);
    await outboundRound(w.ctx, NOON, use);
    expect(sent).toHaveLength(1);
  });

  it('leaves a message written after the restore to the rules alone', async () => {
    const w = await world();
    await restore(w);
    const { messageId, status } = await w.submit();
    expect(status).toBe('scheduled');
    expect((await dispatched(w, messageId, NOON)).kind).toBe('begun');
    expect(await openRequests(w)).toEqual([]);
  });
});
