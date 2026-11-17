#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { hostname, uptime } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOAD_MS, NodeBuild, type AgentEvent, type CredKind, type Limits, type NodeLoad, type NodeMessage, type NodeStopReason, type ProviderId, type ServerMessage } from '@hornhoof/protocol';
import { SIGNIN_ERRORS } from '@hornhoof/protocol/signin';
import { agentFs, ownFs, type AgentFs } from './agent-fs.js';
import { bootFacts } from './boot.js';
import { prepareAndVerifyBrowser, readBrowserError, startupBrowserCheck, writeBrowserError } from './browser.js';
import { connect } from './connection.js';
import { agentUser, builtinAdapters, secureNode, userFor, type JobUser } from './isolation.js';
import { machineLoad } from './load.js';
import { adapterFor, programFor } from './providers/index.js';
import { runJob, type ProviderAdapter, type RunInput, type RunResult } from './runner.js';
import { applyCredential, dropCredential, giveUpLease, heldCredential, holdsLease, isSpare, takeLease } from './credentials.js';
import { nodeIdentity, seal, unseal } from './keys.js';
import { LOGIN_KEY, LoginTerminal, type LoginSetup } from './login.js';
import { dataDir, isRemoved, markRemoved, readState, rememberSession, writeState, type NodeState } from './state.js';
import { SETUP_CHECK_MS, SetupWait } from './setup-wait.js';
import { partFiles, removeOldParts, runTests } from './tests.js';
import { SIGNED_OUT as AGY_SIGNED_OUT } from './providers/antigravity.js';
import { SIGNED_OUT as CLAUDE_SIGNED_OUT } from './providers/claude.js';
import { SIGNED_OUT as CODEX_SIGNED_OUT } from './providers/codex.js';
import { SCREEN_SIGNED_OUT as KIMI_SIGNED_OUT } from './providers/kimi.js';
import { childEnv, firstLine } from './providers/process.js';
import { TerminalHost } from './terminal/host.js';
import { agyProgram, claudeProgram, codexProgram, kimiProgram, type TermProgram } from './terminal/programs.js';
import { Tmux } from './terminal/tmux.js';
import { procOwner, type OwnerFactory } from './terminal/peer.js';
import { macOwner, type Command } from './terminal/mac-peer.js';
import { ProgramUpdates, readInstalledVersion } from './program-updates.js';
import { nodeLifecycle, stopNode } from './lifecycle.js';
import { lifecycleCommand } from './lifecycle-command.js';
import { updateWaitCommand } from './update-wait.js';

export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/* The node build CI wrote into this node's image, when it is one: the last commit that changed the image's files. */
export const buildOf = (env: NodeJS.ProcessEnv): string | undefined => NodeBuild.safeParse(env.HORNHOOF_NODE_BUILD).data;

const LOGIN_CHECK_MS = 10_000;
const BROWSER_CHECK_MS = 60_000;
/* How often a Codex plan's holder looks whether Codex renewed its sign-in between turns. */
const LEASE_CHECK_MS = 60_000;
/* How often a node with terminals reads its program's tokens again: a program signs in again or renews them between turns. */
const LEARN_MS = 60_000;
/* How often a personal node asks its program for the plan's limits between turns: work on other machines moves them too. */
const LIMITS_MS = 5 * 60_000;
/* How long a removal waits for called-off jobs to stop before it deletes their folders. */
const STOP_WAIT_MS = 5_000;
/* How many unconfirmed job ends a node keeps for a server that does not confirm them. */
const MAX_UNCONFIRMED = 50;

type JobRun = Extract<ServerMessage, { type: 'job.run' }>;
type Recipient = { nodeId: string; publicKey: string };

const digestOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/* The sign-in Hornhoof hands each kind of plan. */
const CRED_KINDS: Record<string, CredKind> = { claude: 'claude_token', codex: 'codex_auth', kimi: 'kimi_key', glm: 'glm_key' };
type TestRun = Extract<ServerMessage, { type: 'tests.run' }>;
type TestsDone = Extract<NodeMessage, { type: 'tests.done' }>;

/* What a node says to a sign-in it cannot run: a company key's, a Kimi or GLM key's, or one with no tmux. */

