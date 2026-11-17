import { beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import ts from 'typescript';
import { CheckClient } from '../src/check-client.js';
import { currentCheckLease, setCheckClient, withCheckSlot } from '../src/check-queue.js';
import { configureCheckCommands, installCheckCommand } from '../src/check-command-runner.js';
import { classifyAgentCommand } from '../src/command-guard.js';
import { createAgentCommandGuard } from '../src/check-runtime.js';
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { JobUser } from '../src/isolation.js';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Bridge, type OpensCheck } from '../src/terminal/bridge.js';
import { procOwner } from '../src/terminal/peer.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { eventually } from '../../../test-support/eventually.mjs';

/* The runner never runs a command as root. A run of these tests as root, as in a plain node image, hands the commands to an
   unprivileged user of the machine and the folders they use to that user. */
function commandUser(): JobUser | null {
  if (process.getuid?.() !== 0) return null;
  const users = readFileSync('/etc/passwd', 'utf8').split('\n').map(line => line.split(':'));
  const found = ['node', 'nobody'].map(name => users.find(entry => entry[0] === name)).find(Boolean);
  if (!found) throw new Error('Run as root, these tests need an unprivileged user named node or nobody to run check commands as.');
  return { uid: Number(found[2]), gid: Number(found[3]) };
}
const user = commandUser();

function giveToUser(dir: string): void {
  if (!user) return;
  chownSync(dir, user.uid, user.gid);
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) chownSync(join(entry.parentPath, entry.name), user.uid, user.gid);
}

