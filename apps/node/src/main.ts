#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOAD_MS, type AgentEvent, type Limits, type NodeLoad, type NodeMessage, type ProviderId, type ServerMessage } from '@hornhoof/protocol';
import { agentFs, ownFs, type AgentFs } from './agent-fs.js';
import { connect } from './connection.js';
import { agentUser, builtinAdapters, secureNode, userFor, type JobUser } from './isolation.js';
import { machineLoad } from './load.js';
import { adapterFor, programFor } from './providers/index.js';
import { runJob, type ProviderAdapter, type RunResult } from './runner.js';
import { dataDir, isRemoved, markRemoved, readState, rememberSession, writeState, type NodeState } from './state.js';
import { runTests } from './tests.js';
import { SIGNED_OUT as AGY_SIGNED_OUT } from './providers/antigravity.js';
import { SIGNED_OUT as CLAUDE_SIGNED_OUT } from './providers/claude.js';
import { SIGNED_OUT as CODEX_SIGNED_OUT } from './providers/codex.js';
import { SCREEN_SIGNED_OUT as KIMI_SIGNED_OUT } from './providers/kimi.js';
import { childEnv, firstLine } from './providers/process.js';
import { TerminalHost } from './terminal/host.js';
import { agyProgram, claudeProgram, codexProgram, kimiProgram, type TermProgram } from './terminal/programs.js';
import { Tmux } from './terminal/tmux.js';

export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const LOGIN_CHECK_MS = 10_000;
/* How often a node with terminals reads its program's tokens again: a program signs in again or renews them between turns. */
const LEARN_MS = 60_000;
/* How often a personal node asks its program for the plan's limits between turns: work on other machines moves them too. */
const LIMITS_MS = 5 * 60_000;
/* How long a removal waits for called-off jobs to stop before it deletes their folders. */
const STOP_WAIT_MS = 5_000;
/* How many unconfirmed job ends a node keeps for a server that does not confirm them. */
const MAX_UNCONFIRMED = 50;

type JobRun = Extract<ServerMessage, { type: 'job.run' }>;
type TestRun = Extract<ServerMessage, { type: 'tests.run' }>;

/* Agents of a personal Claude Code, Codex or Kimi Code plan run in tmux sessions people can watch and type into. */
export type TerminalSetup = { tmux: Tmux; program: TermProgram; bin: string; home: string; signedOut: RegExp; proc?: string; user?: JobUser | null; fs?: AgentFs };

type RunOptions = {
  dir: string;
  terminal?: TerminalSetup;
  /* A personal node runs one agent program; the built-in node picks one per job. */
  adapter: ProviderAdapter | ((job: JobRun) => ProviderAdapter);
  /* The built-in node takes Hornhoof's address and its key from the env instead of node.json. */
  builtin?: { server: string; key: string };
  log?: (line: string) => void;
  loginCheckMs?: number;
  learnMs?: number;
  limitsMs?: number;
  /* How often the node says how busy its machine is. */
  loadMs?: number;
  /* The user test runs run as, on a node that runs as root; none runs them as the node, as its agents run there. */
  testUser?: JobUser | null;
  /* Runs a part of a test run; tests pass a fake. */
  runPart?: typeof runTests;
};

/* A complete list of the plan's windows replaces what the node knew. A partial one, such as the single window a turn
   tells, updates the windows it names and leaves the others as they were; one of those still full keeps the plan at
   its limit until it starts over. */
function merged(known: Limits | null, news: Limits): Limits {
  if (news.complete || !known) return news;
  const fresh = new Map(news.windows.map(w => [w.name, w]));
  const kept = known.windows.filter(w => !fresh.has(w.name));
  const windows = [...known.windows.map(w => fresh.get(w.name) ?? w), ...news.windows.filter(w => !known.windows.some(k => k.name === w.name))];
  const full = kept.some(w => (w.utilization ?? 0) >= 1 && (w.resetsAt === null || Date.parse(w.resetsAt) > Date.now()));
  return { status: full ? 'rejected' : news.status, windows: windows.slice(0, 8), ...(known.complete ? { complete: true } : {}) };
}

