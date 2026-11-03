import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { TAIL_BYTES } from '@hornhoof/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { jobDone } from '../src/runner.js';
import { Tmux } from '../src/terminal/tmux.js';

const hasTmux = (() => {
  try { execFileSync('tmux', ['-V']); return true; } catch { return false; }
})();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) if (await check()) return;
  throw new Error('timed out');
};

describe.skipIf(!hasTmux)('terminal output recording lifecycle', () => {
  const instances: Tmux[] = [];
  const paused = new Set<number>();
  const recordingFiles = (dir: string) => readdirSync(dir).filter(name => name.startsWith('.hh-output-')).map(name => join(dir, name));

  function fixture(flushTimeoutMs = 1000, home = mkdtempSync(join(tmpdir(), 'hh-recording-'))) {
    const socket = `hh-recording-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
    const env = { PATH: process.env.PATH ?? '', HOME: home, ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}) };
    const options = { socket, env, flushTimeoutMs };
    const replacement = () => {
      const tmux = new Tmux(options);
      instances.push(tmux);
      return tmux;
    };
    const tmux = replacement();
    const dir = join(home, socket);
    mkdirSync(dir);
    return { tmux, replacement, dir, home };
  }

  async function launch(tmux: Tmux, dir: string, name = 'agent', initial = 'running') {
    writeFileSync(join(dir, 'initial-output'), `${initial}\n`);
    await tmux.launch(name, {
      cwd: dir, outputDir: dir, cols: 80, rows: 24,
      command: ['sh', '-c', 'cat initial-output; IFS= read -r line; printf "\\033[?1049hboom-final-output\\n\\033[?1049l" >&2; exit 3'],
    });
    await until(async () => (await tmux.screen(name)).includes(initial.split('\n').at(-1)!));
  }

  async function recorders(tmux: Tmux, name = 'agent') {
    const parent = Number((await tmux.run(['display-message', '-p', '-t', name, '#{pid}'])).trim());
    const ownChildren = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).trim().split('\n')
      .map(line => line.trim().split(/\s+/))
      .filter(([, ppid, command]) => Number(ppid) === parent && basename(command ?? '') === basename(process.execPath));
    return ownChildren.map(([pid]) => Number(pid));
  }

  async function recorderPid(tmux: Tmux, name = 'agent') {
    const ownChildren = await recorders(tmux, name);
    expect(ownChildren).toHaveLength(1);
    return ownChildren[0]!;
  }

  async function exitProgram(tmux: Tmux, name = 'agent') {
    await tmux.keys(name, 'Enter');
    await until(async () => !(await tmux.alive(name)));
    await tmux.run(['run-shell', 'true']);
    await until(async () => (await tmux.run(['display-message', '-p', '-t', name, '#{pane_dead_status}'])).trim() === '3');
  }

  const resume = (pid: number) => { process.kill(pid, 'SIGCONT'); paused.delete(pid); };
  afterEach(async () => {
    for (const pid of paused) resume(pid);
    for (const tmux of instances.splice(0)) await tmux.stopAll();
  });

  it('keeps a live stderr failure after the program erases its screen', async () => {
    const { tmux, dir } = fixture();
    expect(tmux.programOutput('missing')).toBeNull();
    await tmux.launch('agent', {
      cwd: dir, outputDir: dir, cols: 80, rows: 24,
      command: [process.execPath, '-e', `process.stderr.write(${JSON.stringify('AGY_ERROR: {"short_error":"overloaded","retryable":false}\n')}); process.stdout.write("\\x1b[2J\\x1b[3J\\x1b[Hready"); process.stdin.resume();`],
    });
    await until(async () => (await tmux.screen('agent')).includes('ready'));
    await until(() => tmux.programOutput('agent')?.includes('AGY_ERROR: ') ?? false);
    expect(await tmux.alive('agent')).toBe(true);
    expect(await tmux.screen('agent')).not.toContain('AGY_ERROR');
    expect(tmux.programOutput('agent')).toContain('AGY_ERROR: {"short_error":"overloaded","retryable":false}');
  });

  it('reads only bytes after a cursor even when its old output rolls out of the tail', async () => {
    const { tmux, dir } = fixture();
    const old = 'AGY_ERROR: {"short_error":"old","retryable":false}\n';
    const fresh = 'AGY_ERROR: {"short_error":"fresh network failure","retryable":true}\n';
    await tmux.launch('agent', {
      cwd: dir, outputDir: dir, cols: 80, rows: 24,
      command: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(old + 'ready\n')}); process.stdin.on('data', () => process.stdout.write('x'.repeat(3 * 256 * 1024) + ${JSON.stringify('\n' + fresh)}));`],
    });
    await until(() => tmux.programOutput('agent')?.includes('ready') ?? false);
    const cursor = (await tmux.programCursor('agent'))!;
    expect(cursor).not.toBeNull();
    expect(tmux.programOutput('agent', cursor)).toBe('');
    await tmux.keys('agent', 'Enter');
    await until(() => tmux.programOutput('agent', cursor)?.includes('fresh network failure') ?? false);
    expect(tmux.programOutput('agent')).not.toContain('"short_error":"old"');
    expect(tmux.programOutput('agent', cursor)).toContain(fresh.replace(/\n$/, ''));
  });

  it('waits for a transient recorder write before capturing the invocation cursor', async () => {
    const { tmux, dir } = fixture();
    await launch(tmux, dir);
    await until(() => tmux.programOutput('agent')?.includes('running') ?? false);
    const position = recordingFiles(dir).find(file => file.endsWith('.position'))!;
    const published = readFileSync(position);
    const changing = Buffer.from(published);
    changing.writeDoubleBE(published.readDoubleBE(0) + 1, 0);
    writeFileSync(position, changing);
    let settled = false;
    const cursor = Promise.resolve(tmux.programCursor('agent')).then(value => { settled = true; return value; });
    await sleep(30);
    expect(settled).toBe(false);
    writeFileSync(position, published);
    expect(await cursor).toMatchObject({ offset: published.readDoubleBE(8) });
  });

  it('waits for a delayed recorder before returning and caching the final output', async () => {
    const { tmux, dir } = fixture();
    await launch(tmux, dir);
    const pid = await recorderPid(tmux);
    process.kill(pid, 'SIGSTOP');
    paused.add(pid);
    await exitProgram(tmux);
    const result = tmux.ended('agent');
    expect(await Promise.race([result.then(() => 'finished'), sleep(100).then(() => 'waiting')])).toBe('waiting');
    resume(pid);
    expect(await result).toMatch(/boom-final-output\nProgram ended: code 3, signal none, at /);
    expect(await tmux.ended('agent')).toContain('boom-final-output');
  });

  it('bounds the wait for a stopped recorder and retries an incomplete snapshot', async () => {
    const { tmux, dir } = fixture(100);
    await launch(tmux, dir);
    const pid = await recorderPid(tmux);
    process.kill(pid, 'SIGSTOP');
    paused.add(pid);
    await exitProgram(tmux);
    const first = await Promise.race([tmux.ended('agent'), sleep(1500).then(() => 'timed out')]);
    expect(first).toContain('Program ended: code 3');
    resume(pid);
    const raw = recordingFiles(dir).find(file => file.endsWith('.log'))!;
    await until(() => readFileSync(raw, 'utf8').includes('boom-final-output'));
    expect(await tmux.ended('agent')).toContain('boom-final-output');
  });

  it.each([
    { cap: '50 output lines', padding: 1, flushTimeoutMs: 100 },
    { cap: '4096 tail bytes', padding: 256, flushTimeoutMs: 5000 },
  ])('marks incomplete job.done output after limiting $cap and its 400-character preview', async ({ padding, flushTimeoutMs }) => {
    const { tmux, dir } = fixture(flushTimeoutMs);
    const initial = Array.from({ length: 60 }, (_, i) => `initial-${i}-${'x'.repeat(padding)}`);
    await launch(tmux, dir, 'agent', initial.join('\n'));
    const raw = recordingFiles(dir).find(file => file.endsWith('.log'))!;
    await until(() => readFileSync(raw, 'utf8').includes(initial.at(-1)!));
    const pid = await recorderPid(tmux);
    process.kill(pid, 'SIGSTOP');
    paused.add(pid);
    await exitProgram(tmux);

    const snapshot = await tmux.exitSnapshot('agent');
    const output = snapshot?.output ?? '';
    expect(snapshot?.programOutput?.complete).toBe(false);
    const done = jobDone('incomplete-output', { ok: false, sessionId: null, result: '', output, programOutput: snapshot?.programOutput, error: 'agent_failed', limits: null }, []);
    const warning = 'Output capture did not finish before the wait expired.';
    expect(done).toMatchObject({ type: 'job.done', ok: false, error: 'agent_failed' });
    expect(done.tail).not.toContain('boom-final-output');
    expect(output.split('\n').filter(line => line.startsWith('initial-'))).toHaveLength(50);
    expect(Buffer.byteLength(done.tail)).toBe(Math.min(Buffer.byteLength(output), TAIL_BYTES));
    expect(done.tail.split('\n').at(-1)).toMatch(/^Program ended: code 3, signal none, at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(done.tail.slice(-400)).toContain(warning);
    expect(done.tail.split('\n').at(-2)).toBe(warning);
  });

  it('removes recordings left by an exited recorder when a new controller stops the server', async () => {
    const { tmux, replacement, dir } = fixture();
    await launch(tmux, dir);
    const pid = await recorderPid(tmux);
    await exitProgram(tmux);
    expect(await tmux.ended('agent')).toContain('boom-final-output');
    if ((await recorders(tmux)).includes(pid)) process.kill(pid, 'SIGTERM');
    await until(async () => {
      await tmux.run(['run-shell', 'true']);
      return !(await recorders(tmux)).includes(pid);
    });
    expect(recordingFiles(dir).length).toBeGreaterThanOrEqual(2);
    const next = replacement();
    await next.stopAll();
    expect(await next.has('agent')).toBe(false);
    expect(recordingFiles(dir)).toEqual([]);
    await next.stopAll();
    expect(recordingFiles(dir)).toEqual([]);
  });

  it('recovers cleanup after both the recorder and tmux were killed', async () => {
    const { tmux, replacement, dir } = fixture();
    await launch(tmux, dir);
    const raw = recordingFiles(dir).find(file => file.endsWith('.log'))!;
    await until(() => readFileSync(raw, 'utf8').includes('running'));
    const keep = join(dir, 'keep.log');
    writeFileSync(keep, 'unrelated file');
    process.kill(await recorderPid(tmux), 'SIGKILL');
    await tmux.run(['kill-server']);
    await replacement().stopAll();
    expect(recordingFiles(dir)).toEqual([]);
    expect(readFileSync(keep, 'utf8')).toBe('unrelated file');
  });

  it('removes the previous recording when a new controller relaunches the session', async () => {
    const { tmux, replacement, dir, home } = fixture();
    await launch(tmux, dir);
    await exitProgram(tmux);
    const oldFiles = recordingFiles(dir);
    const nextDir = join(home, 'next');
    mkdirSync(nextDir);
    const next = replacement();
    await launch(next, nextDir);
    expect(oldFiles.some(existsSync)).toBe(false);
    expect(recordingFiles(nextDir).length).toBeGreaterThanOrEqual(2);
  });

  it('recovers one session without removing another session on the same server', async () => {
    const { tmux, replacement, dir, home } = fixture();
    const other = join(home, 'other-agent');
    mkdirSync(other);
    await launch(tmux, dir);
    await launch(tmux, other, 'other');
    await exitProgram(tmux);
    await replacement().kill('agent');
    expect(recordingFiles(dir)).toEqual([]);
    expect(await tmux.alive('other')).toBe(true);
    expect(recordingFiles(other).length).toBeGreaterThanOrEqual(2);
  });

  it('limits restart cleanup to the owning tmux socket', async () => {
    const first = fixture();
    const other = fixture(1000, first.home);
    await launch(first.tmux, first.dir);
    await launch(other.tmux, other.dir);
    process.kill(await recorderPid(first.tmux), 'SIGKILL');
    await first.tmux.run(['kill-server']);
    await first.replacement().stopAll();
    expect(recordingFiles(first.dir)).toEqual([]);
    expect(await other.tmux.alive('agent')).toBe(true);
    expect(recordingFiles(other.dir).length).toBeGreaterThanOrEqual(2);
  });
});
