import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATOR_CELLS_BYTES, type OperatorServerMessage } from '@hornhoof/protocol/program-operator';
import { afterEach, describe, expect, it } from 'vitest';
import { OperatorControl, operatorCells } from '../src/terminal/operator-control.js';

type Case = Extract<OperatorServerMessage, { type: 'program.operator_case' }>;
const identity = { agentKey: randomUUID(), jobId: randomUUID(), instance: randomUUID() };
const opened: Case = { type: 'program.operator_case', ...identity, case: randomUUID(), capability: randomUUID(), disposition: 'open', remainingMs: 600000, revision: 1 };
const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'hh-operator-cases-')); folders.push(folder);
  let now = 1000, cells = 'Choose a theme. Press Enter.';
  const options = { file: join(folder, 'cases.json'), now: () => now, capture: () => Promise.resolve({ cols: 80, rows: 24, cells }), lane: <T>(run: () => Promise<T>) => run(), secrets: () => ['private-token-123'] };
  const control = new OperatorControl(options); control.openCase(opened);
  return { control, options, folder, at: (value: number) => { now = 1000 + value; }, cells: (value: string) => { cells = value; } };
}

const line = () => 'text' as const;

describe('the cases the server opened', () => {
  const retention = 24 * 60 * 60 * 1000;

  it('never reopens a revoked case, with a higher revision or a late open', () => {
    const c = fixture();
    expect(c.control.openCase({ ...opened, disposition: 'revoke', remainingMs: 0, revision: 2 })).toBe(true);
    expect(c.control.openCase({ ...opened, revision: 3 })).toBe(true);
    expect(c.control.openCase(opened)).toBe(false);
    const state = JSON.parse(readFileSync(c.options.file, 'utf8')) as { cases: Record<string, { revoked: boolean; revision: number }> };
    expect(state.cases[opened.case]).toMatchObject({ revoked: true, revision: 3 });
  });

  it('cannot extend the ten minute deadline of a case', () => {
    const c = fixture();
    c.at(599999);
    c.control.openCase({ ...opened, revision: 2 });
    const state = JSON.parse(readFileSync(c.options.file, 'utf8')) as { cases: Record<string, { deadline: number }> };
    expect(state.cases[opened.case]!.deadline).toBe(601000);
  });

  it('prunes expired histories so a new case can open, and durably rejects delayed opens', () => {
    const c = fixture();
    const state = JSON.parse(readFileSync(c.options.file, 'utf8')) as { cases: Record<string, object> };
    const oldCase = state.cases[opened.case]!;
    for (let index = 0; index < 4096; index++) state.cases[`30000000-0000-4000-8000-${String(index).padStart(12, '0')}`] = { ...oldCase };
    writeFileSync(c.options.file, JSON.stringify(state));
    c.at(retention + 600000);
    const control = new OperatorControl(c.options);
    expect(control.openCase({ ...opened, case: randomUUID(), capability: randomUUID() })).toBe(true);
    const pruned = JSON.parse(readFileSync(c.options.file, 'utf8')) as { cases: Record<string, unknown>; retired: Record<string, unknown> };
    expect(Object.keys(pruned.cases)).toHaveLength(1);
    expect(pruned.retired[opened.case]).toMatchObject({ instance: identity.instance, revision: 1, deadline: 601000 });
    expect(new OperatorControl(c.options).openCase({ ...opened, revision: 1000 })).toBe(false);
  });
});

