#!/usr/bin/env node
// Plays Claude Code in a terminal for the host tests: tells the bridge it started, answers each line typed or pasted with
// "echo: LINE" on the screen and in its session log, and calls the prompt and stop hooks around each answer.
// SLOW makes an answer take 2 s, LAG writes the answer to the log only after the stop hook, as Claude Code can (LAGLONG
// 2.5 s after), HANG never
// answers (as when a person stops it with Escape: no stop hook), EXIT ends the
// program, SECRET prints the value of FAKE_SECRET, MUTE says on the screen only that it will not answer and ends the turn with
// no answer, as Codex does when its provider refuses the work. INTERRUPT logs what Claude Code logs when a person stops a turn with
// Escape, and calls no stop hook. TICK works 3 s under a line counting the time, with Claude Code's way to stop it.
// SPINNER works for 3 s with the current spinner and an empty prompt, without a way to stop it on screen.
// WORK thinks, runs a command and asks a question with AskUserQuestion, 1.5 s each, as Claude Code shows and logs them,
// and then answers. CLEAR starts a new session, as /clear does. FAKE_MCP_LIST_MS makes it list its Hornhoof
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
readKeys(key => {
  if (Date.now() < inputAt) return;
  // Escape stops an answer; it is not part of the next line.
  if (key === 'escape') return;
  if (key !== 'enter') return typed(key);
  const line = entered();
  if (line) queue = queue.then(() => take(line));
});

function typed(key) {
  if (key === 'kill') input = input.slice(0, input.lastIndexOf('\n') + 1);
  else if (key === 'erase') input = input.slice(0, -1);
  else input += key.text;
  show();
}

// The line Enter sends, or none while the fake is deaf, loses the Enter, or its input is empty: an Enter into an empty
// input does nothing.
function entered() {
  if (Date.now() < deafUntil) return '';
  if (loseEnter) {
    loseEnter = false;
    return '';
  }
  const line = keepTail ? input.slice(-keepTail) : input;
  if (!line) return '';
  keepTail = 0;
  input = '';
  shown = 0;
  process.stdout.write('\r\n');
  return line;
}

async function take(line) {
  if (line === 'EXIT') process.exit(3);
  if (line === 'CLEAR') return clear();
  const context = await hook('prompt', { prompt: line });
  if (line.startsWith('CRASH')) crash(line.includes('LONG') ? 'long' : '');
  if (line.includes('HANG_EXIT')) process.stdout.write('exit-test running\n');
  const ending = ENDINGS.find(([word]) => line.includes(word));
  if (ending) return ending[1]();
  await workFirst(line);
  await answer(line, context);
}

async function clear() {
  session = randomUUID();
  log = logOf(session);
  process.stdout.write('❯ ');
  await hook('start', { source: 'clear' });
}

// Words that end a turn without an answer, each its own way.
const ENDINGS = [
  ['HANG', () => process.stdout.write('❯ ')],
  [
    'INTERRUPT',
    () => {
      appendFileSync(log, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }) + '\n');
      process.stdout.write('  ⎿  Interrupted\n❯ ');
    },
  ],
  [
    'MUTE',
    async () => {
      process.stdout.write("■ This content can't be shown.\n❯ ");
      await hook('stop', { last_assistant_message: '', transcript_path: log });
    },
  ],
];

async function workFirst(line) {
  if (line.includes('SLOW')) {
    process.stdout.write('❯ ');
    await sleep(2000);
  }
  if (line.includes('SPINNER')) await currentSpinner();
  if (line.includes('TICK')) await tick();
  if (line.includes('WORK')) await work();
}

// TICK works for 3 s with its prompt empty under a line that counts the time, as Claude Code's spinner does.
async function tick() {
  process.stdout.write('\n❯ ');
  for (let i = 0; i < 12; i++) {
    spinner(`Working ${i * 250} ms`);
    await sleep(250);
  }
  spinner('');
  process.stdout.write('\r\x1b[2K');
}

// Claude Code 2.1.317 leaves an empty input below its spinner while the turn runs.
async function currentSpinner() {
  const rule = '─'.repeat(60);
  process.stdout.write(`✻ Recombobulating… (4s · ↓ 691 tokens · thought for 1s)\n${rule}\n❯ \n${rule}\n`);
  await sleep(3000);
}

async function answer(line, context) {
  const text = line === 'SECRET' ? `the key is ${process.env.FAKE_SECRET}` : `echo: ${line}${context ? `\n${context}` : ''}`;
  const write = () => appendFileSync(log, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n');
  const lag = line.includes('LAG');
  if (!lag) write();
  process.stdout.write(`● ${text}\n❯ `);
  await hook('status', { rate_limits: { five_hour: { used_percentage: 40, resets_at: 1793379000 } }, context_window: { used_percentage: 25 } });
  await hook('stop', { last_assistant_message: text, transcript_path: log });
  if (lag) setTimeout(write, line.includes('LAGLONG') ? 2500 : 300);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Claude Code's spinner, redrawn in place over the empty input under it, and gone once the work is.
const spinner = what => process.stdout.write(`\x1b[1A\r\x1b[2K${what ? `✻ ${what}… (esc to interrupt)` : ''}\r\n\x1b[2K❯ `);
const said = (type, block) => appendFileSync(log, JSON.stringify({ type, message: { role: type, content: [block] } }) + '\n');

async function work() {
  process.stdout.write('\n❯ ');
  spinner('Thinking');
  await sleep(1500);
  said('assistant', { type: 'tool_use', id: 'toolu_work', name: 'Bash', input: { command: 'make' } });
  spinner('Running make');
  await sleep(1500);
  said('user', { type: 'tool_result', tool_use_id: 'toolu_work', content: 'built' });
  spinner('');
  said('assistant', { type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input: { questions: [{ question: 'Which one?' }] } });
  process.stdout.write('\rWhich one?\r\n❯ 1. Yes\r\n  2. No\r\nEnter to select · Esc to cancel\r\n');
  await sleep(1500);
  said('user', { type: 'tool_result', tool_use_id: 'toolu_ask', content: 'Yes' });
}