/* A part of a run never runs as the node itself: without a user of its own for runs, the node takes none. */
const NO_RUNS = 'This node has no user of its own for runs, which it gets only when it runs as root with the rights to switch users, so it takes no part of any run.';

/* Agents of a personal Claude Code, Codex or Kimi Code plan run in tmux sessions people can watch and type into. */
export type TerminalSetup = { tmux: Tmux; program: TermProgram; bin: string; home: string; signedOut: RegExp; owner?: OwnerFactory; user?: JobUser | null; fs?: AgentFs };

type RunOptions = {
  dir: string;
  terminal?: TerminalSetup;
  /* A personal Claude Code or Codex plan signs in from Hornhoof, in a terminal the plan's owner sees. */
  login?: LoginSetup;
  /* A personal node runs one agent program; the built-in node picks one per job. */
  adapter: ProviderAdapter | ((job: JobRun) => ProviderAdapter);
  /* The built-in node takes Hornhoof's address and its key from the env instead of node.json. */
  builtin?: { server: string; key: string };
  log?: (line: string) => void;
  loginCheckMs?: number;
  /* How often the node looks again at a first setup the plan waits for. */
  setupCheckMs?: number;
  learnMs?: number;
  limitsMs?: number;
  /* How often the node says how busy its machine is. */
  loadMs?: number;
  leaseCheckMs?: number;
  /* Installs the plan's program when it is missing: as the node starts, and before a turn in a session or a sign-in. */
  install?: () => Promise<void>;
  programs?: ProgramUpdates;
  /* The user test runs run as, on a node that runs as root; none runs them as the node, as its agents run there. */
  testUser?: JobUser | null;
  /* Runs a part of a test run; tests pass a fake. */
  runPart?: typeof runTests;
  /* The node build it says in its hello; none from a node built by hand. */
  build?: string;
  /* Verifies that Playwright Chromium launches before Hornhoof hands tasks or runs to this node. */
  checkBrowser?: () => Promise<string | null>;
  browserCheckMs?: number;
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
export async function runNode({ dir, adapter, builtin, terminal, login: loginSetup, log: writeLog = console.log, loginCheckMs = LOGIN_CHECK_MS, setupCheckMs = SETUP_CHECK_MS, learnMs = LEARN_MS, limitsMs = LIMITS_MS, loadMs = LOAD_MS, leaseCheckMs = LEASE_CHECK_MS, install, programs = new ProgramUpdates([]), testUser = null, runPart = runTests, build, checkBrowser = async () => null, browserCheckMs = BROWSER_CHECK_MS }: RunOptions): Promise<{ stop(reason?: NodeStopReason): void }> {
  if (!builtin && isRemoved(dir)) {
    writeLog('This node was removed in Hornhoof.');
    return { stop() {} };
  }
  /* How this node came up, the same in every hello of this run: Hornhoof tells from it why the turns it ran are gone. */
  const boot = bootFacts(Date.now(), uptime(), hostname());
  const state = builtin ?? readState(dir);
  if (!state) throw new Error(`No node settings in ${dir}/node.json. Run the install command from Hornhoof again.`);
  /* The key Hornhoof seals this node's sign-ins to. */
  const keyPair = await nodeIdentity(dir);
  /* Where the plan's program keeps its sign-in; on a node that runs as root it belongs to the agents' user. */
  const credHome = (typeof adapter === 'function' ? null : adapter.owner?.home) ?? join(dir, 'home');
  const credUser = (typeof adapter === 'function' ? null : adapter.owner?.user) ?? null;
  /* The node's own keys never leave in a job's output. */
  const hidden = [state.key, keyPair.identity];
  const known = new Set(hidden);
  const life = nodeLifecycle({ dir, startedAt: boot.startedAt, secrets: () => [...known], write: writeLog });
  const log = life.log;
  removeOldParts(dir, log);
  const toolsUrl = `${state.server}/mcp`;
  /* The task's files a part of work takes in and puts back. */
  const files = partFiles(state.server, state.key);
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
  /* The kind of sign-in Hornhoof hands this plan, and what that sign-in was when the plan's program refused it: until
     it changes, the node stays signed out, so turns do not go round on a sign-in that no longer works. */
  const planProvider = builtin ? null : (state as NodeState).provider;
  const credKind: CredKind | null = single && !builtin && planProvider ? (CRED_KINDS[planProvider] ?? null) : null;
  let refused: string | null = null;
  const signedInHere = async (): Promise<boolean> => {
    if (!single) return true;
    /* Only a Codex plan's machines are told they are spare. */
    if (isSpare(dir)) return false;
    if (refused !== null) {
      const held = credKind ? heldCredential(credHome, credKind) : null;
      if (held && digestOf(held) === refused) return false;
      refused = null;
    }
    return single.loggedIn();
  };
  let loggedIn = await signedInHere();
  const setup = new SetupWait(single, setupCheckMs);
  await setup.check(loggedIn);
  let limits: Limits | null = null;
  let stopped = false;

  const emit = (m: NodeMessage) => {
    if (m.type === 'job.done') keep(m.jobId, m);
    if (m.type === 'tests.done') keepTest(m.partId, m);
    const current = withPrograms(m, programs);
    if (!send?.(current) && m.type !== 'job.done' && m.type !== 'tests.done') outbox.push(current);
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
  const learn = async (more: (string | null | undefined)[] = []) => {
    for (const s of more) if (s) known.add(s);
    for (const s of await (single?.secrets() ?? Promise.resolve([])).catch(() => [])) known.add(s);
  };
  await learn();
  /* A screen nobody receives is not worth keeping; everything else waits for the connection like any message. */
  const host = terminal
    ? new TerminalHost({
        tmux: terminal.tmux,
        hornhoof: state.server,
        send: m => (m.type === 'term.data' || m.type === 'term.exit' ? void send?.(m) : emit(m)),
        secrets: () => [...known],
        log,
        remember: (sessionId, workDir) => rememberSession(dir, sessionId, workDir),
        owner: terminal.owner,
        user: terminal.user,
        fs: terminal.fs,
      })
    : null;
  const login =
    loginSetup && !builtin
      ? new LoginTerminal({
          setup: loginSetup,
          dir,
          home: credHome,
          send: m => (m.type === 'term.data' || m.type === 'term.exit' ? void send?.(m) : emit(m)),
          secrets: () => [...known],
          signedIn: () => signedInNow(),
          install,
        })
      : null;
  /* A sign-in that ran when the node last stopped is over: it gave nothing, and its session and folder go. */
  await login?.clear();
  /* A plan's sign-in can reach a new node from Hornhoof with no sign-in on the machine, which used to install it. */
  if (!builtin) install?.().catch(err => log(`Could not install the program: ${message(err)}`));
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
  /* Which account and plan the program is signed in to, read at the start, after a sign-in and with the limits. */
  const readAccount = async () => (single?.account ? await single.account().catch(() => null) : null);
  let account = await readAccount();
  let browserError = await checkBrowser().catch(err => message(err));
  writeBrowserError(dir, browserError);
  if (browserError) log(`Playwright Chromium could not start: ${browserError}`);
  const noRunsNow = (): string | null =>
    !testUser ? NO_RUNS : browserError ? `Playwright Chromium could not start: ${browserError}` : null;
  const tellStatus = () => {
    browserError = readBrowserError(dir);
    emit({ type: 'status', loggedIn, ...setup.field(), limits, ...(models ? { models } : {}), account, browserError, noRuns: noRunsNow() });
  };
  const status = async () => {
    /* A program that cannot list its models now keeps those it listed before. */
    models = await readModels().catch(() => models);
    tellStatus();
  };

  /* How busy the machine is, which Hornhoof weighs when it picks a machine for a test run. */
  const load = (): NodeLoad => ({ ...machineLoad({ dir }), tests: testing.size, jobs: running.size });

  const conn = connect({
    url: state.server.replace(/^http/, 'ws') + '/api/nodes/socket',
    key: state.key,
    log,
    onOpen(next) {
      send = next;
      host?.closeViews();
      login?.closeViews();
      /* Finished jobs Hornhoof has not confirmed still count as running, so the server does not give up on them. */
      const typed = host?.typedJobs() ?? [];
      const tests = [...testing.keys(), ...unconfirmedTests.keys()];
      const noRuns = noRunsNow();
      next({ type: 'hello', version: VERSION, loggedIn, ...setup.field(), running: [...running.keys(), ...typed, ...unconfirmed.keys()], ...(models ? { models } : {}), terminals: Boolean(host), work: Boolean(testUser), ...(noRuns ? { noRuns } : {}), browserError, load: load(), tests, skillFiles: true, publicKey: keyPair.recipient, account, boot, programs: programs.snapshot(), build, restart: life.previous, nodeLog: life.tail() });
      for (const m of outbox.splice(0)) emit(m);
      for (const m of unconfirmed.values()) next(m);
      for (const m of unconfirmedTests.values()) next(m);
    },
    /* One message that fails is logged; it never ends the node with all its runs. */
    onMessage: m => void handle(m).catch(err => log(`A message from Hornhoof failed: ${message(err)}`)),
    onRefused: () => log('Hornhoof does not know this machine any more. Run the install command from Hornhoof again to reconnect.'),
  });
  void programs.update(tellStatus).catch(err => log(`Could not update the programs: ${message(err)}`));

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
      await login?.shutdown();
      for (const sub of ['home', 'work']) rmSync(join(dir, sub), { recursive: true, force: true });
      markRemoved(dir);
      emit({ type: 'removed' });
      log('This node was removed in Hornhoof.');
      stop();
      return;
    }
    if (acknowledged(m, unconfirmed, unconfirmedTests)) return;
    if (m.type === 'programs.update') return programs.update(tellStatus);
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
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- job.run is handled right after the switch
    switch (m.type) {
      case 'term.open': {
        const shows = m.agentKey === LOGIN_KEY ? login : host;
        if (!shows) return void send?.({ type: 'term.exit', termId: m.termId });
        return shows.open(m).catch(() => void send?.({ type: 'term.exit', termId: m.termId }));
      }
      case 'term.input':
        return login?.owns(m.termId) ? login.input(m) : host?.input(m);
      case 'term.resize':
        return login?.owns(m.termId) ? login.resize(m) : host?.resize(m);
      case 'term.close':
        return login?.owns(m.termId) ? login.close(m) : host?.close(m);
      case 'turn.opened':
        return host?.opened(m);
      case 'agent.say': {
        const ok = host ? await host.say(m.agentKey, m.text, m.within).catch(() => false) : false;
        return void send?.({ type: 'agent.said', ref: m.ref, ok });
      }
      case 'agent.restart': {
        const result = host ? await host.restart(m.agentKey, m.jobId, m.note) : { ok: false, reason: 'The terminal host is not running.' };
        return void send?.({ type: 'agent.restarted', agentKey: m.agentKey, jobId: m.jobId, ...result });
      }
      case 'cred.put':
        return inOrder(() => putCredential(m.kind, m.sealed));
      case 'cred.drop':
        return inOrder(() => {
          if (!single || builtin) return;
          dropCredential(dir, credHome, m.kind, credUser);
          return signedInNow();
        });
      case 'cred.seal':
        return inOrder(() => sealCredential(m.kind, m.version, m.recipients));
      /* A Codex plan runs on one of its machines at a time: the one that holds its lease keeps its sign-in. */
      case 'cred.lease':
        return inOrder(() => {
          if (!single || builtin) return;
          if (m.hold) return takeLease(dir);
          codexSealed = null;
          giveUpLease(dir, credHome, credUser);
          return signedInNow();
        });
      case 'login.start':
        if (!login) return emit({ type: 'login.done', ok: false, error: SIGNIN_ERRORS.noLogin });
        return login.start(m.fresh);
      case 'login.stop':
        return login?.stop();
    }
    if (stopped || running.has(m.jobId)) return;
    const controller = new AbortController();
    const done = runOne(m, controller.signal);
    running.set(m.jobId, { stop: controller, done });
    await done;
  }

  /* A plan's sign-in Hornhoof sealed to this node: opened with its key and kept where the program reads it. What goes into
     the log never carries it, not even in the words of an error. */
  async function putCredential(kind: CredKind, sealed: string) {
    if (!single || builtin) return;
    let plain: Uint8Array;
    try {
      plain = await unseal(sealed, keyPair.identity);
    } catch {
      return log("A plan sign-in from Hornhoof is not for this node's key, so it was left out.");
    }
    try {
      applyCredential(dir, credHome, kind, plain, credUser);
    } catch {
      return log('A plan sign-in from Hornhoof is not one this program can use, so it was left out.');
    }
    await signedInNow();
  }

  /* The sign-in this node holds, sealed for each of the plan's nodes Hornhoof names, one envelope for each. A Codex
     holder keeps whom it sealed for, under which number and what the file was, to seal it again once Codex renews it:
     a list of the plan's nodes replaces what it kept, one more node under the same number joins it. */
  async function sealCredential(kind: CredKind, version: number, recipients: Recipient[]) {
    const held = single && !builtin ? heldCredential(credHome, kind) : null;
    if (!held) return;
    if (kind === 'codex_auth' && holdsLease(dir)) {
      const joins = codexSealed !== null && version === codexSealed.version;
      codexSealed = joins
        ? { ...codexSealed!, recipients: [...codexSealed!.recipients.filter(r => !recipients.some(n => n.nodeId === r.nodeId)), ...recipients].slice(-20) }
        : version > (codexSealed?.version ?? 0) ? { version, recipients, digest: digestOf(held) } : codexSealed;
    }
    emit({ type: 'cred.sealed', kind, version, envelopes: await sealFor(held, recipients) });
  }

  const sealFor = (held: Uint8Array, recipients: Recipient[]) => Promise.all(recipients.map(async r => ({ nodeId: r.nodeId, sealed: await seal(held, [r.publicKey]) })));

  /* Codex renews its sign-in as it runs, and the old one stops working: the holder seals the new one for the plan's
     other machines, under the next number, so one of them can take over. */
  async function renewedCodex() {
    if (!codexSealed || !single || builtin || !holdsLease(dir)) return;
    const held = heldCredential(credHome, 'codex_auth');
    if (!held || digestOf(held) === codexSealed.digest) return;
    const version = codexSealed.version + 1;
    codexSealed = { ...codexSealed, version, digest: digestOf(held) };
    emit({ type: 'cred.sealed', kind: 'codex_auth', version, envelopes: await sealFor(held, codexSealed.recipients) });
  }

  /* Sign-in messages take effect in the order Hornhoof sent them: a move sends the lease, the sign-in and whom to seal it
     for at once, and opening the sign-in takes a moment. */
  let credChain: Promise<unknown> = Promise.resolve();
  function inOrder(work: () => unknown): Promise<unknown> {
    const next = credChain.then(work);
    credChain = next.catch(() => {});
    return next;
  }

  /* What a Codex holder last sealed its sign-in for. */
  let codexSealed: { version: number; recipients: Recipient[]; digest: string } | null = null;

  /* After a sign-in came or went: what the screens hide, and whether the program is signed in, said at once. */
  async function signedInNow() {
    await learn();
    loggedIn = await signedInHere();
    await setup.check(loggedIn);
    account = await readAccount();
    await status();
  }

  /* A part of a test run: no agent program takes part, and its user reaches none of the node's keys. */
  async function testOne(m: TestRun, signal: AbortSignal) {
    const refusal = noRunsNow();
    if (refusal || !testUser) {
      const refusedPart: TestsDone = { type: 'tests.done', partId: m.partId, ok: false, exitCode: null, error: 'failed', commit: null, log: refusal || NO_RUNS };
      keepTest(m.partId, refusedPart);
      testing.delete(m.partId);
      return emit(refusedPart);
    }
    emit({ type: 'tests.started', partId: m.partId });
    const done = await runPart(m, { dir, user: testUser, hidden: [...known], signal, files });
    keepTest(m.partId, done);
    testing.delete(m.partId);
    emit(done);
  }

  async function runOne(m: JobRun, signal: AbortSignal) {
    emit({ type: 'job.started', jobId: m.jobId });
    let done: Awaited<ReturnType<typeof runJob>>;
    try {
      await programs.ready(signal);
      const chosen = pick(m);
      await learn([m.toolToken, m.secret, m.workspace?.repo?.token]);
      /* An agent's turn runs in its session; a test job, with no agent, runs as before. */
      const runIn = async (input: Parameters<ProviderAdapter['run']>[0]): Promise<RunResult> => {
        if (!(host && terminal && input.agentKey)) return chosen.run(input);
        try {
          await install?.();
        } catch (err) {
          return { ok: false, sessionId: null, result: '', output: `Could not install the program: ${message(err)}`, error: 'agent_failed', limits: null };
        }
        const version = async () => { await programs.ready(input.signal); return programs.version(terminal.program.kind); };
        return host.run({ key: input.agentKey, program: terminal.program, bin: terminal.bin, home: terminal.home, signedOut: terminal.signedOut, input, version });
      };
      const tracked: ProviderAdapter = {
        ...chosen,
        run: async input => {
          const res = await runUnlessStopped(input, () => runIn(input));
          if (res.limits) limits = merged(limits, res.limits);
          return res;
        },
      };
      let seq = 0;
      const onEvent = (event: AgentEvent) => emit({ type: 'job.event', jobId: m.jobId, seq: seq++, event });
      done = await runJob(tracked, m, dir, { hidden, signal, toolsUrl, onEvent, beforeRun: () => programs.ready(signal), untimed: Boolean(host && terminal && m.workspace?.key) });
    } catch (err) {
      done = { type: 'job.done', jobId: m.jobId, ok: false, sessionId: null, result: '', tail: message(err), error: 'agent_failed' };
    }
    /* The end counts as running from here, so a hello while the limits are read does not give the job up. */
    keep(m.jobId, done);
    running.delete(m.jobId);
    /* A first setup the turn met, which only the plan's owner may pass, and the limits the turn brought go first, so
       Hornhoof knows of a plan that waits for its owner or is at its limit when it hears the job ended. */
    setup.met(done.failure);
    await status();
    emit(done);
    await renewedCodex().catch(() => {});
    if (done.error === 'not_logged_in') {
      loggedIn = false;
      const held = credKind ? heldCredential(credHome, credKind) : null;
      if (held) refused = digestOf(held);
      void status();
    }
  }

  /* While signed out or waiting for the first setup, look again now and then, so the person sees Ready soon after. Only a
     sign-in found by looking changes it: a turn may have found it gone meanwhile. */
  const checkLogin = async () => {
    if (stopped || !single) return;
    const now = await setup.recheck(loggedIn, signedInHere);
    loggedIn ||= now.signedIn;
    if (now.changed) void status();
  };
  const timer = setInterval(() => void checkLogin(), loginCheckMs);
  timer.unref();
  const learning = host ? setInterval(() => void learn(), learnMs) : null;
  learning?.unref();
  const askLimits = async () => {
    if (stopped) return;
    /* A program that renewed its sign-in, or one signed in again by hand, may be on another plan of its maker now. */
    const was = JSON.stringify(account);
    account = await readAccount();
    const now = single?.limits ? await single.limits().catch(() => null) : null;
    const moved = now !== null && JSON.stringify(merged(limits, now)) !== JSON.stringify(limits);
    if (moved) limits = merged(limits, now);
    if (moved || JSON.stringify(account) !== was) void status();
  };
  void askLimits();
  const asking = setInterval(() => void askLimits(), limitsMs);
  asking.unref();
  const renewing = setInterval(() => void renewedCodex().catch(() => {}), leaseCheckMs);
  renewing.unref();
  const recheckBrowser = async () => {
    if (stopped || browserError === null) return;
    const next = await checkBrowser().catch(err => message(err));
    if (next === browserError) return;
    browserError = next;
    writeBrowserError(dir, browserError);
    if (browserError) log(`Playwright Chromium could not start: ${browserError}`);
    else log('Playwright Chromium is ready.');
    await status();
  };
  const checkingBrowser = setInterval(() => void recheckBrowser(), browserCheckMs);
  checkingBrowser.unref();
  /* An old figure says nothing, so one that cannot go out now is not kept for later. */
  const reporting = setInterval(() => void send?.({ type: 'load', ...load() }), loadMs);
  reporting.unref();

  function stop(reason: NodeStopReason = 'stopped') {
    stopNode(life, send, boot.startedAt, reason);
    stopped = true;
    clearInterval(timer);
    if (learning) clearInterval(learning);
    clearInterval(asking);
    clearInterval(reporting);
    clearInterval(renewing);
    clearInterval(checkingBrowser);
    void host?.stop();
    void login?.shutdown();
    /* Let the last message leave before the socket closes. */
    setTimeout(() => conn.close(), 50);
  }
  return { stop };
}

