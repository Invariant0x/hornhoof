#!/usr/bin/env node
// Plays Codex in a terminal for the host tests: shows its prompt, keeps a session log under CODEX_HOME/sessions as Codex
// does, and answers each line typed or pasted with "echo: LINE". HANG never answers, ABORT logs what Codex logs when a
// person stops a turn with Escape; LATE answers, then logs a stop of that turn a moment later. TICK works 3 s under
// Codex's status line, with its way to stop it; WORK thinks and runs a command, 1.5 s each, and then answers. Like Codex, a new session
// writes its log only once the first message comes. A paste comes whole, line breaks and all, as in Codex.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { crash } from './crash.mjs';
import { rawKeys, readKeys } from './keys.mjs';

if (process.env.FAKE_CRASH_START) crash(process.env.FAKE_CRASH_START);

const args = process.argv.slice(2);
const home = process.env.CODEX_HOME ?? '/tmp';
const day = join(home, 'sessions', '2026', '10', '30');
mkdirSync(day, { recursive: true });
let log;
let meta = null;
if (args[0] === 'resume') {
  log = join(day, readdirSync(day).find(name => name.endsWith(`-${args[1]}.jsonl`)));
} else {
  const id = randomUUID();
  log = join(day, `rollout-2026-10-30T00-00-00-${id}.jsonl`);
  meta = { type: 'session_meta', payload: { id, cwd: args[args.indexOf('-C') + 1] } };
}
const event = payload => {
  if (meta) appendFileSync(log, JSON.stringify(meta) + '\n');
  meta = null;
  appendFileSync(log, JSON.stringify({ type: 'event_msg', payload }) + '\n');
};
const item = (type, text) => event({ type: 'item_completed', item: { type, id: randomUUID(), content: [{ type: 'text', text }] } });
const prompt = () => process.stdout.write('\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m\r\x1b[2C');

rawKeys();
process.stdout.write('OpenAI Codex\n');
prompt();
// The composer: what is typed or pasted stays in it, over as many lines as it takes, until Enter.
let input = '';
let shown = 0;
const show = () => {
  process.stdout.write(`${shown ? `\x1b[${shown}A` : ''}\r\x1b[J`);
  const lines = input.split('\n');
  shown = input ? lines.length - 1 : 0;
  if (input) process.stdout.write(`\x1b[1m›\x1b[0m ${lines.join('\r\n')}`);
  else prompt();
};
let queue = Promise.resolve();
readKeys(key => {
  // Escape stops an answer; it is not part of the next line.
  if (key === 'escape') return;
  if (key === 'kill') input = input.slice(0, input.lastIndexOf('\n') + 1);
  else if (key === 'erase') input = input.slice(0, -1);
  else if (key !== 'enter') input += key.text;
  if (key !== 'enter') return show();
  const line = input;
  if (!line) return;
  input = '';
  shown = 0;
  process.stdout.write('\r\n');
  queue = queue.then(() => take(line));
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Codex's status line over its composer while it works, gone once it is done.
const status = what => {
  process.stdout.write(`\x1b[1A\r\x1b[2K${what ? `• ${what} (esc to interrupt)` : ''}\r\n\x1b[2K`);
  prompt();
};

async function work(line) {
  if (line.includes('TICK')) for (let i = 1; i <= 12; i++, await sleep(250)) status(`Working (${i * 250} ms`);
  if (!line.includes('WORK')) return status('');
  await sleep(1500);
  const command = { type: 'CommandExecution', id: 'work-1', command: 'make' };
  event({ type: 'item_started', item: command });
  await sleep(1500);
  event({ type: 'item_completed', item: { ...command, exit_code: 0, aggregated_output: 'built\n', status: 'completed' } });
  status('');
}

async function take(line) {
  // Codex shows that it works as it takes the line.
  if (line.includes('TICK') || line.includes('WORK')) {
    process.stdout.write('\n');
    status('Working (0s');
  }
  event({ type: 'task_started', turn_id: randomUUID() });
  item('UserMessage', line);
  if (line.startsWith('CRASH')) crash(line.includes('LONG') ? 'long' : '');
  if (line.includes('HANG_EXIT')) process.stdout.write('exit-test running\n');
  if (line.includes('HANG')) {
    prompt();
    return;
  }
  if (line.includes('ABORT')) {
    event({ type: 'turn_aborted', reason: 'interrupted' });
    process.stdout.write('■ Conversation interrupted\n');
    prompt();
    return;
  }
  if (line.includes('SLOW')) {
    prompt();
    await new Promise(r => setTimeout(r, 2000));
    process.stdout.write('\r\x1b[2K');
  }
  if (line.includes('TICK') || line.includes('WORK')) await work(line);
  const answer = `echo: ${line}`;
  item('AgentMessage', answer);
  event({ type: 'token_count', info: { last_token_usage: { total_tokens: 112000 }, model_context_window: 212000 }, rate_limits: null });
  event({ type: 'task_complete', last_agent_message: answer });
  process.stdout.write(`• ${answer}\n`);
  prompt();
  if (line.includes('LATE')) setTimeout(() => event({ type: 'turn_aborted', reason: 'interrupted' }), 150);
}
