import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { sheet } from './outbound-contact-workbook.js';
import { MAX_IMPORT_BYTES, readContactTable } from '../src/modules/outbound/contact-table.js';

const invalid = { reason: 'outbound_import_invalid' };
const csv = (text: string) => readContactTable('contacts.csv', Buffer.from(text));

describe('bounded contact table data', () => {
  it('reads a BOM, quoted commas and escaped quotes, and treats additional named columns as contact fields', async () => {
    expect(await csv('\ufeffaddress,consent,name,personal_line\r\nann@shop.example,yes,Ann,"Hello, ""Ann""."')).toEqual({ rows: [{ row: 2, address: 'ann@shop.example', fields: { name: 'Ann', personal_line: 'Hello, "Ann".' } }], skipped: [] });
  });
  it('skips excess cells, missing consent, missing addresses and invalid fields separately', async () => {
    const data = 'address,consent,name\nann@shop.example,1,Ann,extra\nno@shop.example,,No\n,true,Missing\nbad@shop.example,yes,"Two\nlines"\nlong@shop.example,yes,' + 'x'.repeat(201);
    expect(await csv(data)).toEqual({ rows: [], skipped: [{ row: 2, reason: 'extra_columns' }, { row: 3, reason: 'consent_missing' }, { row: 4, reason: 'address_missing' }, { row: 5, reason: 'field_invalid' }, { row: 6, reason: 'field_invalid' }] });
  });
  it.each(['address,name', 'address,consent,name,name', 'address,consent,Name', 'address,consent,account_label', 'address,consent,__proto__'])('refuses malformed or reserved headers: %s', async headers => {
    await expect(csv(headers + '\nann@shop.example,yes,Ann')).rejects.toMatchObject(invalid);
  });
  it('bounds files and rows, and refuses other file formats and invalid workbooks', async () => {
    await expect(readContactTable('contacts.csv', Buffer.alloc(MAX_IMPORT_BYTES + 1))).rejects.toMatchObject(invalid);
    await expect(csv('address,consent\n' + 'ann@shop.example,yes\n'.repeat(1001))).rejects.toMatchObject(invalid);
    await expect(readContactTable('contacts.xls', Buffer.from('address,consent'))).rejects.toMatchObject(invalid);
    await expect(readContactTable('contacts.xlsx', Buffer.from('not a workbook'))).rejects.toMatchObject(invalid);
  });
  it.each(['r="A1002"', "r = 'A1002'", 'r="&#65;1002"', 'r="BA1"'])('refuses oversized cell coordinates before reading a sheet: %s', async coordinate => {
    await expect(readContactTable('contacts.xlsx', sheet(`<worksheet><sheetData><row r="1"><c ${coordinate} t="inlineStr"><is><t>address</t></is></c></row></sheetData></worksheet>`))).rejects.toMatchObject(invalid);
  });
  it('refuses formula and entity declarations, never evaluating either', async () => {
    await expect(readContactTable('contacts.xlsx', sheet('<worksheet><sheetData><row r="1"><c r="A1"><f>TRUE()</f><v>1</v></c></row></sheetData></worksheet>'))).rejects.toMatchObject(invalid);
    await expect(readContactTable('contacts.xlsx', sheet('<!DOCTYPE worksheet [<!ENTITY x "address">]><worksheet>&x;</worksheet>'))).rejects.toMatchObject(invalid);
  });
  it('bounds expanded workbook data even when its archive is small', async () => {
    const workbook = sheet('<worksheet/>');
    const files = unzipSync(workbook);
    files['xl/oversize.xml'] = strToU8('x'.repeat(8 * 1024 * 1024 + 1));
    await expect(readContactTable('contacts.xlsx', Buffer.from(zipSync(files)))).rejects.toMatchObject(invalid);
  });
});

it('bounds implicit row and cell counts before the workbook parser allocates them', async () => {
  await expect(readContactTable('contacts.xlsx', sheet('<worksheet><sheetData>' + '<row/>'.repeat(1002) + '</sheetData></worksheet>'))).rejects.toMatchObject(invalid);
  await expect(readContactTable('contacts.xlsx', sheet('<worksheet><sheetData><row>' + '<c/>'.repeat(53) + '</row></sheetData></worksheet>'))).rejects.toMatchObject(invalid);
});
