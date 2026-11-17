import { describe, expect, it } from 'vitest';
import { outboundContacts } from '../src/db/schema.js';
import { workbook } from './outbound-contact-workbook.js';
import { as } from './helpers.js';
import { world } from './outbound-world.js';

const ROWS = [['address', 'consent', 'name', 'organization'], ['import-ann@shop.example', 'yes', 'Ann', 'The shop'], ['no@shop.example', '', 'No consent', ''], ['', 'yes', 'No address', ''], ['extra@shop.example', 'yes', 'Extra', 'Shop', 'surplus']];

describe('a consented contact table', () => {
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

});
