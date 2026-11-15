import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { JobUser } from './isolation.js';
import { currentCheckLease, reuseCheckLease, withCheckSlot } from './check-queue.js';
import { trackCheckProcess } from './check-processes.js';
import { refusalText, type AgentCommandVerdict, type CommandInput } from './command-guard.js';

export type CheckCommandGuard = (key: string, input: Pick<CommandInput, 'command' | 'cwd'>) => Promise<AgentCommandVerdict>;

const Word = z.string().max(100_000).refine(value => !value.includes('\0'));
const Command = z.object({ command: z.array(Word).min(1).max(1000), cwd: Word, env: z.record(z.string().regex(/^[^=\0]+$/), Word), lease: z.uuid().optional() });
type Command = z.infer<typeof Command>;
let user: JobUser | null = null;
let commandGuard: CheckCommandGuard | undefined;

export function configureCheckCommands(owner: JobUser | null, guard?: CheckCommandGuard): void { user = owner; commandGuard = guard; }

async function commandPolicy(key: string, input: Command): Promise<AgentCommandVerdict> {
  try {
    if (commandGuard) return await commandGuard(key, input);
  } catch { /* Policy failure cannot authorize a command or disclose its diagnostics. */ }
  return { allow: false, code: 'command_guard_unavailable', category: 'command_context' };
}

export function installCheckCommand(dir: string): void {
  const bin = join(dir, 'tools', 'bin'), target = fileURLToPath(new URL('./check-command.js', import.meta.url));
  mkdirSync(bin, { recursive: true });
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const marker = '#!/bin/sh\n# Hornhoof machine check command.\n';
  const script = `${marker}exec ${quote(process.execPath)} ${quote(target)} "$@"\n`;
  const path = join(bin, 'hh-check'), existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing) {
    if (!existing.isFile()) throw new Error('The hh-check command path is already occupied.');
    const previous = readFileSync(path, 'utf8');
    if (previous === script) return;
    if (!previous.startsWith(marker)) throw new Error('The hh-check command path is already occupied.');
  }
  writeFileSync(path, script, { mode: 0o755 });
}

function send(res: ServerResponse, frame: object): boolean {
  return !res.destroyed && !res.writableEnded && res.write(`${JSON.stringify(frame)}\n`);
}

async function assertCommandPolicy(key: string, input: Command, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const verdict = await commandPolicy(key, input);
  signal.throwIfAborted();
  if (!verdict.allow) throw new Error(refusalText(verdict));
}

/* jobId: the step of the tools Hornhoof opened for a command with no turn running, whose slot it is. */
async function admitCommand(key: string, input: Command, signal: AbortSignal, res: ServerResponse, jobId: string | undefined): Promise<boolean> {
  const run = (slotSignal: AbortSignal) => runCommand(key, input, slotSignal, res);
  if (input.lease) return reuseCheckLease(input.lease, key, signal, run);
  return withCheckSlot(run, { agentId: key, ...(jobId ? { jobId } : {}), label: basename(input.command[0]).slice(0, 100), signal, onPosition: position => { send(res, { type: 'queued', position }); } });
}

function assertCommandUser(): void {
  if ((user?.uid ?? process.getuid?.()) === 0) throw new Error('Check commands require an agent user.');
}

function parseCommand(body: Buffer): Command {
  const input = Command.parse(JSON.parse(body.toString('utf8')));
  if (!input.command[0]) throw new Error('A check command needs a program.');
  return input;
}

/* True when the command ran to its end with code 0. */
export async function serveCheckCommand(key: string, body: Buffer, signal: AbortSignal, res: ServerResponse, jobId?: string): Promise<boolean> {
  assertCommandUser();
  const input = parseCommand(body);
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  try {
    await assertCommandPolicy(key, input, signal);
    return await admitCommand(key, input, signal, res, jobId);
  } catch (error) {
    send(res, { type: 'error', message: error instanceof Error ? error.message : 'Check command stopped.' });
    return false;
  } finally { res.end(); }
}

function output(stream: Readable, type: string, res: ServerResponse): void {
  stream.on('data', (chunk: Buffer) => {
    if (!send(res, { type, data: chunk.toString('base64') }) && !res.destroyed) {
      stream.pause(); res.once('drain', () => stream.resume());
    }
  });
}

function killCommandGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  try { if (pid) process.kill(-pid, signal); } catch { /* Already gone. */ }
}

async function runCommand(key: string, input: Command, signal: AbortSignal, res: ServerResponse): Promise<boolean> {
  signal.throwIfAborted();
  /* The shell changes directory after dropping privileges. The node never opens an agent's cwd as root. */
  const child = spawn('/bin/bash', ['-c', 'cd -- "$1" || exit; shift; exec "$@"', 'hh-check', input.cwd, ...input.command], {
    uid: user?.uid, gid: user?.gid, env: { ...input.env, ...(currentCheckLease() ? { HH_CHECK_SLOT: currentCheckLease() } : {}) }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  output(child.stdout, 'stdout', res); output(child.stderr, 'stderr', res);
  const forget = trackCheckProcess(key, child.pid);
  try { return await new Promise<boolean>((resolve, reject) => {
    let killing: NodeJS.Timeout | undefined;
    const kill = (value: NodeJS.Signals) => killCommandGroup(child.pid, value);
    const abort = () => { kill('SIGTERM'); killing ??= setTimeout(() => kill('SIGKILL'), 5000); };
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', reject);
    /* End descendants before waiting for the pipes they inherited to close. */
    child.once('exit', () => kill('SIGKILL'));
    child.once('close', (code, exitSignal) => {
      signal.removeEventListener('abort', abort);
      if (killing) clearTimeout(killing);
      /* A child may have left a compiler in its process group after exiting. */
      kill('SIGKILL');
      send(res, { type: 'exit', code, signal: exitSignal }); resolve(code === 0);
    });
    if (signal.aborted) abort();
  }); } finally { forget(); }
}