describe('operator pane control strings', () => {
  it.each(['\x1b]52;c;', '\x1bP', '\x1b_', '\x1b^', '\x1bX', '\x9d52;c;', '\x90', '\x9f', '\x9e', '\x98'])('withholds unterminated control-string payload following %j', prefix => {
    expect(operatorCells(`Visible${prefix}private payload`, [])).toBe('Visible');
  });

  it.each(['\x1bP', '\x1b_', '\x1b^', '\x1bX', '\x90', '\x9f', '\x9e', '\x98'])('strips terminated control strings following %j and preserves SGR', prefix => {
    expect(operatorCells(`\x1b[31mVisible${prefix}private payload\x1b\\ after\x1b[0m`, [])).toBe('\x1b[31mVisible after\x1b[0m');
  });

  it('strips C1 OSC and CSI payloads and unfinished escape sequences', () => {
    expect(operatorCells('Visible\x9d52;c;private\x9c after\x9b2J end\x1b[12;', [])).toBe('Visible after end');
  });

  it('masks known secrets and strips OSC clipboard and link operations', () => {
    const cells = operatorCells('Token private-token-123\n\x1b]52;c;dG9rZW4=\x07Safe text\x1b]8;;https://example.invalid\x07link\x1b]8;;\x07', ['private-token-123']);
    expect(cells).toBe('Token [hidden]\nSafe textlink');
  });

  it('masks a secret split by terminal styles', () => {
    const cells = operatorCells('Token private-\x1b[31mtoken\x1b[0m-123', ['private-token-123']);
    expect(cells).toBe('Token [hidden]');
  });
});

describe('operator secrets spanning terminal rows', () => {
  it.each([
    'private-\ntoken-123',
    'private-\r\ntoken-123',
    'private-\x1b[31mto\x1b[0m\nken-123',
    'cHJpdmF0ZS10\nb2tlbi0xMjM=',
  ])('masks the complete known secret form before forwarding %j', cells => {
    expect(operatorCells(`before ${cells} after`, ['private-token-123'])).toBe('before [hidden] after');
  });
});

describe('the look at a screen before telling of a turn', () => {
  it('gives the input line and the styled screen', async () => {
    const c = fixture();
    const control = new OperatorControl({ ...c.options, capture: async () => ({ cols: 90, rows: 30, cells: '\x1b[1mWords\x1b[0m in the input.' }) });
    expect(await control.check(line)).toEqual({ input: 'text', screen: { cols: 90, rows: 30, cells: '\x1b[1mWords\x1b[0m in the input.' } });
  });

  it('reads the line from the raw cells, and masks only the values of secrets in what it shows', async () => {
    const c = fixture();
    const secret = 'a-secret-of-this-node';
    const seen: string[] = [];
    const control = new OperatorControl({ ...c.options, secrets: () => [secret], capture: async () => ({ cols: 80, rows: 24, cells: `Screen ${secret} end` }) });
    const check = await control.check(cells => { seen.push(cells); return 'text'; });
    expect(seen).toEqual([`Screen ${secret} end`]);
    expect(check).toEqual({ input: 'text', screen: { cols: 80, rows: 24, cells: 'Screen [hidden] end' } });
  });

  it('shows a screen of sign-in, terms or payment as the program shows it', async () => {
    const c = fixture();
    for (const cells of ['Enter your password here.', 'Terms and conditions: accept?', 'Оплата и смена тарифа']) {
      c.cells(cells);
      expect(await c.control.check(line)).toEqual({ input: 'text', screen: { cols: 80, rows: 24, cells } });
    }
  });

  it('has an unknown line and no screen when it cannot capture', async () => {
    const c = fixture();
    const control = new OperatorControl({ ...c.options, capture: async () => { throw new Error('tmux is gone'); } });
    expect(await control.check(line)).toEqual({ input: 'unknown', screen: null });
  });

  it('has an unknown line and no screen when the raw pane is out of bounds, before anything is stripped', async () => {
    const c = fixture();
    c.cells('x'.repeat(OPERATOR_CELLS_BYTES + 1));
    expect(await c.control.check(line)).toEqual({ input: 'unknown', screen: null });
    c.cells(`Sign in\x1b]52;c;${'x'.repeat(65536)}`);
    expect(await c.control.check(line)).toEqual({ input: 'unknown', screen: null });
  });
});
