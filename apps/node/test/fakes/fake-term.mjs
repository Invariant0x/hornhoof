#!/usr/bin/env node
// Plays Claude Code in a terminal for the host tests: tells the bridge it started, answers each line typed or pasted with
// "echo: LINE" on the screen and in its session log, and calls the prompt and stop hooks around each answer.
// SLOW makes an answer take 2 s, LAG writes the answer to the log only after the stop hook, as Claude Code can (LAGLONG
// 2.5 s after), HANG never
// answers (as when a person stops it with Escape: no stop hook), EXIT ends the
// program, SECRET prints the value of FAKE_SECRET, MUTE says on the screen only that it will not answer and ends the turn with
// no answer, as Codex does when its provider refuses the work. INTERRUPT logs what Claude Code logs when a person stops a turn with
// Escape, and calls no stop hook. CLEAR starts a new session, as /clear does. FAKE_MCP_LIST_MS makes it list its Hornhoof
// tools that long after it started, as Claude Code connects to its MCP servers, and show "tools: ok" or "tools: failed".
// FAKE_LOSE_ENTER misses the first Enter, as Claude Code just started can: the line stays in its input until the next one.
// FAKE_START_MS makes it say it started that long after it shows, as Claude Code can while it loads. FAKE_DEAF_MS makes
// it keep what is typed in its input without taking Enter for that long after it started, as Claude Code does while it
// loads a long session it resumed. FAKE_DEAF_ONCE_MS does so only the first time it starts in its folder.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { crash } from './crash.mjs';

if (process.env.FAKE_CRASH_START) crash(process.env.FAKE_CRASH_START);

const args = process.argv.slice(2);
const flag = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
let session = flag('--session-id') ?? flag('--resume') ?? 'none';
const home = process.env.CLAUDE_CONFIG_DIR ?? '/tmp';
const logOf = id => join(home, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`);
let log = logOf(session);
mkdirSync(dirname(log), { recursive: true });
const hook = (event, body) => fetch(`${process.env.HH_BRIDGE}/${event}`, { method: 'POST', body: JSON.stringify({ session_id: session, ...body }) }).catch(() => {});

process.stdout.write(`fake claude ${args.includes('--resume') ? 'resumed' : 'new'} ${session}\n❯ `);
if (process.env.FAKE_START_MS) await new Promise(r => setTimeout(r, Number(process.env.FAKE_START_MS)));
await hook('start', {});
if (process.env.FAKE_MCP_LIST_MS) {
  const { url } = JSON.parse(flag('--mcp-config')).mcpServers.hornhoof;
  setTimeout(async () => {
    const listed = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
      .then(r => r.json())
      .catch(() => null);
    process.stdout.write(`tools: ${listed?.result ? 'ok' : 'failed'}\n❯ `);
  }, Number(process.env.FAKE_MCP_LIST_MS));
}
let kept = process.env.FAKE_LOSE_ENTER ? '' : null;
const deafOnce = process.env.FAKE_DEAF_ONCE_MS && !existsSync('.fake-deaf') ? Number(process.env.FAKE_DEAF_ONCE_MS) : 0;
if (deafOnce) writeFileSync('.fake-deaf', '');
const deafUntil = Date.now() + Number(process.env.FAKE_DEAF_MS ?? 0) + deafOnce;
for await (const typed of createInterface({ input: process.stdin })) {
  if (Date.now() < deafUntil) {
    kept = `${kept ?? ''}${typed}`;
    continue;
  }
  if (kept === '') {
    kept = typed;
    continue;
  }
  // Escape stops an answer; it is not part of the next line.
  const line = `${kept ?? ''}${typed}`.replaceAll('\u001b', '');
  kept = null;
  // An Enter into an empty input does nothing.
  if (!line) continue;
  if (line === 'EXIT') process.exit(3);
  if (line === 'CLEAR') {
    session = randomUUID();
    log = logOf(session);
    process.stdout.write('❯ ');
    await hook('start', { source: 'clear' });
    continue;
  }
  await hook('prompt', { prompt: line });
  if (line.startsWith('CRASH')) crash(line.includes('LONG') ? 'long' : '');
  if (line.includes('HANG_EXIT')) process.stdout.write('exit-test running\n');
  if (line.includes('HANG')) {
    process.stdout.write('❯ ');
    continue;
  }
  if (line.includes('INTERRUPT')) {
    appendFileSync(log, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }) + '\n');
    process.stdout.write('  ⎿  Interrupted\n❯ ');
    continue;
  }
  if (line.includes('MUTE')) {
    process.stdout.write("■ This content can't be shown.\n❯ ");
    await hook('stop', { last_assistant_message: '', transcript_path: log });
    continue;
  }
  if (line.includes('SLOW')) {
    process.stdout.write('❯ ');
    await new Promise(r => setTimeout(r, 2000));
  }
  const answer = line === 'SECRET' ? `the key is ${process.env.FAKE_SECRET}` : `echo: ${line}`;
  const write = () => appendFileSync(log, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } }) + '\n');
  if (!line.includes('LAG')) write();
  process.stdout.write(`● ${answer}\n❯ `);
  await hook('status', { rate_limits: { five_hour: { used_percentage: 40, resets_at: 1793379000 } }, context_window: { used_percentage: 25 } });
  await hook('stop', { last_assistant_message: answer, transcript_path: log });
  if (line.includes('LAG')) setTimeout(write, line.includes('LAGLONG') ? 2500 : 300);
}
