#!/usr/bin/env node
// Plays Kimi Code in a terminal for the host tests: shows its welcome and footer, starts a new session only with the first
// message, as Kimi does, keeps the session log under KIMI_CODE_HOME/sessions, calls the hooks named in its config.toml
// with Kimi's snake_case input, and answers each line with "echo: LINE". -S resumes a session, or fails as Kimi does when
// there is none. HANG never answers until Escape stops it, ABORT logs a stopped turn, FAIL a failed one, SLOW answers after
// 2 s, EXIT ends the program, SECRET prints the value of FAKE_SECRET, /new starts a new session. FAKE_MCP_LIST_MS makes it
// list its Hornhoof tools from .kimi-code/mcp.json that long after its session's workspace opened, and show "tools: ok" or
// "tools: failed". FAKE_SIGNED_OUT shows what a signed-out Kimi shows.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

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
    ? fetch(`${process.env.HH_BRIDGE}/${event}`, { method: 'POST', body: JSON.stringify({ hook_event_name: name, session_id: session, cwd: process.cwd(), ...body }) }).catch(() => {})
    : Promise.resolve();
const record = (type, payload) => appendFileSync(wireOf(session), JSON.stringify({ type, agentId: 'main', ...payload, time: Date.now() }) + '\n');
const print = text => process.stdout.write(text);

function listTools() {
  if (!process.env.FAKE_MCP_LIST_MS) return;
  setTimeout(async () => {
    const { url } = JSON.parse(readFileSync(join(process.cwd(), '.kimi-code', 'mcp.json'), 'utf8')).mcpServers.hornhoof;
    const listed = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
      .then(r => r.json())
      .catch(() => null);
    print(`tools: ${listed?.result ? 'ok' : 'failed'}\n❯ `);
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

print(`fake kimi ${session ? `resumed ${session}` : 'new'}\nWelcome to Kimi Code!\n`);
print(process.env.FAKE_SIGNED_OUT ? 'Run /login or /provider to get started.\n' : 'Send /help for help information.\n');
print('context: 0% (0/256k)\n❯ ');
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
    print('❯ ');
    return;
  }
  if (!session) await startSession('startup');
  await hook('prompt', 'UserPromptSubmit', { prompt: [{ type: 'text', text: line }], is_steer: false });
  if (line.includes('BLOCKED')) {
    // A prompt hook of the person's own said no: Kimi completes the prompt as blocked and starts no turn.
    record('prompt.completed', { promptId: `p${turn}`, finishedAt: new Date().toISOString(), reason: 'blocked' });
    print('Blocked by a hook\n❯ ');
    return;
  }
  const turnId = turn++;
  record('turn.prompt', { input: [{ type: 'text', text: line }], origin: { kind: 'user' } });
  if (line.includes('HANG')) {
    hanging = turnId;
    return;
  }
  if (line.includes('ABORT') || line.includes('FAIL')) {
    record('turn.ended', line.includes('FAIL') ? { turnId, reason: 'failed', error: { name: 'APIError', message: 'The plan ran out.' } } : { turnId, reason: 'cancelled' });
    print('Interrupted\n❯ ');
    return;
  }
  if (line.includes('SLOW')) await new Promise(r => setTimeout(r, 2000));
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
    print('● first half. second half.\n❯ ');
    return;
  }
  const answer = line === 'SECRET' ? `the key is ${process.env.FAKE_SECRET}` : `echo: ${line}`;
  loop({ type: 'content.part', step: 1, part: { type: 'text', text: answer } });
  record('turn.ended', { turnId, reason: 'completed' });
  print(`● ${answer}\n❯ `);
}

// Kimi reads keys raw: Escape stops a running turn at once, and Enter ends a line.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let typed = '';
let queue = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
  for (const ch of data) {
    if (ch === '\u001b') {
      if (hanging !== null) {
        record('turn.ended', { turnId: hanging, reason: 'cancelled' });
        hanging = null;
        print('Interrupted\n❯ ');
      }
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      const line = typed.replace(/\[[0-9;]*[~A-Za-z]/g, '');
      typed = '';
      if (line) queue = queue.then(() => take(line));
      continue;
    }
    typed += ch;
  }
});
