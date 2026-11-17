import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { as } from './helpers.js';
import { world } from './outbound-world.js';

/* A tiny synthetic workbook, with recorded Office XML and literal cells, no spreadsheet process. */
export function workbook(rows: string[][]): Buffer {
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const xml = rows.map((row, i) => `<row r="${i + 1}">${row.map((v, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t>${escape(v)}</t></is></c>`).join('')}</row>`).join('');
  return Buffer.from(zipSync({
    'xl/workbook.xml': strToU8('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Contacts" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xml}</sheetData></worksheet>`),
  }));
}

const ROWS = [['address', 'consent', 'name', 'organization'], ['import-ann@shop.example', 'yes', 'Ann', 'The shop'], ['no@shop.example', '', 'No consent', ''], ['', 'yes', 'No address', '']];

describe('a consented contact table', () => {
  it.each(['csv', 'xlsx'] as const)('imports %s fields and names skipped rows without echoing their private contents', async format => {
    const w = await world();
    const bytes = format === 'csv' ? Buffer.from(ROWS.map(row => row.join(',')).join('\n')) : workbook(ROWS);
    const res = await w.c.app.inject({ method: 'POST', url: '/api/outbound/contacts/import', ...as(w.c.ceoToken), payload: {
      channelId: w.channel.id, filename: `contacts.${format}`, data: bytes.toString('base64'), source: 'Signup sheet', evidence: 'Written signup confirmations',
    } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ added: 1, updated: 0, skipped: [{ row: 3, reason: 'consent_missing' }, { row: 4, reason: 'address_missing' }] });
    expect(res.body).not.toContain('Ann');
    expect(res.body).not.toContain('shop.example');
  });
});
