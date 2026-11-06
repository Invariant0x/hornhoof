#!/usr/bin/env node
// Plays Kimi Code in a terminal for the host tests: shows its welcome and footer, starts a new session only with the first
// message, as Kimi does, keeps the session log under KIMI_CODE_HOME/sessions, calls the hooks named in its config.toml
// with Kimi's snake_case input, and answers each line with "echo: LINE". -S resumes a session, or fails as Kimi does when
// there is none. HANG never answers until Escape stops it, ABORT logs a stopped turn, FAIL a failed one, SLOW answers after
// 2 s, WORK thinks and runs a command, 1.5 s each, as Kimi logs them, and then answers, EXIT ends the program, SECRET prints the value of FAKE_SECRET, /new starts a new session. FAKE_MCP_LIST_MS makes it
// list its Hornhoof tools from .kimi-code/mcp.json that long after its session's workspace opened, and show "tools: ok" or
// "tools: failed". FAKE_SIGNED_OUT shows what a signed-out Kimi shows. A paste comes whole, line breaks and all, as in Kimi;
// FAKE_KEEP_TAIL keeps only that many last characters of the first message. What its prompt hook prints goes with the
// prompt, as in Kimi Code.
// APIFAIL prompts replay API failures captured from Kimi Code, with their error codes.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { crash } from './crash.mjs';
import { rawKeys, readKeys } from './keys.mjs';
import failures from '../fixtures/terminal-api-failures.json' with { type: 'json' };
import hooks from '../fixtures/turn-hooks.json' with { type: 'json' };
const captured = name => hooks.find(h => h.program === 'kimi' && h.event === name)?.input ?? {};

if (process.env.FAKE_CRASH_START) crash(process.env.FAKE_CRASH_START);

const args = process.argv.slice(2);
const home = process.env.KIMI_CODE_HOME ?? '/tmp';
const workspace = `wd_${basename(process.cwd())}_${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12)}`;
const wireOf = id => join(home, 'sessions', workspace, id, 'agents', 'main', 'wire.jsonl');
const config = (() => {
  try {
    return readFileSync(join(home, 'config.toml'), 'utf8');
  } catch {
    return '';
  }
})();
const hook = (event, name, body) =>
  config.includes(`command = "hh-hook ${event}"`)
    ? fetch(`${process.env.HH_BRIDGE}/${event}`, { method: 'POST', body: JSON.stringify({ ...captured(name), hook_event_name: name, session_id: session, cwd: process.cwd(), ...body }) })
        .then(r => r.text())
        .catch(() => '')
    : Promise.resolve('');
const record = (type, payload) => appendFileSync(wireOf(session), JSON.stringify({ type, agentId: 'main', ...payload, time: Date.now() }) + '\n');
const print = text => process.stdout.write(text);
// Its input box as Kimi Code 2 draws it (fixtures/real-screens), with the cursor behind what is typed.
const BOX = 69;
const inputRow = text => `│ > ${text.padEnd(BOX - 4)} │\x1b[${text.length + 5}G`;
const prompt = () => print(`╭${'─'.repeat(BOX)}╮\n${inputRow('')}\n╰${'─'.repeat(BOX)}╯\ncontext: 0% (0/256k)\x1b[2A\x1b[5G`);

function listTools() {
  if (!process.env.FAKE_MCP_LIST_MS) return;
  setTimeout(async () => {
    const { url } = JSON.parse(readFileSync(join(process.cwd(), '.kimi-code', 'mcp.json'), 'utf8')).mcpServers.hornhoof;
    const listed = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
      .then(r => r.json())
      .catch(() => null);
    print(`tools: ${listed?.result ? 'ok' : 'failed'}\n`);
    prompt();
  }, Number(process.env.FAKE_MCP_LIST_MS));
}

let session = null;
const at = args.indexOf('-S');
if (at >= 0) {
  session = args[at + 1];
  if (!existsSync(wireOf(session))) {
    print(`Session "${session}" not found.\n`);
    process.exit(1);
  }
}
async function startSession(source) {
  session = `session_${randomUUID()}`;
  mkdirSync(join(home, 'sessions', workspace, session, 'agents', 'main'), { recursive: true });
  appendFileSync(wireOf(session), JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: Date.now() }) + '\n');
  listTools();
  await hook('start', 'SessionStart', { source });
}