/* The node's life: stay connected, run jobs, report the sign-in state and the limits, clean up when removed. */
export async function runNode({ dir, adapter, builtin, terminal, log = console.log, loginCheckMs = LOGIN_CHECK_MS, learnMs = LEARN_MS, limitsMs = LIMITS_MS, loadMs = LOAD_MS, testUser = null, runPart = runTests }: RunOptions): Promise<{ stop(): void }> {
  if (!builtin && isRemoved(dir)) {
    log('This node was removed in Hornhoof.');
    return { stop() {} };
  }
  const state = builtin ?? readState(dir);
  if (!state) throw new Error(`No node settings in ${dir}/node.json. Run the install command from Hornhoof again.`);
  /* The node's own key never leaves in a job's output. */
  const hidden = [state.key];
  const toolsUrl = `${state.server}/mcp`;
  /* The built-in node serves API keys, which need no sign-in. */
  const single = typeof adapter === 'function' ? null : adapter;
  const pick = typeof adapter === 'function' ? adapter : () => adapter;

  /* Each running job with the way to call it off and the promise of its end, and the same for parts of test runs. */
  const running = new Map<string, { stop: AbortController; done: Promise<void> }>();
  const testing = new Map<string, { stop: AbortController; done: Promise<void> }>();
  /* Messages that could not be sent while offline. They go out right after the next hello. */
  const outbox: NodeMessage[] = [];
  /* Ends of jobs Hornhoof has not confirmed: a socket can drop with one on its way. They count as running and go again
     after each hello. A server that never confirms keeps only the last few. */
  const unconfirmed = new Map<string, NodeMessage>();
  const unconfirmedTests = new Map<string, NodeMessage>();
  let send: ((m: NodeMessage) => boolean) | null = null;
  let loggedIn = single ? await single.loggedIn() : true;
  let limits: Limits | null = null;
  let stopped = false;

  const emit = (m: NodeMessage) => {
    if (m.type === 'job.done') keep(m.jobId, m);
    if (m.type === 'tests.done') keepTest(m.partId, m);
    if (!send?.(m) && m.type !== 'job.done' && m.type !== 'tests.done') outbox.push(m);
  };
  const keep = (jobId: string, m: NodeMessage) => {
    unconfirmed.set(jobId, m);
    if (unconfirmed.size > MAX_UNCONFIRMED) unconfirmed.delete(unconfirmed.keys().next().value!);
  };
  const keepTest = (partId: string, m: NodeMessage) => {
    unconfirmedTests.set(partId, m);
    if (unconfirmedTests.size > MAX_UNCONFIRMED) unconfirmedTests.delete(unconfirmedTests.keys().next().value!);
  };
  /* Values no screen shows: the node's key, the programs' tokens and each turn's tokens. */
  const known = new Set(hidden);
  const learn = async (more: (string | null | undefined)[] = []) => {
    for (const s of more) if (s) known.add(s);
    for (const s of await (single?.secrets() ?? Promise.resolve([])).catch(() => [])) known.add(s);
  };
  /* A screen nobody receives is not worth keeping; everything else waits for the connection like any message. */
  const host = terminal
    ? new TerminalHost({
        tmux: terminal.tmux,
        hornhoof: state.server,
        send: m => (m.type === 'term.data' || m.type === 'term.exit' ? void send?.(m) : emit(m)),
        secrets: () => [...known],
        remember: (sessionId, workDir) => rememberSession(dir, sessionId, workDir),
        proc: terminal.proc,
        user: terminal.user,
        fs: terminal.fs,
      })
    : null;
  if (host && terminal) {
    /* Sessions from before a restart talk to a bridge that is gone; their turns failed with the restart. */
    await terminal.tmux.stopAll();
    await host.start();
    await learn();
  }
  /* A personal node says which models its program can run, read again after each job since a plan's list can change.
     The built-in node serves API keys, whose models Hornhoof knows. */
  const readModels = async () => (single?.models ? await single.models() : undefined);
  let models = await readModels();
  const status = async () => {
    /* A program that cannot list its models now keeps those it listed before. */
    models = await readModels().catch(() => models);
    emit({ type: 'status', loggedIn, limits, ...(models ? { models } : {}) });
  };

  /* How busy the machine is, which Hornhoof weighs when it picks a machine for a test run. */
  const load = (): NodeLoad => ({ ...machineLoad(), tests: testing.size, jobs: running.size });

  const conn = connect({
    url: state.server.replace(/^http/, 'ws') + '/api/nodes/socket',
    key: state.key,
    onOpen(next) {
      send = next;
      host?.closeViews();
      /* Finished jobs Hornhoof has not confirmed still count as running, so the server does not give up on them. */
      const typed = host?.typedJobs() ?? [];
      const tests = [...testing.keys(), ...unconfirmedTests.keys()];
      next({ type: 'hello', version: VERSION, loggedIn, running: [...running.keys(), ...typed, ...unconfirmed.keys()], ...(models ? { models } : {}), terminals: Boolean(host), load: load(), tests });
      for (const m of outbox.splice(0)) emit(m);
      for (const m of unconfirmed.values()) next(m);
      for (const m of unconfirmedTests.values()) next(m);
    },
    /* One message that fails is logged; it never ends the node with all its runs. */
    onMessage: m => void handle(m).catch(err => log(`A message from Hornhoof failed: ${message(err)}`)),
    onRefused: () => log('Hornhoof does not know this machine any more. Run the install command from Hornhoof again to reconnect.'),
  });

  async function handle(m: ServerMessage) {
    if (m.type === 'remove') {
      /* Only personal subscriptions are removed this way; the built-in node stays. */
      if (builtin || stopped) return;
      stopped = true;
      /* The agents stop first, so nothing writes into the folders while they go. */
      const jobs = [...running.values(), ...testing.values()];
      for (const job of jobs) job.stop.abort();
      await Promise.race([Promise.allSettled(jobs.map(j => j.done)), new Promise(r => setTimeout(r, STOP_WAIT_MS))]);
      await host?.stop();
      for (const sub of ['home', 'work']) rmSync(join(dir, sub), { recursive: true, force: true });
      markRemoved(dir);
      emit({ type: 'removed' });
      log('This node was removed in Hornhoof.');
      stop();
      return;
    }
    if (m.type === 'job.ack') return void unconfirmed.delete(m.jobId);
    if (m.type === 'tests.ack') return void unconfirmedTests.delete(m.partId);
    if (m.type === 'tests.cancel') return void testing.get(m.partId)?.stop.abort();
    if (m.type === 'tests.run') {
      if (stopped || testing.has(m.partId) || unconfirmedTests.has(m.partId)) return;
      const controller = new AbortController();
      const done = testOne(m, controller.signal);
      testing.set(m.partId, { stop: controller, done });
      return done;
    }
    if (m.type === 'job.cancel') {
      running.get(m.jobId)?.stop.abort();
      await host?.cancel(m.jobId);
      return;
    }
    switch (m.type) {
      case 'term.open':
        if (!host) return void send?.({ type: 'term.exit', termId: m.termId });
        return host.open(m).catch(() => void send?.({ type: 'term.exit', termId: m.termId }));
      case 'term.input':
        return host?.input(m);
      case 'term.resize':
        return host?.resize(m);
      case 'term.close':
        return host?.close(m);
      case 'turn.opened':
        return host?.opened(m);
      case 'agent.say': {
        const ok = host ? await host.say(m.agentKey, m.text).catch(() => false) : false;
        return void send?.({ type: 'agent.said', ref: m.ref, ok });
      }
    }
    if (stopped || running.has(m.jobId)) return;
    const controller = new AbortController();
    const done = runOne(m, controller.signal);
    running.set(m.jobId, { stop: controller, done });
    await done;
  }

  /* A part of a test run: no agent program takes part, and its user reaches none of the node's keys. */
  async function testOne(m: TestRun, signal: AbortSignal) {
    emit({ type: 'tests.started', partId: m.partId });
    const done = await runPart(m, { dir, user: testUser, hidden: [...known], signal });
    keepTest(m.partId, done);
    testing.delete(m.partId);
    emit(done);
  }

  async function runOne(m: JobRun, signal: AbortSignal) {
    emit({ type: 'job.started', jobId: m.jobId });
    let done: Awaited<ReturnType<typeof runJob>>;
    try {
      const chosen = pick(m);
      await learn([m.toolToken, m.secret, m.workspace?.repo?.token]);
      /* An agent's turn runs in its session; a test job, with no agent, runs as before. */
      const runIn = (input: Parameters<ProviderAdapter['run']>[0]) =>
        host && terminal && input.agentKey ? host.run({ key: input.agentKey, program: terminal.program, bin: terminal.bin, home: terminal.home, signedOut: terminal.signedOut, input }) : chosen.run(input);
      const tracked: ProviderAdapter = {
        ...chosen,
        run: async input => {
          const res = await runIn(input);
          if (res.limits) limits = merged(limits, res.limits);
          return res;
        },
      };
      let seq = 0;
      const onEvent = (event: AgentEvent) => emit({ type: 'job.event', jobId: m.jobId, seq: seq++, event });
      done = await runJob(tracked, m, dir, { hidden, signal, toolsUrl, onEvent, untimed: Boolean(host && terminal && m.workspace?.key) });
    } catch (err) {
      done = { type: 'job.done', jobId: m.jobId, ok: false, sessionId: null, result: '', tail: message(err), error: 'agent_failed' };
    }
    /* The end counts as running from here, so a hello while the limits are read does not give the job up. */
    keep(m.jobId, done);
    running.delete(m.jobId);
    /* The limits the turn brought go first, so Hornhoof knows of a plan at its limit when it hears the job ended. */
    await status();
    emit(done);
    if (done.error === 'not_logged_in') {
      loggedIn = false;
      void status();
    }
  }

  /* While signed out, look again now and then, so the person sees Ready soon after signing in. */
  const timer = setInterval(async () => {
    if (loggedIn || stopped || !single) return;
    if (await single.loggedIn()) {
      loggedIn = true;
      void status();
    }
  }, loginCheckMs);
  timer.unref();
  const learning = host ? setInterval(() => void learn(), learnMs) : null;
  learning?.unref();
  const askLimits = async () => {
    if (stopped || !single?.limits) return;
    const now = await single.limits().catch(() => null);
    if (!now || JSON.stringify(merged(limits, now)) === JSON.stringify(limits)) return;
    limits = merged(limits, now);
    void status();
  };
  void askLimits();
  const asking = setInterval(() => void askLimits(), limitsMs);
  asking.unref();
  /* An old figure says nothing, so one that cannot go out now is not kept for later. */
  const reporting = setInterval(() => void send?.({ type: 'load', ...load() }), loadMs);
  reporting.unref();

  function stop() {
    stopped = true;
    clearInterval(timer);
    if (learning) clearInterval(learning);
    clearInterval(asking);
    clearInterval(reporting);
    void host?.stop();
    /* Let the last message leave before the socket closes. */
    setTimeout(() => conn.close(), 50);
  }
  return { stop };
}

