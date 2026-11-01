import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { TermJob } from '../src/terminal/host.js';
import { runJob, type ProviderAdapter } from '../src/runner.js';
import { SECRET, hasTmux, until, host, tmux, sent, home, setUp, job, codexJob, kimiJob, done, ack } from './terminal-host-helpers.js';

describe.skipIf(!hasTmux)('agents in live terminals', () => {
  afterEach(async () => host?.stop());

  describe('exit diagnostics', () => {
    const jobs = { claude: job, codex: codexJob, kimi: kimiJob };
    const kinds = ['claude', 'codex', 'kimi'] as const;
    const runTail = (j: TermJob) => {
      const adapter: ProviderAdapter = {
        install: async () => {}, loggedIn: async () => true, login: async () => {}, secrets: async () => [SECRET],
        run: input => host.run({ ...j, input: { ...input, env: { ...input.env, ...j.input.env } } }),
      };
      const message: Extract<ServerMessage, { type: 'job.run' }> = {
        type: 'job.run', jobId: 'exit-' + j.key, subscriptionId: 'test', provider: j.program.kind,
        prompt: j.input.prompt, sessionId: j.input.sessionId, model: null, timeoutMs: 20000,
        secret: null, instructions: j.input.instructions, toolToken: 'known-turn-token-0123456789', workspace: { key: j.key, repo: null },
      };
      return runJob(adapter, message, home, { toolsUrl: 'http://x/mcp', untimed: true });
    };

    const footer = (tail: string) => {
      const last = tail.split('\n').at(-1)!;
      expect(last).toMatch(/^Program ended: code 3, signal none, at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(last.length).toBeLessThanOrEqual(400);
    };

    it.each(kinds)('%s retains alternate-screen output and the exit code when startup fails', async kind => {
      await setUp();
      const key = 'startup-' + kind;
      const result = await runTail(jobs[kind](key, 'hello', { env: { FAKE_SECRET: SECRET, FAKE_CRASH_START: 'crash' } }));
      expect(result).toMatchObject({ ok: false, error: 'agent_failed' });
      footer(result.tail);
      expect(result.tail.split('\n').slice(0, -1)).toEqual([
        ...Array.from({ length: 49 }, (_, i) => `output ${i + 11}`), 'boom [hidden]',
      ]);
      expect(result.tail).not.toContain(SECRET);
      expect(result.tail).not.toContain('\x1b');
      const epoch = (await tmux.run(['display-message', '-p', '-t', 'a-' + key, '#{pane_dead_time}'])).trim();
      if (/^\d+$/.test(epoch)) expect(result.tail.endsWith(new Date(Number(epoch) * 1000).toISOString())).toBe(true);
    });

    it('uses the observation time when tmux has no pane_dead_time format', async () => {
      await setUp();
      const run = tmux.run.bind(tmux);
      tmux.run = (args, input) => run(args.map(arg => arg.replaceAll('#{pane_dead_time}', '#{unknown_time_for_test}')), input);
      const before = Date.now();
      const result = await runTail(job('no-exit-time', 'hello', { env: { FAKE_SECRET: SECRET, FAKE_CRASH_START: 'crash' } }));
      footer(result.tail);
      const at = Date.parse(result.tail.slice(-24));
      expect(at).toBeGreaterThanOrEqual(before);
      expect(at).toBeLessThanOrEqual(Date.now());
    });

    it.each(kinds)('%s retains stderr, UTC time and redacted secrets when the program exits during a turn', async kind => {
      await setUp();
      const result = await runTail(jobs[kind]('crash-' + kind, 'CRASH'));
      expect(result).toMatchObject({ ok: false, error: 'agent_failed' });
      footer(result.tail);
      expect(result.tail).toContain('boom [hidden]\nProgram ended:');
      expect(result.tail).not.toContain(SECRET);
    });

    it.each(kinds)('%s reports the native KILL signal after the running program is killed', async kind => {
      await setUp();
      const run = tmux.run.bind(tmux);
      let incompleteUntil: number | null = null;
      tmux.run = async (args, input) => {
        const result = await run(args, input);
        if (args.at(-1)?.includes('#{pane_dead_status}') && result.startsWith('1|')) {
          incompleteUntil ??= Date.now() + 1200;
          if (Date.now() < incompleteUntil) return '1|||\n';
        }
        return result;
      };
      const key = 'killed-' + kind;
      const running = runTail(jobs[kind](key, 'HANG_EXIT'));
      await until(async () => (await host.screen(key)).includes('exit-test running'));
      const pid = await tmux.programPid('a-' + key);
      expect(pid).not.toBeNull();
      process.kill(pid!, 'SIGKILL');
      const result = await running;
      expect(result).toMatchObject({ ok: false, error: 'agent_failed' });
      expect(result.tail).toMatch(/Program ended: (?:code none, signal KILL \(9\)|code 137, signal none), at /);
      expect(result.tail.split('\n').at(-1)).toMatch(/^Program ended:/);
    });

    it.each(kinds)('%s keeps typed-turn exit output until Hornhoof acknowledges the turn', async kind => {
      await setUp({ openMs: 100 });
      const key = 'typed-exit-' + kind;
      await host.run(jobs[kind](key, 'warm up'));
      const termId = 'view-' + kind;
      await host.open({ type: 'term.open', termId, agentKey: key, cols: 80, rows: 24, write: true });
      host.input({ type: 'term.input', termId, data: 'CRASH\r' });
      await until(() => sent.some(m => m.type === 'turn.open' && m.agentKey === key));
      await until(() => sent.filter(m => m.type === 'term.program' && m.termId === termId).length >= 2);
      ack(key, 'dead-' + kind);
      await until(() => Boolean(done('dead-' + kind)));
      const result = done('dead-' + kind)!;
      expect(result).toMatchObject({ ok: false, error: 'agent_failed' });
      if (result.type !== 'job.done') throw new Error('Expected job.done');
      footer(result.tail);
      expect(result.tail).toContain('boom [hidden]');
      expect(result.tail).not.toContain(SECRET);
      expect(host.typedJobs()).toEqual([]);
    });

    it.each(kinds)('%s retains exit details when the failed startup says to sign in', async kind => {
      await setUp();
      const result = await runTail(jobs[kind]('login-exit-' + kind, 'hello', { env: { FAKE_SECRET: SECRET, FAKE_CRASH_START: 'login' } }));
      expect(result).toMatchObject({ ok: false, error: 'not_logged_in' });
      footer(result.tail);
      expect(result.tail).toContain('boom [hidden]');
    });

    it('bounds private output files and removes them with their session', async () => {
      await setUp();
      const key = 'bounded-exit';
      const result = await runTail(job(key, 'CRASH LONG'));
      const files = readdirSync(tmux.scratch()).filter(name => /^\.hh-output-[a-f0-9]{16}\.log$/.test(name)).map(name => join(tmux.scratch(), name));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(statSync(file).size).toBeLessThanOrEqual(256 * 1024);
      }
      expect(Buffer.byteLength(result.tail)).toBeLessThanOrEqual(4096);
      footer(result.tail);
      await tmux.kill('a-' + key);
      expect(files.some(existsSync)).toBe(false);
      expect((await runTail(job(key, 'warm up'))).ok).toBe(true);
      const nextFiles = readdirSync(tmux.scratch()).filter(name => /^\.hh-output-[a-f0-9]{16}\.log$/.test(name)).map(name => join(tmux.scratch(), name));
      expect(nextFiles.length).toBeGreaterThan(0);
      await host.stop();
      expect(nextFiles.some(existsSync)).toBe(false);
    });
  });
});