export type Io = { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };

const USAGE = 'Usage: hornhoof-node run [--builtin] | login | status | set-key | prepare-browser [repo]';
const SET_KEY_LINE = 'set-key expects one line: <server> <id> <provider or machine> <key>';
/* A machine joined without a plan has a node of its own: it runs no agent program and has nothing to sign in to. */
const MACHINE = 'machine';
const NO_PLAN = 'This machine has no plan to sign in to.';

const machineOnly: ProviderAdapter = {
  install: async () => {},
  loggedIn: async () => true,
  login: async () => {},
  run: async () => ({ ok: false, sessionId: null, result: '', output: 'This machine has no plan to run agents with.', error: 'agent_failed', limits: null }),
  secrets: async () => [],
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/* Replayed status messages describe the current installation, never an earlier queued phase. */
function withPrograms(message: NodeMessage, programs: ProgramUpdates): NodeMessage {
  return message.type === 'status' ? { ...message, programs: programs.snapshot() } : message;
}

function acknowledged(message: ServerMessage, jobs: Map<string, NodeMessage>, tests: Map<string, NodeMessage>): message is Extract<ServerMessage, { type: 'job.ack' | 'tests.ack' }> {
  if (message.type === 'job.ack') {
    jobs.delete(message.jobId);
    return true;
  }
  if (message.type === 'tests.ack') {
    tests.delete(message.partId);
    return true;
  }
  return false;
}

function runUnlessStopped(input: RunInput, run: () => Promise<RunResult>): Promise<RunResult> {
  if (input.signal?.aborted) return Promise.resolve({ ok: false, sessionId: input.sessionId, result: 'Stopped.', output: 'Stopped.', error: 'cancelled', limits: null });
  return run();
}

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
  return updateInstalled(tools, provider, adapter);
}

