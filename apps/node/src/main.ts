#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Limits, NodeMessage, ProviderId, ServerMessage } from '@hornhoof/protocol';
import { connect } from './connection.js';
import { adapterFor, programFor } from './providers/index.js';
import { runJob, type ProviderAdapter, type RunResult } from './runner.js';
import { dataDir, isRemoved, markRemoved, readState, writeState, type NodeState } from './state.js';

export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const LOGIN_CHECK_MS = 10_000;

type JobRun = Extract<ServerMessage, { type: 'job.run' }>;

type RunOptions = {
  dir: string;
  /* A personal node runs one agent program; the built-in node picks one per job. */
  adapter: ProviderAdapter | ((job: JobRun) => ProviderAdapter);
  /* The built-in node takes Hornhoof's address and its key from the env instead of node.json. */
  builtin?: { server: string; key: string };
  log?: (line: string) => void;
  loginCheckMs?: number;
};

/* The node's life: stay connected, run jobs, report the sign-in state and the limits, clean up when removed. */
export async function runNode({ dir, adapter, builtin, log = console.log, loginCheckMs = LOGIN_CHECK_MS }: RunOptions): Promise<{ stop(): void }> {
  if (!builtin && isRemoved(dir)) {
    log('This node was removed in Hornhoof.');
    return { stop() {} };
  }
  const state = builtin ?? readState(dir);
  if (!state) throw new Error(`No node settings in ${dir}/node.json. Run the install command from Hornhoof again.`);
  /* The built-in node serves API keys, which need no sign-in. */
  const single = typeof adapter === 'function' ? null : adapter;
  const pick = typeof adapter === 'function' ? adapter : () => adapter;

  const running = new Set<string>();
  /* Messages that could not be sent while offline. They go out right after the next hello. */
  const outbox: NodeMessage[] = [];
  let send: ((m: NodeMessage) => boolean) | null = null;
  let loggedIn = single ? await single.loggedIn() : true;
  let limits: Limits | null = null;
  let stopped = false;

  const emit = (m: NodeMessage) => {
    if (!send?.(m)) outbox.push(m);
  };
  const status = () => emit({ type: 'status', loggedIn, limits });

  const conn = connect({
    url: state.server.replace(/^http/, 'ws') + '/api/nodes/socket',
    key: state.key,
    onOpen(next) {
      send = next;
      /* Finished jobs waiting in the outbox still count as running, so the server does not give up on them. */
      const pending = outbox.flatMap(m => (m.type === 'job.done' ? [m.jobId] : []));
      next({ type: 'hello', version: VERSION, loggedIn, running: [...running, ...pending] });
      for (const m of outbox.splice(0)) emit(m);
    },
    onMessage: m => void handle(m),
    onRefused: () => log('Hornhoof does not know this machine any more. Run the install command from Hornhoof again to reconnect.'),
  });

  async function handle(m: ServerMessage) {
    if (m.type === 'remove') {
      /* Only personal subscriptions are removed this way; the built-in node stays. */
      if (builtin) return;
      for (const sub of ['home', 'work']) rmSync(join(dir, sub), { recursive: true, force: true });
      markRemoved(dir);
      emit({ type: 'removed' });
      log('This node was removed in Hornhoof.');
      stop();
      return;
    }
    if (running.has(m.jobId)) return;
    running.add(m.jobId);
    emit({ type: 'job.started', jobId: m.jobId });
    const chosen = pick(m);
    const tracked: ProviderAdapter = {
      ...chosen,
      run: async input => {
        const res = await chosen.run(input);
        if (res.limits) limits = res.limits;
        return res;
      },
    };
    const done = await runJob(tracked, m, dir);
    running.delete(m.jobId);
    emit(done);
    if (done.error === 'not_logged_in') loggedIn = false;
    status();
  }

  /* While signed out, look again now and then, so the person sees Ready soon after signing in. */
  const timer = setInterval(async () => {
    if (loggedIn || stopped || !single) return;
    if (await single.loggedIn()) {
      loggedIn = true;
      status();
    }
  }, loginCheckMs);
  timer.unref();

  function stop() {
    stopped = true;
    clearInterval(timer);
    /* Let the last message leave before the socket closes. */
    setTimeout(() => conn.close(), 50);
  }
  return { stop };
}

export type Io = { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };

const USAGE = 'Usage: hornhoof-node run [--builtin] | login | status | set-key';
const SET_KEY_LINE = 'set-key expects one line: <server> <subscriptionId> <provider> <key>';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/* The agent program for a personal node lives in /data/tools, its sign-in in /data/home. */
const personal = (dir: string, provider: ProviderId) => adapterFor(provider, { home: join(dir, 'home'), tools: join(dir, 'tools') });

/* Each program is installed the first time something needs it. A failed install is tried again next time. */
const installing = new Map<string, Promise<void>>();
function ensureInstalled(tools: string, provider: ProviderId, adapter: ProviderAdapter): Promise<void> {
  const path = join(tools, 'bin', programFor(provider).bin);
  if (existsSync(path)) return Promise.resolve();
  let pending = installing.get(path);
  if (!pending) {
    pending = adapter.install().finally(() => installing.delete(path));
    installing.set(path, pending);
  }
  return pending;
}

