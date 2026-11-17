import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESET_AGENT_ENV } from '../src/agent-env.js';
import { envFile, Tmux } from '../src/terminal/tmux.js';

/* What the node asks of tmux, and what it makes of tmux's answers. tmux itself is never started: its answers are recorded. */
const spawned = vi.hoisted(() => [] as { bin: string; args: string[]; env: NodeJS.ProcessEnv }[]);
vi.mock('node:child_process', async original => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: (bin: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    spawned.push({ bin, args, env: options.env });
    return new EventEmitter();
  },
}));

type Call = { args: string[]; input?: string };
const homes: string[] = [];

/* A Tmux whose every command is written down and answered as the recorded tmux answered it. */
function recorded(answer: (args: string[]) => string | Error = () => '', env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hh-tmux-'));
  homes.push(home);
  const tmux = new Tmux({ socket: 'hh-test', env: { PATH: '/usr/bin', HOME: home, NODE_KEY: 'node-own-key', HORNHOOF_URL: 'http://hh', ...env }, recordingsDir: join(home, 'recordings') });
  const calls: Call[] = [];
  vi.spyOn(tmux, 'run').mockImplementation(async (args, input) => {
    calls.push({ args, ...(input === undefined ? {} : { input }) });
    const out = answer(args);
    if (out instanceof Error) throw out;
    return out;
  });
  return { tmux, calls, home };
}
const named = (calls: Call[], command: string) => calls.filter(c => c.args.includes(command));
const recorderFile = (command: string) => command.match(/([^\s']+\.hh-output-[a-f0-9]{16}\.log)/)![1]!;

afterEach(() => {
  spawned.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('starting a program in tmux', () => {
  it('clears the private marker when an explicitly removed session was already gone', async () => {
    const { tmux } = recorded(args => ['kill-session', 'has-session'].includes(args[0]!) ? new Error('no session') : '');
    await tmux.protectOutput('a-private');
    await tmux.kill('a-private');
    expect(tmux.outputPrivate('a-private')).toBe(false);
  });

  it('removes raw output even when its privacy marker cannot be written', async () => {
    const { tmux, home } = recorded();
    const recording = tmux['recordings'].create('a-private', home);
    writeFileSync(recording.file, 'private-failed-marker-1178');
    vi.spyOn(tmux['recordings'], 'protect').mockImplementation(() => { throw new Error('No room for marker'); });
    await expect(tmux.protectOutput('a-private')).rejects.toThrow('No room for marker');
    expect(existsSync(recording.file)).toBe(false);
  });

  it('removes a sensitive recording and keeps recording disabled after the node restarts', async () => {
    const { tmux, home } = recorded();
    const recording = tmux['recordings'].create('a-private', home);
    writeFileSync(recording.file, 'private-recording-marker-1178');
    await tmux.protectOutput('a-private');
    expect(existsSync(recording.file)).toBe(false);
    const restarted = new Tmux({ socket: 'hh-test', env: { HOME: home }, recordingsDir: join(home, 'recordings') });
    vi.spyOn(restarted, 'run').mockImplementation(async args => {
      if (args[0] === 'has-session') throw new Error('no session');
      return '';
    });
    expect(restarted.outputPrivate('a-private')).toBe(true);
    await restarted.launch('a-private', { cwd: home, command: ['claude'], cols: 80, rows: 24, outputDir: home });
    expect(vi.mocked(restarted.run).mock.calls.some(([args]) => args[0] === 'pipe-pane' && args.length > 3)).toBe(false);
    await restarted.kill('a-private');
    expect(restarted.outputPrivate('a-private')).toBe(false);
  });

  it('keeps the sensitive pane out of the temporary screen file used on stop', async () => {
    const marker = 'private-stopped-screen-marker-1178';
    const { tmux, calls } = recorded(args => args[0] === 'capture-pane' ? marker : '');
    vi.spyOn(tmux, 'alive').mockResolvedValue(false);
    await tmux.protectOutput('a-private');
    await tmux.stop('a-private');
    const shown = calls.find(call => call.args[0] === 'respawn-pane')?.args.at(-1);
    expect(shown).toBeDefined();
    expect(readFileSync(shown!, 'utf8')).not.toContain(marker);
    expect(readFileSync(shown!, 'utf8')).toMatch(/hidden/i);
  });

  it('starts a new session in one command line: its options, the program, then the keys that leave watchers none', async () => {
    const { tmux, calls } = recorded(args => (args[0] === 'has-session' ? new Error("can't find session") : ''));
    await tmux.launch('a-1', { cwd: '/work', command: ['claude', '--model', 'opus'], cols: 100, rows: 30 });
    const line = named(calls, 'start-server')[0]!.args;
    const commands = line.join(' ').split(' ; ');
    expect(commands.slice(0, 9)).toEqual([
      'start-server', 'set-option -g status off', 'set-option -g mouse on', 'set-option -g focus-events on', 'set-option -g window-size smallest',
      'set-option -g escape-time 0', 'set-option -g history-limit 50000', 'set-option -g default-terminal tmux-256color', 'set-option -g remain-on-exit on',
    ]);
    const start = line.indexOf('new-session');
    expect(line.slice(start, start + 10)).toEqual(['new-session', '-d', '-s', 'a-1', '-x', '100', '-y', '30', '-c', '/work']);
    expect(line.slice(start + 10, start + 13)).toEqual(['sh', '-c', `${RESET_AGENT_ENV}; exec "$@"`]);
    expect(line.slice(start + 13, start + 17)).toEqual(['hh-program', 'claude', '--model', 'opus']);
    /* The keys come last, so they hold only once the program has started; no prefix, no key but the wheel. */
    expect(commands.slice(-5, -1)).toEqual([
      expect.stringMatching(/hh-program claude --model opus$/), 'set-option -g prefix None', 'set-option -g prefix2 None', 'unbind-key -a -T root',
    ]);
    expect(line.slice(line.lastIndexOf(';') + 1)).toEqual(['bind-key', '-n', 'WheelUpPane', 'if-shell', '-F', '#{||:#{alternate_on},#{||:#{pane_in_mode},#{mouse_any_flag}}}', 'send-keys -M', 'copy-mode -e']);
    expect(commands.filter(c => c.startsWith('bind-key'))).toHaveLength(1);
  });

  it('puts the env in a file the program reads and removes, never on the command line, after clearing what the machine set', async () => {
    const { tmux, calls, home } = recorded(args => (args[0] === 'has-session' ? new Error('no session') : ''));
    const file = envFile(home, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-secret', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await tmux.launch('a-2', { cwd: '/work', command: ['claude'], cols: 80, rows: 24, envFile: file });
    const line = named(calls, 'start-server')[0]!.args;
    const at = line.indexOf('new-session') + 10;
    expect(line.slice(at, at + 4)).toEqual(['sh', '-c', `${RESET_AGENT_ENV}; set -a; . "$0"; set +a; rm -f "$0"; exec "$@"`, file]);
    expect(line.join(' ')).not.toContain('sk-ant-oat01-secret');
    for (const key of ['NODE_KEY', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'KIMI_MODEL_NAME', 'AGY_ADC_AUTH']) expect(RESET_AGENT_ENV.split(' ')).toContain(key);
  });

  it('starts the program again in the same session after reading how the last one ended', async () => {
    const { tmux, calls } = recorded(args => (args.join(' ').includes('#{pane_dead}|') ? '0|||' : ''));
    await tmux.launch('a-4', { cwd: '/work', command: ['codex'], cols: 80, rows: 24 });
    const line = named(calls, 'start-server')[0]!.args;
    const start = line.indexOf('respawn-pane');
    expect(line.slice(start, start + 6)).toEqual(['respawn-pane', '-k', '-c', '/work', '-t', 'a-4']);
    expect(line).not.toContain('new-session');
    expect(calls.findIndex(c => c.args[0] === 'has-session')).toBeLessThan(calls.indexOf(named(calls, 'start-server')[0]!));
  });

  it("keeps the node's own key and Hornhoof's settings out of the env tmux and its programs start from", () => {
    recorded();
    const { tmux } = recorded();
    tmux.attach('a-1', 80, 24, true);
    expect(spawned[0]!.env).not.toHaveProperty('NODE_KEY');
    expect(spawned[0]!.env).not.toHaveProperty('HORNHOOF_URL');
    expect(spawned[0]!.env).toMatchObject({ PATH: '/usr/bin', LANG: 'C.UTF-8', TERM: 'xterm-256color' });
  });

  it('starts the gated program right away when the first output recorder becomes ready', async () => {
    vi.useFakeTimers();
    const { tmux, calls } = recorded(args => {
      if (args[0] === 'has-session') return new Error('no session');
      if (args[0] === 'pipe-pane' && args[3]) {
        const file = recorderFile(args[3]);
        writeFileSync(`${file}.ready`, 'ready');
        writeFileSync(file, 'recorded output\n');
      }
      return '';
    });
    await tmux.launch('a-1', { cwd: '/work', command: ['claude'], cols: 80, rows: 24, outputDir: tmux.scratch() });
    expect(calls.filter(c => c.args[0] === 'pipe-pane')).toHaveLength(1);
    expect(named(calls, 'send-keys')).toEqual([{ args: ['send-keys', '-t', 'a-1', 'Enter'] }]);
    expect(tmux.programOutput('a-1')).toBe('recorded output\n');
  });

  it('restarts a silent output recorder once and continues launching the waiting program', async () => {
    vi.useFakeTimers();
    const files: string[] = [];
    let stoppedFirst = false;
    const { tmux, calls } = recorded(args => {
      if (args[0] === 'has-session') return new Error('no session');
      if (args[0] === 'pipe-pane' && !args[3]) stoppedFirst = true;
      if (args[0] === 'pipe-pane' && args[3]) {
        const file = recorderFile(args[3]);
        files.push(file);
        if (files.length === 2) {
          expect(stoppedFirst).toBe(true);
          expect(existsSync(files[0]!)).toBe(false);
          expect(existsSync(`${files[0]!}.ready`)).toBe(false);
          writeFileSync(`${file}.ready`, 'ready');
          writeFileSync(file, 'from restarted recorder\n');
        }
      }
      return '';
    });
    const outcome = tmux.launch('a-1', { cwd: '/work', command: ['claude'], cols: 80, rows: 24, outputDir: tmux.scratch() }).then(
      () => null,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(await outcome).toBeNull();
    expect(files).toHaveLength(2);
    expect(files[1]).not.toBe(files[0]);
    expect(calls.filter(c => c.args[0] === 'pipe-pane' && Boolean(c.args[3]))).toHaveLength(2);
    expect(calls.filter(c => c.args[0] === 'pipe-pane' && !c.args[3])).toEqual([{ args: ['pipe-pane', '-t', 'a-1'] }]);
    expect(named(calls, 'send-keys')).toEqual([{ args: ['send-keys', '-t', 'a-1', 'Enter'] }]);
    expect(tmux.programOutput('a-1')).toBe('from restarted recorder\n');
  });

  it('fails and clears the restarted recorder when neither recorder attempt starts', async () => {
    vi.useFakeTimers();
    const files: string[] = [];
    const { tmux, calls } = recorded(args => {
      if (args[0] === 'has-session') return new Error('no session');
      if (args[0] === 'pipe-pane' && args[3]) files.push(recorderFile(args[3]));
      return '';
    });
    const outcome = tmux.launch('a-1', { cwd: '/work', command: ['claude'], cols: 80, rows: 24, outputDir: tmux.scratch() }).then(
      () => null,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('The terminal output recorder did not start.');
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(existsSync(file)).toBe(false);
      expect(existsSync(`${file}.ready`)).toBe(false);
    }
    expect(calls.filter(c => c.args[0] === 'pipe-pane' && Boolean(c.args[3]))).toHaveLength(2);
    expect(calls.filter(c => c.args[0] === 'pipe-pane' && !c.args[3])).toHaveLength(2);
    expect(named(calls, 'send-keys')).toEqual([]);
    expect(tmux.programOutput('a-1')).toBeNull();
  });
});

describe('typing into a program in tmux', () => {
  it('pastes text as one bracketed paste with its control characters taken out, and only into a live pane', async () => {
    const { tmux, calls } = recorded();
    const controls = '\x00\x01\x07\x08\x0b\x0c\x0d\x0e\x1b\x1f\x7f\x80\x9b\x9f';
    await tmux.paste('a-1', `a\x1b[31mred\x1b[0m\x1b[201~after${controls}\n\tz\u00a0🙂`);
    expect(calls).toHaveLength(2);
    const [load, paste] = calls;
    expect(load!.args.slice(0, 2)).toEqual(['load-buffer', '-b']);
    expect(load!.args.at(-1)).toBe('-');
    expect(load!.input).toBe('a[31mred[0m[201~after\n\tz\u00a0🙂');
    const buffer = load!.args[2]!;
    expect(paste!.args).toEqual(['if-shell', '-F', '-t', 'a-1', '#{pane_dead}', `delete-buffer -b ${buffer}`, `paste-buffer -p -d -b ${buffer} -t 'a-1'`]);
  });

  it('sends keys by their names to the session it was asked to', async () => {
    const { tmux, calls } = recorded();
    await tmux.keys('a-1', 'C-u', 'Enter');
    expect(calls).toEqual([{ args: ['send-keys', '-t', 'a-1', 'C-u', 'Enter'] }]);
  });
});

describe('reading a program in tmux', () => {
  it('reads the screen with its history, styles only when asked, and nothing when tmux cannot answer', async () => {
    const { tmux, calls } = recorded(args => (args.includes('gone') ? new Error("can't find pane") : 'Ask Codex\n'));
    expect(await tmux.screen('a-1')).toBe('Ask Codex\n');
    expect(await tmux.screen('a-1', 0, true)).toBe('Ask Codex\n');
    expect(await tmux.screen('gone')).toBe('');
    expect(calls.map(c => c.args)).toEqual([
      ['capture-pane', '-p', '-J', '-S', '-200', '-t', 'a-1'],
      ['capture-pane', '-p', '-e', '-J', '-S', '0', '-t', 'a-1'],
      ['capture-pane', '-p', '-J', '-S', '-200', '-t', 'gone'],
    ]);
  });

  it('tells a live program from one that ended or a session that is gone', async () => {
    const { tmux } = recorded(args => (args.includes('live') ? '0\n' : args.includes('ended') ? '1\n' : new Error('no session')));
    expect(await tmux.alive('live')).toBe(true);
    expect(await tmux.alive('ended')).toBe(false);
    expect(await tmux.alive('gone')).toBe(false);
  });

  it('names the native exit of a program that ended, and the time tmux saw it', async () => {
    const { tmux } = recorded(args => (args.join(' ').includes('#{pane_dead}|') ? '1|3||1762689600' : args[0] === 'capture-pane' ? 'boom\n' : ''));
    const end = await tmux.exitSnapshot('a-1');
    expect(end).toMatchObject({ complete: true, programOutput: { code: 3, signal: null, at: '2025-11-09T12:00:00.000Z' } });
    expect(end!.output).toContain('boom');
  });

  it("names the agents whose programs run, from one answer of tmux, and none when tmux runs no server", async () => {
    const panes = 'a-7f1c2a9e-0b1d-4c55-9d1e-3f0a8b6c2d11 0\na-0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b 1\na-receipt 0\nother 0\n';
    const { tmux, calls } = recorded(args => (args[0] === 'list-panes' ? panes : ''));
    expect(await tmux.livePrograms()).toEqual(['7f1c2a9e-0b1d-4c55-9d1e-3f0a8b6c2d11', 'receipt']);
    expect(named(calls, 'list-panes')).toEqual([{ args: ['list-panes', '-a', '-F', '#{session_name} #{pane_dead}'] }]);
    expect(await recorded(() => new Error('no server running on /tmp/tmux-501/hh-test')).tmux.livePrograms()).toEqual([]);
  });

  it('reads the pid of a live program only', async () => {
    const { tmux } = recorded(args => (args.includes('#{pane_dead}') ? (args.includes('live') ? '0' : '1') : '4242\n'));
    expect(await tmux.programPid('live')).toBe(4242);
    expect(await tmux.programPid('ended')).toBeNull();
  });
});

describe('people watching a program in tmux', () => {
  it('gives a watcher who may not type a read-only client of its own size, and one who may type a writing one', () => {
    const { tmux } = recorded();
    tmux.attach('a-1', 120, 40, false);
    tmux.attach('a-1', 90, 30, true);
    const [watcher, writer] = spawned.map(s => (process.platform === 'darwin' ? s.args.at(-1)! : s.args[1]!));
    expect(watcher).toBe(`stty cols 120 rows 40; exec tmux -u -f /dev/null -L hh-test set-option -s 'terminal-overrides[9]' 'xterm-256color:smcup@:rmcup@:csr@' \\; attach -r -t '=a-1'`);
    expect(writer).toBe(`stty cols 90 rows 30; exec tmux -u -f /dev/null -L hh-test set-option -s 'terminal-overrides[9]' 'xterm-256color:smcup@:rmcup@:csr@' \\; attach -t '=a-1'`);
  });

  it('ends a session only after reading how its program ended, and forgets its recording', async () => {
    const { tmux, calls } = recorded(args => (args.join(' ').includes('#{pane_dead}|') ? '' : ''));
    await tmux.kill('a-1');
    expect(calls.at(-1)!.args).toEqual(['kill-session', '-t', '=a-1']);
    expect(calls.some(c => c.args.join(' ').includes('#{pane_dead}|'))).toBe(true);
  });
});

describe('env files for a program', () => {
  it('quote every value so the shell reads it back as it was, and only the owner reads the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-env-'));
    const file = envFile(dir, { A: "x'y", B: 'line $HOME `cmd`' });
    expect(readFileSync(file, 'utf8')).toBe("A='x'\\''y'\nB='line $HOME `cmd`'\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
