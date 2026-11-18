import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { Agent as HttpAgent, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bridge } from '../src/terminal/bridge.js';
import { TerminalHost } from '../src/terminal/host.js';
import { fromAgent, type Peer } from '../src/terminal/peer.js';
import type { TermProgram } from '../src/terminal/programs.js';
import { agyProgram } from '../src/providers/antigravity-terminal.js';
import { claudeProgram } from '../src/providers/claude-terminal.js';
import { codexProgram } from '../src/providers/codex-terminal.js';
import { real } from './real-screens.js';
import { Tmux } from '../src/terminal/tmux.js';

const sample = JSON.parse(readFileSync(new URL('./fixtures/hook-owner-reparented.json', import.meta.url), 'utf8')) as {
  inode: string; holder: number; panes: Record<string, number[]>; stats: string[];
};
const tmuxError = JSON.parse(readFileSync(new URL('./fixtures/hook-owner-tmux-error.json', import.meta.url), 'utf8')) as { command: string[]; stderr: string; recoveredStdout: string };
const stops: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); vi.restoreAllMocks(); });

function procSample(holder = sample.holder) {
  const proc = mkdtempSync(join(tmpdir(), 'hh-hook-owner-'));
  stops.push(() => rmSync(proc, { recursive: true, force: true }));
  for (const stat of sample.stats) {
    const pid = stat.split(' ')[0]!;
    mkdirSync(join(proc, pid, 'fd'), { recursive: true });
    writeFileSync(join(proc, pid, 'stat'), stat);
  }
  symlinkSync(`socket:[${sample.inode}]`, join(proc, String(holder), 'fd', '7'));
  return proc;
}
const peer = (pid?: number): Peer => ({ port: 41001, bridgePort: 35001, acceptedInode: sample.inode, ...(pid === undefined ? {} : { pid }) });

describe('hook ownership after reparenting to init', () => {
  it.each([undefined, 112])('accepts the real socket holder in its pane session, with pid hint %s', async pid => {
    const owns = fromAgent(async key => sample.panes[key] ?? [], procSample());
    expect(await owns('own', peer(pid))).toBe(true);
  });

  it.each([212, 300, 400])('rejects foreign socket holder %s even with the target address', async pid => {
    const owns = fromAgent(async key => sample.panes[key] ?? [], procSample(pid));
    expect(await owns('own', peer(pid))).toBe(false);
    expect(await owns('own', peer())).toBe(false);
    expect(await owns('own', peer(112))).toBe(false);
  });

  it.each(['end', 'status'])('delivers the reparented program %s hook', async event => {
    const heard: string[] = [];
    const bridge = new Bridge('http://127.0.0.1:9', (_key, got) => { heard.push(got); }, fromAgent(async () => [100], procSample()), { capture: async () => ({ acceptedInode: sample.inode }) });
    await bridge.start(); stops.push(() => bridge.stop());
    const res = await fetch(`${bridge.agent('own').hookUrl}/${event}`, { method: 'POST', headers: { 'x-hh-pid': '112' }, body: '{}' });
    expect(res.status).toBe(200);
    expect(heard).toEqual([event]);
  });
});