function withInstall(adapter: ProviderAdapter, tools: string, provider: ProviderId): ProviderAdapter {
  return {
    ...adapter,
    async run(input): Promise<RunResult> {
      try {
        await ensureInstalled(tools, provider, adapter);
      } catch (err) {
        const output = `Could not install ${programFor(provider).name}: ${message(err)}`;
        return { ok: false, sessionId: null, result: '', output, error: 'agent_failed', limits: null };
      }
      return adapter.run(input);
    },
  };
}

function firstLine(input: NodeJS.ReadableStream): Promise<string> {
  return new Promise(resolve => {
    let text = '';
    const finish = () => {
      input.off('data', onData);
      input.off('end', finish);
      input.pause();
      resolve(text.split('\n')[0]!.trim());
    };
    const onData = (chunk: Buffer | string) => {
      text += chunk.toString();
      if (text.includes('\n')) finish();
    };
    input.on('data', onData);
    input.on('end', finish);
    input.resume();
  });
}

async function setKey(dir: string, io: Io): Promise<number> {
  const [server, subscriptionId, provider, key, ...rest] = (await firstLine(io.stdin)).split(/\s+/);
  try {
    if (rest.length) throw new Error('extra words');
    mkdirSync(dir, { recursive: true });
    writeState(dir, { server, subscriptionId, provider, key } as NodeState);
  } catch {
    io.stderr.write(`${SET_KEY_LINE}.\n`);
    return 1;
  }
  /* A new key means Hornhoof took this machine back after a removal. */
  rmSync(join(dir, 'removed'), { force: true });
  return 0;
}

async function status(dir: string, io: Io): Promise<number> {
  const state = readState(dir);
  const word = isRemoved(dir) ? 'removed' : !state ? 'no_key' : (await personal(dir, state.provider).loggedIn()) ? 'ready' : 'needs_login';
  io.stdout.write(word + '\n');
  return 0;
}

async function login(dir: string, io: Io): Promise<number> {
  const state = readState(dir);
  if (!state) {
    io.stderr.write('This machine has no key yet. Run the install command from Hornhoof.\n');
    return 1;
  }
  const adapter = personal(dir, state.provider);
  const { name, bin } = programFor(state.provider);
  try {
    if (!existsSync(join(dir, 'tools', 'bin', bin))) io.stdout.write(`Installing ${name}.\n`);
    await ensureInstalled(join(dir, 'tools'), state.provider, adapter);
  } catch (err) {
    io.stderr.write(`Could not install ${name}: ${message(err)}\n`);
    return 1;
  }
  if (!(await adapter.loggedIn())) {
    /* The installer watches this file and opens the link in the person's browser. */
    const urlFile = join(dir, 'login-url');
    rmSync(urlFile, { force: true });
    try {
      await adapter.login({ input: io.stdin, output: io.stdout, urlFile });
    } catch (err) {
      io.stderr.write(`Sign-in to ${name} failed: ${message(err)}\n`);
      return 1;
    }
    if (!(await adapter.loggedIn())) {
      io.stderr.write(`${name} is still not signed in. Run the install command again to retry.\n`);
      return 1;
    }
  }
  io.stdout.write('Logged in.\n');
  return 0;
}

async function run(dir: string, builtinMode: boolean, io: Io): Promise<number | { stop(): void }> {
  const log = (line: string) => void io.stdout.write(line + '\n');
  const tools = join(dir, 'tools');
  if (!builtinMode) {
    const state = readState(dir);
    if (!state && !isRemoved(dir)) {
      io.stderr.write('This machine has no key yet. Run the install command from Hornhoof.\n');
      return 1;
    }
    const provider = state?.provider ?? 'claude';
    return runNode({ dir, adapter: withInstall(personal(dir, provider), tools, provider), log });
  }

  const server = process.env.HORNHOOF_SERVER;
  const key = process.env.NODE_KEY;
  if (!server || !key) {
    io.stderr.write('The built-in node needs HORNHOOF_SERVER and NODE_KEY in its env.\n');
    return 1;
  }
  /* Each API key gets its own home, so two keys of one provider never share settings. */
  const pick = (job: JobRun) => withInstall(adapterFor(job.provider, { home: join(dir, 'subs', job.subscriptionId), tools }), tools, job.provider);
  /* Install both programs right away, so the first check does not wait for npm. */
  for (const provider of ['anthropic_api', 'openai_api'] as const) {
    ensureInstalled(tools, provider, adapterFor(provider, { home: dir, tools })).catch(err => log(`Could not install ${programFor(provider).name}: ${message(err)}`));
  }
  return runNode({ dir, adapter: pick, builtin: { server, key }, log });
}

/* One command line. A running node answers its handle and keeps the process up; the others answer an exit code. */
export async function command(args: string[], io: Io): Promise<number | { stop(): void }> {
  const dir = dataDir();
  switch (args[0]) {
    case 'run':
      return run(dir, args[1] === '--builtin', io);
    case 'login':
      return login(dir, io);
    case 'status':
      return status(dir, io);
    case 'set-key':
      return setKey(dir, io);
    default:
      io.stderr.write(USAGE + '\n');
      return 1;
  }
}

function isEntry(): boolean {
  try {
    return realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntry()) {
  void command(process.argv.slice(2), process).then(res => {
    if (typeof res === 'number') process.exit(res);
    /* Stay up, also after a removal, until Docker stops the container. */
    setInterval(() => {}, 1 << 30);
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => {
        res.stop();
        setTimeout(() => process.exit(0), 100);
      });
    }
  }, err => {
    console.error(message(err));
    process.exit(1);
  });
}
