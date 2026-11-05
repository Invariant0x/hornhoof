#!/usr/bin/env node
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const Frame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('queued'), position: z.number().int().positive() }),
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
    case 'stdout': await write(process.stdout, Buffer.from(frame.data, 'base64')); return null;
    case 'stderr': await write(process.stderr, Buffer.from(frame.data, 'base64')); return null;
    case 'error': throw new Error(frame.message);
    case 'exit': return frame.code ?? 1;
  }
}

async function consume(body: ReadableStream<Uint8Array>): Promise<number> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let pending = '', code = 1;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return code;
      pending += decoder.decode(chunk.value, { stream: true });
      if (pending.length > 4 * 1024 * 1024) throw new Error('The check bridge frame is too large.');
      const lines = pending.split('\n'); pending = lines.pop()!;
      for (const line of lines) code = await show(Frame.parse(JSON.parse(line))) ?? code;
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export async function checkCommand(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const command = args[0] === '--' ? args.slice(1) : args;
  if (!command.length) throw new Error('Usage: hh-check -- COMMAND [ARGUMENTS]');
  if (!env.HH_BRIDGE) throw new Error('hh-check works inside a Hornhoof agent turn.');
  const stop = new AbortController(), abort = () => stop.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const url = new URL(env.HH_BRIDGE); url.pathname = url.pathname.replace('/hook/', '/check/');
    const response = await fetch(url, { method: 'POST', headers: { 'x-hh-pid': String(process.pid) }, signal: stop.signal,
      body: JSON.stringify({ command, cwd: process.cwd(), env, ...(env.HH_CHECK_SLOT ? { lease: env.HH_CHECK_SLOT } : {}) }) });
    if (!response.ok || !response.body) throw new Error(`The machine check bridge answered ${response.status}.`);
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
