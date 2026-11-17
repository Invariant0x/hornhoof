import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret } from '../src/crypto/secrets.js';
import { outboundContactFields, outboundMessageRevisions } from '../src/db/schema.js';
import { as } from './helpers.js';
import { dispatched, published, world } from './outbound-world.js';

const VALUES = { name: 'Ann', organization: 'Example shop', personal_line: 'Thank you for visiting.' };

describe('contact values for outbound templates', () => {
  it('adds private values on the same consent route without echoing them or logging them', async () => {
    const w = await world();
    const res = await w.c.app.inject({ method: 'POST', url: '/api/outbound/contacts', ...as(w.c.ceoToken), payload: {
      channelId: w.channel.id, kind: 'email', address: 'fields@shop.example', source: 'signup', evidence: 'Recorded signup', fields: VALUES,
    } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ contactId: expect.any(String), permissionId: expect.any(String) });
    const list = await w.c.app.inject({ url: `/api/outbound/contacts?department=${w.c.dev.id}`, ...as(w.c.ceoToken) });
    const log = await w.c.app.inject({ url: `/api/outbound/setup-log?department=${w.c.dev.id}`, ...as(w.c.ceoToken) });
    for (const value of Object.values(VALUES)) expect(res.body + list.body + log.body).not.toContain(value);
  });

  it('names a missing contact value as the reason for rejecting only that recipient', async () => {
    const w = await world();
    const field = await published(w.c, { kind: 'variable', field: 'name' });
    const document = { ...w.document, variables: [{ slotId: w.variableSlot, valueRef: field.entryId }] };
    const noValue = await w.submit({ document });
    expect(noValue.status).toBe('rejected');
    expect(noValue.reasonCodes).toContain('contact_field_missing');
    const added = await w.c.app.inject({ method: 'POST', url: '/api/outbound/contacts', ...as(w.c.ceoToken), payload: {
      channelId: w.channel.id, kind: 'email', address: 'ready@shop.example', source: 'signup', evidence: 'Recorded signup', fields: VALUES,
    } });
    expect(added.statusCode, added.body).toBe(200);
    const yes = await w.submit({ document, target: { kind: 'contact', contactId: added.json<{ contactId: string }>().contactId }, idempotencyKey: randomUUID() });
    expect(yes.status).toBe('scheduled');
    expect(yes.reasonCodes).toEqual([]);
    const [revision] = await w.c.db.select().from(outboundMessageRevisions).where(eq(outboundMessageRevisions.messageId, yes.messageId));
    expect(JSON.parse(decryptSecret(revision!.sealedEnc, w.ctx.config.secret)).text).toContain('Hello from Ann.');
    const [privateFields] = await w.c.db.select().from(outboundContactFields).where(eq(outboundContactFields.contactId, added.json<{ contactId: string }>().contactId));
    expect(privateFields!.fieldsEnc).not.toContain('Ann');
    expect(JSON.parse(decryptSecret(privateFields!.fieldsEnc, w.ctx.config.secret))).toEqual(VALUES);
  });
  it('lets the department head add contact fields through MCP and replies with ids only', async () => {
    const w = await world();
    const tools = await w.c.tools(w.c.head, w.c.ids.ceo);
    const reply = await tools.callTool({ name: 'outbound_contact_add', arguments: { channel: w.channel.id, kind: 'email', address: 'tool@shop.example', source: 'signup', evidence: 'Recorded consent', fields: VALUES } });
    expect(reply.isError).toBeFalsy();
    const text = JSON.stringify(reply.content);
    expect(text).toContain('contactId');
    for (const value of Object.values(VALUES)) expect(text).not.toContain(value);
  });

  it('refuses a queued message when its contact values change before dispatch', async () => {
    const w = await world();
    const field = await published(w.c, { kind: 'variable', field: 'name' });
    const document = { ...w.document, variables: [{ slotId: w.variableSlot, valueRef: field.entryId }] };
    const save = (name: string) => w.c.app.inject({ method: 'POST', url: '/api/outbound/contacts', ...as(w.c.ceoToken), payload: {
      channelId: w.channel.id, kind: 'email', address: 'ann@shop.example', source: 'signup', evidence: 'Recorded signup', fields: { name },
    } });
    expect((await save('Ann')).statusCode).toBe(200);
    const queued = await w.submit({ document });
    expect(queued.status).toBe('scheduled');
    expect((await save('Beth')).statusCode).toBe(200);
    expect(await dispatched(w, queued.messageId)).toMatchObject({ kind: 'refused' });
  });

});
