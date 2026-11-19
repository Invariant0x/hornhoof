#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:os';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { checkGroupProcess, type CheckGroup } from './check-group.js';

const Frame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('unavailable') }),
  z.object({ type: z.literal('queued'), position: z.number().int().positive() }),
  z.object({ type: z.literal('slot'), lease: z.string() }),
  z.object({ type: z.enum(['stdout', 'stderr']), data: z.string().max(2 * 1024 * 1024) }),
  z.object({ type: z.literal('exit'), code: z.number().int().min(0).max(255).nullable() }),
  z.object({ type: z.literal('error'), message: z.string() }),
  /* The node's word that the slot or the turn of a waiting command ended. */
  z.object({ type: z.literal('stop'), message: z.string() }),
  /* Nothing to say yet: the stream is alive while the command waits for its slot or runs under it. */
  z.object({ type: z.literal('alive') }),
]);
type Frame = z.infer<typeof Frame>;

/* How long a command told to stop with TERM has before its group is killed, as on the node. */
const KILL_AFTER_MS = 5000;

async function write(stream: Writable, bytes: string | Buffer): Promise<void> {
  if (!stream.write(bytes)) await once(stream, 'drain');
}

async function show(frame: Frame): Promise<number | null> {
  switch (frame.type) {
    case 'queued': await write(process.stderr, `Waiting for a machine check slot. Position ${frame.position}.\n`); return null;
    case 'slot': case 'unavailable': case 'alive': return null;
    case 'stdout': await write(process.stdout, Buffer.from(frame.data, 'base64')); return null;
    case 'stderr': await write(process.stderr, Buffer.from(frame.data, 'base64')); return null;
    case 'error': case 'stop': throw new Error(frame.message);
    case 'exit': return frame.code ?? 1;
  }
}

/* The connection to the bridge failed. Node's fetch says only "terminated" then; why is in its cause, such as the node
   going away ("other side closed"). */
class BridgeGone extends Error {
  constructor(readonly why: string) { super(`The connection to the node's machine check bridge ended (${why}).`); }
}

function read(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
  return reader.read().catch((error: unknown) => {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    throw new BridgeGone(cause instanceof Error ? cause.message : String(cause));
  });
}

