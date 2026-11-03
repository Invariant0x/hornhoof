#!/usr/bin/env node
// Plays agy's own terminal from the recorded screens, hooks and transcript. Login keeps its own recorded flow.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    this.hooks = JSON.parse(readFileSync(join(process.cwd(), '.agents', 'hooks.json'), 'utf8')).hornhoof;
    trace({ argv: args, home: process.env.HOME, agentsMd: readFileSync('AGENTS.md', 'utf8'), hooks: this.hooks });
    rawKeys();
    this.display();
    readKeys(key => this.key(key));
  }

  write(line) {
    appendFileSync(this.log, JSON.stringify(line) + '\n');
  }

  show(name, typed = '') {
    let text = fixture(`screen-${name}`).trimEnd();
    if (typed) text = text.replace(/>(\x1b\[[0-9;]*m)?\n(?=(?:\x1b\[[0-9;]*m)?─)/, (_, style = '') => `>${style} ${typed}\n`);
    if (this.active) text = text.replace('Run the shell command: sleep 8; echo slept. Then reply FINISHED.', this.active.line);
    if (this.queued.length) text = text.replace('Also say BANANA.', this.queued[0]);
    if (process.env.FAKE_OLD_INTERRUPTED) text = '⎿  Interrupted · What should Antigravity CLI do instead?\n' + text;
    process.stdout.write(`\x1b[0m\x1b[2J\x1b[H${text}\x1b[0m`);
  }

  display() {
    this.show(this.queued.length ? 'queued.txt' : this.active ? 'busy.ansi' : 'idle.ansi', this.input);
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
    this.write(this.lines[2]);
    await this.hook('PreInvocation', 'hook-pre-after-tool.json', line);
    return this.active === turn;
  }

  async finish(turn) {
    const { line } = turn;
    const answer = this.lines[line.includes('BANANA') ? 5 : 3];
    if (!line.includes('LAG')) this.write(answer);
    if (!line.includes('NO_STOP')) await this.hook('Stop', 'hook-stop.json', line, { error: line.includes('FAIL') ? 'invalid model selection' : '' });
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
    if (key === 'escape') return this.interrupt();
    if (key === 'kill') this.input = this.input.slice(0, this.input.lastIndexOf('\n') + 1);
    else if (key === 'erase') this.input = this.input.slice(0, -1);
    else if (key !== 'enter') this.input += key.text;
    if (key !== 'enter') return this.display();
    const line = this.input;
    this.input = '';
    if (!line) return;
    if (this.active) { this.queued.push(line); this.display(); }
    else void this.take(line);
  }
}

if (!process.argv.includes('--dangerously-skip-permissions')) await import('./fake-agy-login.mjs');
else new AgyTerminal();