rawKeys();
print(`fake kimi ${session ? `resumed ${session}` : 'new'}\nWelcome to Kimi Code!\n`);
print(process.env.FAKE_SIGNED_OUT ? 'Run /login or /provider to get started.\n' : 'Send /help for help information.\n');
prompt();
if (session) {
  listTools();
  await hook('start', 'SessionStart', { source: 'resume' });
}

let turn = 0;
let hanging = null;
async function take(line) {
  if (line === 'EXIT') { await hook('end', 'SessionEnd', { reason: 'exit' }); process.exit(3); }
  if (line === '/new') return newSession();
  if (!session) await startSession('startup');
  const context = await hook('prompt', 'UserPromptSubmit', { prompt: [{ type: 'text', text: line }], is_steer: false });
  // Opening the typed job can finish before the program is ready to take Escape.
  if (line === 'HANG typed') await sleep(100);
  if (line.includes('BLOCKED')) return blocked();
  const turnId = turn++;
  record('turn.prompt', { input: [{ type: 'text', text: line }], origin: { kind: 'user' } });
  if (await endsAtOnce(line, turnId)) return;
  await workFirst(line, turnId);
  if (line.includes('PARTS')) return parts(turnId, line.includes('HOOKFIRST'));
  await answer(line, turnId, context);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const loop = (turnId, event) => record('context.append_loop_event', { event: { turnId: String(turnId), ...event } });

async function newSession() {
  await startSession('new');
  prompt();
}

// A prompt hook of the person's own said no: Kimi completes the prompt as blocked and starts no turn.
function blocked() {
  record('prompt.completed', { promptId: `p${turn}`, finishedAt: new Date().toISOString(), reason: 'blocked' });
  print('Blocked by a hook\n');
  prompt();
}

// Whether the turn ended as it started: CRASH ends the program, HANG waits until Escape stops it, ABORT logs a stopped
// turn and FAIL a failed one.
async function endsAtOnce(line, turnId) {
  const failure = failures.find(f => f.program === 'kimi' && line.startsWith(f.prompt));
  if (failure) {
    const { type, ...body } = failure.line;
    if (line.includes('HOOKFIRST')) await hook('stop', 'StopFailure', { error_type: body.error.name, error_message: body.error.message });
    record(type, { ...body, turnId });
    if (!line.includes('HOOKFIRST')) await hook('stop', 'StopFailure', { error_type: body.error.name, error_message: body.error.message });
    prompt();
    return true;
  }
  if (line.startsWith('CRASH')) crash(line.includes('LONG') ? 'long' : '');
  if (line.includes('HANG_EXIT')) print('exit-test running\n');
  if (line.includes('HANG')) {
    hanging = turnId;
    print(`waiting: ${line}\n`);
  } else if (line.includes('ABORT') || line.includes('FAIL')) {
    if (line.includes('ABORT')) await hook('interrupt', 'Interrupt', { turn_id: turnId, reason: 'cancelled' });
    record('turn.ended', line.includes('FAIL') ? { turnId, reason: 'failed', error: { name: 'APIError', message: 'The plan ran out.' } } : { turnId, reason: 'cancelled' });
    print('Interrupted\n');
  } else return false;
  prompt();
  return true;
}

async function workFirst(line, turnId) {
  if (line.includes('SLOW')) {
    prompt();
    await sleep(2000);
    print('\r\x1b[J');
  }
  if (!line.includes('WORK')) return;
  await sleep(1500);
  await hook('tool', 'PreToolUse', { tool_call_id: 'work-1', tool_name: 'Bash' });
  loop(turnId, { type: 'tool.call', step: 1, toolCallId: 'work-1', name: 'Bash', args: { command: 'make' } });
  await sleep(1500);
  await hook('tooldone', 'PostToolUse', { tool_call_id: 'work-1', tool_name: 'Bash' });
  loop(turnId, { type: 'tool.result', step: 1, toolCallId: 'work-1', result: { output: 'built', isError: false } });
}

// A step with a tool call, then a final message in two text parts with a thought between them.
async function parts(turnId, hookFirst) {
  loop(turnId, { type: 'step.begin', step: 1 });
  loop(turnId, { type: 'content.part', step: 1, part: { type: 'text', text: 'Looking.' } });
  loop(turnId, { type: 'tool.call', step: 1, toolCallId: 'c1', name: 'Bash', args: { command: 'ls' } });
  loop(turnId, { type: 'tool.result', step: 1, toolCallId: 'c1', result: { output: 'a.txt', isError: false } });
  loop(turnId, { type: 'step.end', step: 1 });
  loop(turnId, { type: 'step.begin', step: 2 });
  loop(turnId, { type: 'content.part', step: 2, part: { type: 'text', text: 'first half.' } });
  const stopping = hookFirst ? hook('stop', 'Stop', { turn_id: String(turnId) }) : null;
  if (hookFirst) await sleep(300);
  loop(turnId, { type: 'content.part', step: 2, part: { type: 'think', think: 'More.' } });
  loop(turnId, { type: 'content.part', step: 2, part: { type: 'text', text: ' second half.' } });
  loop(turnId, { type: 'step.end', step: 2 });
  record('turn.ended', { turnId, reason: 'completed' });
  await stopping;
  print('● first half. second half.\n');
  prompt();
}

async function answer(line, turnId, context) {
  const text = line === 'SECRET' ? `the key is ${process.env.FAKE_SECRET}` : `echo: ${line}${context ? `\n${context}` : ''}`;
  loop(turnId, { type: 'content.part', step: 1, part: { type: 'text', text } });
  if (line.includes('SWITCH')) record('config.update', { modelAlias: 'small' });
  record('token_counting.measured', { length: 2, tokens: 262144 });
  const stopping = !line.includes('LOGFIRST') ? hook('stop', 'Stop', {}) : null;
  record('turn.ended', { turnId, reason: 'completed' });
  await stopping;
  if (line.includes('LOGFIRST')) await hook('stop', 'Stop', {});
  print(`● ${text}\n`);
  prompt();
}

// Kimi reads keys raw: Escape stops a running turn at once, and Enter ends a line.
let typed = '';
let keepTail = Number(process.env.FAKE_KEEP_TAIL ?? 0);
let queue = Promise.resolve();
readKeys(key => {
  if (key === 'escape') {
    if (hanging !== null) {
      void hook('interrupt', 'Interrupt', { turn_id: hanging, reason: 'cancelled' });
      record('turn.ended', { turnId: hanging, reason: 'cancelled' });
      hanging = null;
      print('\r\x1b[JInterrupted\n');
      prompt();
    }
    return;
  }
  if (key === 'steer') {
    const text = typed;
    typed = '';
    print('\r\x1b[J\n');
    if (!text || hanging === null) return prompt();
    queue = queue.then(async () => {
      await hook('queued', 'UserPromptQueued', { prompt: [{ type: 'text', text }], is_steer: true });
      record('prompt.steered', { input: [{ type: 'text', text }] });
      if (process.env.FAKE_HOLD_WORDS) return prompt();
      const turnId = hanging;
      record('turn.steer', { turnId, input: [{ type: 'text', text }], origin: { inTurn: true } });
      hanging = null;
      await workFirst(text, turnId);
      await answer(text, turnId, '');
    });
    return;
  }
  if (key === 'enter') {
    const line = keepTail ? typed.slice(-keepTail) : typed;
    typed = '';
    print('\r\x1b[J\n');
    if (!line) return;
    keepTail = 0;
    queue = queue.then(() => take(line));
    return;
  }
  if (key === 'kill') typed = '';
  else if (key === 'erase') typed = typed.slice(0, -1);
  else typed += key.text;
  print(`\r\x1b[2K${inputRow(typed.replaceAll('\n', ' '))}`);
});
