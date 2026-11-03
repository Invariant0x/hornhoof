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
// loads a long session it resumed. FAKE_DEAF_ONCE_MS does so only the first time it starts in its folder. FAKE_INPUT_MS
// makes it say it started that long before its input box shows, as Claude Code can while it still starts: what is typed
// meanwhile is lost. FAKE_KEEP_TAIL keeps only that many last characters of the first message, as Claude Code once did
// with a message typed while it started. What its prompt hook answers goes with the prompt, as in Claude Code.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crash } from './crash.mjs';
import { bracketed, rawKeys, readKeys } from './keys.mjs';

if (process.env.FAKE_CRASH_START) crash(process.env.FAKE_CRASH_START);

const args = process.argv.slice(2);
const flag = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
let session = flag('--session-id') ?? flag('--resume') ?? 'none';
const home = process.env.CLAUDE_CONFIG_DIR ?? '/tmp';
const logOf = id => join(home, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`);
let log = logOf(session);
mkdirSync(dirname(log), { recursive: true });
const hook = (event, body) =>
  fetch(`${process.env.HH_BRIDGE}/${event}`, { method: 'POST', body: JSON.stringify({ session_id: session, ...body }) })
    .then(r => r.text())
    .catch(() => '');

const inputMs = Number(process.env.FAKE_INPUT_MS ?? 0);
rawKeys({ ask: !inputMs });
process.stdout.write(`fake claude ${args.includes('--resume') ? 'resumed' : 'new'} ${session}\n${inputMs ? '' : '❯ '}`);
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
let loseEnter = Boolean(process.env.FAKE_LOSE_ENTER);
let keepTail = Number(process.env.FAKE_KEEP_TAIL ?? 0);
const deafOnce = process.env.FAKE_DEAF_ONCE_MS && !existsSync('.fake-deaf') ? Number(process.env.FAKE_DEAF_ONCE_MS) : 0;
if (deafOnce) writeFileSync('.fake-deaf', '');
const deafUntil = Date.now() + Number(process.env.FAKE_DEAF_MS ?? 0) + deafOnce;
const inputAt = Date.now() + inputMs;
if (inputMs)
  setTimeout(() => {
    process.stdout.write('❯ ');
    bracketed();
  }, inputMs);

// The input box: what is typed or pasted stays in it, over as many lines as it takes, until Enter.
let input = '';
let shown = 0;
const show = () => {
  const lines = input.split('\n');
  process.stdout.write(`${shown ? `\x1b[${shown}A` : ''}\r\x1b[J❯ ${lines.join('\r\n')}`);
  shown = lines.length - 1;
};
let queue = Promise.resolve();
readKeys(
  key => {
    if (Date.now() < inputAt) return;
    // Escape stops an answer; it is not part of the next line.
    if (key === 'escape') return;
    if (key === 'kill') input = input.slice(0, input.lastIndexOf('\n') + 1);
    else if (key === 'erase') input = input.slice(0, -1);
    else if (key !== 'enter') input += key.text;
    if (key !== 'enter') return show();
    if (Date.now() < deafUntil) return;
    if (loseEnter) {
      loseEnter = false;
      return;
    }
    const line = keepTail ? input.slice(-keepTail) : input;
    // An Enter into an empty input does nothing.
    if (!line) return;
    keepTail = 0;
    input = '';
    shown = 0;
    process.stdout.write('\r\n');
    queue = queue.then(() => take(line));
  },
);

async function take(line) {
  if (line === 'EXIT') process.exit(3);
  if (line === 'CLEAR') {
    session = randomUUID();
    log = logOf(session);
    process.stdout.write('❯ ');
    await hook('start', { source: 'clear' });
    return;
  }
  const context = await hook('prompt', { prompt: line });
  if (line.startsWith('CRASH')) crash(line.includes('LONG') ? 'long' : '');
  if (line.includes('HANG_EXIT')) process.stdout.write('exit-test running\n');
  if (line.includes('HANG')) {
    process.stdout.write('❯ ');
    return;
  }
  if (line.includes('INTERRUPT')) {
    appendFileSync(log, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }) + '\n');
    process.stdout.write('  ⎿  Interrupted\n❯ ');
    return;
  }
  if (line.includes('MUTE')) {
    process.stdout.write("■ This content can't be shown.\n❯ ");
    await hook('stop', { last_assistant_message: '', transcript_path: log });
    return;
  }
  if (line.includes('SLOW')) {
    process.stdout.write('❯ ');
    await new Promise(r => setTimeout(r, 2000));
  }
  const answer = line === 'SECRET' ? `the key is ${process.env.FAKE_SECRET}` : `echo: ${line}${context ? `\n${context}` : ''}`;
  const write = () => appendFileSync(log, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } }) + '\n');
  if (!line.includes('LAG')) write();
  process.stdout.write(`● ${answer}\n❯ `);
  await hook('status', { rate_limits: { five_hour: { used_percentage: 40, resets_at: 1793379000 } }, context_window: { used_percentage: 25 } });
  await hook('stop', { last_assistant_message: answer, transcript_path: log });
  if (line.includes('LAG')) setTimeout(write, line.includes('LAGLONG') ? 2500 : 300);
}
