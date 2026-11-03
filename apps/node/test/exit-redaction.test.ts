import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseServerMessage, type NodeMessage, type ServerMessage } from '@hornhoof/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adapterFor } from '../src/providers/index.js';
import { runJob, type ProviderAdapter } from '../src/runner.js';
import { TerminalHost } from '../src/terminal/host.js';
import { claudeProgram, codexProgram, kimiProgram } from '../src/terminal/programs.js';
import { Tmux } from '../src/terminal/tmux.js';

const CLI = String.raw`
const dump = () => {
  const lines = Array.from({ length: 49 }, (_, i) => 'ordinary-' + i);
  process.stderr.write(process.env.FAKE_ERROR_SECRET + '\n' + lines.join('\n') + '\n', () => process.exit(3));
};
async function main() {
  if (process.env.FAKE_BOUNDARY_MODE !== 'typed') return dump();
  const session_id = process.argv[process.argv.indexOf('--session-id') + 1];
  const hook = (event, body) => fetch(process.env.HH_BRIDGE + '/' + event, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id, ...body }),
  });
  process.stdin.setRawMode(true);
  process.stdin.resume();
  await hook('start', {});
  let taken = false;
  process.stdin.on('data', async data => {
    if (taken || !/[\r\n]/.test(data.toString())) return;
    taken = true;
    setTimeout(dump, 100);
    await hook('prompt', { prompt: 'typed request' });
  });
}
main().catch(() => process.exit(4));
`;

const programs = { claude: claudeProgram, codex: codexProgram, kimi: kimiProgram };
const cases = (['claude', 'codex', 'kimi'] as const).flatMap(provider => [
  { provider, mode: 'process' as const }, { provider, mode: 'terminal' as const },
]);

async function until(check: () => boolean) {
  for (const end = Date.now() + 8000; Date.now() < end; await new Promise(r => setTimeout(r, 20))) if (check()) return;
  throw new Error('The synthetic terminal did not report its turn.');
}

describe('redaction before the program output line boundary', () => {
  let dir: string;
  let bin: string;
  let secret: string;
  let suffix: string;
  let host: TerminalHost | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hh-exit-boundary-'));
    bin = join(dir, 'cli.cjs');
    mkdirSync(join(dir, 'home'));
    writeFileSync(bin, '#!' + process.execPath + '\n' + CLI, { mode: 0o700 });
    suffix = randomBytes(24).toString('hex');
    secret = randomBytes(24).toString('hex') + '\n' + suffix;
  });

  afterEach(async () => {
    await host?.stop();
    host = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  async function terminal(provider: keyof typeof programs, mode = 'exit', send: (message: NodeMessage) => void = () => {}) {
    const tmux = new Tmux({
      socket: 'hh-boundary-' + process.pid + '-' + randomBytes(4).toString('hex'),
      env: { PATH: process.env.PATH ?? '', HOME: dir, FAKE_ERROR_SECRET: secret, FAKE_BOUNDARY_MODE: mode },
      recordingsDir: join(dir, 'recordings'),
    });
    host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send, secrets: () => [secret], readyMs: 5000, pollMs: 20 });
    await host.start();
    return programs[provider];
  }

  function check(done: Extract<NodeMessage, { type: 'job.done' }>) {
    expect(done.error).toBe('agent_failed');
    expect('programOutput' in done).toBe(false);
    expect(done.exit).toEqual({ code: 3, signal: null });
    expect(done.tail.includes(suffix)).toBe(false);
    expect(done.tail.includes('[hidden]')).toBe(true);
    expect(done.tail.split('\n').filter(line => line.startsWith('ordinary-'))).toHaveLength(49);
    expect(done.tail.split('\n').at(-1)).toMatch(/^Program ended: code 3, signal none, at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(Buffer.byteLength(done.tail)).toBeLessThanOrEqual(4096);
  }

  it.each(cases)('$mode $provider hides the whole known secret before limiting the final job.done.tail', async ({ provider, mode }) => {
    const base = adapterFor(provider, { home: join(dir, 'home'), tools: join(dir, 'tools'), bin });
    const program = mode === 'terminal' ? await terminal(provider) : null;
    const adapter: ProviderAdapter = {
      ...base,
      run: input => program
        ? host!.run({ key: 'boundary', bin, home: join(dir, 'home'), program, signedOut: /not logged in/i, input })
        : base.run({ ...input, env: { ...input.env, FAKE_ERROR_SECRET: secret } }),
    };
    const msg: Extract<ServerMessage, { type: 'job.run' }> = {
      type: 'job.run', jobId: 'boundary', subscriptionId: 'test', provider, prompt: 'boundary',
      sessionId: null, model: null, timeoutMs: 10000, secret, instructions: null, toolToken: null,
      ...(program ? { workspace: { key: 'boundary', repo: null } } : {}),
    };
    const accepted = parseServerMessage(JSON.stringify(msg));
    expect(accepted?.type === 'job.run' && accepted.secret === secret).toBe(true);
    check(await runJob(adapter, msg, dir, { untimed: !!program }));
  });

  it('hides the known multiline secret in a typed terminal turn before its server acknowledgement', async () => {
    const sent: NodeMessage[] = [];
    const program = await terminal('claude', 'typed', message => sent.push(message));
    const workDir = join(dir, 'work');
    mkdirSync(workDir);
    await host!.run({ key: 'typed-boundary', bin, home: join(dir, 'home'), program, signedOut: /not logged in/i,
      input: { prompt: '', sessionId: null, model: null, workDir, secret: null, timeoutMs: 10000, instructions: null, tools: null } });
    await host!.open({ type: 'term.open', termId: 'boundary-view', agentKey: 'typed-boundary', cols: 100, rows: 30, write: true });
    const beforeExit = sent.length;
    host!.input({ type: 'term.input', termId: 'boundary-view', data: 'typed request\r' });
    await until(() => sent.some(message => message.type === 'turn.open'));
    const opened = sent.find((message): message is Extract<NodeMessage, { type: 'turn.open' }> => message.type === 'turn.open')!;
    await until(() => sent.slice(beforeExit).some(message => message.type === 'term.program'));
    host!.opened({ type: 'turn.opened', agentKey: opened.agentKey, jobId: 'typed-result', toolToken: randomBytes(24).toString('hex'), ref: opened.ref });
    await until(() => sent.some(message => message.type === 'job.done'));
    const done = sent.find((message): message is Extract<NodeMessage, { type: 'job.done' }> => message.type === 'job.done')!;
    check(done);
  });
});
