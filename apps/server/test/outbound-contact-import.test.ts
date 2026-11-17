import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { decryptSecret } from '../src/crypto/secrets.js';
import { outboundContactFields, outboundContacts } from '../src/db/schema.js';
import { workbook } from './outbound-contact-workbook.js';
import { as } from './helpers.js';
import { aChannelOf, dispatched, published, world } from './outbound-world.js';

const ROWS = [['address', 'consent', 'name', 'organization'], ['import-ann@shop.example', 'yes', 'Ann', 'The shop'], ['no@shop.example', '', 'No consent', ''], ['', 'yes', 'No address', ''], ['extra@shop.example', 'yes', 'Extra', 'Shop', 'surplus']];

describe('a consented contact table', () => {
  it.each(['csv', 'xlsx'] as const)('adds values to an existing contact through %s and prepares their rendered message for dispatch', async format => {
    const w = await world();
    const rows = [['address', 'consent', 'name', 'organization', 'personal_line'], ['ann@shop.example', 'yes', 'Ann', 'Example shop', 'Thank you for visiting.']];
    const bytes = format === 'csv' ? Buffer.from(rows.map(row => row.join(',')).join('\n')) : workbook(rows);
    const response = await w.c.app.inject({ method: 'POST', url: '/api/outbound/contacts/import', ...as(w.c.ceoToken), payload: { channelId: w.channel.id, filename: `contacts.${format}`, data: bytes.toString('base64'), source: 'Signup sheet', evidence: 'Recorded consent' } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ added: 0, updated: 1, skipped: [] });
    const [saved] = await w.c.db.select().from(outboundContactFields).where(eq(outboundContactFields.contactId, w.contact.id));
    expect(JSON.parse(decryptSecret(saved!.fieldsEnc, w.ctx.config.secret))).toEqual({ name: 'Ann', organization: 'Example shop', personal_line: 'Thank you for visiting.' });
    const field = await published(w.c, { kind: 'variable', field: 'name' });
    const result = await w.submit({ document: { ...w.document, variables: [{ slotId: w.variableSlot, valueRef: field.entryId }] } });
    expect(result.status).toBe('scheduled');
    expect(await dispatched(w, result.messageId)).toMatchObject({ kind: 'begun', sealedPayload: { recipient: 'ann@shop.example', text: expect.stringContaining('Hello from Ann.') } });
  });

  it.each(['csv', 'xlsx'] as const)('imports %s fields and names skipped rows without echoing their private contents', async format => {
    const w = await world();
    const bytes = format === 'csv' ? Buffer.from(ROWS.map(row => row.join(',')).join('\n')) : workbook(ROWS);
    const res = await w.c.app.inject({ method: 'POST', url: '/api/outbound/contacts/import', ...as(w.c.ceoToken), payload: {
      channelId: w.channel.id, filename: `contacts.${format}`, data: bytes.toString('base64'), source: 'Signup sheet', evidence: 'Written signup confirmations',
    } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ added: 1, updated: 0, skipped: [{ row: 3, reason: 'consent_missing' }, { row: 4, reason: 'address_missing' }, { row: 5, reason: 'extra_columns' }] });
    expect(await w.c.db.select().from(outboundContacts)).toHaveLength(2);
    expect(res.body).not.toContain('Ann');
    expect(res.body).not.toContain('shop.example');
  });
  it('skips a contact exceeding its combined field limit and still imports the next row', async () => {
    const w = await world();
    const fields = Object.fromEntries(Array.from({ length: 50 }, (_, n) => [`field_${n}`, 'value']));
    const saved = await w.c.app.inject({ method: 'POST', url: '/api/outbound/contacts', ...as(w.c.ceoToken), payload: { channelId: w.channel.id, kind: 'email', address: 'ann@shop.example', source: 'Signup', evidence: 'Consent', fields } });
    expect(saved.statusCode).toBe(200);
    const data = Buffer.from('address,consent,fresh\nann@shop.example,yes,Extra\nnext@shop.example,yes,Ready').toString('base64');
    const response = await w.c.app.inject({ method: 'POST', url: '/api/outbound/contacts/import', ...as(w.c.ceoToken), payload: { channelId: w.channel.id, filename: 'contacts.csv', data, source: 'Signup', evidence: 'Consent' } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ added: 1, updated: 0, skipped: [{ row: 2, reason: 'field_invalid' }] });
  });

  it('imports nothing without a person who may manage this departments channel', async () => {
    const w = await world();
    const payload = { channelId: w.channel.id, filename: 'contacts.csv', data: Buffer.from('address,consent,name\nprivate@shop.example,yes,Ann').toString('base64'), source: 'Signup', evidence: 'Consent' };
    for (const [headers, status] of [[{}, 401], [as(w.c.samToken), 403]] as const) {
      const response = await w.c.app.inject({ method: 'POST', url: '/api/outbound/contacts/import', ...headers, payload });
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain('private@shop.example');
    }
    expect(await w.c.db.select().from(outboundContacts)).toHaveLength(1);
    expect(await w.c.db.select().from(outboundContactFields)).toEqual([]);
  });

  it('refuses a malformed table with a clear reason, no private diagnostics and no writes', async () => {
    const w = await world();
    const data = Buffer.from('address,consent,name,name\nprivate@shop.example,yes,Private cell,Private cell').toString('base64');
    const response = await w.c.app.inject({ method: 'POST', url: '/api/outbound/contacts/import', ...as(w.c.ceoToken), payload: { channelId: w.channel.id, filename: 'contacts.csv', data, source: 'Signup', evidence: 'Consent' } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { reason: 'outbound_import_invalid' } });
    expect(response.body).not.toContain('Private cell');
    expect(response.body).not.toContain('private@shop.example');
    expect(await w.c.db.select().from(outboundContacts)).toHaveLength(1);
    expect(await w.c.db.select().from(outboundContactFields)).toEqual([]);
  });

  it('uses the channel adapter for direct addresses rather than treating every address as email', async () => {
    const w = await world();
    const channel = await aChannelOf(w.c, { adapter: 'webhook' });
    const data = Buffer.from('address,consent,name\npartner-1,yes,Ann').toString('base64');
    const response = await w.c.app.inject({ method: 'POST', url: '/api/outbound/contacts/import', ...as(w.c.ceoToken), payload: { channelId: channel.id, filename: 'contacts.csv', data, source: 'Signup', evidence: 'Consent' } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ added: 1, updated: 0, skipped: [] });
    const [added] = await w.c.db.select().from(outboundContacts).where(eq(outboundContacts.kind, 'direct'));
    expect(added).toBeDefined();
    const [saved] = await w.c.db.select().from(outboundContactFields).where(eq(outboundContactFields.contactId, added!.id));
    expect(JSON.parse(decryptSecret(saved!.fieldsEnc, w.ctx.config.secret))).toEqual({ name: 'Ann' });
  });

  it('keeps a suppressed contact suppressed while importing another consenting row', async () => {
    const w = await world();
    const stopped = await w.c.app.inject({ method: 'POST', url: `/api/outbound/contacts/${w.contact.id}/suppress`, ...as(w.c.ceoToken), payload: { evidence: 'Asked to stop' } });
    expect(stopped.statusCode).toBe(200);
    const data = Buffer.from('address,consent,name\nann@shop.example,yes,Ann\nnext@shop.example,yes,Next').toString('base64');
    const response = await w.c.app.inject({ method: 'POST', url: '/api/outbound/contacts/import', ...as(w.c.ceoToken), payload: { channelId: w.channel.id, filename: 'contacts.csv', data, source: 'Signup', evidence: 'Consent' } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ added: 1, updated: 0, skipped: [{ row: 2, reason: 'contact_suppressed' }] });
    const saved = await w.c.db.select().from(outboundContactFields);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.contactId).not.toBe(w.contact.id);
  });

});