function updateInstalled(tools: string, provider: ProviderId, adapter: ProviderAdapter): Promise<void> {
  const path = join(tools, 'bin', programFor(provider).bin);
  let pending = installing.get(path);
  if (!pending) {
    pending = adapter.install().finally(() => installing.delete(path));
    installing.set(path, pending);
  }
  return pending;
}

function managedUpdates(tools: string, programs: { provider: ProviderId; adapter: ProviderAdapter }[]): ProgramUpdates {
  return new ProgramUpdates(programs.flatMap(({ provider, adapter }) => {
    const id = programFor(provider).bin;
    return id === 'agy' ? [] : [{ id, install: () => updateInstalled(tools, provider, adapter), readVersion: () => readInstalledVersion(tools, id) }];
  }));
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
    writeState(dir, { server, subscriptionId, provider: provider === MACHINE ? null : provider, key } as NodeState);
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
  /* spare: another machine of the plan runs Codex now, and this one takes over when that one is away. */
  let word = isRemoved(dir) ? 'removed' : !state ? 'no_key' : isSpare(dir) ? 'spare' : state.provider ? await planWord(dir, state.provider) : 'ready';
  const browserProblem = word === 'ready' ? readBrowserError(dir) : null;
  if (browserProblem) word = `browser_failed: ${browserProblem}`;
  io.stdout.write(word + '\n');
  return 0;
}

