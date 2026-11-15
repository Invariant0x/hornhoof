#!/usr/bin/env node
// Plays agy's own terminal from the recorded screens, hooks and transcript. Login keeps its own recorded flow.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstRun } from './fake-agy-setup.mjs';
import { rawKeys, readKeys } from './keys.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = name => readFileSync(new URL(`../fixtures/agy-tui/${name}`, import.meta.url), 'utf8');
const trace = data => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(data) + '\n');
};

async function runHook(command, payload) {
  const args = command.split(' ');
  const bin = args.shift();
  const child = bin === 'hh-hook' ? spawn(process.execPath, [fileURLToPath(new URL('../../hh-hook.cjs', import.meta.url)), ...args]) : spawn(bin, args);
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', data => stdout += data);
  child.stderr.pipe(process.stderr);
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stdin.end(JSON.stringify(payload));
  await exited;
  return stdout;
}

class AgyTerminal {
  input = '';
  active = null;
  queued = [];
  lines = fixture('transcript.jsonl').trim().split('\n').map(JSON.parse);

  constructor() {
    const args = process.argv.slice(2);
    this.id = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : randomUUID();
    this.log = join(process.env.HOME, '.gemini', 'antigravity-cli', 'brain', this.id, '.system_generated', 'logs', 'transcript_full.jsonl');
    mkdirSync(dirname(this.log), { recursive: true });
    /* agy starts in any folder; only an agent's folder has Hornhoof's hooks and rules. */
    const own = file => (existsSync(file) ? readFileSync(file, 'utf8') : null);
    this.hooks = JSON.parse(own(join(process.cwd(), '.agents', 'hooks.json')) ?? '{}').hornhoof;
    trace({ argv: args, home: process.env.HOME, agentsMd: own('AGENTS.md'), hooks: this.hooks });
    this.mcpUrl = JSON.parse(own(join(process.cwd(), '.agents', 'mcp_config.json')) ?? '{}').mcpServers?.hornhoof?.serverUrl;
    rawKeys();
    this.display();
    readKeys(key => this.key(key));
  }

  /* agy 1.4.12 connects to the MCP servers of its folder only once it takes its first input or opens its /mcp panel, never
     on its own, and the turn whose input made it connect works without their tools.
     FAKE_MCP_LIST_MS: how long listing them takes; FAKE_AGY_NO_TOOLS: it never gets them. */
  tools = false;