it('returns a retryable error on tmux failure and rechecks the same connection after recovery', async () => {
  const tmux = new Tmux({ env: { HOME: tmpdir() } });
  const run = vi.spyOn(tmux, 'run').mockRejectedValueOnce(new Error(tmuxError.stderr)).mockRejectedValueOnce(new Error(tmuxError.stderr)).mockResolvedValue(tmuxError.recoveredStdout);
  vi.spyOn(tmux, 'stopAll').mockResolvedValue();
  const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: () => {}, secrets: () => [] });
  stops.push(() => host.stop());
  const heard: string[] = [];
  const bridge = new Bridge('http://127.0.0.1:9', (_key, event) => { heard.push(event); }, fromAgent(key => host['panes'](key), procSample()), { capture: async () => ({ acceptedInode: sample.inode }) });
  await bridge.start(); stops.push(() => bridge.stop());
  const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
  stops.push(() => agent.destroy());
  const sockets = new Set<unknown>();
  bridge['server']!.on('connection', socket => sockets.add(socket));
  const post = () => new Promise<number>(resolve => {
    const req = request(`${bridge.agent('own').hookUrl}/end`, { method: 'POST', agent, headers: { 'x-hh-pid': '112', 'x-hh-call': 'same-end' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
    req.end('{}');
  });
  expect(await post()).toBe(502);
  expect(heard).toEqual([]);
  expect(await post()).toBe(200);
  expect(heard).toEqual(['end']);
  expect(sockets.size).toBe(1);
  expect(run.mock.calls[0]![0]).toEqual(tmuxError.command);
});

it('repeats one failed tmux lookup for a status hook instead of requiring a client retry', async () => {
  const tmux = new Tmux({ env: { HOME: tmpdir() } });
  vi.spyOn(tmux, 'run').mockRejectedValueOnce(new Error(tmuxError.stderr)).mockResolvedValue(tmuxError.recoveredStdout);
  vi.spyOn(tmux, 'stopAll').mockResolvedValue();
  const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: () => {}, secrets: () => [] });
  stops.push(() => host.stop());
  const heard: string[] = [];
  const bridge = new Bridge('http://127.0.0.1:9', (_key, event) => { heard.push(event); }, fromAgent(key => host['panes'](key), procSample()), { capture: async () => ({ acceptedInode: sample.inode }) });
  await bridge.start(); stops.push(() => bridge.stop());
  const res = await fetch(`${bridge.agent('own').hookUrl}/status`, { method: 'POST', headers: { 'x-hh-pid': '112' }, body: '{}' });
  expect(res.status).toBe(200);
  expect(heard).toEqual(['status']);
});

describe('screen evidence independent of a lost end hook', () => {
  const idle = '● Done.\n✻ Worked for 4s · done 10:47 AM\n────────────────────\n❯ \n────────────────────\n  ⏵⏵ bypass permissions on';
  async function facts(screen: string, pending = false, program: TermProgram = claudeProgram) {
    const home = mkdtempSync(join(tmpdir(), 'hh-screen-idle-'));
    stops.push(() => rmSync(home, { recursive: true, force: true }));
    const tmux = new Tmux({ env: { HOME: home } });
    vi.spyOn(tmux, 'alive').mockResolvedValue(true);
    vi.spyOn(tmux, 'screen').mockResolvedValue(screen);
    vi.spyOn(tmux, 'stopAll').mockResolvedValue();
    const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: () => {}, secrets: () => [], operator: { dir: join(home, 'operator'), send: () => true, connected: () => true } });
    stops.push(() => host.stop());
    const a = host['agent']('own');
    a.program = program; a.instance = 'program-1'; a.busy = true; a.took = true;
    if (pending) a.calls.set('pending', { name: 'Bash', at: 0 });
    return host['programFacts']('own');
  }

  it('reports a completed empty screen idle while the rejected end leaves busy set', async () => {
    expect(await facts(idle)).toMatchObject({ working: false, input: 'empty' });
  });

  it.each([
    idle.replace('✻ Worked for 4s · done 10:47 AM', '✻ Recombobulating… (4s · ↓ 691 tokens)'),
    idle.replace('❯ ', '❯ draft'),
    idle.replace('✻ Worked for 4s · done 10:47 AM', '✻ Worked for 4s · done 10:47 AM\n❯ New task\nWorking.'),
    readFileSync(new URL('./fixtures/claude-busy-screen.txt', import.meta.url), 'utf8'),
  ])('keeps work or uncertain input working', async screen => {
    expect(await facts(screen)).toMatchObject({ working: true });
  });

  it.each([
    ['codex', codexProgram, real('codex-0.166.0-long-session')],
    ['antigravity', agyProgram, readFileSync(new URL('./fixtures/agy-tui/screen-done.ansi', import.meta.url), 'utf8')],
  ] as const)('reports completed %s idle independently, while a pending tool still prevents completion', async (_kind, program, screen) => {
    expect(await facts(screen, false, program)).toMatchObject({ working: false, input: 'empty' });
    expect(await facts(screen, true, program)).toMatchObject({ working: true, tool: 'Bash' });
  });

  it('keeps a pending tool working even at a completed empty screen', async () => {
    expect(await facts(idle, true)).toMatchObject({ working: true, tool: 'Bash' });
  });
});
