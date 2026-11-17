import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson } from '../../auth/session.js';
import { companyPhones } from '../../db/schema.js';
import { addPhone, NewPhone, ProbePhone, phoneById, phoneInvalid, phoneOwner, phoneView, probePhone } from './store.js';
import { reconcilePhone, stopPhone } from './queue.js';
import { imageBytes, livePhone, recordingImage, taskRecordings } from './recording.js';

const Id = z.strictObject({ id: z.uuid() });

function body<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw phoneInvalid();
  return parsed.data;
}

export function phoneRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/phones', async req => {
    const me = await requirePerson(req, ctx.db);
    const phones = await ctx.db.select().from(companyPhones).where(and(eq(companyPhones.companyId, me.companyId), isNull(companyPhones.removedAt))).orderBy(asc(companyPhones.createdAt), asc(companyPhones.id));
    await Promise.all(phones.map(p => reconcilePhone(ctx, p.id)));
    return { phones: await Promise.all(phones.map(p => phoneView(ctx, p, me))) };
  });
  app.get('/api/phones/:id', async req => {
    const me = await requirePerson(req, ctx.db);
    return phoneView(ctx, await phoneById(ctx, me.companyId, Id.parse(req.params).id), me);
  });
  app.post('/api/phones/probe', async req => {
    const me = await requirePerson(req, ctx.db);
    return { devices: (await probePhone(ctx, me, body(ProbePhone, req.body))).devices };
  });
  app.post('/api/phones', async (req, reply) => {
    const me = await requirePerson(req, ctx.db);
    const phone = await addPhone(ctx, me, body(NewPhone, req.body));
    return reply.code(201).send(await phoneView(ctx, phone, me));
  });
  app.post('/api/phones/:id/stop', async req => {
    const me = await requirePerson(req, ctx.db);
    const phone = await phoneById(ctx, me.companyId, Id.parse(req.params).id);
    phoneOwner(me, phone);
    await stopPhone(ctx, phone);
    return phoneView(ctx, await phoneById(ctx, me.companyId, phone.id), me);
  });
  app.post('/api/phones/:id/resume', async req => {
    const me = await requirePerson(req, ctx.db);
    const phone = await phoneById(ctx, me.companyId, Id.parse(req.params).id);
    phoneOwner(me, phone);
    await ctx.db.update(companyPhones).set({ lending: true }).where(eq(companyPhones.id, phone.id));
    return phoneView(ctx, { ...phone, lending: true }, me);
  });
  app.get('/api/phones/:id/live', async (req, reply) => {
    const me = await requirePerson(req, ctx.db);
    const live = await livePhone(ctx, me, Id.parse(req.params).id);
    return reply.header('cache-control', 'no-store').send({ frame: live.frame, lending: live.phone.lending });
  });
  app.get('/api/phones/:id/live/image', async (req, reply) => {
    const me = await requirePerson(req, ctx.db);
    const live = await livePhone(ctx, me, Id.parse(req.params).id);
    return reply.type('image/jpeg').header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').send(await imageBytes(ctx, me.companyId, live.attachmentId));
  });
  app.get('/api/tasks/:id/phone-recordings', async (req, reply) => {
    const me = await requirePerson(req, ctx.db);
    return reply.header('cache-control', 'no-store').send(await taskRecordings(ctx, me, Id.parse(req.params).id));
  });
  app.get('/api/phone-sessions/:id/frames/:sequence/image', async (req, reply) => {
    const me = await requirePerson(req, ctx.db);
    const { id, sequence } = z.strictObject({ id: z.uuid(), sequence: z.coerce.number().int().nonnegative() }).parse(req.params);
    const attachmentId = await recordingImage(ctx, me, id, sequence);
    return reply.type('image/jpeg').header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').send(await imageBytes(ctx, me.companyId, attachmentId));
  });
}
