import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { OPERATOR_CELLS_BYTES, OPERATOR_PROTECTED_SCREEN, type OperatorServerMessage } from '@hornhoof/protocol/program-operator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperatorControl, operatorCells, type OperatorProgram } from '../src/terminal/operator-control.js';
import { Tmux } from '../src/terminal/tmux.js';

type Case = Extract<OperatorServerMessage, { type: 'program.operator_case' }>;
const identity = { agentKey: randomUUID(), jobId: randomUUID(), instance: randomUUID() };
const opened: Case = { type: 'program.operator_case', ...identity, case: randomUUID(), capability: randomUUID(), disposition: 'open', remainingMs: 600000, revision: 1 };
const folders: string[] = [];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'hh-operator-guard-')); folders.push(folder);
  let now = 1000, cells = 'Choose a theme. Press Enter.';
  const program: OperatorProgram = { ...identity, generation: 1, agentProgram: true, alive: true, pasted: false, turnStarted: false, active: false, runningTool: false, retrying: false, wait: null };
  const pressed: string[] = [];
  const options = { file: join(folder, 'actions.json'), now: () => now, current: () => ({ ...program }), capture: () => Promise.resolve({ cols: 80, rows: 24, cells }), press: (key: string) => { pressed.push(key); return Promise.resolve(); }, lane: <T>(run: () => Promise<T>) => run(), secrets: () => ['private-token-123'] };
  const control = new OperatorControl(options); control.openCase(opened);
  const screenCommand = { type: 'program.screen_get' as const, ...identity, request: randomUUID(), case: opened.case, capability: opened.capability };
  const keyCommand = (snapshot: string, generation = 1, owner = control) => {
    const input = { ...identity, case: opened.case, capability: opened.capability, snapshot, generation, action: randomUUID(), key: 'Enter' as const };
    const prepared = owner.prepare({ type: 'program.key_prepare', ...input });
    return { type: 'program.key_send' as const, ...input, lease: prepared.lease ?? randomUUID() };
  };
  return { control, options, program, pressed, folder, screenCommand, keyCommand, at: (value: number) => { now = 1000 + value; }, cells: (value: string) => { cells = value; } };
}