  connect() {
    if (this.connecting || !this.mcpUrl || process.env.FAKE_AGY_NO_TOOLS) return;
    this.connecting = true;
    setTimeout(async () => {
      const listed = await fetch(this.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
        .then(res => res.json(), () => null);
      this.tools = Array.isArray(listed?.result?.tools);
      trace({ toolsListed: this.tools });
      if (this.panel) this.display();
    }, Number(process.env.FAKE_MCP_LIST_MS ?? 50));
  }

  /* agy's /mcp panel connects to the folder's MCP servers and calls no model; Escape closes it. Its look here stands in for
     agy's, which was not recorded: it shows no prompt, and the prompt from before stays in the lines above the screen. FAKE_MCP_PANEL_STAYS: Escape does not close it;
     FAKE_MCP_PANEL_KEEPS_INPUT: closed, it leaves "/mcp" in agy's input. */
  openPanel() {
    /* agy empties its input as it takes the command, and the panel then scrolls that empty prompt up. */
    this.display();
    this.panel = true;
    trace({ mcpPanel: 'open' });
    this.connect();
    this.display();
  }

  closePanel() {
    if (process.env.FAKE_MCP_PANEL_STAYS) return trace({ mcpPanel: 'kept' });
    this.panel = false;
    if (process.env.FAKE_MCP_PANEL_KEEPS_INPUT) this.input = '/mcp';
    trace({ mcpPanel: 'closed' });
    this.display();
  }

  write(line) {
    appendFileSync(this.log, JSON.stringify(line) + '\n');
  }

  show(name, typed = '') {
    let text = fixture(`screen-${name}`).trimEnd();
    if (typed) text = text.replace(/>(\x1b\[[0-9;]*m)?\n(?=(?:\x1b\[[0-9;]*m)?─)/, (_, style = '') => `>${style} ${typed}\n`);
    if (this.active) text = text.replace('Run the shell command: sleep 8; echo slept. Then reply FINISHED.', this.active.line);
    if (this.queued.length) text = text.replace('Also say BANANA.', this.queued[0]);
    if (process.env.FAKE_OLD_AGY_ERROR && !this.oldErrorShown) text = 'AGY_ERROR: {"short_error":"The server is overloaded","retryable":false,"old":true}\n' + text;
    if (process.env.FAKE_OLD_INTERRUPTED) text = '⎿  Interrupted · What should Antigravity CLI do instead?\n' + text;
    process.stdout.write(`\x1b[0m\x1b[2J\x1b[H${text}\x1b[0m`);
    this.oldErrorShown = true;
  }

  display() {
    /* The panel scrolls agy's prompt up into the lines above the screen rather than clear it. */
    if (this.panel) return process.stdout.write(`\x1b[0m${'\n'.repeat(process.stdout.rows ?? 48)} Manage MCP servers\n\n  hornhoof  ${this.tools ? 'connected' : 'connecting'}\n\n Esc to close`);
    /* FAKE_AGY_SHOWN_AFTER_MCP: what agy shows after /mcp typed, as a suggestion of its list; FAKE_AGY_PLACEHOLDER: a dim
       placeholder in its empty input. */
    const empty = process.env.FAKE_AGY_PLACEHOLDER ? '\x1b[2mAsk anything\x1b[22m' : '';
    const shown = this.input === '/mcp' ? this.input + (process.env.FAKE_AGY_SHOWN_AFTER_MCP ?? '') : this.input || empty;
    this.show(this.queued.length ? 'queued.txt' : this.active ? 'busy.ansi' : 'idle.ansi', shown);
  }

  async hook(name, sample, line, extra = {}) {
    const payload = { ...JSON.parse(fixture(sample)), conversationId: this.id, lastUserInput: line, ...extra };
    for (const command of this.hooks[name] ?? []) {
      const stdout = await runHook(command.command, payload);
      trace({ hook: name, payload, stdout });
    }
  }

  async take(line) {
    const turn = { line };
    trace({ turn: line, tools: this.tools });
    this.connect();
    this.active = turn;
    this.display();
    await this.hook('PreInvocation', 'hook-pre.json', line);
    if (this.active !== turn) return;
    this.write({ ...this.lines[line.includes('BANANA') ? 4 : 0], content: `<USER_REQUEST>\n${line}\n</USER_REQUEST>` });
    if (line.includes('HANG')) return;
    if (await this.work(turn)) await this.finish(turn);
  }

  async work(turn) {
    const { line } = turn;
    await sleep(line.includes('TICK') || line.includes('WORK') ? 1500 : 200);
    if (this.active !== turn) return false;
    if (line.includes('BANANA')) return true;
    this.write(line.includes('LAG_TEXT') ? { ...this.lines[1], content: 'Checking the command.' } : this.lines[1]);
    if (line.includes('CUT')) return false;
    await sleep(line.includes('WORK') ? 1500 : 150);
    if (this.active !== turn) return false;
    this.write(line.includes('APIFAIL') ? { ...this.lines[2], status: 'ERROR', content: 'failed tool' } : this.lines[2]);
    await this.hook('PreInvocation', 'hook-pre-after-tool.json', line);
    return this.active === turn;
  }

  async finish(turn) {
    const { line } = turn;
    const answer = this.lines[line.includes('BANANA') ? 5 : 3];
    if (!line.includes('LAG')) this.write(answer);
    if (line.includes('ROLLOVER')) await new Promise(resolve => process.stdout.write('x'.repeat(3 * 256 * 1024) + '\n', resolve));
    if (line.includes('APIFAIL') && !line.includes('NO_DETAIL')) process.stderr.write('AGY_ERROR: {"short_error":"The server is overloaded","retryable":false}\n');
    if (!line.includes('NO_STOP')) await this.hook('Stop', 'hook-stop.json', line, { error: line.includes('APIFAIL') ? 'The server is overloaded' : line.includes('FAIL') ? 'invalid model selection' : '' });
    if (line.includes('LAG')) { await sleep(250); this.write(answer); }
    if (this.active !== turn) return;
    this.active = null;
    this.display();
    if (this.queued.length) void this.take(this.queued.shift());
  }

  interrupt() {
    if (!this.active) return;
    this.active = null;
    this.queued.length = 0;
    this.input = '';
    this.show('interrupted.txt');
    trace({ interrupted: true });
  }

  key(key) {
    /* FAKE_AGY_DEAF: agy takes no keys at all; FAKE_AGY_EXITS_ON_KEY: it exits on the first one. */
    if (process.env.FAKE_AGY_DEAF) return trace({ deafKey: key });
    if (process.env.FAKE_AGY_EXITS_ON_KEY) process.exit(3);
    /* The node types nothing into the panel but the Escape that closes it. */
    if (this.panel) return key === 'escape' ? this.closePanel() : trace({ panelKey: key });
    if (key === 'escape') return this.interrupt();
    if (key === 'kill') this.input = this.input.slice(0, this.input.lastIndexOf('\n') + 1);
    else if (key === 'erase') this.input = this.input.slice(0, -1);
    else if (key !== 'enter') this.input += key.text;
    if (key !== 'enter') return this.display();
    const line = this.input;
    this.input = '';
    if (!line) return;
    if (line === '/mcp') return this.openPanel();
    if (this.active) { this.queued.push(line); this.display(); }
    else void this.take(line);
  }
}

if (process.argv.includes('--print=/usage') && process.argv.includes('--output-format')) {
  const modeFile = join(process.env.HOME ?? '', '.fake-limits-mode');
  const mode = existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : '';
  if (mode === 'fail') {
    process.stderr.write('error: failed to fetch usage\n');
    process.exit(1);
  }
  if (mode === 'bad_json') {
    process.stdout.write('not json\n');
    process.exit(0);
  }
  const custom = join(process.env.HOME ?? '', '.fake-agy-usage.json');
  process.stdout.write(existsSync(custom) ? readFileSync(custom) : readFileSync(new URL('../fixtures/agy-usage.json', import.meta.url)));
  process.exit(0);
}
if (!process.argv.includes('--dangerously-skip-permissions')) await import('./fake-agy-login.mjs');
else {
  /* agy asks for its first-run setup before anything else on a machine where nobody passed it. */
  await firstRun();
  new AgyTerminal();
}
