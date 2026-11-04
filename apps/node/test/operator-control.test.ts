import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperatorServerMessage } from '@hornhoof/protocol/program-operator';
import { afterEach, describe, expect, it } from 'vitest';
import { OperatorControl, type OperatorProgram } from '../src/terminal/operator-control.js';
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
  const keyCommand = (snapshot: string, generation = 1) => ({ type: 'program.key_send' as const, ...identity, case: opened.case, capability: opened.capability, snapshot, generation, action: randomUUID(), key: 'Enter' as const });
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

  it('keeps an observation-only incident read-only even at a harmless input wait', async () => {
    const c = fixture(); c.program.wait = { id: 'question-1', kind: 'harmless' };
    c.control.openCase({ ...opened, revision: 2, readOnly: true });
    const screen = await c.control.screen(c.screenCommand);
    expect(screen.keysAllowed).toBe(false);
    expect(await c.control.key(c.keyCommand(screen.snapshot!))).toMatchObject({ result: 'refused', reason: 'operator_forbidden' });
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

  it.each(['Terms and conditions: accept?', 'Share telemetry data?', 'Sign in with a password', 'Payment and billing', 'Согласие на передачу данных', 'Введите пароль', 'Оплата и смена тарифа'])('protects sensitive screens: %s', async text => {
    const c = fixture(); c.cells(text);
    const screen = await c.control.screen(c.screenCommand);
    expect(screen).toMatchObject({ protected: true, keysAllowed: false });
    expect(await c.control.key(c.keyCommand(screen.snapshot!))).toMatchObject({ result: 'refused', reason: 'protected_screen' });
    expect(c.pressed).toEqual([]);
  });

  it('does not treat an unknown or permission event as a harmless asking state', async () => {
    const c = fixture(); c.program.wait = { id: 'permission-1', kind: 'permission' };
    const screen = await c.control.screen(c.screenCommand);
    expect(screen.keysAllowed).toBe(false);
    expect(await c.control.key(c.keyCommand(screen.snapshot!))).toMatchObject({ result: 'refused', reason: 'protected_screen' });
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
    const command = c.keyCommand(screen.snapshot!);
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
    block = true; const pending = control.key(c.keyCommand(screen.snapshot!)); await waiting;
    c.program.turnStarted = true; c.program.generation++; release();
    expect((await pending).result).toBe('refused'); expect(existsSync(path)).toBe(false);
  });
});