export type Io = { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };

const USAGE = 'Usage: hornhoof-node run [--builtin] | login | status | set-key';
const SET_KEY_LINE = 'set-key expects one line: <server> <subscriptionId> <provider> <key>';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/* The agent program for a personal node lives in /data/tools, its sign-in in /data/home. On a node that runs as root the
   program runs as the agents' user, who also make their folders and work in their repositories. */
function personal(dir: string, provider: ProviderId, user: JobUser | null = null, fs: AgentFs = ownFs): ProviderAdapter {
  const home = join(dir, 'home');
  const adapter = adapterFor(provider, { home, tools: join(dir, 'tools'), user });
  return user ? { ...adapter, owner: { user, home, prepare: () => {}, mkdir: path => fs.mkdir(path), fs } } : adapter;
}

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
  const word = isRemoved(dir) ? 'removed' : !state ? 'no_key' : (await personal(dir, state.provider, agentUser()).loggedIn()) ? 'ready' : 'needs_login';
  io.stdout.write(word + '\n');
  return 0;
}

async function login(dir: string, io: Io): Promise<number> {
  const state = readState(dir);
  if (!state) {
    io.stderr.write('This machine has no key yet. Run the install command from Hornhoof.\n');
    return 1;
  }
  const adapter = personal(dir, state.provider, agentUser());
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

/* The program a personal plan's agents run in their terminals, and what its screen says when it is not signed in. */
const TERMINALS: Partial<Record<ProviderId, { program: TermProgram; signedOut: RegExp }>> = {
  claude: { program: claudeProgram, signedOut: CLAUDE_SIGNED_OUT },
  codex: { program: codexProgram, signedOut: CODEX_SIGNED_OUT },
  kimi: { program: kimiProgram, signedOut: KIMI_SIGNED_OUT },
  antigravity: { program: agyProgram, signedOut: AGY_SIGNED_OUT },
};

/* A personal Claude Code, Codex, Kimi Code or Antigravity plan runs its agents in tmux when the machine has it; the rest
   run as before. */
function terminalFor(dir: string, provider: ProviderId, user: JobUser | null, fs: AgentFs): { terminal?: TerminalSetup } {
  const known = TERMINALS[provider];
  if (!known) return {};
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  } catch {
    return {};
  }
  const tools = join(dir, 'tools');
  const home = join(dir, 'home');
  const tmux = new Tmux({ env: childEnv(tools, { HOME: process.env.HOME ?? home }), recordingsDir: join(dir, '.hh-recordings') });
  /* Nodes run on Linux, where the bridge can tell which agent's program calls it. */
  const proc = process.platform === 'linux' && existsSync('/proc/net/tcp') ? '/proc' : undefined;
  return { terminal: { tmux, ...known, bin: join(tools, 'bin', programFor(provider).bin), home, proc, user, fs } };
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
    const user = agentUser();
    if (user) secureNode(dir, user);
    const fs = user ? agentFs(user) : ownFs;
    /* Test runs get a user of their own, apart from the agents' sign-in and folders. */
    const testUser = user ? userFor(dir, 'tests', true) : null;
    return runNode({ dir, adapter: withInstall(personal(dir, provider, user, fs), tools, provider), log, testUser, ...terminalFor(dir, provider, user, fs) });
  }

  const server = process.env.HORNHOOF_SERVER;
  const key = process.env.NODE_KEY;
  if (!server || !key) {
    io.stderr.write('The built-in node needs HORNHOOF_SERVER and NODE_KEY in its env.\n');
    return 1;
  }
  /* Each API key gets its own home and, as root, its own user, so two keys never share settings or files. */
  const builtinPick = builtinAdapters(dir, tools);
  const pick = (job: JobRun) => withInstall(builtinPick(job), tools, job.provider);
  /* Install both programs right away, so the first check does not wait for npm. */
  for (const provider of ['anthropic_api', 'openai_api'] as const) {
    ensureInstalled(tools, provider, adapterFor(provider, { home: dir, tools })).catch(err => log(`Could not install ${programFor(provider).name}: ${message(err)}`));
  }
  return runNode({ dir, adapter: pick, builtin: { server, key }, log, testUser: userFor(dir, 'tests') });
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
