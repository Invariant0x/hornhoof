import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it, onTestFinished } from 'vitest';
import { listenIn } from '../../../test-support/ports.mjs';
import { classifyAgentCommand } from '../src/command-guard.js';
import { buildCsv, buildXlsx, parseTableInput } from '../src/spreadsheet.js';

const XLSX_SCRIPT = fileURLToPath(new URL('../hh-xlsx.cjs', import.meta.url));
const ATTACH_SCRIPT = fileURLToPath(new URL('../hh-attach.cjs', import.meta.url));
const DOCKERFILE = fileURLToPath(new URL('../Dockerfile', import.meta.url));

/* Unpacks a ZIP buffer from its Central Directory and checks every entry's CRC-32 and sizes. */
function unzipEntries(zip: Buffer): Map<string, string> {
  expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = zip.readUInt16LE(eocd + 10);
  let pos = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, string>();
  for (let n = 0; n < count; n++) {
    expect(zip.readUInt32LE(pos)).toBe(0x02014b50);
    const method = zip.readUInt16LE(pos + 10);
    const expectedCrc = zip.readUInt32LE(pos + 16);
    const compressed = zip.readUInt32LE(pos + 20);
    const uncompressed = zip.readUInt32LE(pos + 24);
    const nameLen = zip.readUInt16LE(pos + 28);
    const extraLen = zip.readUInt16LE(pos + 30);
    const commentLen = zip.readUInt16LE(pos + 32);
    const localOffset = zip.readUInt32LE(pos + 42);
    const name = zip.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen + extraLen + commentLen;

    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = zip.subarray(dataStart, dataStart + compressed);
    const bytes = method === 0 ? raw : inflateRawSync(raw);
    expect(bytes.length).toBe(uncompressed);
    expect(crc32(bytes) >>> 0).toBe(expectedCrc);
    out.set(name, bytes.toString('utf8'));
  }
  return out;
}

