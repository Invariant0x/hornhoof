import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNodeMessage, type NodeMessage, type ServerMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runNode } from '../src/main.js';
import type { ProviderAdapter } from '../src/runner.js';
import { writeState } from '../src/state.js';
import { Bridge } from '../src/terminal/bridge.js';
import { kimiProgram } from '../src/terminal/programs.js';
import { Tmux } from '../src/terminal/tmux.js';
import { SCREEN_SIGNED_OUT } from '../src/providers/kimi.js';
import { withProgramExit } from '../src/program-exit.js';

const channel = vi.hoisted(() => ({ receive: null as ((message: ServerMessage) => void) | null, sent: [] as NodeMessage[] }));
vi.mock('../src/connection.js', () => ({
  connect(options: { onMessage(message: ServerMessage): void; onOpen(send: (message: NodeMessage) => boolean): void }) {
    channel.receive = options.onMessage;
    options.onOpen(message => { channel.sent.push(message); return true; });
    return { close() {} };
  },
}));

const CANARIES = ['synthetic-node-key-0123456789', 'synthetic-job-key-0123456789', 'synthetic-job-token-0123456789'];
const JOB = '00000000-0000-4000-8000-000000000074';
const AGENT = '00000000-0000-4000-8000-000000000075';
const cleanups: { stop(): void; root: string }[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup.stop();
    await vi.advanceTimersByTimeAsync(100);
    rmSync(cleanup.root, { recursive: true, force: true });
  }
  channel.receive = null; channel.sent.length = 0;
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('phase evidence through the existing node diagnostic path', () => {
  it.each(['screen', 'recording'] as const)('keeps the %s final boundary and delivers correlated phase evidence', async mode => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval'] });
    vi.setSystemTime(Date.UTC(2026, 10, 1));
    const root = mkdtempSync(join(tmpdir(), 'hh-phase-node-'));
    const home = join(root, 'synthetic-home'); mkdirSync(home);
    writeState(root, { server: 'http://127.0.0.1:9', subscriptionId: 'synthetic', provider: 'kimi', key: CANARIES[0]! });
    const ending = 'Program ended (status 3, signal unknown, time 2026-11-01T00:00:00.000Z).';
    const final400 = 'z'.repeat(400 - ending.length - 1) + '\n' + ending;
    const screen = (`untrusted old screen ${CANARIES.join(' ')}\n`).repeat(400) + final400;
    const tmux = new Tmux({ socket: 'isolated-main-phase-stub', env: { PATH: 'fixture-only' } });
    /* Phase delivery uses a synthetic program, with no capture writer or CLI. */
    vi.spyOn(tmux, 'launch').mockResolvedValue();
    const exit = withProgramExit(screen, { code: 3, signal: null, at: '2026-11-01T00:00:00.000Z' }, false);
    vi.spyOn(tmux, 'exitSnapshot').mockResolvedValue(mode === 'recording' ? { ...exit, complete: false } : null);
    vi.spyOn(tmux, 'run').mockImplementation(async args => {
      if (args[0] === 'display-message') return '0\n';
      if (args[0] === 'capture-pane') return screen;
      return '';
    });
    vi.spyOn(Bridge.prototype, 'start').mockResolvedValue();
    const fetch = vi.fn(() => Promise.reject(new Error('Unexpected network call.')));
    vi.stubGlobal('fetch', fetch);
    const fallback = vi.fn(() => Promise.reject(new Error('Unexpected nonterminal adapter.')));
    const adapter: ProviderAdapter = { install: async () => {}, loggedIn: async () => true, login: async () => {}, secrets: async () => [...CANARIES], run: fallback };
    const node = await runNode({ dir: root, adapter, terminal: { tmux, program: kimiProgram, bin: '/fixture/kimi', home, signedOut: SCREEN_SIGNED_OUT }, log: () => {} });
    cleanups.push({ root, stop: node.stop });
    if (!channel.receive) throw new Error('Expected the isolated connection callback.');
    channel.receive({ type: 'job.run', jobId: JOB, provider: 'kimi', subscriptionId: 'synthetic', prompt: 'synthetic prompt', sessionId: null, model: null, timeoutMs: 7_200_000, secret: CANARIES[1]!, instructions: null, toolToken: CANARIES[2]!, workspace: { key: AGENT, repo: null } });
    const completed = () => channel.sent.find(message => message.type === 'job.done');
    for (let tick = 0; tick < 260 && !completed(); tick++) await vi.advanceTimersByTimeAsync(500);
    const done = completed();
    if (!done || done.type !== 'job.done') throw new Error('Expected a completed synthetic job.');
    expect(done).toMatchObject({ jobId: JOB, ok: false, error: 'agent_failed' });
    if (mode === 'screen') {
      expect(done.tail.endsWith(ending)).toBe(true);
      expect(done.tail.slice(-400)).toBe(final400);
      expect(done.tail).not.toContain('hh-terminal-phase-v1');
    } else {
      const footer = done.tail.slice(-400);
      expect(footer).toContain('hh-terminal-phase-v1');
      expect(footer).toContain('phase=ready finish=ready_deadline');
      expect(footer).toContain('Output capture did not finish before the wait expired.');
      expect(footer.endsWith('Program ended: code 3, signal none, at 2026-11-01T00:00:00.000Z')).toBe(true);
      expect(footer.indexOf('hh-terminal-phase-v1')).toBeLessThan(footer.indexOf('Output capture'));
    }
    expect(Buffer.byteLength(done.tail)).toBeLessThanOrEqual(4096);
    const diagnostic = channel.sent.find(message => message.type === 'job.event' && message.event.kind === 'tool_result' && message.event.summary.includes('hh-terminal-phase-v1'));
    expect(diagnostic).toMatchObject({ type: 'job.event', jobId: JOB, event: { kind: 'tool_result', ok: false, summary: expect.stringContaining('phase=ready') } });
    expect(channel.sent.indexOf(diagnostic!)).toBeLessThan(channel.sent.indexOf(done));
    expect(channel.sent.every(message => parseNodeMessage(JSON.stringify(message)) !== null)).toBe(true);
    const records = readdirSync(join(root, 'terminal-phase')).filter(name => name.endsWith('.json')).sort().map(name => readFileSync(join(root, 'terminal-phase', name), 'utf8'));
    expect(JSON.parse(records.at(-1)!)).toMatchObject({ jobId: JOB, phase: 'ready', finish: 'ready_deadline', pane: { queryOk: true, paneDead: false }, waits: { ready: { budgetMs: 120_000, result: 'deadline' } } });
    for (const canary of CANARIES) expect(JSON.stringify(channel.sent) + records.join('')).not.toContain(canary);
    expect(fetch).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
    const evidence = process.env.HH_PHASE_TEST_EVIDENCE ? join(process.env.HH_PHASE_TEST_EVIDENCE, mode) : undefined;
    if (evidence) {
      mkdirSync(evidence, { recursive: true, mode: 0o700 });
      const files: Record<string, string> = { 'synthetic-record.json': records.at(-1)!, 'synthetic-delivery.json': JSON.stringify({ diagnostic, done, diagnosticBeforeDone: true, protocolAccepted: true, networkCalls: 0, fallbackCalls: 0 }, null, 2) + '\n' };
      records.forEach((bytes, i) => { files[`synthetic-chain-${String(i + 1).padStart(4, '0')}.json`] = bytes; });
      const hashes: Record<string, string> = {};
      for (const [name, bytes] of Object.entries(files)) {
        writeFileSync(join(evidence, name), bytes, { mode: 0o600, flag: 'wx' });
        hashes[name] = createHash('sha256').update(bytes).digest('hex');
      }
      writeFileSync(join(evidence, 'SHA256.json'), JSON.stringify(hashes, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    }
  });
});