/* The CLI as the node ships it, built here from its source with its one package found where it is installed. */
let cli: string;
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-check-cli-'));
  const source = readFileSync(fileURLToPath(new URL('../src/check-command.ts', import.meta.url)), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  cli = join(dir, 'check-command.mjs');
  writeFileSync(cli, outputText.replace(/from 'zod'/, `from ${JSON.stringify(import.meta.resolve('zod'))}`));
  const groupSource = readFileSync(fileURLToPath(new URL('../src/check-group.ts', import.meta.url)), 'utf8');
  writeFileSync(join(dir, 'check-group.js'), ts.transpileModule(groupSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  chmodSync(dir, 0o755); chmodSync(cli, 0o644);
  return () => rmSync(dir, { recursive: true, force: true });
});

describe('check command bridge', () => {
  beforeEach(() => {
    configureCheckCommands(user, (_key, input) => classifyAgentCommand({ ...input, workspaceRoot: '/tmp' }));
    onTestFinished(() => configureCheckCommands(null));
  });
  it('runs a command through a granted slot with its output and exit code', async () => {
    const key = '10000000-0000-4000-8000-000000000001';
    const client = new CheckClient(frame => {
      if (frame.type === 'check.acquire') queueMicrotask(() => client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 }));
      return true;
    });
    client.online(true); setCheckClient(client);
    const bridge = new Bridge('http://127.0.0.1:1', () => {});
    await bridge.start(); bridge.setToken(key, 'turn');
    onTestFinished(() => { bridge.stop(); client.stop(); setCheckClient(null); });
    const url = bridge.agent(key).hookUrl.replace('/hook/', '/check/');
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ command: [process.execPath, '-e', 'process.stdout.write("check output");process.stderr.write("check error");process.exit(7)'], cwd: '/tmp', env: { PATH: process.env.PATH } }) });
    expect(response.status).toBe(200);
    const frames = (await response.text()).trim().split('\n').map(line => JSON.parse(line) as { type: string; data?: string; code?: number });
    expect(frames.filter(f => f.type === 'stdout').map(f => Buffer.from(f.data!, 'base64').toString()).join('')).toBe('check output');
    expect(frames.filter(f => f.type === 'stderr').map(f => Buffer.from(f.data!, 'base64').toString()).join('')).toBe('check error');
    expect(frames.at(-1)).toMatchObject({ type: 'exit', code: 7 });
  });

  it('makes the CLI preserve command output and its nonzero exit status', async () => {
    const key = '10000000-0000-4000-8000-000000000002';
    const client = new CheckClient(frame => {
      if (frame.type === 'check.acquire') queueMicrotask(() => client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 }));
      return true;
    });
    client.online(true); setCheckClient(client);
    const bridge = new Bridge('http://127.0.0.1:1', () => {}); await bridge.start(); bridge.setToken(key, 'turn');
    onTestFinished(() => { bridge.stop(); client.stop(); setCheckClient(null); });
    const child = spawn(process.execPath, [cli, '--', process.execPath, '-e', 'process.stdout.write("from CLI");process.exit(7)'], {
      cwd: '/tmp', env: { PATH: process.env.PATH, HH_BRIDGE: bridge.agent(key).hookUrl }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; child.stdout.on('data', chunk => { stdout += String(chunk); });
    const code = await new Promise(resolve => child.on('close', resolve));
    expect(code).toBe(7); expect(stdout).toBe('from CLI');
  });

  /* Who owns a request is read from /proc, which only Linux has. */
  it.runIf(existsSync('/proc/self'))('allows nested wrappers and hooks from its own checked command while rejecting another agent', async () => {
    const key = '10000000-0000-4000-8000-000000000005', other = '10000000-0000-4000-8000-000000000006';
    let acquired = 0, pane = 0;
    const client = new CheckClient(frame => {
      if (frame.type === 'check.acquire') { acquired++; queueMicrotask(() => client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 })); }
      return true;
    });
    client.online(true); setCheckClient(client);
    const owner = procOwner('/proc')(async agent => agent === key ? [pane] : []);
    const bridge = new Bridge('http://127.0.0.1:1', () => {}, owner.owns, { capture: owner.capture });
    await bridge.start(); bridge.setToken(key, 'turn'); bridge.setToken(other, 'other-turn');
    onTestFinished(() => { bridge.stop(); client.stop(); setCheckClient(null); });
    const script = `
      const { spawnSync } = await import('node:child_process');
      const nested = spawnSync(process.execPath, [${JSON.stringify(cli)}, '--', process.execPath, '-e', 'process.stdout.write("nested")'], { env: process.env, encoding: 'utf8' });
      process.stdout.write(nested.stdout); process.stderr.write(nested.stderr);
      const request = { method: 'POST', headers: { 'x-hh-pid': String(process.pid) }, body: '{}' };
      const own = await fetch(${JSON.stringify(bridge.agent(key).hookUrl + '/tool')}, request);
      const foreign = await fetch(${JSON.stringify(bridge.agent(other).hookUrl.replace('/hook/', '/check/'))}, request);
      process.stdout.write(':' + own.status + ':' + foreign.status);
      process.exitCode = nested.status ?? 1;
    `;
    const child = spawn(process.execPath, [cli, '--', process.execPath, '--input-type=module', '-e', script], {
      cwd: '/tmp', env: { PATH: process.env.PATH, HH_BRIDGE: bridge.agent(key).hookUrl }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    pane = child.pid!;
    onTestFinished(() => { child.kill('SIGKILL'); });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
    const code = await new Promise(resolve => child.once('close', resolve));
    expect({ code, stdout, stderr, acquired }).toEqual({ code: 0, stdout: 'nested:200:403', stderr: '', acquired: 1 });
  });

  it('cleans the group and returns the slot when the command leader leaves an open output pipe', async () => {
    const key = '10000000-0000-4000-8000-000000000007';
    let released = false;
    const client = new CheckClient(frame => {
      if (frame.type === 'check.acquire') queueMicrotask(() => client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 }));
      else released = true;
      return true;
    });
    client.online(true); setCheckClient(client);
    const bridge = new Bridge('http://127.0.0.1:1', () => {}); await bridge.start(); bridge.setToken(key, 'turn');
    onTestFinished(() => { bridge.stop(); client.stop(); setCheckClient(null); });
    const response = await fetch(bridge.agent(key).hookUrl.replace('/hook/', '/check/'), {
      method: 'POST', body: JSON.stringify({ command: ['/bin/bash', '-c', 'sleep 60 & echo leader-exiting; exit 0'], cwd: '/tmp', env: { PATH: process.env.PATH } }),
    });
    /* It ends although the leader's child still holds the pipe: one that waited for the pipe would never end. */
    expect(await response.text()).toContain('"type":"exit","code":0');
    expect(released).toBe(true);
  });

  it('requires the authenticated agent process and a current turn before accepting a command', async () => {
    const key = '10000000-0000-4000-8000-000000000003';
    const owned = new Bridge('http://127.0.0.1:1', () => {}, async () => false);
    const outside = new Bridge('http://127.0.0.1:1', () => {});
    await owned.start(); await outside.start(); owned.setToken(key, 'turn');
    onTestFinished(() => { owned.stop(); outside.stop(); });
    const input = JSON.stringify({ command: [process.execPath, '-e', 'process.exit(0)'], cwd: '/tmp', env: {} });
    expect((await fetch(owned.agent(key).hookUrl.replace('/hook/', '/check/'), { method: 'POST', body: input })).status).toBe(403);
    expect((await fetch(outside.agent(key).hookUrl.replace('/hook/', '/check/'), { method: 'POST', body: input })).status).toBe(409);
  });

  it('retains the slot while a cancelled command ignores TERM and is killed after its grace', async () => {
    const key = '10000000-0000-4000-8000-000000000004';
    let released = false;
    const client = new CheckClient(frame => {
      if (frame.type === 'check.acquire') queueMicrotask(() => client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 }));
      else released = true;
      return true;
    });
    client.online(true); setCheckClient(client);
    const bridge = new Bridge('http://127.0.0.1:1', () => {}); await bridge.start(); bridge.setToken(key, 'turn');
    onTestFinished(() => { bridge.stop(); client.stop(); setCheckClient(null); });
    const scratch = mkdtempSync(join(tmpdir(), 'hh-check-term-')), termed = join(scratch, 'termed');
    giveToUser(scratch);
    onTestFinished(() => { rmSync(scratch, { recursive: true, force: true }); });
    const command = `process.on("SIGTERM",()=>{require("fs").writeFileSync(${JSON.stringify(termed)},"yes")});process.stdout.write(String(process.pid));setInterval(()=>{},1000)`;
    const child = spawn(process.execPath, [cli, '--', process.execPath, '-e', command], {
      cwd: '/tmp', env: { PATH: process.env.PATH, HH_BRIDGE: bridge.agent(key).hookUrl }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    onTestFinished(() => { child.kill('SIGKILL'); });
    const pid = Number(await new Promise<string>(resolve => child.stdout.once('data', chunk => resolve(String(chunk)))));
    /* The grace runs on a clock the test moves: once the command has had TERM, just short of 5 s and then to them. */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => { vi.useRealTimers(); });
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('close', resolve));
    await eventually(() => existsSync(termed));
    await vi.advanceTimersByTimeAsync(4999);
    expect(released).toBe(false);
    expect(() => process.kill(pid, 0)).not.toThrow();
    await vi.advanceTimersByTimeAsync(1);
    await eventually(() => released);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  describe('with no turn of the agent running', () => {
    const STEP = '20000000-0000-4000-8000-000000000001';
    /* A machine queue that gives each slot at once, and what the node asked it for. */
    function grantingQueue() {
      const asked: Record<string, unknown>[] = [];
      const client = new CheckClient(frame => {
        if (frame.type === 'check.acquire') { asked.push(frame); queueMicrotask(() => client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 })); }
        return true;
      });
      client.online(true); setCheckClient(client);
      onTestFinished(() => { client.stop(); setCheckClient(null); });
      return asked;
    }
    async function bridgeWith(checkStep: OpensCheck) {
      const bridge = new Bridge('http://127.0.0.1:1', () => {}, null, { checkStep });
      await bridge.start();
      onTestFinished(() => bridge.stop());
      return bridge;
    }
    const run = (bridge: Bridge, key: string, script: string) => fetch(bridge.agent(key).hookUrl.replace('/hook/', '/check/'), {
      method: 'POST', body: JSON.stringify({ command: [process.execPath, '-e', script], cwd: '/tmp', env: { PATH: process.env.PATH } }),
    });

    it('runs a command in a step Hornhoof opens for it, with the slot asked for that step, and says how it ended', async () => {
      const key = '10000000-0000-4000-8000-000000000011';
      const asked = grantingQueue(), opened: string[] = [], ended: boolean[] = [];
      const bridge = await bridgeWith(async k => (opened.push(k), { jobId: STEP, signal: new AbortController().signal, end: ok => ended.push(ok) }));
      expect(await (await run(bridge, key, 'process.exit(7)')).text()).toContain('"type":"exit","code":7');
      expect(await (await run(bridge, key, 'process.exit(0)')).text()).toContain('"type":"exit","code":0');
      expect(opened).toEqual([key, key]);
      expect(ended).toEqual([false, true]);
      expect(asked).toMatchObject([{ agentId: key, jobId: STEP }, { agentId: key, jobId: STEP }]);
    });

    it("gives Hornhoof's words when the command may not run, and the old answer when Hornhoof cannot be asked", async () => {
      const key = '10000000-0000-4000-8000-000000000012';
      const words = 'This employee is switched off: its tools work again once a person switches it on.';
      const refusing = await bridgeWith(async () => ({ refused: words }));
      const refused = await run(refusing, key, 'process.exit(0)');
      expect([refused.status, await refused.text()]).toEqual([409, words]);
      const away = await bridgeWith(async () => null);
      expect((await run(away, key, 'process.exit(0)')).status).toBe(409);
      /* The program reads the words in what hh-check says. */
      const cliRun = spawn(process.execPath, [cli, '--', process.execPath, '-e', 'process.exit(0)'], {
        cwd: '/tmp', env: { PATH: process.env.PATH, HH_BRIDGE: refusing.agent(key).hookUrl }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      cliRun.stderr.on('data', chunk => (stderr += String(chunk)));
      expect(await new Promise(resolve => cliRun.once('close', resolve))).toBe(1);
      expect(stderr).toContain(words);
    });

    it('stops the command at once when Hornhoof stops its step, and not when a turn of the agent starts', async () => {
      const key = '10000000-0000-4000-8000-000000000013';
      grantingQueue();
      const stop = new AbortController(), ended: boolean[] = [];
      const bridge = await bridgeWith(async () => ({ jobId: STEP, signal: stop.signal, end: ok => ended.push(ok) }));
      const response = await run(bridge, key, 'process.stdout.write("up");setInterval(()=>{},1000)');
      const reader = response.body!.getReader();
      let seen = '';
      for (let part = await reader.read(); !part.done; part = await reader.read()) {
        seen += new TextDecoder().decode(part.value);
        if (seen.includes('"type":"stdout"')) break;
      }
      expect(seen).toContain('"type":"stdout"');
      /* A turn starts: what it stops when it ends are its own commands. */
      const kills = vi.spyOn(process, 'kill');
      bridge.setToken(key, 'turn');
      expect(kills).not.toHaveBeenCalled();
      kills.mockRestore();
      stop.abort();
      for (let part = await reader.read(); !part.done; part = await reader.read()) seen += new TextDecoder().decode(part.value);
      expect(seen).toContain('"type":"exit","code":null,"signal":"SIGTERM"');
      expect(ended).toEqual([false]);
    });
  });
});