async function prepareBrowserCommand(dir: string, repoArg: string | undefined, io: Io): Promise<number> {
  const owner = agentUser();
  const res = await prepareAndVerifyBrowser({ dir, ...(repoArg ? { repoDir: resolve(repoArg) } : {}), owner, verifyUser: owner });
  if (!res.ok) {
    io.stderr.write(`Playwright Chromium could not start: ${res.error}\n`);
    return 1;
  }
  if (res.status === 'not_needed') io.stdout.write('not_needed\n');
  else io.stdout.write(`ready: playwright@${res.version} chromium ${res.browserVersion} (downloaded: ${res.downloaded})\n`);
  return 0;
}

/* A plan's program is ready once signed in and past a first setup only its owner passes on the machine. A setup the node
   cannot look at does not hold the plan, as in the node's own hello. */
async function planWord(dir: string, provider: ProviderId): Promise<string> {
  const adapter = personal(dir, provider, agentUser());
  if (!(await adapter.loggedIn())) return 'needs_login';
  return (await adapter.setupNeeded?.().catch(() => false)) ? 'needs_setup' : 'ready';
}

/* The first setup its owner passes on the machine after the sign-in, such as accepting agy's terms; an exit code when it
   did not finish. */
async function firstSetup(adapter: ProviderAdapter, name: string, io: Io, urlFile: string): Promise<number | null> {
  if (!adapter.setup) return null;
  try {
    if (!(await adapter.setupNeeded?.())) return null;
    await adapter.setup({ input: io.stdin, output: io.stdout, urlFile });
    return null;
  } catch (err) {
    io.stderr.write(`The first setup of ${name} did not finish: ${message(err)}\n`);
    return 1;
  }
}

