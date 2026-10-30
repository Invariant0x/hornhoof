#!/usr/bin/env node
// Plays Claude Code in a terminal for the host tests: tells the bridge it started, answers each line typed or pasted with
// "echo: LINE" on the screen and in its session log, and calls the prompt and stop hooks around each answer.
// SLOW makes an answer take 2 s, HANG never answers (as when a person stops it with Escape: no stop hook), EXIT ends the
// program, SECRET prints the value of FAKE_SECRET.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const flag = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const session = flag('--session-id') ?? flag('--resume') ?? 'none';
const home = process.env.CLAUDE_CONFIG_DIR ?? '/tmp';
const log = join(home, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'), `${session}.jsonl`);
mkdirSync(dirname(log), { recursive: true });
const hook = (event, body) => fetch(`${process.env.HH_BRIDGE}/${event}`, { method: 'POST', body: JSON.stringify({ session_id: session, ...body }) }).catch(() => {});

process.stdout.write(`fake claude ${args.includes('--resume') ? 'resumed' : 'new'} ${session}\n❯ `);
await hook('start', {});
for await (const typed of createInterface({ input: process.stdin })) {
  // Escape stops an answer; it is not part of the next line.
  const line = typed.replaceAll('\u001b', '');
  if (line === 'EXIT') process.exit(3);
  await hook('prompt', { prompt: line });
  if (line.includes('HANG')) continue;
  if (line.includes('SLOW')) await new Promise(r => setTimeout(r, 2000));
  const answer = line === 'SECRET' ? `the key is ${process.env.FAKE_SECRET}` : `echo: ${line}`;
  appendFileSync(log, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } }) + '\n');
  process.stdout.write(`● ${answer}\n❯ `);
  await hook('status', { rate_limits: { five_hour: { used_percentage: 40, resets_at: 1793379000 } } });
  await hook('stop', { last_assistant_message: answer, transcript_path: log });
}
