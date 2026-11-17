import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

type SpreadsheetCell = string | number | boolean | null | undefined;

type SpreadsheetSheet = {
  name?: string;
  headers?: string[];
  rows: SpreadsheetCell[][];
};

const USAGE = 'Usage: hh-xlsx <input.json|input.csv|input.tsv|-> <output.xlsx|output.csv>';

const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function cleanXmlText(raw: string): string {
  return raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[&<>"']/g, ch => XML_ESCAPES[ch]!);
}

function columnLetters(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function safeSheetName(raw: string | undefined, index: number, used: Set<string>): string {
  const cleaned = (raw ?? '')
    .replace(/[\u0000-\u001f\\/*?:[\]]/g, '_')
    .trim()
    .replace(/^'+|'+$/g, '')
    .slice(0, 31);
  const base = cleaned || `Sheet${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    const tag = ` (${suffix++})`;
    candidate = `${base.slice(0, 31 - tag.length)}${tag}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function toCell(value: unknown): SpreadsheetCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

function sheetFromObjects(rows: Record<string, unknown>[], name?: string): SpreadsheetSheet {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return {
    ...(name ? { name } : {}),
    headers: keys,
    rows: rows.map(row => keys.map(key => toCell(row[key]))),
  };
}

function isObjectRow(item: unknown): item is Record<string, unknown> {
  return Boolean(item) && typeof item === 'object' && !Array.isArray(item);
}

/* A row of cells from a JSON row: an array cell by cell, anything else as the one cell of its row. */
const cellRow = (row: unknown): SpreadsheetCell[] => (Array.isArray(row) ? row.map(toCell) : [toCell(row)]);

const headerTexts = (raw: unknown): string[] | undefined => (Array.isArray(raw) ? raw.map(h => String(h ?? '')) : undefined);

function rowsSheet(rows: unknown[], name?: string, headers?: string[]): SpreadsheetSheet {
  return { ...(name ? { name } : {}), ...(headers ? { headers } : {}), rows: rows.map(cellRow) };
}

function normalizeSheetEntry(entry: unknown): SpreadsheetSheet {
  if (!isObjectRow(entry) || !Array.isArray(entry.rows)) throw new Error('Each sheet needs a rows array.');
  const name = typeof entry.name === 'string' ? entry.name : undefined;
  const rows = entry.rows as unknown[];
  if (isObjectRow(rows[0])) return sheetFromObjects(rows as Record<string, unknown>[], name);
  return rowsSheet(rows, name, headerTexts(entry.headers));
}

const JSON_SHAPES = 'JSON table input must be an array of objects, an array of rows, or { sheets: [...] }.';

function arrayInput(rows: unknown[]): SpreadsheetSheet[] {
  if (rows.length === 0) return [{ headers: [], rows: [] }];
  if (isObjectRow(rows[0])) return [sheetFromObjects(rows as Record<string, unknown>[])];
  return [{ rows: rows.map(cellRow) }];
}

function objectInput(parsed: Record<string, unknown>): SpreadsheetSheet[] {
  if (Array.isArray(parsed.sheets)) {
    if (!parsed.sheets.length) throw new Error('Provide at least one sheet in sheets.');
    return parsed.sheets.map(entry => normalizeSheetEntry(entry));
  }
  if (Array.isArray(parsed.rows)) return [normalizeSheetEntry(parsed)];
  throw new Error(JSON_SHAPES);
}

function parseJsonInput(parsed: unknown): SpreadsheetSheet[] {
  if (Array.isArray(parsed)) return arrayInput(parsed);
  if (isObjectRow(parsed)) return objectInput(parsed);
  throw new Error(JSON_SHAPES);
}

/* Where a CSV or TSV reader stands: the rows read, the row and the cell it reads, and whether it is inside quotes. */
type Reading = { rows: string[][]; row: string[]; cell: string; quoted: boolean };

function endRow(r: Reading): void {
  r.row.push(r.cell);
  r.rows.push(r.row);
  r.row = [];
  r.cell = '';
}

/* One character inside quotes: two quotes are one quote, one quote ends them. How many characters it took. */
function quotedChar(r: Reading, raw: string, i: number): number {
  const ch = raw[i]!;
  if (ch !== '"') {
    r.cell += ch;
    return 1;
  }
  if (raw[i + 1] === '"') {
    r.cell += '"';
    return 2;
  }
  r.quoted = false;
  return 1;
}

/* A line break ends the row; \r\n is one break. How many characters it took. */
function lineBreak(r: Reading, raw: string, i: number): number {
  endRow(r);
  return raw[i] === '\r' && raw[i + 1] === '\n' ? 2 : 1;
}

/* One character outside quotes. How many characters it took. */
function plainChar(r: Reading, raw: string, i: number, sep: ',' | '\t'): number {
  const ch = raw[i]!;
  if (ch === '\r' || ch === '\n') return lineBreak(r, raw, i);
  if (ch === '"' && r.cell.length === 0) r.quoted = true;
  else if (ch === sep) {
    r.row.push(r.cell);
    r.cell = '';
  } else r.cell += ch;
  return 1;
}

function parseDelimitedRows(raw: string, sep: ',' | '\t'): string[][] {
  const r: Reading = { rows: [], row: [], cell: '', quoted: false };
  for (let i = 0; i < raw.length; ) i += r.quoted ? quotedChar(r, raw, i) : plainChar(r, raw, i, sep);
  if (r.quoted || r.cell.length > 0 || r.row.length > 0) endRow(r);
  return r.rows;
}

/* JSON by its extension, or by its first character when the extension does not say CSV or TSV. */
function isJsonInput(ext: string, trimmed: string): boolean {
  if (ext === '.json') return true;
  if (ext === '.csv' || ext === '.tsv') return false;
  return trimmed.startsWith('[') || trimmed.startsWith('{');
}

/* Tabs by the extension, or, without one, a text with tabs and no commas. */
function separatorOf(ext: string, text: string): ',' | '\t' {
  if (ext === '.tsv') return '\t';
  return !ext && text.includes('\t') && !text.includes(',') ? '\t' : ',';
}

export function parseTableInput(raw: string, sourceName = ''): SpreadsheetSheet[] {
  const text = raw.replace(/^\uFEFF/, '');
  const ext = extname(sourceName).toLowerCase();
  if (isJsonInput(ext, text.trim())) return parseJsonInput(JSON.parse(text.trim()));
  const parsed = parseDelimitedRows(text, separatorOf(ext, text));
  if (!parsed.length) return [{ headers: [], rows: [] }];
  return [{ headers: parsed[0]!, rows: parsed.slice(1) }];
}

function csvField(cell: SpreadsheetCell): string {
  if (cell === null || cell === undefined) return '';
  const text = String(cell);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function buildCsv(sheet: SpreadsheetSheet): string {
  const allRows: SpreadsheetCell[][] = [...(sheet.headers?.length ? [sheet.headers] : []), ...sheet.rows];
  if (!allRows.length) return '';
  return `${allRows.map(row => row.map(csvField).join(',')).join('\r\n')}\r\n`;
}

const blank = (value: SpreadsheetCell): boolean => value === null || value === undefined || value === '';

/* The type and the value of a cell as the worksheet writes them: a number and a truth as such, anything else as its text. */
function cellContent(value: SpreadsheetCell): string {
  if (typeof value === 'number' && Number.isFinite(value)) return ` t="n"><v>${value}</v>`;
  if (typeof value === 'boolean') return ` t="b"><v>${value ? 1 : 0}</v>`;
  return ` t="inlineStr"><is><t xml:space="preserve">${cleanXmlText(String(value ?? ''))}</t></is>`;
}

function renderCellXml(col: number, rowNumber: number, value: SpreadsheetCell, header: boolean): string {
  if (blank(value) && !header) return '';
  return `<c r="${columnLetters(col)}${rowNumber}"${header ? ' s="1"' : ''}${cellContent(value)}</c>`;
}

function renderWorksheetXml(sheet: SpreadsheetSheet): string {
  const hasHeaders = Boolean(sheet.headers?.length);
  const allRows: SpreadsheetCell[][] = [...(hasHeaders ? [sheet.headers!] : []), ...sheet.rows];
  const rowXml = allRows
    .map((cells, idx) => {
      const rowNum = idx + 1;
      const isHeader = hasHeaders && idx === 0;
      const rendered = cells.map((cell, col) => renderCellXml(col, rowNum, cell, isHeader)).join('');
      return `<row r="${rowNum}">${rendered}</row>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${rowXml}</sheetData>` +
    '</worksheet>'
  );
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
  '</styleSheet>';

const ROOT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

function packZip(entries: { name: string; data: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const sum = crc32(entry.data) >>> 0;

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centralParts.push(central);

    offset += local.length + compressed.length;
  }

  const centralSize = centralParts.reduce((acc, b) => acc + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

export function buildXlsx(sheets: SpreadsheetSheet[]): Buffer {
  const list = sheets.length ? sheets : [{ headers: [], rows: [] }];
  const usedNames = new Set<string>();
  const named = list.map((sheet, idx) => ({ ...sheet, safeName: safeSheetName(sheet.name, idx, usedNames) }));

  const sheetTags = named
    .map((s, idx) => `<sheet name="${cleanXmlText(s.safeName)}" sheetId="${idx + 1}" r:id="rId${idx + 1}"/>`)
    .join('');
  const workbookXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheetTags}</sheets>` +
    '</workbook>';

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    named
      .map((_, idx) => `<Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${idx + 1}.xml"/>`)
      .join('') +
    `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>';

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    named
      .map((_, idx) => `<Override PartName="/xl/worksheets/sheet${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join('') +
    '</Types>';

  const entries: { name: string; data: Buffer }[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS_XML, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') },
    ...named.map((sheet, idx) => ({
      name: `xl/worksheets/sheet${idx + 1}.xml`,
      data: Buffer.from(renderWorksheetXml(sheet), 'utf8'),
    })),
  ];

  return packZip(entries);
}

/* The input and the output of a command line, or its usage when it names anything else. */
function cliPaths(args: string[]): { input: string; output: string; csv: boolean } {
  const [input, output] = args;
  if (args.length !== 2 || !input || !output) throw new Error(USAGE);
  const ext = extname(output).toLowerCase();
  if (ext !== '.xlsx' && ext !== '.csv') throw new Error(`${USAGE} (output must end in .xlsx or .csv)`);
  return { input, output, csv: ext === '.csv' };
}

/* The table text and the name that tells its kind; "-" is stdin, which has no name. */
const readInput = (input: string, stdin: string | undefined): { raw: string; name: string } =>
  input === '-' ? { raw: stdin ?? '', name: '' } : { raw: readFileSync(input, 'utf8'), name: input };

export async function runSpreadsheetCli(args: string[], stdin?: string): Promise<{ out: string }> {
  const { input, output, csv } = cliPaths(args);
  const { raw, name } = readInput(input, stdin);
  const sheets = parseTableInput(raw, name);
  if (csv) writeFileSync(output, buildCsv(sheets[0]!), 'utf8');
  else writeFileSync(output, buildXlsx(sheets));
  return { out: output };
}
