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
]);

async function write(stream: Writable, bytes: string | Buffer): Promise<void> {
  if (!stream.write(bytes)) await once(stream, 'drain');
}

async function show(frame: z.infer<typeof Frame>): Promise<number | null> {
  switch (frame.type) {
    case 'queued': await write(process.stderr, `Waiting for a machine check slot. Position ${frame.position}.\n`); return null;
    case 'slot': return null;
    case 'stdout': await write(process.stdout, Buffer.from(frame.data, 'base64')); return null;
    case 'stderr': await write(process.stderr, Buffer.from(frame.data, 'base64')); return null;
    case 'error': throw new Error(frame.message);
    case 'exit': return frame.code ?? 1;
  }
}

/* The bridge's frames as they come. */
async function* frames(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<z.infer<typeof Frame>> {
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

/* The lease of the slot the machine gave, which stays this command's while the request stays open. */
async function slot(command: string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string | undefined> {
  if (!env.HH_BRIDGE) return undefined;
  const response = await ask(env, { command, cwd: process.cwd(), env: {}, wait: true, ...(env.HH_CHECK_SLOT ? { lease: env.HH_CHECK_SLOT } : {}) }, signal);
  if (!response.ok || !response.body) return undefined;
  for await (const frame of frames(response.body.getReader())) {
    if (frame.type === 'slot') return frame.lease;
    await show(frame);
  }
  return undefined;
}

/* hh-check --wait -- COMMAND: the command runs here, in the agent's own shell, once the machine gives it a check slot, and
   holds the slot until it ends, like a lock; what runs inside it holds the same slot. With no slot to be had, as with no
   turn or with the node away from Hornhoof, it runs at once, as it would with no queue. */
async function waited(command: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const stop = new AbortController();
  try {
    const lease = await slot(command, env, stop.signal).catch(() => undefined);
    const child = spawn(command[0]!, command.slice(1), { stdio: 'inherit', env: lease ? { ...env, HH_CHECK_SLOT: lease } : env });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal));
    const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    return code ?? (signal ? 128 + constants.signals[signal] : 1);
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
