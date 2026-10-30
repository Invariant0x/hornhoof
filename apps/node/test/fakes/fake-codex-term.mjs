#!/usr/bin/env node
// Plays Codex in a terminal for the host tests: shows its prompt, keeps a session log under CODEX_HOME/sessions as Codex
// does, and answers each line typed or pasted with "echo: LINE". HANG never answers, ABORT logs what Codex logs when a
// person stops a turn with Escape; LATE answers, then logs a stop of that turn a moment later.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const home = process.env.CODEX_HOME ?? '/tmp';
const day = join(home, 'sessions', '2026', '10', '30');
mkdirSync(day, { recursive: true });
let log;
if (args[0] === 'resume') {
  log = join(day, readdirSync(day).find(name => name.endsWith(`-${args[1]}.jsonl`)));
} else {
  const id = randomUUID();
  log = join(day, `rollout-2026-10-30T00-00-00-${id}.jsonl`);
  appendFileSync(log, JSON.stringify({ type: 'session_meta', payload: { id, cwd: args[args.indexOf('-C') + 1] } }) + '\n');
}
const event = payload => appendFileSync(log, JSON.stringify({ type: 'event_msg', payload }) + '\n');
const item = (type, text) => event({ type: 'item_completed', item: { type, id: randomUUID(), content: [{ type: 'text', text }] } });

process.stdout.write('OpenAI Codex\n› ');
for await (const typed of createInterface({ input: process.stdin })) {
  const line = typed.replaceAll('\u001b', '');
  event({ type: 'task_started', turn_id: randomUUID() });
  item('UserMessage', line);
  if (line.includes('HANG')) continue;
  if (line.includes('ABORT')) {
    event({ type: 'turn_aborted', reason: 'interrupted' });
    process.stdout.write('■ Conversation interrupted\n› ');
    continue;
  }
  const answer = `echo: ${line}`;
  item('AgentMessage', answer);
  event({ type: 'task_complete', last_agent_message: answer });
  process.stdout.write(`• ${answer}\n› `);
  if (line.includes('LATE')) setTimeout(() => event({ type: 'turn_aborted', reason: 'interrupted' }), 150);
}
