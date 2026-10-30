#!/usr/bin/env node
// hh-hook EVENT [JSON]: Claude Code's hooks and status line, and Codex's notify, call this to tell the node how the agent's
// turn goes: start, prompt, stop, status. It reads the program's JSON from the last argument or from stdin, posts it to the
// node's bridge in HH_BRIDGE and prints nothing, so a status line stays empty. It never fails the program's turn.
'use strict';

const WAIT_MS = { prompt: 12000 };

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('');
    let text = '';
    const done = () => resolve(text);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => (text += c));
    process.stdin.on('end', done);
    setTimeout(done, 1000).unref();
  });
}

async function main() {
  const event = process.argv[2];
  const url = process.env.HH_BRIDGE;
  if (!event || !url || !/^[a-z]+$/.test(event)) return;
  const body = process.argv[3] ?? (await readStdin());
  await fetch(`${url}/${event}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body || '{}',
    signal: AbortSignal.timeout(WAIT_MS[event] ?? 3000),
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
