#!/usr/bin/env node
// Plays Codex in a terminal for the host tests: shows its prompt, keeps a session log under CODEX_HOME/sessions as Codex
// does, and answers each line typed or pasted with "echo: LINE". HANG never answers, ABORT logs what Codex logs when a
// person stops a turn with Escape; LATE answers, then logs a stop of that turn a moment later. TICK works 3 s under
// Codex's status line, with its way to stop it; WORK thinks and runs a command, 1.5 s each, and then answers. Like Codex, a new session
// writes its log only once the first message comes. A paste comes whole, line breaks and all, as in Codex.
// APIFAIL prompts replay API failures captured from Codex, without a Stop hook; LONG prints a long screen first. CLOSING stays
// in its turn a while after its Stop hook, and words that come then go into that same turn with no new task_started, as Codex
// does on a busy machine.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { crash } from './crash.mjs';
import { rawKeys, readKeys } from './keys.mjs';
import failures from '../fixtures/terminal-api-failures.json' with { type: 'json' };

if (process.env.FAKE_CRASH_START) crash(process.env.FAKE_CRASH_START);

import hooks from '../fixtures/turn-hooks.json' with { type: 'json' };
const args = process.argv.slice(2);
let turnId;
const hook = (event, name, body = {}) => fetch(`${process.env.HH_BRIDGE}/${event}`, { method: 'POST', body: JSON.stringify({ ...hooks.find(h => h.program === 'codex' && h.event === name)?.input, ...body, turn_id: turnId }) }).catch(() => {});
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
const item = (type, text) => event({ type: 'item_completed', turn_id: turnId, item: { type, id: randomUUID(), content: [{ type: 'text', text }] } });
// An empty row and its footer under its input, not dim, as Codex shows them (fixtures/real-screens).
const FOOTER = '\r\n\r\n  \x1b[1m?\x1b[0m for shortcuts\x1b[2A\r';
const prompt = () => process.stdout.write(`\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m${FOOTER}\x1b[2C`);

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
  if (input) process.stdout.write(`\x1b[1m›\x1b[0m ${lines.join('\r\n')}${FOOTER}\x1b[${lines.at(-1).length + (shown ? 1 : 3)}G`);
  else prompt();
};
let queue = Promise.resolve();
let hanging = false;
let closing = false;
let lastAnswer = '';
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
  process.stdout.write('\r\n\x1b[J');
  if (hanging && process.env.FAKE_HOLD_WORDS) { prompt(); return; }
  if (closing) return steer(line);
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
  await hook('tool', 'PreToolUse', { tool_use_id: command.id, tool_name: 'Bash' });
  await sleep(1500);
  await hook('tooldone', 'PostToolUse', { tool_use_id: command.id, tool_name: 'Bash' });
  event({ type: 'item_completed', item: { ...command, exit_code: 0, aggregated_output: 'built\n', status: 'completed' } });
  status('');
}

async function take(line) {
  const busy = line.includes('TICK') || line.includes('WORK');
  // Codex shows that it works as it takes the line.
  if (busy) {
    process.stdout.write('\n');
    status('Working (0s');
  }
  if (!hanging) {
    turnId = randomUUID();
    event({ type: 'task_started', turn_id: turnId });
  }
  hanging = false;
  item('UserMessage', line);
  if (endsAtOnce(line)) return;
  if (line.includes('SLOW')) await slow();
  if (busy) await work(line);
  await answer(line);
}

// Whether the turn ended as it started: CRASH ends the program, HANG never answers, and ABORT logs what Codex logs when a
// person stops a turn with Escape.
function endsAtOnce(line) {
  const failure = failures.find(f => f.program === 'codex' && line.startsWith(f.prompt));
  if (failure) {
    if (line.includes('LONG')) process.stdout.write('screen content '.repeat(300) + '\n');
    event({ ...failure.line.payload, turn_id: turnId });
    prompt();
    return true;
  }
  if (line.startsWith('CRASH')) crash(line.includes('LONG') ? 'long' : '');
  if (line.includes('HANG_EXIT')) process.stdout.write('exit-test running\n');
  if (line.includes('HANG')) {
    hanging = true;
    prompt();
    return true;
  }
  if (!line.includes('ABORT')) return false;
  void hook('interrupt', 'Interrupt');
  event({ type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' });
  process.stdout.write('■ Conversation interrupted\n');
  prompt();
  return true;
}

async function slow() {
  prompt();
  await sleep(2000);
  process.stdout.write('\r\x1b[J');
}

function steer(line) {
  item('UserMessage', line);
  lastAnswer = `echo: ${line}`;
  item('AgentMessage', lastAnswer);
  process.stdout.write(`• ${lastAnswer}\n`);
  prompt();
}

async function closeTurn() {
  closing = true;
  // Its empty prompt shows all through a turn (fixtures/real-screens).
  prompt();
  await sleep(1500);
  closing = false;
  process.stdout.write('\r\x1b[J');
}

async function answer(line) {
  const text = `echo: ${line}`;
  lastAnswer = text;
  item('AgentMessage', text);
  event({ type: 'token_count', info: { last_token_usage: { total_tokens: 112000 }, model_context_window: 212000 }, rate_limits: null });
  if (!line.includes('LOGFIRST')) await hook('stop', 'Stop', { last_assistant_message: text });
  if (line.includes('CLOSING')) await closeTurn();
  event({ type: 'task_complete', turn_id: turnId, last_agent_message: lastAnswer });
  if (line.includes('LOGFIRST')) await hook('stop', 'Stop', { last_assistant_message: text });
  // Its answer takes the place of the empty prompt it worked under, and leaves nothing of it on its row.
  process.stdout.write(`\r\x1b[J• ${text}\n`);
  prompt();
  if (line.includes('LATE')) setTimeout(() => event({ type: 'turn_aborted', reason: 'interrupted' }), 150);
}
