import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { requests } from '../src/db/schema.js';
import { as } from './helpers.js';
import { dispatched, world, type World } from './outbound-world.js';

const NOON = new Date('2026-11-06T12:00:00.000Z');
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

  it('leaves a message written after the restore to the rules alone', async () => {
    const w = await world();
    await restore(w);
    const { messageId, status } = await w.submit();
    expect(status).toBe('scheduled');
    expect((await dispatched(w, messageId, NOON)).kind).toBe('begun');
    expect(await openRequests(w)).toEqual([]);
  });
});
