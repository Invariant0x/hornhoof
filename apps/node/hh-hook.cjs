#!/usr/bin/env node
// hh-hook EVENT [JSON]: Claude Code's hooks and status line, Codex's notify, Kimi Code's and Antigravity's hooks tell the
// node how the agent's turn goes: start, prompt, invocation, stop, status. It reads the program's JSON from the last
// argument or stdin, posts it to the node's bridge in HH_BRIDGE and prints nothing, so a status line stays empty and Kimi
// adds nothing to the prompt. Antigravity reads hook output as JSON, so invocation prints nothing. It never fails the
// program's turn. hh-hook compact only prints what Claude Code adds to a conversation it just compacted, and hh-hook
// prompt what the bridge answers, which the program adds to the prompt: where the whole message is when the program
// got only part of it.
'use strict';

const { sendHook } = require('./hh-hook-send.cjs');
const AFTER_COMPACT =
  'Hornhoof: your conversation was just compacted, so details of it may be gone. Before you go on, read again what your instructions say to read after a compaction.';

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

/* The process that ran this hook, as the hook started. A program gives up on a hook by ending the process it started, and
   only that one, as Claude Code does with a status line a newer one overtook: a hook that outlived it belongs to no program
   any more, and the node refuses it as a caller outside the agent's pane. It ends at once instead and says nothing, as its
   program asked. One let go before it even started is already init's: no program runs as init. */
const PARENT = process.ppid;
const letGo = () => process.ppid !== PARENT || process.ppid === 1;

function endOnceLetGo() {
  setInterval(() => {
    if (letGo()) process.exit(0);
  }, 50).unref();
}

async function main() {
  const event = process.argv[2];
  /* Written before the exit below cuts a pipe short. */
  if (event === 'compact') return new Promise(resolve => process.stdout.write(`${AFTER_COMPACT}\n`, () => resolve()));
  const url = process.env.HH_BRIDGE;
  if (!event || !url || !/^[a-z]+$/.test(event)) return;
  endOnceLetGo();
  const body = process.argv[3] ?? (await readStdin());
  if (letGo()) return;
  const res = await sendHook(event, body || '{}');
  if (!res) return;
  return print(await answerOf(event, res));
}

/* What the bridge answers a prompt is for the program to add to it; the other events print nothing. */
async function answerOf(event, res) {
  return event === 'prompt' && res.ok ? (await res.text()).trim() : '';
}

/* Written before the exit below cuts a pipe short. */
function print(text) {
  return text ? new Promise(resolve => process.stdout.write(`${text}\n`, () => resolve())) : undefined;
}

main()
  .catch(() => new Promise(resolve => process.stderr.write('Hook delivery failed.\n', resolve)))
  .finally(() => process.exit(0));
