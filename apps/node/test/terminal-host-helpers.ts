import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent, NodeMessage } from '@hornhoof/protocol';
import { SCREEN_SIGNED_OUT } from '../src/providers/kimi.js';
import { TerminalHost, type TermJob } from '../src/terminal/host.js';
import { claudeProgram, codexProgram, kimiProgram } from '../src/terminal/programs.js';
import { Tmux } from '../src/terminal/tmux.js';

/* What the tests of agents in live terminals share. They wait on real programs in tmux far more than they compute, so
   they sit in several files that run side by side. Each file loads its own copy of this module, with a home of its own,
   and each test starts a tmux server under a name of its own. */

export const FAKE = fileURLToPath(new URL('./fakes/fake-term.mjs', import.meta.url));
export const FAKE_CODEX = fileURLToPath(new URL('./fakes/fake-codex-term.mjs', import.meta.url));
export const FAKE_KIMI = fileURLToPath(new URL('./fakes/fake-kimi-term.mjs', import.meta.url));
export const SECRET = 'sk-fake-0123456789abcdef';

export const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
})();

export const until = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) if (await check()) return;
  throw new Error('timed out');
};

export let host: TerminalHost;
export let tmux: Tmux;
export let sent: NodeMessage[];
export const home = mkdtempSync(join(tmpdir(), 'hh-home-'));

export function setUp(more: Partial<ConstructorParameters<typeof TerminalHost>[0]> = {}, path = process.env.PATH ?? '') {
  sent = [];
  tmux = new Tmux({ socket: `hh-host-${process.pid}-${Math.random().toString(36).slice(2, 8)}`, env: { PATH: path, HOME: home } });
  host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: m => sent.push(m), secrets: () => [SECRET], readyMs: 10_000, pollMs: 100, toolsMs: 300, ...more });
  return host.start();
}

export const job = (key: string, prompt: string, more: Partial<TermJob['input']> = {}): TermJob & { events: AgentEvent[] } => {
  const events: AgentEvent[] = [];
  return {
    key,
    program: claudeProgram,
    bin: FAKE,
    home,
    signedOut: /not logged in/i,
    events,
    input: { prompt, sessionId: null, model: null, workDir: join(home, 'work', key), secret: null, timeoutMs: 20_000, instructions: 'Be brief.', tools: { url: 'http://x/mcp', token: 'tok-turn' }, onEvent: e => events.push(e), env: { FAKE_SECRET: SECRET }, ...more },
  };
};

export const codexJob = (key: string, prompt: string, more: Partial<TermJob['input']> = {}) => ({ ...job(key, prompt, more), program: codexProgram, bin: FAKE_CODEX });
/* Kimi keeps its settings in its home, which these tests give each agent of their own. */
export const kimiJob = (key: string, prompt: string, more: Partial<TermJob['input']> = {}) => ({
  ...job(key, prompt, more),
  program: { ...kimiProgram, limits: async () => ({ status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.3, resetsAt: null }] }) },
  bin: FAKE_KIMI,
  home: join(home, 'kimi', key),
  signedOut: SCREEN_SIGNED_OUT,
});
export const done = (jobId: string) => sent.find(m => m.type === 'job.done' && m.jobId === jobId);
/* Hornhoof answers the nth turn.open the node sent, naming it by its ref. */
export const ack = (key: string, jobId: string, nth = 0) => {
  const asked = sent.filter((m): m is Extract<NodeMessage, { type: 'turn.open' }> => m.type === 'turn.open' && m.agentKey === key)[nth];
  host.opened({ type: 'turn.opened', agentKey: key, jobId, toolToken: `tok-${jobId}`, ref: asked?.ref });
};
/* A person types a line into the agent's terminal, and Hornhoof opens a turn for it. */
export const typeTurn = async (key: string, termId: string, line: string, jobId: string) => {
  await host.open({ type: 'term.open', termId, agentKey: key, cols: 80, rows: 24, write: true });
  host.input({ type: 'term.input', termId, data: `${line}\r` });
  await until(() => sent.some(m => m.type === 'turn.open'));
  ack(key, jobId);
  await until(() => host.typedJobs().includes(jobId) || Boolean(done(jobId)));
};

/* A Hornhoof that answers every tool call, and the tokens they came with. */
export async function withTools(test: (auths: string[]) => Promise<void>) {
  const auths: string[] = [];
  const hornhoof = createServer((req, res) => {
    auths.push(req.headers.authorization ?? '');
    req.resume().on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } })));
  });
  await new Promise<void>(r => hornhoof.listen(0, '127.0.0.1', r));
  try {
    await setUp({ hornhoof: `http://127.0.0.1:${(hornhoof.address() as AddressInfo).port}`, toolsMs: 5000 });
    await test(auths);
  } finally {
    hornhoof.close();
  }
}
