#!/usr/bin/env node
// Plays Codex in a terminal for the host tests: shows its prompt, keeps a session log under CODEX_HOME/sessions as Codex
// does, and answers each line typed or pasted with "echo: LINE". HANG never answers, ABORT logs what Codex logs when a
// person stops a turn with Escape; LATE answers, then logs a stop of that turn a moment later. Like Codex, a new session
// writes its log only once the first message comes.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { crash } from './crash.mjs';

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

process.stdout.write('OpenAI Codex\n');
prompt();
for await (const typed of createInterface({ input: process.stdin })) {
  const line = typed.replaceAll('\u001b', '');
  event({ type: 'task_started', turn_id: randomUUID() });
  item('UserMessage', line);
  if (line.startsWith('CRASH')) crash(line.includes('LONG') ? 'long' : '');
  if (line.includes('HANG_EXIT')) process.stdout.write('exit-test running\n');
  if (line.includes('HANG')) {
    prompt();
    continue;
  }
  if (line.includes('ABORT')) {
    event({ type: 'turn_aborted', reason: 'interrupted' });
    process.stdout.write('■ Conversation interrupted\n');
    prompt();
    continue;
  }
  if (line.includes('SLOW')) {
    prompt();
    await new Promise(r => setTimeout(r, 2000));
    process.stdout.write('\r\x1b[2K');
  }
  const answer = `echo: ${line}`;
  item('AgentMessage', answer);
  event({ type: 'token_count', info: { last_token_usage: { total_tokens: 112000 }, model_context_window: 212000 }, rate_limits: null });
  event({ type: 'task_complete', last_agent_message: answer });
  process.stdout.write(`• ${answer}\n`);
  prompt();
  if (line.includes('LATE')) setTimeout(() => event({ type: 'turn_aborted', reason: 'interrupted' }), 150);
}