async function login(dir: string, io: Io): Promise<number> {
  const state = readState(dir);
  if (!state) {
    io.stderr.write('This machine has no key yet. Run the install command from Hornhoof.\n');
    return 1;
  }
  if (!state.provider) {
    io.stdout.write(`${NO_PLAN}\n`);
    return 0;
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
  const unfinished = await firstSetup(adapter, name, io, join(dir, 'login-url'));
  if (unfinished !== null) return unfinished;
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
   run as before. A Claude Code or Codex plan also signs in from Hornhoof there, on a tmux server apart from the agents'. */
function terminalFor(dir: string, provider: ProviderId, user: JobUser | null, fs: AgentFs): { terminal?: TerminalSetup; login?: LoginSetup } {
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
  const owner = terminalOwner();
  const bin = join(tools, 'bin', programFor(provider).bin);
  const signs = provider === 'claude' || provider === 'codex' ? provider : null;
  const login: LoginSetup | undefined = signs
    ? { provider: signs, bin, tmux: new Tmux({ socket: 'hh-signin', env: childEnv(tools, { HOME: process.env.HOME ?? home }), recordingsDir: join(dir, '.hh-recordings') }), env: childEnv(tools, {}), user, fs }
    : undefined;
  return { terminal: { tmux, ...known, bin, home, owner, user, fs }, ...(login ? { login } : {}) };
}

/* Select the operating system's connection proof once; the host receives it as a dependency. */
export function terminalOwner(on: NodeJS.Platform = process.platform, run?: Command): OwnerFactory | undefined {
  const owners: Partial<Record<NodeJS.Platform, OwnerFactory>> = { linux: procOwner('/proc'), darwin: macOwner(run) };
  return owners[on];
}

async function run(dir: string, builtinMode: boolean, io: Io): Promise<number | { stop(): void }> {
  const log = (line: string) => void io.stdout.write(line + '\n');
  const tools = join(dir, 'tools');
  const build = buildOf(process.env);
  if (!builtinMode) {
    const state = readState(dir);
    if (!state && !isRemoved(dir)) {
      io.stderr.write('This machine has no key yet. Run the install command from Hornhoof.\n');
      return 1;
    }
    const user = agentUser();
    if (user) secureNode(dir, user);
    /* Test runs get a user of their own, apart from the agents' sign-in and folders. */
    const testUser = user ? userFor(dir, 'tests', true) : null;
    const checkBrowser = () => startupBrowserCheck(dir, user, user);
    if (state && !state.provider) return runNode({ dir, adapter: machineOnly, log, testUser, build, checkBrowser });
    const provider = state?.provider ?? 'claude';
    const fs = user ? agentFs(user) : ownFs;
    const adapter = personal(dir, provider, user, fs);
    const programs = managedUpdates(tools, [{ provider, adapter }]);
    const install = () => ensureInstalled(tools, provider, adapter);
    return runNode({ dir, adapter: withInstall(adapter, tools, provider), install, programs, log, testUser, build, checkBrowser, ...terminalFor(dir, provider, user, fs) });
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
  const managed = (['anthropic_api', 'openai_api'] as const).map(provider => ({ provider, adapter: adapterFor(provider, { home: dir, tools }) }));
  const testUser = userFor(dir, 'tests');
  const browserOwner = agentUser();
  const checkBrowser = () => startupBrowserCheck(dir, browserOwner, testUser || browserOwner);
  return runNode({ dir, adapter: pick, programs: managedUpdates(tools, managed), builtin: { server, key }, log, testUser, build, checkBrowser });
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
    case 'prepare-browser':
      return prepareBrowserCommand(dir, args[1], io);
    case 'wait-update':
      return updateWaitCommand(dir, args.slice(1), io);
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
  void Promise.resolve(lifecycleCommand(process.argv.slice(2)) ?? command(process.argv.slice(2), process)).then(res => {
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