/* The bridge's frames as they come. */
async function* frames(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<Frame> {
  const decoder = new TextDecoder();
  let pending = '';
  for (;;) {
    const chunk = await read(reader);
    if (chunk.done) return;
    pending += decoder.decode(chunk.value, { stream: true });
    if (pending.length > 4 * 1024 * 1024) throw new Error('The check bridge frame is too large.');
    const lines = pending.split('\n'); pending = lines.pop()!;
    for (const line of lines) yield Frame.parse(JSON.parse(line));
  }
}

async function consume(body: ReadableStream<Uint8Array>): Promise<number> {
  const reader = body.getReader();
  let code = 1;
  try {
    for await (const frame of frames(reader)) code = await show(frame) ?? code;
    return code;
  } finally { await reader.cancel().catch(() => {}); }
}

function ask(env: NodeJS.ProcessEnv, body: object, signal: AbortSignal): Promise<Response> {
  const url = new URL(env.HH_BRIDGE!); url.pathname = url.pathname.replace('/hook/', '/check/');
  return fetch(url, { method: 'POST', headers: { 'x-hh-pid': String(process.pid) }, signal, body: JSON.stringify(body) });
}

type Held = { lease: string; rest: AsyncGenerator<Frame> };

/* The lease of the slot the machine gave, which stays this command's while the request stays open, and the rest of the
   request's stream. */
async function slot(command: string[], env: NodeJS.ProcessEnv, signal: AbortSignal, group?: CheckGroup): Promise<Held | undefined> {
  if (!env.HH_BRIDGE) return undefined;
  const response = await ask(env, { command, cwd: process.cwd(), env: {}, wait: true, ...(group ? { group } : {}), ...(env.HH_CHECK_SLOT ? { lease: env.HH_CHECK_SLOT } : {}) }, signal).catch(error => { if (signal.aborted) throw error; return null; });
  if (!response || response.status === 409) return undefined;
  if (!response.ok || !response.body) throw new Error(`The machine check bridge answered ${response.status}.`);
  const rest = frames(response.body.getReader());
  for (;;) {
    const next = await rest.next().catch((error: unknown) => {
      throw error instanceof BridgeGone ? new Error(`The connection to the node's machine check bridge ended before the command got a slot (${error.why}).`) : error;
    });
    if (next.done) throw new Error('The machine check bridge ended before admission.');
    if (next.value.type === 'unavailable') return undefined;
    if (next.value.type === 'slot') return { lease: next.value.lease, rest };
    await show(next.value);
  }
}

/* The slot goes as the rest of its stream ends, fails, or brings the node's word that the slot or the turn ended: why. */
async function lapsed(rest: AsyncGenerator<Frame>): Promise<string> {
  try {
    for (;;) {
      const next = await rest.next();
      if (next.done) return 'The machine check slot ended.';
      await show(next.value);
    }
  } catch (error) { return error instanceof Error && error.message ? error.message : 'The machine check slot ended.'; }
}

/* Outside an agent turn there is no machine lease. Preserve the ordinary local command and shell signal status. */
async function localWaited(command: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn(command[0]!, command.slice(1), { stdio: 'inherit', detached: false, env });
  let stopped: NodeJS.Signals | null = null, killing: NodeJS.Timeout | undefined;
  const cancel = (value: NodeJS.Signals) => {
    stopped ??= value; child.kill(value);
    killing ??= setTimeout(() => { stopped = 'SIGKILL'; child.kill('SIGKILL'); }, KILL_AFTER_MS);
  };
  const listeners = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(value => ({ value, stop: () => cancel(value) }));
  for (const listener of listeners) process.on(listener.value, listener.stop);
  try {
    const [code, by] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
    const ending = stopped ?? (code === null ? by : null);
    return ending ? 128 + constants.signals[ending] : code ?? 1;
  } finally {
    clearTimeout(killing);
    for (const listener of listeners) process.removeListener(listener.value, listener.stop);
  }
}

/* This local leader has no payload until the node owns its identity and grants admission. IPC loss before that
   admission exits it without starting work. Afterwards it stays alive as the group's identity anchor until cleanup:
   under a slot also once its payload ended, as the node ends the group only while this leader still names it and kills
   the leader last. A node that never comes for the group leaves it to the leader, the one that may end it safely. */
export const ANCHOR_MS = 60_000;
export const PARKED_CHECK = String.raw`
const { spawn } = require('node:child_process');
const ANCHOR_MS = ${ANCHOR_MS};
let started = false, stopped = null, managed = false;
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { stopped = signal; });
process.on('disconnect', () => {
  if (!started) process.exit(1);
  if (!managed) process.kill(-process.pid, 'SIGKILL');
});
process.on('message', message => {
  if (started || stopped) return;
  started = true; managed = message.managed;
  const child = spawn(message.command[0], message.command.slice(1), { stdio: 'inherit', env: message.env });
  const tell = result => { if (process.connected) process.send(result, () => {}); };
  child.once('error', () => tell({ code: 127, signal: null }));
  child.once('exit', (code, signal) => {
    tell({ code: stopped ? null : code, signal: stopped ?? signal });
    if (managed) setTimeout(() => process.kill(-process.pid, 'SIGKILL'), ANCHOR_MS);
  });
});
if (!process.connected) process.exit(1);
`;

async function waited(command: string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (!env.HH_BRIDGE) return localWaited(command, env);
  const stop = new AbortController();
  const child = spawn(process.execPath, ['-e', PARKED_CHECK], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], detached: true, env: { ...env, NODE_OPTIONS: '' } });
  let ended = false, stopped: NodeJS.Signals | null = null, killing: NodeJS.Timeout | undefined;
  const signal = (value: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, value); } catch { /* The group is gone. */ } };
  const result = new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, by) => resolve([code, by]));
    child.on('message', message => {
      const parsed = z.object({ code: z.number().int().min(0).max(255).nullable(), signal: z.string().nullable() }).safeParse(message);
      if (parsed.success) resolve([parsed.data.code, parsed.data.signal as NodeJS.Signals | null]);
    });
  });
  /* A spawn error can precede the first await of result. */
  void result.catch(() => {});
  const cancel = (value: NodeJS.Signals) => {
    if (ended) return;
    stopped ??= value; signal(value);
    stop.abort();
    killing ??= setTimeout(() => { stopped = 'SIGKILL'; signal('SIGKILL'); }, KILL_AFTER_MS);
  };
  const listeners = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(value => ({ value, stop: () => cancel(value) }));
  for (const listener of listeners) process.on(listener.value, listener.stop);
  try {
    await once(child, 'spawn');
    if (!child.pid) throw new Error('The waiting check has no group leader.');
    const group = await checkGroupProcess(child.pid);
    if (!group || group.group !== child.pid || group.session !== child.pid) throw new Error('The waiting check group cannot be identified.');
    const held = await slot(command, env, stop.signal, { pid: child.pid, started: group.started });
    stop.signal.throwIfAborted();
    child.send({ command, env: held ? { ...env, HH_CHECK_SLOT: held.lease } : env, managed: Boolean(held) });
    if (held) void lapsed(held.rest).then(async why => {
      if (ended) return;
      cancel('SIGTERM');
      await write(process.stderr, `${why} The command stops.\n`).catch(() => {});
    });
    const [code, by] = await result;
    const ending = stopped ?? (code === null ? by : null);
    return ending ? 128 + constants.signals[ending] : code ?? 1;
  } catch (error) {
    if (stopped) return 128 + constants.signals[stopped];
    throw error;
  } finally {
    ended = true; stop.abort(); clearTimeout(killing);
    for (const listener of listeners) process.removeListener(listener.value, listener.stop);
    if (child.connected) child.disconnect();
    child.unref();
  }
}

/* The words a refusal gives, as the bridge says why the command may not run now. */
async function said(response: Response): Promise<string> {
  const text = (await response.text().catch(() => '')).trim().slice(0, 500);
  return text ? ` ${text}` : '';
}

export async function checkCommand(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const wait = args[0] === '--wait', rest = wait ? args.slice(1) : args;
  const command = rest[0] === '--' ? rest.slice(1) : rest;
  if (!command.length) throw new Error('Usage: hh-check [--wait] -- COMMAND [ARGUMENTS]');
  /* A run part has no agent bridge. Its own process group already runs under the inherited slot. */
  if (env.HH_CHECK_SLOT && !env.HH_BRIDGE) return localWaited(command, env);
  if (wait) return waited(command, env);
  if (!env.HH_BRIDGE) throw new Error('hh-check works inside a Hornhoof agent turn.');
  const stop = new AbortController(), abort = () => stop.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const response = await ask(env, { command, cwd: process.cwd(), env, ...(env.HH_CHECK_SLOT ? { lease: env.HH_CHECK_SLOT } : {}) }, stop.signal);
    if (!response.ok || !response.body) throw new Error(`The machine check bridge answered ${response.status}.${await said(response)}`);
    return await consume(response.body);
  } finally {
    stop.abort(); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void checkCommand(process.argv.slice(2), process.env).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Heavy command stopped.'}\n`); process.exitCode = 1;
  });
}