/* Real child sentinel and queue protocol, but no real compiler or native CLI.
   The fixture executable only records whether the forbidden payload started. */
async function guardedCommandFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hh-guard-command-'));
  const key = '10000000-0000-4000-8000-000000000050';
  const root = join(dir, 'work', 'agents', key);
  mkdirSync(root, { recursive: true });
  const bin = join(root, 'bin'), sentinel = join(root, 'payload-started');
  mkdirSync(bin);
  const runner = join(bin, 'vitest');
  writeFileSync(runner, '#!/bin/sh\nprintf spawned > "$HH_GUARD_SENTINEL"\n');
  chmodSync(runner, 0o755);
  let acquired = 0;
  const client = new CheckClient(frame => {
    if (frame.type === 'check.acquire') {
      acquired++;
      queueMicrotask(() => client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 }));
    }
    return true;
  });
  client.online(true); setCheckClient(client); configureCheckCommands(user);
  giveToUser(dir);
  const bridge = new Bridge('http://127.0.0.1:1', () => {});
  await bridge.start(); bridge.setToken(key, 'current-fixture-turn');
  onTestFinished(() => { bridge.stop(); client.stop(); setCheckClient(null); configureCheckCommands(null); rmSync(dir, { recursive: true, force: true }); });
  const run = async (lease?: string, command = ['vitest', 'run'], signal?: AbortSignal) => {
    const response = await fetch(bridge.agent(key).hookUrl.replace('/hook/', '/check/'), {
      method: 'POST', signal, body: JSON.stringify({ command, cwd: root, env: { PATH: bin, HH_GUARD_SENTINEL: sentinel, HH_CHECK_SLOT: lease ?? 'forged-claim' }, ...(lease ? { lease } : {}) }),
    });
    return response.text();
  };
  return { dir, root, bin, key, bridge, run, acquired: () => acquired, sentinel };
}

