import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { listenIn } from '../../../test-support/ports.mjs';
import { claudeProgram } from '../src/providers/claude-terminal.js';

const HOOK = fileURLToPath(new URL('../hh-hook.cjs', import.meta.url));
const run = promisify(execFile);

describe('hh-hook', () => {
  it('tells a program that compacted its conversation to read the company again, without a bridge', () => {
    const out = execFileSync('node', [HOOK, 'compact', '{}'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    expect(out).toContain('compacted');
    expect(out).toContain('instructions');
  });

  it('prints nothing for the events it only passes on', () => {
    expect(execFileSync('node', [HOOK, 'status', '{}'], { env: { PATH: process.env.PATH }, encoding: 'utf8' })).toBe('');
  });

  /* The program adds what its prompt hook prints to the prompt; a status line shows what its command prints. */
  it("prints the bridge's answer to a prompt, and only to a prompt", async () => {
    const bridge = createServer((req, res) => req.resume().on('end', () => res.end(`said to ${req.url}`)));
    await listenIn(bridge);
    const env = { PATH: process.env.PATH, HH_BRIDGE: `http://127.0.0.1:${(bridge.address() as AddressInfo).port}` };
    try {
      expect((await run('node', [HOOK, 'prompt', '{"prompt":"hi"}'], { env })).stdout).toBe('said to /prompt\n');
      for (const event of ['status', 'invocation', 'tool', 'tooldone', 'toolfail', 'ask', 'interrupt', 'end']) {
        expect((await run('node', [HOOK, event, '{}'], { env })).stdout).toBe('');
      }
    } finally {
      bridge.close();
    }
  });
});

/* A program gives up on a hook as Claude Code gives up on a status line a newer one overtook, or on a hook past its time:
   it ends the process it started, and only that one. Claude starts each hook as `/bin/sh -c <command>` in a session of its
   own, so a hook that outlived its shell belonged to no program any more, still called the bridge, and the node refused it
   as a caller outside the agent's pane. A hook its program let go must say nothing. */
describe.runIf(process.platform === 'linux')('a hook its program let go', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { for (const clean of cleanups.splice(0).reverse()) clean(); });

  async function bridge(): Promise<{ url: string; heard: string[] }> {
    const heard: string[] = [];
    const server: Server = createServer((req, res) => req.resume().on('end', () => { heard.push(req.url ?? ''); res.end(); }));
    await listenIn(server);
    cleanups.push(() => server.close());
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, heard };
  }

  /* hh-hook on the PATH, as the node installs it. */
  function hookOnPath(): string {
    const bin = mkdtempSync(join(tmpdir(), 'hh-hook-bin-'));
    cleanups.push(() => rmSync(bin, { recursive: true, force: true }));
    writeFileSync(join(bin, 'hh-hook'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(HOOK)} "$@"\n`);
    chmodSync(join(bin, 'hh-hook'), 0o755);
    return bin;
  }

  /* The live hh-hook processes among these pids and their children, with their parents. */
  function hooksOf(pids: number[]): { pid: number; ppid: number }[] {
    const found: { pid: number; ppid: number }[] = [];
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        if (!readFileSync(`/proc/${name}/cmdline`, 'utf8').includes(HOOK)) continue;
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        const [state, ppid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (state !== 'Z' && (pids.includes(Number(name)) || pids.includes(Number(ppid)))) found.push({ pid: Number(name), ppid: Number(ppid) });
      } catch { /* gone meanwhile */ }
    }
    return found;
  }

  const alive = (pid: number) => { try { return !readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.startsWith('Z'); } catch { return false; } };

  async function until(done: () => boolean, what: string): Promise<void> {
    for (const end = Date.now() + 10_000; !done(); await new Promise(resolve => setTimeout(resolve, 20))) {
      if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
    }
  }

  /* The program writes the hook's input as it ends the hook's shell. A hook already over by then has closed its end,
     and the write is refused with EPIPE; that refusal is no fault, any other is. */
  function feed(child: ChildProcess, input: string): void {
    child.stdin!.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') throw error; });
    child.stdin!.end(input);
  }

  function track(child: ChildProcess): number {
    cleanups.push(() => { try { process.kill(child.pid!, 'SIGKILL'); } catch { /* gone */ } });
    return child.pid!;
  }

  it('ends with the shell its program started it in, so it calls nothing once the program ends that shell', async () => {
    const { url, heard } = await bridge();
    const settings = JSON.parse(claudeProgram.launch({ bin: '/t/claude', home: '/h', workDir: '/w', sessionId: null, model: null, instructionsFile: null, urls: { mcpUrl: url, mcpAddress: url, secret: 's', attachUrl: url, hookUrl: url } }).command.find(arg => arg.startsWith('{'))!);
    /* As Claude Code runs its status line: a shell of its own, in a session of its own, with the program's input. */
    const shell = spawn('/bin/sh', ['-c', settings.statusLine.command], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: `${hookOnPath()}:${process.env.PATH}`, HH_BRIDGE: url } });
    const sh = track(shell);
    await until(() => hooksOf([sh]).length === 1, 'the hook runs');
    const [hook] = hooksOf([sh]);
    cleanups.push(() => { try { process.kill(hook!.pid, 'SIGKILL'); } catch { /* gone */ } });
    process.kill(sh, 'SIGTERM');
    feed(shell, '{}');
    await until(() => !alive(hook!.pid), 'the hook is over');
    expect(heard).toEqual([]);
  });

  it('calls nothing once the process that ran it is gone', async () => {
    const { url, heard } = await bridge();
    const runs = `require('node:child_process').spawn(process.execPath, [${JSON.stringify(HOOK)}, 'tool'], { stdio: 'inherit' }); setInterval(() => {}, 60000);`;
    const runner = spawn(process.execPath, ['-e', runs], { stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: process.env.PATH, HH_BRIDGE: url } });
    const parent = track(runner);
    await until(() => hooksOf([parent]).some(h => h.ppid === parent), 'the hook runs');
    const hook = hooksOf([parent]).find(h => h.ppid === parent)!;
    cleanups.push(() => { try { process.kill(hook.pid, 'SIGKILL'); } catch { /* gone */ } });
    process.kill(parent, 'SIGKILL');
    feed(runner, '{}');
    await until(() => !alive(hook.pid), 'the hook is over');
    expect(heard).toEqual([]);
  });

  it('still calls the bridge while the process that ran it is there', async () => {
    const { url, heard } = await bridge();
    const runs = `const c = require('node:child_process').spawn(process.execPath, [${JSON.stringify(HOOK)}, 'tool'], { stdio: 'inherit' }); c.on('exit', () => process.exit(0));`;
    const runner = spawn(process.execPath, ['-e', runs], { stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: process.env.PATH, HH_BRIDGE: url } });
    track(runner);
    runner.stdin!.end('{}');
    await new Promise(resolve => runner.on('exit', resolve));
    expect(heard).toEqual(['/tool']);
  });
});
