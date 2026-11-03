#!/usr/bin/env node
// hh-agy AGY [--conversation ID] [FLAG...]: the terminal of an agent on Antigravity CLI. agy's own screen tells the node
// neither its answers nor its steps, so each message runs agy's print mode, whose stream-json its docs describe: the
// screen shows the answer and the steps as they come, HH_AGY_LOG gets agy's lines for the node, and the next message goes
// on in agy's conversation. Through HH_BRIDGE it tells the node when it is ready (start), what each message says (prompt)
// and how agy's turn ended (stop). A message typed while agy works goes after it; Escape stops agy's turn.
'use strict';

const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');

const WAIT_MS = { prompt: 12000 };
const STOP_MS = 3000;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

const [bin, ...given] = process.argv.slice(2);
let conversation = null;
const flags = [];
for (let i = 0; i < given.length; i++) {
  if (given[i] === '--conversation') conversation = given[++i] || null;
  else flags.push(given[i]);
}

const out = text => process.stdout.write(text);
const dim = text => `\x1b[2m${text}\x1b[22m`;

/* Tells the node; never fails the screen. */
async function hook(event, body) {
  const url = process.env.HH_BRIDGE;
  if (!url) return;
  await fetch(`${url}/${event}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WAIT_MS[event] ?? 3000),
  }).catch(() => {});
}

let line = '';
let pasting = false;
/* Messages typed while agy works, oldest first. */
const next = [];
/* A message is on its way to agy or agy works on it. */
let busy = false;
let stopping = false;
let child = null;

const prompt = () => out(`\n\x1b[1m›\x1b[22m `);

function typed(text) {
  line += text;
  if (!busy) out(text);
}

function enter() {
  const message = line.trim();
  line = '';
  if (!message) return;
  if (!busy) return void send(message);
  next.push(message);
  out(dim(`\nNext: ${message.length > 80 ? `${message.slice(0, 80)}...` : message}\n`));
}

function backspace() {
  if (!line) return;
  const gone = line.at(-1);
  line = line.slice(0, -1);
  if (!busy && gone !== '\n') out('\b \b');
}

/* Escape stops agy's turn and everything in its process group. */
function stop() {
  if (!busy || stopping) return;
  stopping = true;
  if (!child) return;
  const group = child.pid;
  const kill = signal => {
    try {
      process.kill(-group, signal);
    } catch {
      /* Already gone. */
    }
  };
  kill('SIGINT');
  setTimeout(() => kill('SIGKILL'), STOP_MS).unref();
}

/* Keys as a terminal sends them: a paste comes bracketed, so its line breaks stay in the message. */
function keys(chunk) {
  let rest = chunk;
  while (rest) {
    if (pasting) {
      const end = rest.indexOf(PASTE_END);
      typed((end < 0 ? rest : rest.slice(0, end)).replace(/\r\n?/g, '\n'));
      if (end < 0) return;
      pasting = false;
      rest = rest.slice(end + PASTE_END.length);
    } else if (rest.startsWith(PASTE_START)) {
      pasting = true;
      rest = rest.slice(PASTE_START.length);
    } else if (rest === '\x1b') {
      return stop();
    } else if (rest[0] === '\x1b') {
      /* Arrows and other keys with a sequence of their own do nothing here. */
      const sequence = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|O.|.)?/.exec(rest)[0];
      rest = rest.slice(sequence.length);
    } else {
      const ch = rest[0];
      rest = rest.slice(1);
      /* Enter, or a line feed from a terminal that turns Enter into one. */
      if (ch === '\r' || ch === '\n') enter();
      else if (ch === '\x7f' || ch === '\b') backspace();
      else if (ch === '\x03') stop();
      else if (ch >= ' ' || ch === '\t') typed(ch);
    }
  }
}

/* What a line of agy's stream-json shows: the answer as it comes, and each step once it is done. */
function show(event) {
  const step = event.step_update;
  if (event.event === 'step_update' && step && typeof step === 'object') {
    if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') out(step.text_delta);
    if (step.step_type === 'tool' && step.state === 'DONE') {
      const info = step.tool_info && typeof step.tool_info === 'object' ? step.tool_info : {};
      const input = info.parameters && typeof info.parameters.CommandLine === 'string' ? info.parameters.CommandLine : JSON.stringify(info.parameters ?? {});
      out(dim(`\n• ${info.name ?? step.tool_name ?? 'tool'} ${input.length > 200 ? `${input.slice(0, 200)}...` : input}\n`));
    }
  }
}

async function send(message) {
  busy = true;
  stopping = false;
  out('\n');
  /* The node opens a turn for a message a person typed, with its tools, before agy starts. */
  await hook('prompt', { prompt: message, ...(conversation ? { session_id: conversation } : {}) });
  if (stopping) return ended({ stopped: true });
  const args = [`--print=${message}`, '--output-format', 'stream-json', '--print-timeout', '0s', '--dangerously-skip-permissions'];
  if (conversation) args.push('--conversation', conversation);
  args.push(...flags);
  let result = null;
  let pending = '';
  let errors = '';
  const read = text => {
    if (process.env.HH_AGY_LOG) appendFileSync(process.env.HH_AGY_LOG, text + '\n');
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    if (!event || typeof event !== 'object') return;
    show(event);
    const said = event.step_update ?? event.result ?? event;
    if (said && typeof said.conversation_id === 'string' && said.conversation_id) conversation = said.conversation_id;
    if (event.event === 'result' && event.result && typeof event.result === 'object') result = event.result;
  };
  const code = await new Promise(resolve => {
    child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk;
      for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
        read(pending.slice(0, at));
        pending = pending.slice(at + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      errors = (errors + chunk).slice(-4000);
      out(dim(chunk));
    });
    child.on('error', err => {
      errors += err.message;
      resolve(null);
    });
    child.on('close', resolve);
  });
  if (pending) read(pending);
  child = null;
  if (stopping) return ended({ stopped: true });
  if (code === 0 && result?.status === 'SUCCESS') return ended({ last_assistant_message: String(result.response ?? '').trimEnd() });
  const error = (typeof result?.error === 'string' && result.error) || errors.trim() || `Antigravity CLI ended with code ${code}.`;
  if (!result?.error) out(`\n${error}`);
  return ended({ error });
}

async function ended(how) {
  if (stopping) out(dim('\nStopped.'));
  await hook('stop', { ...(conversation ? { session_id: conversation } : {}), ...how });
  busy = false;
  stopping = false;
  if (next.length) return void send(next.shift());
  prompt();
}

/* agy lists its models only when it is signed in, and says how to sign in otherwise. */
function signedIn() {
  return new Promise(resolve => {
    let said = '';
    const check = spawn(bin, ['models'], { stdio: ['ignore', 'pipe', 'pipe'] });
    check.stdout.on('data', chunk => (said += chunk));
    check.stderr.on('data', chunk => (said += chunk));
    check.on('error', err => resolve({ ok: false, said: err.message }));
    check.on('close', code => resolve({ ok: code === 0, said }));
  });
}

async function main() {
  out(dim('Antigravity CLI, run by Hornhoof. Type a message and press Enter; Escape stops a running turn.\n'));
  const check = await signedIn();
  if (!check.ok) {
    out(check.said);
    process.exit(1);
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', keys);
  /* Pastes come bracketed, so a message of several lines arrives as one. */
  out('\x1b[?2004h');
  await hook('start', conversation ? { session_id: conversation } : {});
  prompt();
}

void main();