describe('command policy boundary', () => {
  it('denies a missing guard before a command sentinel or a slot can start', async () => {
    const c = await guardedCommandFixture();
    const text = await c.run();
    expect(existsSync(c.sentinel)).toBe(false);
    expect(c.acquired()).toBe(0);
    expect(text).toContain('запусти через run_tests');
    expect(text).not.toContain('"type":"exit"');
  });

  it('denies a whole suite agent payload even while the same agent holds a genuine lease', async () => {
    const c = await guardedCommandFixture();
    configureCheckCommands(user, createAgentCommandGuard(c.dir));
    const text = await withCheckSlot(() => c.run(currentCheckLease()), { agentId: c.key });
    expect(existsSync(c.sentinel)).toBe(false);
    expect(c.acquired()).toBe(1);
    expect(text).toContain('запусти через run_tests');
    expect(text).not.toContain('"type":"exit"');
  });

  it('turns a throwing policy into a closed refusal before admission', async () => {
    const c = await guardedCommandFixture();
    configureCheckCommands(user, async () => { throw new Error('private diagnostic'); });
    const text = await c.run();
    expect({ started: existsSync(c.sentinel), acquired: c.acquired() }).toEqual({ started: false, acquired: 0 });
    expect(text).toContain('запусти через run_tests');
    expect(text).not.toContain('private diagnostic');
  });

  it('preserves a classified single-file command output and original nonzero exit', async () => {
    const c = await guardedCommandFixture();
    const program = join(c.bin, 'vitest');
    writeFileSync(program, '#!/bin/sh\nprintf single-file-output\nexit 7\n'); chmodSync(program, 0o755);
    writeFileSync(join(c.root, 'one.test.ts'), 'export {};');
    configureCheckCommands(user, createAgentCommandGuard(c.dir));
    const text = await c.run(undefined, ['vitest', 'run', 'one.test.ts']);
    expect(text).toContain(Buffer.from('single-file-output').toString('base64'));
    expect(text).toContain('"type":"exit","code":7');
    expect(c.acquired()).toBe(1);
  });

  it('does not admit a command whose current turn ends while its guard is pending', async () => {
    const c = await guardedCommandFixture();
    let entered!: () => void, release!: () => void, settled!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const finished = new Promise<void>(resolve => { settled = resolve; });
    configureCheckCommands(user, async () => { entered(); await gate; settled(); return { allow: true, kind: 'ordinary', coverage: 'opaque' }; });
    const request = c.run();
    await began;
    // Revocation aborts the server-owned signal synchronously, before policy settles.
    c.bridge.setToken(c.key, null);
    release(); await finished;
    await request;
    expect({ started: existsSync(c.sentinel), acquired: c.acquired() }).toEqual({ started: false, acquired: 0 });
  });
});