describe('operator key capability', () => {
  it('requires a fresh observation for each individual key and keeps duplicate action ids harmless', async () => {
    const c = fixture(); const screen = await c.control.screen(c.screenCommand);
    expect(screen).toMatchObject({ state: 'pre_work', keysAllowed: true, cols: 80, rows: 24 });
    const command = c.keyCommand(screen.snapshot!);
    expect(await c.control.key(command)).toMatchObject({ result: 'applied' });
    expect(await c.control.key(command)).toMatchObject({ result: 'applied' });
    expect(await c.control.key(c.keyCommand(screen.snapshot!))).toMatchObject({ result: 'refused', reason: 'snapshot_stale' });
    expect(c.pressed).toEqual(['Enter']);
  });

  it.each(['pasted', 'turnStarted', 'active', 'runningTool', 'retrying'] as const)('refuses keys when %s even though a menu-like screen is shown', async state => {
    const c = fixture(); c.program[state] = true;
    const screen = await c.control.screen(c.screenCommand);
    expect(screen.keysAllowed).toBe(false);
    expect(await c.control.key(c.keyCommand(screen.snapshot!))).toMatchObject({ result: 'refused', reason: 'program_busy' });
    expect(c.pressed).toEqual([]);
  });

  it('allows only a current authenticated harmless input wait after work began', async () => {
    const c = fixture(); c.program.turnStarted = c.program.active = true;
    c.program.wait = { id: 'question-1', kind: 'harmless' };
    const screen = await c.control.screen(c.screenCommand);
    expect(screen).toMatchObject({ state: 'awaiting_input', keysAllowed: true });
    expect(await c.control.key(c.keyCommand(screen.snapshot!))).toMatchObject({ result: 'applied' });
  });

  it.each(['permission', 'menu'] as const)('allows the current %s question only with its cause-five capability', async kind => {
    const c = fixture();
    const id = randomUUID();
    c.program.turnStarted = c.program.active = c.program.runningTool = true;
    c.program.wait = { id, kind };
    c.cells('Permission request for Bash. Remove the agent temporary folder? Yes / No');
    c.control.openCase({ ...opened, revision: 2, reason: 'question_waiting', questionId: id });
    const screen = await c.control.screen(c.screenCommand);
    expect(screen).toMatchObject({ keysAllowed: true, state: 'awaiting_input', protected: false });
    expect(await c.control.key(c.keyCommand(screen.snapshot!))).toMatchObject({ result: 'applied' });
    expect(c.pressed).toEqual(['Enter']);
  });

  it('refuses a question key after that question stopped being current, including an awaited-capture race', async () => {
    const c = fixture();
    const id = randomUUID();
    c.program.active = c.program.turnStarted = true;
    c.program.wait = { id, kind: 'permission' };
    c.control.openCase({ ...opened, revision: 2, reason: 'question_waiting', questionId: id });
    let continued = false;
    const control = new OperatorControl({ ...c.options, capture: async () => {
      const pane = await c.options.capture();
      if (continued) { c.program.wait = null; c.program.generation++; }
      return pane;
    } });
    const screen = await control.screen(c.screenCommand);
    expect(screen.keysAllowed).toBe(true);
    continued = true;
    expect(await control.key(c.keyCommand(screen.snapshot!, 1, control))).toMatchObject({ result: 'refused' });
    expect(c.pressed).toEqual([]);
  });

  it('leaves a work decision to people even if a question capability names its id', async () => {
    const c = fixture(); const id = randomUUID();
    c.program.wait = { id, kind: 'work' };
    c.control.openCase({ ...opened, revision: 2, reason: 'question_waiting', questionId: id });
    const screen = await c.control.screen(c.screenCommand);
    expect(screen.keysAllowed).toBe(false);
    expect(await c.control.key(c.keyCommand(screen.snapshot!))).toMatchObject({ result: 'refused' });
    expect(c.pressed).toEqual([]);
  });

  it('keeps an observation-only incident read-only even at a harmless input wait', async () => {
    const c = fixture(); c.program.wait = { id: 'question-1', kind: 'harmless' };
    c.control.openCase({ ...opened, revision: 2, readOnly: true });
    const screen = await c.control.screen(c.screenCommand);
    expect(screen.keysAllowed).toBe(false);
    expect(await c.control.key(c.keyCommand(screen.snapshot!))).toMatchObject({ result: 'refused', reason: 'operator_forbidden' });
    expect(c.pressed).toEqual([]);
  });

  it('refuses a key if the case becomes read-only while capture is awaited', async () => {
    const c = fixture();
    let readOnly = false;
    const control = new OperatorControl({ ...c.options, capture: async () => {
      const pane = await c.options.capture();
      if (readOnly) control.openCase({ ...opened, revision: 2, readOnly: true });
      return pane;
    } });
    const screen = await control.screen(c.screenCommand);
    readOnly = true;
    expect(await control.key(c.keyCommand(screen.snapshot!, 1, control))).toMatchObject({ result: 'refused', reason: 'operator_forbidden' });
    expect(c.pressed).toEqual([]);
  });

  it('returns the same refusal and reason when an action is repeated', async () => {
    const c = fixture(); const screen = await c.control.screen(c.screenCommand);
    const command = c.keyCommand(screen.snapshot!, 2);
    const first = await c.control.key(command);
    expect(first).toMatchObject({ result: 'refused', reason: 'snapshot_stale' });
    expect(await c.control.key(command)).toEqual(first);
  });

  it.each(['runningTool', 'retrying'] as const)('does not let an earlier input question override current %s evidence', async state => {
    const c = fixture(); c.program.wait = { id: 'question-1', kind: 'harmless' }; c.program[state] = true;
    const screen = await c.control.screen(c.screenCommand);
    expect(screen.keysAllowed).toBe(false);
    expect(await c.control.key(c.keyCommand(screen.snapshot!))).toMatchObject({ result: 'refused', reason: 'program_busy' });
    expect(c.pressed).toEqual([]);
  });

  it('expires a snapshot at the exact thirty second boundary', async () => {
    const c = fixture(); const screen = await c.control.screen(c.screenCommand); c.at(30000);
    expect(await c.control.key(c.keyCommand(screen.snapshot!))).toMatchObject({ result: 'refused', reason: 'snapshot_stale' });
    expect(c.pressed).toEqual([]);
  });

  it('withholds a protected login code even when it is not a previously known secret', async () => {
    const c = fixture(); c.cells('Sign in using device code 482917');
    const screen = await c.control.screen(c.screenCommand);
    expect(screen).toMatchObject({ protected: true, keysAllowed: false });
    expect(screen.cells).not.toContain('482917');
    expect(screen.cells).toContain('[hidden]');
  });

  it('refuses a key whose short dispatch lease elapsed while it awaited the pane', async () => {
    const c = fixture(); let delayed = false;
    const control = new OperatorControl({ ...c.options, capture: async () => { const pane = await c.options.capture(); if (delayed) c.at(2000); return pane; } });
    const screen = await control.screen(c.screenCommand);
    delayed = true;
    expect(await control.key(c.keyCommand(screen.snapshot!, 1, control))).toMatchObject({ result: 'refused', reason: 'snapshot_stale' });
    expect(c.pressed).toEqual([]);
  });

  it('refuses a key delayed in the network after its node-issued preparation lease expired', async () => {
    const c = fixture(); const screen = await c.control.screen(c.screenCommand);
    const command = c.keyCommand(screen.snapshot!);
    const prepared = c.control.prepare({ ...command, type: 'program.key_prepare' });
    expect(prepared.result).toBe('ok');
    c.at(2000);
    expect(await c.control.key({ ...command, lease: prepared.lease! })).toMatchObject({ result: 'refused', reason: 'snapshot_stale' });
    expect(c.pressed).toEqual([]);
  });

  it.each(['Terms and conditions: accept?', 'Share telemetry data?', 'Sign in with a password', 'Payment and billing', 'Согласие на передачу данных', 'Введите пароль', 'Оплата и смена тарифа'])('protects sensitive screens: %s', async text => {
    const c = fixture(); c.cells(text);
    const screen = await c.control.screen(c.screenCommand);
    expect(screen).toMatchObject({ protected: true, keysAllowed: false });
    expect(await c.control.key(c.keyCommand(screen.snapshot!))).toMatchObject({ result: 'refused', reason: 'protected_screen' });
    expect(c.pressed).toEqual([]);
  });

  it('does not treat an unbound permission event as a cause-five capability', async () => {
    const c = fixture(); c.program.wait = { id: 'permission-1', kind: 'permission' };
    const screen = await c.control.screen(c.screenCommand);
    expect(screen.keysAllowed).toBe(false);
    expect(await c.control.key(c.keyCommand(screen.snapshot!))).toMatchObject({ result: 'refused', reason: 'input_not_proven' });
  });

  it('rejects Escape even if called directly without the transport parser', async () => {
    const c = fixture(); const screen = await c.control.screen(c.screenCommand);
    const result = await c.control.key({ ...c.keyCommand(screen.snapshot!), key: 'Escape' });
    expect(result).toMatchObject({ result: 'refused', reason: 'operator_forbidden' }); expect(c.pressed).toEqual([]);
  });

  it('refuses stale instance, pane, generation, capability and expired snapshots', async () => {
    for (const change of ['instance', 'pane', 'generation', 'capability', 'expired'] as const) {
      const c = fixture(); const screen = await c.control.screen(c.screenCommand);
      const command = c.keyCommand(screen.snapshot!);
      if (change === 'instance') c.program.instance = randomUUID();
      if (change === 'pane') c.cells('A different menu.');
      if (change === 'generation') c.program.generation++;
      if (change === 'capability') command.capability = randomUUID();
      if (change === 'expired') c.at(30001);
      expect((await c.control.key(command)).result).toBe('refused'); expect(c.pressed).toEqual([]);
    }
  });

  it('does not let a late open undo revocation or extend the ten minute case', async () => {
    const c = fixture(); c.control.openCase({ ...opened, disposition: 'revoke', remainingMs: 0, revision: 2 }); c.control.openCase(opened);
    expect(await c.control.screen(c.screenCommand)).toMatchObject({ result: 'refused', reason: 'case_closed' });
    const d = fixture(); d.at(599999); d.control.openCase(opened); d.at(600000);
    expect(await d.control.screen(d.screenCommand)).toMatchObject({ result: 'refused', reason: 'case_closed' });
  });

  it('masks known secrets and strips OSC clipboard/link operations before returning a pane', async () => {
    const c = fixture(); c.cells('Token private-token-123\n\x1b]52;c;dG9rZW4=\x07Safe text\x1b]8;;https://example.invalid\x07link\x1b]8;;\x07');
    const screen = await c.control.screen(c.screenCommand);
    expect(screen.cells).toContain('[hidden]'); expect(screen.cells).not.toContain('private-token');
    expect(screen.cells).not.toContain('\x1b]'); expect(screen.cells).not.toContain('dG9rZW4=');
  });

  it('masks a secret split by terminal styles before it can leave the node', async () => {
    const c = fixture(); c.cells('Token private-\x1b[31mtoken\x1b[0m-123');
    const screen = await c.control.screen(c.screenCommand);
    expect(screen.cells).toContain('[hidden]');
    expect(screen.cells.replace(/\x1b\[[0-9;]*m/g, '')).not.toContain('private-token-123');
    expect(screen.keysAllowed).toBe(false);
  });

  it('persists an unknown outcome after an uncertain write and never retries it after restart', async () => {
    const c = fixture(); const options = { ...c.options, press: async () => { c.pressed.push('Enter'); throw new Error('lost acknowledgement'); } };
    const control = new OperatorControl(options); const screen = await control.screen(c.screenCommand);
    const command = c.keyCommand(screen.snapshot!, 1, control);
    expect(await control.key(command)).toMatchObject({ result: 'unknown', reason: 'action_unknown' });
    const restored = new OperatorControl(options);
    expect(await restored.key(command)).toMatchObject({ result: 'unknown' }); expect(c.pressed).toEqual(['Enter']);
  });

  it('rechecks actual program evidence after an awaited capture before a real tmux key on Linux', async () => {
    const c = fixture(); const path = join(c.folder, 'key-arrived');
    const tmux = new Tmux({ socket: `operator-${randomUUID()}`, env: { PATH: process.env.PATH ?? '', HOME: c.folder } });
    cleanup.push(() => tmux.stopAll());
    await tmux.launch('guard', { cwd: c.folder, command: ['sh', '-c', 'printf "Choose a theme.\\n"; read answer; printf pressed > "$1"; sleep 30', 'fixture', path], cols: 80, rows: 24 });
    let release!: () => void, entered!: () => void, block = false;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const options = { ...c.options, capture: async () => { if (block) { entered(); await barrier; } return { cols: 80, rows: 24, cells: await tmux.screen('guard', 0, true) }; }, press: (key: string) => tmux.keys('guard', key) };
    const control = new OperatorControl(options); const screen = await control.screen(c.screenCommand);
    const command = c.keyCommand(screen.snapshot!, 1, control);
    block = true; const pending = control.key(command); await waiting;
    c.program.turnStarted = true; c.program.generation++; release();
    expect((await pending).result).toBe('refused'); expect(existsSync(path)).toBe(false);
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
});

describe('historical operator capability retention', () => {
  const retention = 24 * 60 * 60 * 1000;

  it('never reopens a revoked case with a higher revision', async () => {
    const c = fixture();
    c.control.openCase({ ...opened, disposition: 'revoke', revision: 2 });
    c.control.openCase({ ...opened, revision: 3 });
    expect(await c.control.screen(c.screenCommand)).toMatchObject({ result: 'refused', reason: 'case_closed' });
  });

  it('prunes expired histories so a valid new case can act, and durably rejects delayed opens', async () => {
    const c = fixture();
    const oldScreen = await c.control.screen(c.screenCommand);
    const oldCommand = c.keyCommand(oldScreen.snapshot!);
    await c.control.key(oldCommand);
    const state = JSON.parse(readFileSync(c.options.file, 'utf8')) as { cases: Record<string, object>; actions: Record<string, object> };
    const oldCase = state.cases[opened.case]!;
    const oldAction = state.actions[oldCommand.action]!;
    for (let index = 0; index < 4096; index++) {
      const id = `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      state.cases[id] = { ...oldCase };
      state.actions[id] = { ...oldAction, case: id };
    }
    writeFileSync(c.options.file, JSON.stringify(state));
    c.at(retention + 600000);
    const control = new OperatorControl(c.options);
    const fresh = { ...opened, case: randomUUID(), capability: randomUUID() };
    expect(control.openCase(fresh)).toBe(true);
    const screenCommand = { ...c.screenCommand, case: fresh.case, capability: fresh.capability };
    const screen = await control.screen(screenCommand);
    const input = { ...c.keyCommand(screen.snapshot!), case: fresh.case, capability: fresh.capability };
    const prepared = control.prepare({ ...input, type: 'program.key_prepare' });
    expect(prepared.result).toBe('ok');
    expect(await control.key({ ...input, lease: prepared.lease! })).toMatchObject({ result: 'applied' });
    const pruned = JSON.parse(readFileSync(c.options.file, 'utf8')) as { cases: Record<string, unknown>; actions: Record<string, unknown>; retired: Record<string, unknown> };
    expect(Object.keys(pruned.cases)).toHaveLength(1);
    expect(Object.keys(pruned.actions)).toHaveLength(1);
    expect(pruned.retired[opened.case]).toMatchObject({ instance: identity.instance, revision: 1, deadline: 601000 });
    const restored = new OperatorControl(c.options);
    expect(restored.openCase({ ...opened, revision: 1000 })).toBe(false);
    expect(await restored.key(oldCommand)).toMatchObject({ result: 'refused', reason: 'case_closed' });
    expect(c.pressed).toEqual(['Enter', 'Enter']);
  });

  it('retains an active uncertain action through pruning and restores requested actions as unknown', async () => {
    const c = fixture();
    const screen = await c.control.screen(c.screenCommand);
    const command = c.keyCommand(screen.snapshot!);
    await c.control.key(command);
    const state = JSON.parse(readFileSync(c.options.file, 'utf8')) as { actions: Record<string, { result: string; reason: string | null }> };
    state.actions[command.action]!.result = 'requested';
    state.actions[command.action]!.reason = null;
    writeFileSync(c.options.file, JSON.stringify(state));
    const restored = new OperatorControl(c.options);
    restored.openCase({ ...opened, case: randomUUID() });
    expect(await restored.key(command)).toMatchObject({ result: 'unknown', reason: 'action_unknown' });
    expect(c.pressed).toEqual(['Enter']);
  });

  it('keeps an in-flight action and its case while capture awaits across the retention boundary', async () => {
    const c = fixture(); let waiting = false;
    const control = new OperatorControl({ ...c.options, capture: async () => {
      if (waiting) {
        c.at(retention + 600000);
        control.openCase({ ...opened, case: randomUUID(), capability: randomUUID() });
      }
      return c.options.capture();
    } });
    const screen = await control.screen(c.screenCommand);
    const command = c.keyCommand(screen.snapshot!);
    waiting = true;
    expect(await control.key(command)).toMatchObject({ result: 'refused', reason: 'case_closed' });
    expect(c.pressed).toEqual([]);
    const state = JSON.parse(readFileSync(c.options.file, 'utf8')) as { cases: Record<string, unknown>; actions: Record<string, { result: string }> };
    expect(state.cases[opened.case]).toBeDefined();
    expect(state.actions[command.action]).toMatchObject({ result: 'refused' });
  });

  it('retains closed history during its retention interval and cannot extend expired deadlines', async () => {
    const c = fixture();
    const screen = await c.control.screen(c.screenCommand);
    const command = c.keyCommand(screen.snapshot!);
    await c.control.key(command);
    c.at(600000);
    const restored = new OperatorControl(c.options);
    restored.openCase({ ...opened, revision: 2 });
    expect(await restored.screen(c.screenCommand)).toMatchObject({ result: 'refused', reason: 'case_closed' });
    expect(await restored.key(command)).toMatchObject({ result: 'applied' });
    expect(c.pressed).toEqual(['Enter']);
  });
});

describe('raw operator pane bounds', () => {
  it('rejects oversized raw control payloads before sanitizing or withholding protected text', async () => {
    const c = fixture();
    c.cells(`Sign in\x1b]52;c;${'x'.repeat(65536)}`);
    expect(await c.control.screen(c.screenCommand)).toMatchObject({ result: 'refused', reason: 'input_not_proven', cells: '' });
  });

  it('rechecks raw pane bounds before pressing a key even if sanitization hides the excess', async () => {
    const c = fixture();
    const screen = await c.control.screen(c.screenCommand);
    c.cells(`Choose a theme. Press Enter.\x1b]52;c;${'x'.repeat(65536)}`);
    expect(await c.control.key(c.keyCommand(screen.snapshot!))).toMatchObject({ result: 'refused', reason: 'input_not_proven' });
    expect(c.pressed).toEqual([]);
  });
});

it('expires the default control key lease after two monotonic seconds despite a backward wall-clock correction', async () => {
  const c = fixture(); let wall = Date.now(), elapsed = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => wall);
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  try {
    const control = new OperatorControl({ ...c.options, file: join(c.folder, 'default-actions.json'), now: undefined });
    control.openCase(opened);
    const screen = await control.screen(c.screenCommand);
    const command = c.keyCommand(screen.snapshot!, 1, control);
    elapsed = 2000; wall -= 60000;
    expect(await control.key(command)).toMatchObject({ result: 'refused', reason: 'snapshot_stale' });
    expect(c.pressed).toEqual([]);
  } finally { vi.restoreAllMocks(); }
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

  it('withholds a pane containing a node-known credential split over rows', async () => {
    const c = fixture(); c.cells('before private-\ntoken-123 after');
    const screen = await c.control.screen(c.screenCommand);
    expect(screen).toMatchObject({ protected: true, keysAllowed: false, reason: 'protected_screen' });
    expect(screen.cells).toContain('[hidden]');
    expect(screen.cells).not.toContain('private-');
    expect(screen.cells).not.toContain('token-123');
  });
});

describe('the look at a screen before telling of a turn', () => {
  const line = () => 'text' as const;

  it('gives the input line and the styled screen, without a snapshot for keys', async () => {
    const c = fixture();
    const control = new OperatorControl({ ...c.options, capture: async () => ({ cols: 90, rows: 30, cells: '\x1b[1mWords\x1b[0m in the input.' }) });
    expect(await control.check(line)).toEqual({ input: 'text', screen: { protected: false, cols: 90, rows: 30, cells: '\x1b[1mWords\x1b[0m in the input.' } });
    expect(control['snapshot']).toBeNull();
  });

  it('reads the line from the raw cells, and masks what it shows', async () => {
    const c = fixture();
    const secret = 'a-secret-of-this-node';
    const seen: string[] = [];
    const control = new OperatorControl({ ...c.options, secrets: () => [secret], capture: async () => ({ cols: 80, rows: 24, cells: `Screen ${secret} end` }) });
    const check = await control.check(cells => { seen.push(cells); return 'text'; });
    expect(seen).toEqual([`Screen ${secret} end`]);
    expect(check).toEqual({ input: 'text', screen: { protected: true, cols: 80, rows: 24, cells: OPERATOR_PROTECTED_SCREEN } });
  });

  it('shows a protected screen only as protected', async () => {
    const c = fixture();
    const control = new OperatorControl({ ...c.options, capture: async () => ({ cols: 80, rows: 24, cells: 'Enter your password here.' }) });
    expect(await control.check(line)).toEqual({ input: 'text', screen: { protected: true, cols: 80, rows: 24, cells: OPERATOR_PROTECTED_SCREEN } });
  });

  it('has an unknown line and no screen when it cannot capture', async () => {
    const c = fixture();
    const control = new OperatorControl({ ...c.options, capture: async () => { throw new Error('tmux is gone'); } });
    expect(await control.check(line)).toEqual({ input: 'unknown', screen: null });
  });

  it('has an unknown line and no screen when the pane is out of bounds', async () => {
    const c = fixture();
    const control = new OperatorControl({ ...c.options, capture: async () => ({ cols: 80, rows: 24, cells: 'x'.repeat(OPERATOR_CELLS_BYTES + 1) }) });
    expect(await control.check(line)).toEqual({ input: 'unknown', screen: null });
  });
});

