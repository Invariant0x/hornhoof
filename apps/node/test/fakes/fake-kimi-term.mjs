#!/usr/bin/env node
// Plays Kimi Code in a terminal for the host tests: shows its welcome and footer, starts a new session only with the first
// message, as Kimi does, keeps the session log under KIMI_CODE_HOME/sessions, calls the hooks named in its config.toml
// with Kimi's snake_case input, and answers each line with "echo: LINE". -S resumes a session, or fails as Kimi does when
// there is none. HANG never answers until Escape stops it, ABORT logs a stopped turn, FAIL a failed one, SLOW answers after
// 2 s, EXIT ends the program, SECRET prints the value of FAKE_SECRET, /new starts a new session. FAKE_MCP_LIST_MS makes it
// list its Hornhoof tools from .kimi-code/mcp.json that long after its session's workspace opened, and show "tools: ok" or
// "tools: failed". FAKE_SIGNED_OUT shows what a signed-out Kimi shows. A paste comes whole, line breaks and all, as in Kimi;
// FAKE_KEEP_TAIL keeps only that many last characters of the first message. What its prompt hook prints goes with the
// prompt, as in Kimi Code.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { crash } from './crash.mjs';
import { rawKeys, readKeys } from './keys.mjs';

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
    ? fetch(`${process.env.HH_BRIDGE}/${event}`, { method: 'POST', body: JSON.stringify({ hook_event_name: name, session_id: session, cwd: process.cwd(), ...body }) })
        .then(r => r.text())
        .catch(() => '')
    : Promise.resolve('');
const record = (type, payload) => appendFileSync(wireOf(session), JSON.stringify({ type, agentId: 'main', ...payload, time: Date.now() }) + '\n');
const print = text => process.stdout.write(text);
const prompt = () => print(`── input ${'─'.repeat(60)}\n \n${'─'.repeat(69)}\ncontext: 0% (0/256k)\x1b[2A\r `);

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
  if (line === 'EXIT') process.exit(3);
  if (line === '/new') {
    await startSession('new');
    prompt();
    return;
  }
  if (!session) await startSession('startup');
  const context = await hook('prompt', 'UserPromptSubmit', { prompt: [{ type: 'text', text: line }], is_steer: false });
  // Opening the typed job can finish before the program is ready to take Escape.
  if (line === 'HANG typed') await new Promise(done => setTimeout(done, 100));
  if (line.includes('BLOCKED')) {
    // A prompt hook of the person's own said no: Kimi completes the prompt as blocked and starts no turn.
    record('prompt.completed', { promptId: `p${turn}`, finishedAt: new Date().toISOString(), reason: 'blocked' });
    print('Blocked by a hook\n');
    prompt();
    return;
  }
  const turnId = turn++;
  record('turn.prompt', { input: [{ type: 'text', text: line }], origin: { kind: 'user' } });
  if (line.startsWith('CRASH')) crash(line.includes('LONG') ? 'long' : '');
  if (line.includes('HANG_EXIT')) print('exit-test running\n');
  if (line.includes('HANG')) {
    hanging = turnId;
    print(`waiting: ${line}\n`);
    prompt();
    return;
  }
  if (line.includes('ABORT') || line.includes('FAIL')) {
    record('turn.ended', line.includes('FAIL') ? { turnId, reason: 'failed', error: { name: 'APIError', message: 'The plan ran out.' } } : { turnId, reason: 'cancelled' });
    print('Interrupted\n');
    prompt();
    return;
  }
  if (line.includes('SLOW')) {
    prompt();
    await new Promise(r => setTimeout(r, 2000));
    print('\r\x1b[J');
  }
  const loop = event => record('context.append_loop_event', { event: { turnId: String(turnId), ...event } });
  if (line.includes('PARTS')) {
    // A step with a tool call, then a final message in two text parts with a thought between them.
    loop({ type: 'step.begin', step: 1 });
    loop({ type: 'content.part', step: 1, part: { type: 'text', text: 'Looking.' } });
    loop({ type: 'tool.call', step: 1, toolCallId: 'c1', name: 'Bash', args: { command: 'ls' } });
    loop({ type: 'tool.result', step: 1, toolCallId: 'c1', result: { output: 'a.txt', isError: false } });
    loop({ type: 'step.end', step: 1 });
    loop({ type: 'step.begin', step: 2 });
    loop({ type: 'content.part', step: 2, part: { type: 'text', text: 'first half.' } });
    loop({ type: 'content.part', step: 2, part: { type: 'think', think: 'More.' } });
    loop({ type: 'content.part', step: 2, part: { type: 'text', text: ' second half.' } });
    loop({ type: 'step.end', step: 2 });
    record('turn.ended', { turnId, reason: 'completed' });
    print('● first half. second half.\n');
    prompt();
    return;
  }
  const answer = line === 'SECRET' ? `the key is ${process.env.FAKE_SECRET}` : `echo: ${line}${context ? `\n${context}` : ''}`;
  loop({ type: 'content.part', step: 1, part: { type: 'text', text: answer } });
  if (line.includes('SWITCH')) record('config.update', { modelAlias: 'small' });
  record('token_counting.measured', { length: 2, tokens: 262144 });
  record('turn.ended', { turnId, reason: 'completed' });
  print(`● ${answer}\n`);
  prompt();
}

// Kimi reads keys raw: Escape stops a running turn at once, and Enter ends a line.
let typed = '';
let keepTail = Number(process.env.FAKE_KEEP_TAIL ?? 0);
let queue = Promise.resolve();
readKeys(key => {
  if (key === 'escape') {
    if (hanging !== null) {
      record('turn.ended', { turnId: hanging, reason: 'cancelled' });
      hanging = null;
      print('\r\x1b[JInterrupted\n');
      prompt();
    }
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
  print(`\r\x1b[2K ${typed.replaceAll('\n', ' ')}`);
});
