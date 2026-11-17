import { ContactFieldName, ContactFields, MAX_CONTACT_FIELDS } from '@hornhoof/protocol';
import { parse } from 'csv-parse/sync';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { Parser } from 'saxen';
import { readSheet } from 'read-excel-file/universal';

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 1000;
const MAX_COLUMNS = MAX_CONTACT_FIELDS + 2;
const MAX_EXPANDED = 8 * 1024 * 1024;
export type ImportReason = 'address_missing' | 'consent_missing' | 'field_invalid' | 'extra_columns' | 'address_invalid' | 'contact_suppressed';
export type ImportRow = { row: number; address: string; fields: ContactFields };
export type SkippedRow = { row: number; reason: ImportReason };
export class ContactTableError extends Error {
  readonly reason = 'outbound_import_invalid';
  constructor() { super('Use a CSV or XLSX table with unique address, consent and field-name columns, up to 1000 rows and 50 fields. Values must be plain single lines of up to 200 characters.'); }
}
const invalid = () => new ContactTableError();

/* Bounds are checked before the workbook parser sees any expanded XML or sparse row/cell coordinates. */
function boundedWorkbook(bytes: Buffer): ArrayBuffer {
  let expanded = 0;
  let entries = 0;
  const files = unzipSync(bytes, { filter: entry => {
    expanded += entry.originalSize;
    if (++entries > 200 || expanded > MAX_EXPANDED) throw invalid();
    return /\.(?:xml|rels)$/.test(entry.name);
  } });
  for (const bytes of Object.values(files)) checkXml(strFromU8(bytes));
  return Uint8Array.from(zipSync(files, { level: 0 })).buffer;
}

function checkCoordinate(value: string, cell: boolean): void {
  const match = /^([A-Z]*)([1-9]\d*)$/.exec(value);
  if (!match || (cell && !match[1]) || (!cell && match[1])) throw invalid();
  const column = [...match[1]!].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  if (Number(match[2]) > MAX_ROWS + 1 || column > MAX_COLUMNS) throw invalid();
}

function checkXml(xml: string): void {
  const parser = new Parser();
  let rows = 0;
  let cells = 0;
  parser.on('error', () => { throw invalid(); });
  parser.on('warn', () => { throw invalid(); });
  parser.on('attention', () => { throw invalid(); });
  parser.on('openTag', (name, attributes, decode) => {
    const tag = name.split(':').at(-1);
    if (tag === 'f') throw invalid();
    if (tag === 'row') { if (++rows > MAX_ROWS + 1) throw invalid(); cells = 0; }
    if (tag === 'c' && ++cells > MAX_COLUMNS) throw invalid();
    if (tag !== 'row' && tag !== 'c') return;
    const ref = attributes()['r'];
    if (ref !== undefined) checkCoordinate(decode(ref), tag === 'c');
  });
  if (parser.parse(xml)) throw invalid();
}

async function rowsOf(filename: string, bytes: Buffer): Promise<unknown[][]> {
  if (!bytes.length || bytes.length > MAX_IMPORT_BYTES) throw invalid();
  if (/\.csv$/i.test(filename)) return parse(bytes, { bom: true, relax_column_count: true, max_record_size: 64 * 1024 }) as string[][];
  if (/\.xlsx$/i.test(filename)) return readSheet(boundedWorkbook(bytes), 1, { trim: false });
  throw invalid();
}

function columnsOf(row: unknown[] | undefined): string[] {
  const values = [...row ?? []];
  while (values.length && (values.at(-1) === null || values.at(-1) === '')) values.pop();
  if (values.length > MAX_COLUMNS || values.some(v => typeof v !== 'string')) throw invalid();
  const names = values as string[];
  if (new Set(names).size !== names.length || !names.includes('address') || !names.includes('consent')) throw invalid();
  if (names.some(name => name !== 'address' && name !== 'consent' && !ContactFieldName.safeParse(name).success)) throw invalid();
  return names;
}

const cellText = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
function readRow(columns: string[], cells: unknown[], row: number): ImportRow | SkippedRow {
  const address = cellText(cells[columns.indexOf('address')]).trim();
  if (!address) return { row, reason: 'address_missing' };
  if (!['true', 'yes', '1'].includes(cellText(cells[columns.indexOf('consent')]).trim().toLowerCase())) return { row, reason: 'consent_missing' };
  if (cells.slice(columns.length).some(v => v !== null && v !== '')) return { row, reason: 'extra_columns' };
  const values = Object.fromEntries(columns.flatMap((name, i) => name === 'address' || name === 'consent' || cells[i] === null || cells[i] === undefined || cells[i] === '' ? [] : [[name, cellText(cells[i])]]));
  const parsed = ContactFields.safeParse(values);
  return parsed.success ? { row, address, fields: parsed.data } : { row, reason: 'field_invalid' };
}

/* Returns row numbers and validated data; callers never echo raw cells or parser diagnostics. */
export async function readContactTable(filename: string, bytes: Buffer): Promise<{ rows: ImportRow[]; skipped: SkippedRow[] }> {
  let table: unknown[][];
  try { table = await rowsOf(filename, bytes); } catch { throw invalid(); }
  if (table.length > MAX_ROWS + 1) throw invalid();
  const columns = columnsOf(table[0]);
  const rows: ImportRow[] = [];
  const skipped: SkippedRow[] = [];
  table.slice(1).forEach((cells, i) => {
    const parsed = readRow(columns, cells, i + 2);
    if ('reason' in parsed) skipped.push(parsed); else rows.push(parsed);
  });
  return { rows, skipped };
}
