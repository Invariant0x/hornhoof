#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:os';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const Frame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('queued'), position: z.number().int().positive() }),
  z.object({ type: z.literal('slot'), lease: z.string() }),
  z.object({ type: z.enum(['stdout', 'stderr']), data: z.string().max(2 * 1024 * 1024) }),
  z.object({ type: z.literal('exit'), code: z.number().int().min(0).max(255).nullable() }),
  z.object({ type: z.literal('error'), message: z.string() }),
  /* The node's word that the slot or the turn of a waiting command ended. */
  z.object({ type: z.literal('stop'), message: z.string() }),
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
    case 'slot': return null;
    case 'stdout': await write(process.stdout, Buffer.from(frame.data, 'base64')); return null;
    case 'stderr': await write(process.stderr, Buffer.from(frame.data, 'base64')); return null;
    case 'error': case 'stop': throw new Error(frame.message);
    case 'exit': return frame.code ?? 1;
  }
}

/* The bridge's frames as they come. */
async function* frames(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<Frame> {
  const decoder = new TextDecoder();
  let pending = '';
  for (;;) {
    const chunk = await reader.read();
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
async function slot(command: string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Held | undefined> {
  if (!env.HH_BRIDGE) return undefined;
  const response = await ask(env, { command, cwd: process.cwd(), env: {}, wait: true, ...(env.HH_CHECK_SLOT ? { lease: env.HH_CHECK_SLOT } : {}) }, signal);
  if (!response.ok || !response.body) return undefined;
  const rest = frames(response.body.getReader());
  for (;;) {
    const next = await rest.next();
    if (next.done) return undefined;
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

/* hh-check --wait -- COMMAND: the command runs here, in the agent's own shell, once the machine gives it a check slot, and
   holds the slot until it ends, like a lock; what runs inside it holds the same slot. With no slot to be had, as with no
   turn or with the node away from Hornhoof, it runs at once, as it would with no queue.
   Under a slot the command leads a process group of its own, so that what it starts stops with it: as the slot goes first,
   the group gets TERM, and KILL after a grace; such a check never passes, it ends with 128 and the signal, as a shell says.
   As the command ends, what it left in its group is killed before the slot goes. */
async function waited(command: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const stop = new AbortController();
  try {
    const held = await slot(command, env, stop.signal).catch(() => undefined);
    const child = spawn(command[0]!, command.slice(1), { stdio: 'inherit', detached: Boolean(held), env: held ? { ...env, HH_CHECK_SLOT: held.lease } : env });
    const signal = (value: NodeJS.Signals) => {
      if (!held || !child.pid) { child.kill(value); return; }
      try { process.kill(-child.pid, value); } catch { /* The group is gone already. */ }
    };
    for (const value of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(value, () => signal(value));
    let ended = false, stopped = null as NodeJS.Signals | null, killing: NodeJS.Timeout | undefined;
    if (held) void lapsed(held.rest).then(async why => {
      if (ended) return;
      stopped = 'SIGTERM'; signal('SIGTERM');
      killing = setTimeout(() => { stopped = 'SIGKILL'; signal('SIGKILL'); }, KILL_AFTER_MS);
      await write(process.stderr, `${why} The command stops.\n`);
    });
    const [code, by] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    ended = true; clearTimeout(killing);
    if (held) signal('SIGKILL');
    const ending = stopped ?? (code === null ? by : null);
    return ending ? 128 + constants.signals[ending] : code ?? 1;
  } finally { stop.abort(); }
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