/* A heavy check an agent starts in its own shell waits for a machine check slot like for a lock, and runs right there. */
describe('a heavy check in the agent\'s own shell', () => {
  const output = (child: ReturnType<typeof spawn>) => new Promise<string>(resolve => {
    let stdout = ''; child.stdout!.on('data', chunk => { stdout += String(chunk); });
    child.once('close', code => resolve(`${code}:${stdout}`));
  });
  beforeEach(() => { configureCheckCommands(user); onTestFinished(() => configureCheckCommands(null)); });
  function machine(grantAtOnce: boolean, online = true, onRelease = () => {}) {
    const key = '10000000-0000-4000-8000-000000000011', frames: string[] = [];
    let grant = () => {}, end = () => {};
    const client = new CheckClient(frame => {
      frames.push(frame.type);
      if (frame.type === 'check.release') onRelease();
      if (frame.type === 'check.acquire') {
        grant = () => client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 });
        end = () => client.receive({ type: 'check.state', id: frame.id, state: 'ended', position: 0 });
      }
      if (grantAtOnce && frame.type === 'check.acquire') queueMicrotask(grant);
      return true;
    });
    client.online(online); setCheckClient(client);
    const bridge = new Bridge('http://127.0.0.1:1', () => {});
    onTestFinished(() => { bridge.stop(); client.stop(); setCheckClient(null); });
    const dir = mkdtempSync(join(tmpdir(), 'hh-check-wait-'));
    giveToUser(dir);
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    return { key, frames, bridge, dir, grant: () => grant(), end: () => end(), start: async () => { await bridge.start(); bridge.setToken(key, 'turn'); return bridge.agent(key).hookUrl; } };
  }

  it('runs the command in its own shell once a slot is given, and holds the slot until the command ends', async () => {
    const m = machine(false), hook = await m.start();
    const said = 'process.stdout.write([process.getuid(), process.cwd(), process.env.HH_CHECK_SLOT ? "slot" : "none"].join(" ")); process.exit(7)';
    const child = spawn(process.execPath, [cli, '--wait', '--', process.execPath, '-e', said], { uid: user?.uid, gid: user?.gid, cwd: m.dir, env: { PATH: process.env.PATH, HH_BRIDGE: hook }, stdio: ['ignore', 'pipe', 'pipe'] });
    const done = output(child);
    await eventually(() => m.frames.includes('check.acquire'));
    expect(m.frames).toEqual(['check.acquire']);
    m.grant();
    expect(await done).toBe(`7:${user?.uid ?? process.getuid!()} ${realpathSync(m.dir)} slot`);
    await eventually(() => m.frames.includes('check.release'));
    expect(m.frames).toEqual(['check.acquire', 'check.release']);
  });

  it.runIf(existsSync('/proc/self'))('stops the command and what it started as its slot ends, and gives the slot back only after', async () => {
    /* A process that was killed but not yet reaped is gone too. */
    const alive = (pid: number) => { try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };
    let leader = 0, grandchild = 0;
    const atRelease: boolean[] = [];
    const m = machine(true, true, () => atRelease.push(alive(leader) || alive(grandchild))), hook = await m.start();
    const started = join(m.dir, 'started');
    const starts = 'const g = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); require("node:fs").writeFileSync(process.argv[1], [process.pid, g.pid].join(" ")); setInterval(() => {}, 1000)';
    const child = spawn(process.execPath, [cli, '--wait', '--', process.execPath, '-e', starts, started], { uid: user?.uid, gid: user?.gid, cwd: m.dir, env: { PATH: process.env.PATH, HH_BRIDGE: hook }, stdio: ['ignore', 'pipe', 'pipe'] });
    const done = output(child);
    /* A run that fails leaves nothing behind; a pid never named stays unsent, as 0 would mean this test's own group. */
    onTestFinished(() => { for (const pid of [child.pid ?? 0, leader, grandchild]) if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL'); });
    await eventually(() => existsSync(started) && readFileSync(started, 'utf8') !== '');
    [leader, grandchild] = readFileSync(started, 'utf8').split(' ').map(Number) as [number, number];
    expect([alive(leader), alive(grandchild)]).toEqual([true, true]);
    m.end();
    expect(await done).toBe('143:');
    await eventually(() => m.frames.includes('check.release'));
    expect(atRelease).toEqual([false]);
    expect([alive(leader), alive(grandchild)]).toEqual([false, false]);
  });

  it('runs the command at once when the machine has no slot to give or it is not an agent\'s', async () => {
    const m = machine(false, false), hook = await m.start();
    const said = 'process.stdout.write(process.env.HH_CHECK_SLOT ?? "none"); process.exit(3)';
    const run = (env: NodeJS.ProcessEnv) => output(spawn(process.execPath, [cli, '--wait', '--', process.execPath, '-e', said], { uid: user?.uid, gid: user?.gid, env, stdio: ['ignore', 'pipe', 'pipe'] }));
    expect(await run({ PATH: process.env.PATH, HH_BRIDGE: hook })).toBe('3:none');
    expect(await run({ PATH: process.env.PATH })).toBe('3:none');
  });

  it.runIf(existsSync('/proc/self'))('keeps no running group past the slot when its wrapper is killed', async () => {
    const alive = (pid: number) => { try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };
    let leader = 0;
    const atRelease: boolean[] = [];
    const m = machine(true, true, () => atRelease.push(alive(leader))), hook = await m.start();
    const started = join(m.dir, 'started');
    const payload = 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)';
    const child = spawn(process.execPath, [cli, '--wait', '--', process.execPath, '-e', payload, started], { uid: user?.uid, gid: user?.gid, cwd: m.dir, env: { PATH: process.env.PATH, HH_BRIDGE: hook }, stdio: ['ignore', 'pipe', 'pipe'] });
    onTestFinished(() => {
      if (leader > 0 && alive(leader)) process.kill(leader, 'SIGKILL');
      if (child.pid && alive(child.pid)) child.kill('SIGKILL');
    });
    await eventually(() => existsSync(started) && readFileSync(started, 'utf8') !== '');
    leader = Number(readFileSync(started, 'utf8'));
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await exited;
    await eventually(() => m.frames.includes('check.release'));
    expect(atRelease).toEqual([false]);
    expect(alive(leader)).toBe(false);
  });

  it('makes an agent\'s tsc, vitest, eslint, jest and playwright wait for a slot however they start, and nothing else', async () => {
    const m = machine(true), hook = await m.start();
    installCheckCommand(m.dir, cli);
    mkdirSync(join(m.dir, 'node_modules', '.bin'), { recursive: true });
    const tool = (name: string) => {
      const path = join(m.dir, 'node_modules', '.bin', name);
      writeFileSync(path, '#!/usr/bin/env node\nprocess.stdout.write(process.env.HH_CHECK_SLOT ? "slot" : "none");\n', { mode: 0o755 });
      return path;
    };
    const path = `${join(m.dir, 'tools', 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`, agent = { PATH: path, HH_BRIDGE: hook };
    const run = (command: string, args: string[], env: NodeJS.ProcessEnv = agent) => output(spawn(command, args, { uid: user?.uid, gid: user?.gid, env, stdio: ['ignore', 'pipe', 'pipe'] }));
    /* As npx and npm scripts start them: by the name in node_modules/.bin, whose first line asks for node. */
    for (const name of ['tsc', 'vitest', 'eslint', 'jest', 'playwright']) expect(await run(tool(name), ['--noEmit']), name).toBe('0:slot');
    expect(await run(join(m.dir, 'tools', 'bin', 'node'), [tool('vitest'), 'run'])).toBe('0:slot');
    expect(m.frames.filter(type => type === 'check.acquire')).toHaveLength(6);
    expect(await run(tool('light'), [])).toBe('0:none');
    expect(await run(tool('tsc'), [], { PATH: path })).toBe('0:none');
    /* One that runs inside a check already holds its slot. */
    expect(await run(tool('vitest'), [], { ...agent, HH_CHECK_SLOT: 'held' })).toBe('0:slot');
    expect(m.frames.filter(type => type === 'check.acquire')).toHaveLength(6);
  });
});
