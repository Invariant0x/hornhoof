import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Tmux } from '../src/terminal/tmux.js';

const hasTmux = (() => {
  try { execFileSync('tmux', ['-V']); return true; } catch { return false; }
})();
const mouse = '\x1b[?1000h\x1b[?1006h';
const alternate = '\x1b[?1049h';
const wheelUp = '\x1b[<64;5;5M';
const states = [
  { name: 'normal', start: '', flags: '0|0|0' },
  { name: 'application mouse', start: mouse, flags: '0|0|1' },
  { name: 'alternate screen', start: alternate, flags: '1|0|0' },
  { name: 'alternate screen with application mouse', start: alternate + mouse, flags: '1|0|1' },
];
const program = `
  const { appendFileSync } = require('node:fs');
  process.stdin.setRawMode(true);
  process.stdout.write(process.argv[2]);
  process.stdout.write(Array.from({ length: 120 }, (_, i) => 'LINE-' + i + '\\r\\n').join('') + 'wheel-ready');
  process.stdin.on('data', chunk => appendFileSync(process.argv[1], chunk));
`;
type Fixture = { dir: string; input: string; tmux: Tmux; client: ReturnType<Tmux['attach']> | null };
const field = async (tmux: Tmux, format: string) => (await tmux.run(['display-message', '-p', '-t', 'agent', format])).trim();
const poll = { timeout: 5000, interval: 25 };

describe.skipIf(!hasTmux)('terminal wheel bindings', () => {
  const fixtures: Fixture[] = [];

  async function fixture(start = ''): Promise<Fixture> {
    const dir = mkdtempSync(join(tmpdir(), 'hh-wheel-'));
    const input = join(dir, 'input');
    writeFileSync(input, '');
    const tmux = new Tmux({ socket: `hh-wheel-${process.pid}-${fixtures.length}`, env: { PATH: process.env.PATH ?? '', HOME: dir } });
    const value: Fixture = { dir, input, tmux, client: null };
    fixtures.push(value);
    await tmux.launch('agent', { cwd: dir, cols: 80, rows: 24, command: [process.execPath, '-e', program, input, start] });
    await expect.poll(async () => (await tmux.screen('agent')).includes('wheel-ready'), poll).toBe(true);
    expect(await tmux.programPid('agent')).toBeGreaterThan(0);
    return value;
  }

  async function attach(value: Fixture) {
    const client = value.tmux.attach('agent', 80, 24, true);
    value.client = client;
    let output = '';
    client.stdout.on('data', chunk => { output += chunk.toString(); });
    client.stderr.resume();
    await expect.poll(async () => (await value.tmux.clients()).length, poll).toBe(1);
    await expect.poll(() => output.includes('wheel-ready'), poll).toBe(true);
    return client;
  }

  async function stop(value: Fixture) {
    value.client?.kill();
    await value.tmux.stopAll();
    rmSync(value.dir, { recursive: true, force: true });
  }
  afterEach(async () => {
    for (const value of fixtures.splice(0)) await stop(value);
  });

  it('evaluates the installed condition as OR for all eight combinations of pane flags', async () => {
    const { tmux } = await fixture();
    const binding = await tmux.run(['list-keys', '-T', 'root', 'WheelUpPane']);
    const condition = binding.match(/#\{\|\|:[^\s"']+/)?.[0] ?? '';
    const results = [];
    for (const [alternate, copy, mouse] of [[0, 0, 0], [0, 0, 1], [0, 1, 0], [0, 1, 1], [1, 0, 0], [1, 0, 1], [1, 1, 0], [1, 1, 1]]) {
      const expanded = condition.replaceAll('#{alternate_on}', String(alternate)).replaceAll('#{pane_in_mode}', String(copy)).replaceAll('#{mouse_any_flag}', String(mouse));
      results.push(await field(tmux, expanded));
    }
    expect(results).toEqual(['0', '1', '1', '1', '1', '1', '1', '1']);
  });

  it('enters copy mode and scrolls normal history when the application does not handle the mouse', async () => {
    const value = await fixture();
    expect(await field(value.tmux, '#{alternate_on}|#{pane_in_mode}|#{mouse_any_flag}')).toBe('0|0|0');
    expect(Number(await field(value.tmux, '#{history_size}'))).toBeGreaterThan(0);
    const client = await attach(value);
    client.stdin.write(wheelUp);
    await expect.poll(() => field(value.tmux, '#{pane_in_mode}'), poll).toBe('1');
    client.stdin.write(wheelUp);
    await expect.poll(async () => Number(await field(value.tmux, '#{scroll_position}')), poll).toBeGreaterThan(0);
    expect(readFileSync(value.input, 'utf8')).toBe('');
  });

  it.each([states[1]!, states[3]!])('forwards wheel events to the $name application', async ({ start, flags }) => {
    const value = await fixture(start);
    expect(await field(value.tmux, '#{alternate_on}|#{pane_in_mode}|#{mouse_any_flag}')).toBe(flags);
    const client = await attach(value);
    client.stdin.write(wheelUp + 'Z');
    await expect.poll(() => readFileSync(value.input, 'utf8').includes('Z'), poll).toBe(true);
    expect(readFileSync(value.input, 'utf8')).toContain(wheelUp);
    expect(await field(value.tmux, '#{pane_in_mode}')).toBe('0');
  });

  it('keeps alternate screen input with the application when its mouse mode is off', async () => {
    const value = await fixture(alternate);
    expect(await field(value.tmux, '#{alternate_on}|#{pane_in_mode}|#{mouse_any_flag}')).toBe('1|0|0');
    const client = await attach(value);
    client.stdin.write(wheelUp + 'Z');
    await expect.poll(() => readFileSync(value.input, 'utf8').includes('Z'), poll).toBe(true);
    expect(await field(value.tmux, '#{pane_in_mode}')).toBe('0');
  });

  it.each([states[0]!, states[1]!])('scrolls an existing copy mode without forwarding to the $name application', async ({ start }) => {
    const value = await fixture(start);
    const client = await attach(value);
    await value.tmux.run(['copy-mode', '-t', 'agent']);
    expect(await field(value.tmux, '#{pane_in_mode}')).toBe('1');
    const before = Number(await field(value.tmux, '#{scroll_position}'));
    client.stdin.write(wheelUp);
    await expect.poll(async () => Number(await field(value.tmux, '#{scroll_position}')), poll).toBeGreaterThan(before);
    expect(await field(value.tmux, '#{pane_in_mode}')).toBe('1');
    expect(readFileSync(value.input, 'utf8')).toBe('');
  });

  it.each([states[2]!, states[3]!])('keeps input in copy mode on the $name without scrollback', async ({ start }) => {
    const value = await fixture(start);
    const client = await attach(value);
    await value.tmux.run(['copy-mode', '-t', 'agent']);
    expect(await field(value.tmux, '#{pane_in_mode}')).toBe('1');
    expect(await field(value.tmux, '#{history_size}')).toBe('0');
    client.stdin.write(wheelUp + 'q');
    await expect.poll(() => field(value.tmux, '#{pane_in_mode}'), poll).toBe('0');
    expect(readFileSync(value.input, 'utf8')).toBe('');
  });
});