const runNode = (script: string, args: string[], env: Record<string, string> = {}, stdin?: string) =>
  new Promise<{ code: number; out: string; err: string }>(resolve => {
    const child = execFile(
      process.execPath,
      [script, ...args],
      { env: { PATH: process.env.PATH ?? '', ...env } },
      (err, out, errOut) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(out), err: String(errOut) }),
    );
    if (stdin !== undefined) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }
  });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('built-in spreadsheet builder and hh-xlsx', () => {
  it('builds a genuine OOXML .xlsx with typed cells, Cyrillic text, multiple sheets and formula-safe literal strings', () => {
    const sheets = parseTableInput(
      JSON.stringify({
        sheets: [
          {
            name: 'Контакты / Лиды:2026*?',
            rows: [
              { Компания: 'Север Плюс', Контакт: 'Анна <CEO> & Co', Сумма: 125000.5, Активен: true, Заметка: '=HYPERLINK("http://evil","click")\u0007' },
              { Компания: 'Юг Тех', Контакт: 'Борис', Сумма: 0, Активен: false, Заметка: null },
            ],
          },
          {
            name: 'Итоги',
            headers: ['Канал', 'Лидов'],
            rows: [['Telegram', 42]],
          },
        ],
      }),
    );
    const xlsx = buildXlsx(sheets);
    const files = unzipEntries(xlsx);
    expect([...files.keys()].sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
    const workbook = files.get('xl/workbook.xml')!;
    expect(workbook).toContain('name="Контакты _ Лиды_2026__"');
    expect(workbook).toContain('name="Итоги"');
    const sheet1 = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet1).toContain('r="A1"');
    expect(sheet1).toContain('Север Плюс');
    expect(sheet1).toContain('Анна &lt;CEO&gt; &amp; Co');
    expect(sheet1).toContain('<c r="C2" t="n"><v>125000.5</v></c>');
    expect(sheet1).toContain('<c r="D2" t="b"><v>1</v></c>');
    expect(sheet1).toContain('<c r="D3" t="b"><v>0</v></c>');
    /* Formula-looking strings stay literal inlineStr cells and never emit <f> elements or control chars. */
    expect(sheet1).not.toContain('<f>');
    expect(sheet1).not.toContain('\u0007');
    expect(sheet1).toContain('=HYPERLINK(&quot;http://evil&quot;,&quot;click&quot;)');
  });

  it('builds RFC 4180 UTF-8 CSV and parses JSON arrays of objects, JSON rows and CSV/TSV text', () => {
    const fromObjects = parseTableInput(JSON.stringify([{ Name: 'Alice, Inc.', Note: 'Line 1\n"Line 2"', Score: 19 }]));
    const csv = buildCsv(fromObjects[0]!);
    expect(csv).toBe('Name,Note,Score\r\n"Alice, Inc.","Line 1\n""Line 2""",19\r\n');
    const roundTrip = parseTableInput(csv, 'contacts.csv');
    expect(roundTrip[0]!.headers).toEqual(['Name', 'Note', 'Score']);
    expect(roundTrip[0]!.rows).toEqual([['Alice, Inc.', 'Line 1\n"Line 2"', '19']]);
  });

  it('runs hh-xlsx from CLI files and stdin, is installed in the node image and allowed by command-guard', async () => {
    const dir = tempDir('hh-xlsx-');
    const inputPath = join(dir, 'leads.json');
    const xlsxPath = join(dir, 'leads.xlsx');
    const csvPath = join(dir, 'leads.csv');
    writeFileSync(inputPath, JSON.stringify([{ Name: 'Contact One', Email: 'one@example.com', Deals: 3 }]));

    const madeXlsx = await runNode(XLSX_SCRIPT, [inputPath, xlsxPath]);
    expect(madeXlsx.code, madeXlsx.err).toBe(0);
    expect(madeXlsx.out.trim()).toBe(xlsxPath);
    const entries = unzipEntries(readFileSync(xlsxPath));
    expect(entries.get('xl/worksheets/sheet1.xml')).toContain('one@example.com');

    const madeCsv = await runNode(XLSX_SCRIPT, ['-', csvPath], {}, '[{"Name":"Contact One","Email":"one@example.com"}]');
    expect(madeCsv.code, madeCsv.err).toBe(0);
    expect(readFileSync(csvPath, 'utf8')).toContain('Contact One,one@example.com');

    const bad = await runNode(XLSX_SCRIPT, []);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('Usage: hh-xlsx');

    expect(await classifyAgentCommand({ command: 'hh-xlsx leads.json leads.xlsx', cwd: dir, workspaceRoot: dir })).toEqual({
      allow: true,
      kind: 'ordinary',
      coverage: 'recognized',
    });
    expect(readFileSync(DOCKERFILE, 'utf8')).toContain('COPY --chmod=755 apps/node/hh-xlsx.cjs /usr/local/bin/hh-xlsx');
  });

  it('supports hh-attach --chat FILE and hh-attach --task N --chat FILE for chat and task table delivery', async () => {
    const got: string[] = [];
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        got.push(req.url ?? '');
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `att-${got.length}` }));
      });
    });
    await listenIn(server);
    onTestFinished(() => new Promise<void>(r => server.close(() => r())));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/attachments`;

    const dir = tempDir('hh-attach-chat-');
    const file = join(dir, 'contacts.xlsx');
    writeFileSync(file, 'xlsx-bytes');
    const env = { HH_ATTACH_URL: url, HH_ATTACH_PASS: 'turn-token' };

    const chatOnly = await runNode(ATTACH_SCRIPT, ['--chat', file], env);
    expect(chatOnly.code, chatOnly.err).toBe(0);
    expect(chatOnly.out.trim()).toBe(`${file} att-1`);

    const taskAndChat = await runNode(ATTACH_SCRIPT, ['--task', '#817', '--chat', file], env);
    expect(taskAndChat.code, taskAndChat.err).toBe(0);
    expect(taskAndChat.out.trim()).toBe(`${file} att-2`);

    expect(got).toEqual([
      '/api/attachments?chat=1&name=contacts.xlsx',
      '/api/attachments?task=817&chat=1&name=contacts.xlsx',
    ]);
  });
});
