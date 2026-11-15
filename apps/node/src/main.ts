#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { hostname, uptime } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNumbered, LOAD_MS, NodeBuild, type AgentEvent, type ApiEndpoint, type CredKind, type Limits, type NodeLoad, type NodeMessage, type NodeStopReason, type ProviderId, type ServerMessage } from '@hornhoof/protocol';
import { SIGNIN_ERRORS } from '@hornhoof/protocol/signin';
import { agentFs, ownFs, type AgentFs } from './agent-fs.js';
import { bootFacts } from './boot.js';
import { prepareAndVerifyBrowser, readBrowserError, startupBrowserCheck, writeBrowserError } from './browser.js';
import { connect } from './connection.js';
import type { ProgramNodeMessage, ProgramServerMessage } from '@hornhoof/protocol/program-operator';
import { agentUser, builtinAdapters, secureNode, userFor, type JobUser } from './isolation.js';
import { withCheckSlot } from './check-queue.js';
import { startCheckClient, stopChecks, isProgramControl, applyProgramControl, runQueuedPart } from './check-runtime.js';
import { TestPartUser, NodeTestMessages, isNodeTestMessage, nodeTestCapabilities, type readTestEnvironment, type TestCapabilities } from './test-environment.js';
import { machineLoad } from './load.js';
import { removalWatch } from './removal.js';
import { clearOutbox, endId, helloIds, isEnd, Outbox, sendPending, type Entry } from './outbox.js';
import { adapterFor, programFor } from './providers/index.js';
import { runJob, type ProviderAdapter, type RunInput, type RunResult } from './runner.js';
import { applyCredential, giveUpLease, heldCredential, holdsLease, isSpare, takeLease } from './credentials.js';
import { builtinKey, nodeIdentity, seal, unseal } from './keys.js';
import { LOGIN_KEY, LoginTerminal, type LoginSetup } from './login.js';
import { dataDir, isRemoved, markRemoved, readState, rememberSession, writeState, type NodeState } from './state.js';
import { waitUpdate } from './wait-update.js';
import { SETUP_CHECK_MS, SetupWait } from './setup-wait.js';
import { harnessRemote } from './test-harness.js';
import { partFiles, removeOldParts, runTests, syncHarness, worktreeHarness, type Worktree } from './tests.js';
import { SIGNED_OUT as AGY_SIGNED_OUT } from './providers/antigravity.js';
import { SIGNED_OUT as CLAUDE_SIGNED_OUT } from './providers/claude.js';
import { SIGNED_OUT as CODEX_SIGNED_OUT } from './providers/codex.js';
import { SCREEN_SIGNED_OUT as KIMI_SIGNED_OUT } from './providers/kimi.js';
import { childEnv, firstLine } from './providers/process.js';
import { TerminalHost } from './terminal/host.js';
import { OutsideCalls } from './terminal/outside-calls.js';
import { agyProgram, claudeProgram, codexProgram, kimiProgram, type TermProgram } from './terminal/programs.js';
import { Tmux } from './terminal/tmux.js';
import { procOwner, type OwnerFactory } from './terminal/peer.js';
import { macOwner, type Command } from './terminal/mac-peer.js';
import { ProgramUpdates, readInstalledVersion } from './program-updates.js';
import { nodeLifecycle, stopNode } from './lifecycle.js';
import { lifecycleCommand } from './lifecycle-command.js';
import { heldJobs } from './held-jobs.js';
import { nodeLog } from './node-log.js';

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

type JobRun = Extract<ProgramServerMessage, { type: 'job.run' }>;
type Recipient = { nodeId: string; publicKey: string };

const digestOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/* The sign-in Hornhoof hands each kind of plan. */
const CRED_KINDS: Record<string, CredKind> = { claude: 'claude_token', codex: 'codex_auth', kimi: 'kimi_key', glm: 'glm_key' };
type TestRun = Extract<ServerMessage, { type: 'tests.run' }>;
type HarnessRun = Extract<ServerMessage, { type: 'tests.harness' }>;
type TestsDone = Extract<NodeMessage, { type: 'tests.done' }>;

async function sayToAgent(host: TerminalHost | null, m: Extract<ProgramServerMessage, { type: 'agent.say' }>, log: (line: string) => void): Promise<boolean> {
  const refused = (reason: string) => { log(`Agent ${m.agentKey}: live words were not delivered: ${reason}.`); return false; };
  if (!host) return refused('the terminal host is not running');
  return host.say(m.agentKey, m.text, m.within, m.operatorDelivery).catch(() => refused('terminal input failed'));
}

async function answerLiveWords(host: TerminalHost | null, m: Extract<ProgramServerMessage, { type: 'agent.say' }>, log: (line: string) => void, emit: (m: NodeMessage) => void): Promise<void> {
  const ok = await sayToAgent(host, m, log);
  emit({ type: 'agent.said', ref: m.ref, ok });
}

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
  describeEnvironment?: typeof readTestEnvironment;
  /* The node build it says in its hello; none from a node built by hand. */
  build?: string;
  /* Verifies that the Playwright browsers launch before Hornhoof hands tasks or runs to this node. */
  checkBrowser?: () => Promise<string | null>;
  browserCheckMs?: number;
};

const MODEL_WEEK = /^seven_day_[a-z]+$/;
const stillOpen = (w: Limits['windows'][number]) => w.resetsAt === null || Date.parse(w.resetsAt) > Date.now();
const windowFull = (w: Limits['windows'][number]) => (w.utilization ?? 0) >= 1 && stillOpen(w);

/* A complete reading from the usage page replaces what the node knew. A turn's complete reading names every unified window
   of the plan, while keeping any unexpired model week from the usage page. A partial reading updates only what it names. */
function keptWindows(known: Limits, news: Limits, fromPage: boolean): Limits['windows'] {
  if (fromPage && news.complete) return [];
  const fresh = new Set(news.windows.map(w => w.name));
  return known.windows.filter(w => !fresh.has(w.name) && (!news.complete || (MODEL_WEEK.test(w.name) && stillOpen(w))));
}

function merged(known: Limits | null, news: Limits, fromPage = false): Limits {
  if (!known || (fromPage && news.complete)) return news;
  const fresh = new Map(news.windows.map(w => [w.name, w]));
  const kept = keptWindows(known, news, fromPage);
  const windows = news.complete
    ? [...news.windows, ...kept]
    : [...known.windows.map(w => fresh.get(w.name) ?? w), ...news.windows.filter(w => !known.windows.some(k => k.name === w.name))];
  const complete = Boolean(news.complete || known.complete);
  return { status: kept.some(windowFull) ? 'rejected' : news.status, windows: windows.slice(0, 8), ...(complete ? { complete: true } : {}) };
}

/* What the node knows of the plan's limits, and whether Hornhoof has heard its last reading. Hornhoof counts them fresh from
   the moment it hears them, so each reading goes out once, also one that moved nothing, and a status with no reading behind
   it says none: null, as the protocol asks for the field, which leaves what Hornhoof knows as it is. While Hornhoof is away
   the newest reading waits here, and one that fails then forgets it: by the time Hornhoof heard it, it would be old. */
class PlanLimits {
  private known: Limits | null = null;
  private unsaid = false;

  read(news: Limits | null, fromPage = false): void {
    if (!news) return;
    this.known = merged(this.known, news, fromPage);
    this.unsaid = true;
  }

  looked(news: Limits | null, online: boolean): void {
    this.read(news, true);
    if (!news && !online) this.unsaid = false;
  }

  get waiting(): boolean {
    return this.unsaid;
  }

  forStatus(online: boolean): Limits | null {
    if (!online) return null;
    const reading = this.unsaid ? this.known : null;
    this.unsaid = false;
    return reading;
  }
}

/* Why a node takes no part of any run; none when it takes them. */
const noRunsBecause = (testUser: JobUser | null, browserError: string | null): string | null =>
  !testUser ? NO_RUNS : browserError ? `Playwright browsers could not start: ${browserError}` : null;

/* A server that never confirms the ends of jobs leaves the node with only the last few. */
/* A screen's messages go to the sign-in that shows it, else to the agents' host. */
const shownBy = (login: LoginTerminal | null, host: TerminalHost | null, termId: string) => (login?.owns(termId) ? login : host);

/* What a Codex holder last sealed its sign-in for. */
type CodexSealed = { version: number; recipients: Recipient[]; digest: string };

/* A list of the plan's nodes under a newer number replaces what the holder kept, one more node under the same number joins it. */
function sealedFor(known: CodexSealed | null, version: number, recipients: Recipient[], held: Uint8Array): CodexSealed | null {
  if (known !== null && version === known.version) {
    return { ...known, recipients: [...known.recipients.filter(r => !recipients.some(n => n.nodeId === r.nodeId)), ...recipients].slice(-20) };
  }
  return version > (known?.version ?? 0) ? { version, recipients, digest: digestOf(held) } : known;
}

/* The node's life: stay connected, run jobs, report the sign-in state and the limits, clean up when removed. */
export async function runNode({ dir, adapter, builtin, terminal, login: loginSetup, log: writeLog = console.log, loginCheckMs = LOGIN_CHECK_MS, setupCheckMs = SETUP_CHECK_MS, learnMs = LEARN_MS, limitsMs = LIMITS_MS, loadMs = LOAD_MS, leaseCheckMs = LEASE_CHECK_MS, install, programs = new ProgramUpdates([]), testUser = null, runPart = runTests, describeEnvironment, build, checkBrowser = async () => null, browserCheckMs = BROWSER_CHECK_MS }: RunOptions): Promise<{ stop(reason?: NodeStopReason): void }> {
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
  /* For a program's own words, which may hold what Hornhoof must not keep: the machine's output only, secrets hidden,
     never the log the node gives Hornhoof. */
  const onMachine = (line: string) => writeLog(nodeLog(line, [...known]));
  removeOldParts(dir, log);
  const toolsUrl = `${state.server}/mcp`;
  /* The task's files a part of work takes in and puts back. */
  const files = partFiles(state.server, state.key);
  /* What this machine lacks of a harness, and what it built for the others. */
  const harness = harnessRemote(state.server, state.key);
  /* The built-in node serves API keys, which need no sign-in. */
  const single = typeof adapter === 'function' ? null : adapter;
  const pick = typeof adapter === 'function' ? adapter : () => adapter;
  /* A plan's sign-in is the node's to hold only on a personal node. */
  const holdsSignIn = single !== null && !builtin;

  /* Each running job with the way to call it off and the promise of its end, and the same for parts of test runs. */
  const running = new Map<string, { stop: AbortController; done: Promise<void> }>();
  const testing = new Map<string, { stop: AbortController; done: Promise<void> }>();
  /* The messages that change the company's data, numbered and kept in the volume until Hornhoof confirms them, so a
     restart of the node or of Hornhoof loses none. A job's end counts as running until then. */
  const outbox = new Outbox(dir, { onError: err => writeLog(`The outbox could not be written: ${message(err)}`) });
  /* Messages that cannot be sent while offline and are worth nothing late wait here, and go out right after the next hello. */
  const waiting: NodeMessage[] = [];
  /* Whether Hornhoof confirms numbered messages: with the server that does not, what was sent is dropped at once. */
  let confirmed = false;
  let send: ((m: ProgramNodeMessage) => boolean) | null = null;
  let online = false;
  const checks = startCheckClient(dir, terminal, () => send);
  /* The kind of sign-in Hornhoof hands this plan, and what that sign-in was when the plan's program refused it, empty when
     Hornhoof gave it none: until it changes, the node stays signed out, so turns do not go round on a sign-in that no
     longer works, each in a terminal, while the program itself still says it is signed in. */
  const planProvider = builtin ? null : (state as NodeState).provider;
  const credKind: CredKind | null = holdsSignIn && planProvider ? (CRED_KINDS[planProvider] ?? null) : null;
  const signInNow = (): string => {
    const held = credKind ? heldCredential(credHome, credKind) : null;
    return held ? digestOf(held) : '';
  };
  let refused: string | null = null;
  const signedInHere = async (): Promise<boolean> => {
    if (!single) return true;
    /* Only a Codex plan's machines are told they are spare. */
    if (isSpare(dir)) return false;
    if (refused !== null) {
      if (signInNow() === refused) return false;
      refused = null;
    }
    return single.loggedIn();
  };
  let loggedIn = await signedInHere();
  const setup = new SetupWait(single, setupCheckMs);
  await setup.check(loggedIn);
  const planLimits = new PlanLimits();
  let stopped = false;

  const emit = (m: NodeMessage) => {
    const current = withPrograms(m, programs);
    if (isNumbered(current)) return void sendNumbered(current);
    if (!send?.(current)) waiting.push(current);
  };
  /* An end is numbered when its turn comes, after the messages of its job; the rest are numbered as they are made. */
  const sendNumbered = (m: NodeMessage) => {
    if (!isEnd(m)) return deliver(outbox.add(m));
    outbox.hold(m);
    sendHeld(endId(m));
  };
  /* The turn of an end that was held has come. None is held when a new connection numbered and sent it meanwhile. */
  const sendHeld = (id: string) => {
    const entry = outbox.number(id);
    if (entry) deliver(entry);
  };
  /* A message that cannot go out now stays numbered in the outbox and goes after the next hello. */
  const deliver = (entry: Entry) => {
    if (send?.(entry.msg) && !confirmed && !isEnd(entry.msg)) outbox.dropSent(entry.n);
  };
  /* Values no screen shows: the node's key, the programs' tokens and each turn's tokens. */
  const learn = async (more: (string | null | undefined)[] = []) => {
    for (const s of more) if (s) known.add(s);
    for (const s of await (single?.secrets() ?? Promise.resolve([])).catch(() => [])) known.add(s);
  };
  await learn();
  /* A screen nobody receives is not worth keeping; everything else waits for the connection like any message. */
  const sendOrKeep = (m: NodeMessage) => (m.type === 'term.data' || m.type === 'term.exit' ? void send?.(m) : emit(m));
  /* What agents' programs send their tools with no turn running goes on the link as it is now, and waits for no other. */
  const outside = new OutsideCalls();
  const host = terminal
    ? new TerminalHost({
        tmux: terminal.tmux,
        operator: { dir: join(dir, 'program-operator'), send: frame => send?.(frame) ?? false, connected: () => online },
        hornhoof: state.server,
        send: sendOrKeep,
        secrets: () => [...known],
        log,
        remember: (sessionId, workDir) => rememberSession(dir, sessionId, workDir),
        toolsOutside: (key, body, version) => outside.ask(key, body, version),
        checkStep: key => outside.check(key),
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
          send: sendOrKeep,
          secrets: () => [...known],
          signedIn: () => signedInNow(),
          install,
          log: onMachine,
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
  /* The plan's limits now, asked of its program; none when it cannot tell. */
  const readLimits = async () => (single?.limits ? single.limits().catch(() => null) : null);
  let browserError = await checkBrowser().catch(err => message(err));
  writeBrowserError(dir, browserError);
  if (browserError) log(`Playwright browsers could not start: ${browserError}`);
  const testCapabilities: TestCapabilities = await nodeTestCapabilities(dir, testUser).catch(() => { log('Product test environments are unavailable on this node.'); return {}; });
  const partUser = new TestPartUser();
  const testMessages = new NodeTestMessages({ dir, describe: describeEnvironment, capabilities: testCapabilities, stopped: () => stopped, testing, unconfirmed: { has: partId => outbox.doneParts().includes(partId) }, run: testOne, harness: syncOne, emit });
  const noRunsNow = () => noRunsBecause(testUser, browserError);
  const tellStatus = () => {
    browserError = readBrowserError(dir);
    emit({ type: 'status', ...testCapabilities, loggedIn, ...setup.field(), limits: planLimits.forStatus(online), ...(models ? { models } : {}), account, browserError, noRuns: noRunsNow() });
  };
  const status = async () => {
    /* A program that cannot list its models now keeps those it listed before. */
    models = await readModels().catch(() => models);
    tellStatus();
  };

  /* How busy the machine is, which Hornhoof weighs when it picks a machine for a test run. */
  const load = (): NodeLoad => ({ ...machineLoad({ dir }), tests: testing.size, jobs: running.size });
  /* The agents whose programs run in its terminals, as of the last look, for Hornhoof starts no new one on a machine short
     of free memory. A node without terminals names none. */
  let live = terminal ? await terminal.tmux.livePrograms() : null;
  const lookLive = async () => {
    if (terminal) live = await terminal.tmux.livePrograms();
  };
  const liveNow = () => (live ? { live } : {});
  /* The node stops once Hornhoof has heard of its removal, not before. */
  const removal = removalWatch(() => outbox.owes('removed'), () => stop());

  /* The turns this node holds. Finished jobs whose end Hornhoof has not confirmed still count as running, so the server does
     not give up on them. */
  const holds = () => [...new Set([...running.keys(), ...(host?.typedJobs() ?? []), ...outbox.doneJobs()])];

  const conn = connect({
    url: state.server.replace(/^http/, 'ws') + '/api/nodes/socket',
    key: state.key,
    log,
    onOpen(next, acks, tools) {
      send = next;
      online = true;
      outside.opened(next, tools);
      checks.online(true);
      confirmed = acks;
      host?.closeViews();
      login?.closeViews();
      /* Finished jobs Hornhoof has not confirmed still count as running, so the server does not give up on them. */
      const typed = host?.typedJobs() ?? [];
      const tests = helloIds([...testing.keys()], outbox.doneParts(), acks);
      const noRuns = noRunsNow();
      next({ type: 'hello', ...testCapabilities, version: VERSION, stream: outbox.stream, loggedIn, ...setup.field(), running: helloIds([...running.keys(), ...typed], outbox.doneJobs(), acks), ...(models ? { models } : {}), terminals: Boolean(host), programOperatorV1: Boolean(host), work: Boolean(testUser), ...(noRuns ? { noRuns } : {}), browserError, load: load(), ...liveNow(), tests, skillFiles: true, publicKey: keyPair.recipient, account, boot, programs: programs.snapshot(), build, restart: life.previous, nodeLog: life.tail() });
      host?.operatorReplay();
      testMessages.replay();
      for (const m of waiting.splice(0)) emit(m);
      /* What it read while Hornhoof was away, before the end of any job that brought it. */
      if (planLimits.waiting) tellStatus();
      sendPending(outbox, next, acks);
      removal.settle();
    },
    /* One message that fails is logged; it never ends the node with all its runs. */
    onMessage: m => void handle(m).catch(err => log(`A message from Hornhoof failed: ${message(err)}`)),
    onClose: () => {
      online = false; outside.closed(); stopChecks(checks, testing); testMessages.cancelDescriptions();
    },
    onRefused: () => {
      log('Hornhoof does not know this machine any more. Run the install command from Hornhoof again to reconnect.');
      removal.refused();
    },
  });
  void programs.update(tellStatus, onMachine).catch(err => log(`Could not update the programs: ${message(err)}`));

  async function handle(m: ProgramServerMessage) {
    if (isProgramControl(m)) return applyProgramControl(m, checks, host);
    if (m.type === 'remove') {
      /* Only personal subscriptions are removed this way; the built-in node stays. */
      if (builtin || stopped) return;
      stopped = true;
      /* Stop the agents before revoking sign-in. Retained work and operation journals are not cleanup targets. */
      const jobs = [...running.values(), ...testing.values(), ...testMessages.activeDescriptions()];
      for (const job of jobs) job.stop.abort();
      await Promise.race([Promise.allSettled(jobs.map(j => j.done)), new Promise(r => setTimeout(r, STOP_WAIT_MS))]);
      await host?.stop();
      await login?.shutdown();
      rmSync(join(dir, 'home'), { recursive: true, force: true });
      markRemoved(dir);
      emit({ type: 'removed' });
      log('This node was removed in Hornhoof.');
      removal.start();
      return;
    }
    if (acknowledged(m, outbox)) return removal.settle();
    if (m.type === 'programs.update') return programs.update(tellStatus, onMachine);
    if (isNodeTestMessage(m)) return testMessages.handle(m);
    if (m.type === 'jobs.check') return emit(heldJobs(m.jobIds, holds()));
    if (m.type === 'job.cancel') {
      running.get(m.jobId)?.stop.abort();
      outside.stop(m.jobId);
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
        return shownBy(login, host, m.termId)?.input(m);
      case 'term.resize':
        return shownBy(login, host, m.termId)?.resize(m);
      case 'term.close':
        return shownBy(login, host, m.termId)?.close(m);
      case 'turn.opened':
        return host?.opened(m);
      case 'tools.answer':
        return outside.answered(m);
      case 'tools.checking':
        return outside.checking(m);
      case 'agent.input_kept':
        return host?.inputKept(m);
      case 'agent.say':
        return answerLiveWords(host, m, log, emit);
      case 'agent.restart': {
        const result = host ? await host.restart(m.agentKey, m.jobId, m.note) : { ok: false, reason: 'The terminal host is not running.' };
        return void send?.({ type: 'agent.restarted', agentKey: m.agentKey, jobId: m.jobId, ...result });
      }
      case 'agent.release':
        return host?.release(m.agentKey, m.jobId);
      case 'cred.put':
        return inOrder(() => putCredential(m.kind, m.sealed));
      case 'cred.seal':
        return inOrder(() => sealCredential(m.kind, m.version, m.recipients));
      /* A Codex plan runs on one of its machines at a time: the one that holds its lease keeps its sign-in. */
      case 'cred.lease':
        return inOrder(() => {
          if (!holdsSignIn) return;
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
    if (!holdsSignIn) return;
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
     holder keeps whom it sealed for, under which number and what the file was, to seal it again once Codex renews it. */
  async function sealCredential(kind: CredKind, version: number, recipients: Recipient[]) {
    const held = holdsSignIn ? heldCredential(credHome, kind) : null;
    if (!held) return;
    if (kind === 'codex_auth' && holdsLease(dir)) codexSealed = sealedFor(codexSealed, version, recipients, held);
    emit({ type: 'cred.sealed', kind, version, envelopes: await sealFor(held, recipients) });
  }

  const sealFor = (held: Uint8Array, recipients: Recipient[]) => Promise.all(recipients.map(async r => ({ nodeId: r.nodeId, sealed: await seal(held, [r.publicKey]) })));

  /* Codex renews its sign-in as it runs, and the old one stops working: the holder seals the new one for the plan's
     other machines, under the next number, so one of them can take over. */
  async function renewedCodex() {
    if (!codexSealed || !holdsSignIn || !holdsLease(dir)) return;
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

  let codexSealed: CodexSealed | null = null;

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
      outbox.hold(refusedPart);
      testing.delete(m.partId);
      return sendHeld(m.partId);
    }
    const inQueue = (position: number) => emit({ type: 'tests.waiting', partId: m.partId, position });
    const done = await runQueuedPart(m, (part, options) => partUser.run(options.signal, () => {
      emit({ type: 'tests.started', partId: part.partId }); return runPart(part, options);
    }, inQueue), { dir, user: testUser, hidden: [...known], signal, files, harness, runtimes: testCapabilities.testRuntimes }, inQueue, () => {});
    outbox.hold(done);
    testing.delete(m.partId);
    sendHeld(m.partId);
  }

  /* A product's harness, ahead of any run: it waits its turn like a part does, as it uses the same user. */
  function syncOne(m: HarnessRun, signal: AbortSignal) {
    return withCheckSlot(granted => partUser.run(granted, () => syncHarness(m, { dir, user: testUser, hidden: [...known], signal: granted, harness, runtimes: testCapabilities.testRuntimes }), () => {}), { signal, label: 'Get a product test harness ready' });
  }

  /* An agent's worktree gets its commit's dependencies from the company's harness, on a node that builds apart from its agents.
     A build takes the machine's turn for heavy work, as the agent's own install would. */
  const worktreeDependencies = testUser && testCapabilities.testHarness
    ? (tree: Worktree, signal?: AbortSignal) => worktreeHarness(tree, { dir, hidden: [...known], signal, harness, runtimes: testCapabilities.testRuntimes, slot: (granted, run) => withCheckSlot(run, { signal: granted, label: "Put a worktree's dependencies in place" }) })
    : undefined;

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
        return host.run({ key: input.agentKey, program: terminal.program, bin: terminal.bin, home: terminal.home, signedOut: terminal.signedOut, input, version, operatorDelivery: m.operatorDelivery, operatorSourceDelivery: m.operatorSourceDelivery, freshPrompt: m.freshPrompt });
      };
      const tracked: ProviderAdapter = {
        ...chosen,
        run: async input => {
          const res = await runUnlessStopped(input, () => runIn(input));
          /* A turn in a session says them itself. */
          planLimits.read(res.limits ?? (host && terminal && input.agentKey ? null : await readLimits()));
          return res;
        },
      };
      let seq = 0;
      const onEvent = (event: AgentEvent) => emit({ type: 'job.event', jobId: m.jobId, seq: seq++, event });
      done = await runJob(tracked, m, dir, { hidden, signal, toolsUrl, onEvent, beforeRun: () => programs.ready(signal), untimed: Boolean(host && terminal && m.workspace?.key), ...(worktreeDependencies ? { dependencies: worktreeDependencies } : {}) });
    } catch (err) {
      done = { type: 'job.done', jobId: m.jobId, ok: false, sessionId: null, result: '', tail: message(err), error: 'agent_failed' };
    }
    /* The end counts as running from here, so a hello while the limits are read does not give the job up. */
    outbox.hold(done);
    running.delete(m.jobId);
    /* A first setup the turn met, which only the plan's owner may pass, and the limits the turn brought go first, so
       Hornhoof knows of a plan that waits for its owner or is at its limit when it hears the job ended. */
    setup.met(done.failure);
    await status();
    sendHeld(m.jobId);
    await renewedCodex().catch(() => {});
    /* The program may end on the sign-in or fail on it: either way its provider refused it. */
    if (done.error === 'not_logged_in' || done.failure?.kind === 'auth') {
      loggedIn = false;
      if (credKind) refused = signInNow();
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
    const now = await readLimits();
    planLimits.looked(now, online);
    if (JSON.stringify(account) !== was) void status();
    /* A reading alone asks for no new list of models, and while Hornhoof is away it waits with planLimits, not in the outbox. */
    else if (now !== null && online) tellStatus();
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
    if (browserError) log(`Playwright browsers could not start: ${browserError}`);
    else log('Playwright Chromium, Firefox and WebKit are ready.');
    await status();
  };
  const checkingBrowser = setInterval(() => void recheckBrowser(), browserCheckMs);
  checkingBrowser.unref();
  /* An old figure says nothing, so one that cannot go out now is not kept for later. */
  const reporting = setInterval(() => void lookLive().then(() => send?.({ type: 'load', ...load(), ...liveNow() })), loadMs);
  reporting.unref();

  function stop(reason: NodeStopReason = 'stopped') {
    stopNode(life, send, boot.startedAt, reason);
    stopped = true;
    stopChecks(checks, testing); testMessages.cancelDescriptions();
    clearInterval(timer);
    if (learning) clearInterval(learning);
    clearInterval(asking);
    clearInterval(reporting);
    clearInterval(renewing);
    clearInterval(checkingBrowser);
    void host?.stop();
    void login?.shutdown();
    outbox.close();
    /* Let the last message leave before the socket closes. */
    setTimeout(() => conn.close(), 50);
  }
  return { stop };
}

export type Io = { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };

const USAGE = 'Usage: hornhoof-node run [--builtin] | login | status | set-key | set-server | wait-update | prepare-browser [repo]';
const SET_KEY_LINE = 'set-key expects one line: <server> <id> <provider or machine> <key>';
const SET_SERVER_LINE = 'set-server expects one line: <server>';
const WEB_ADDRESS = /^https?:\/\/\S+$/;
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

/* What Hornhoof confirms goes out of the outbox: numbers up to one, or a job's or a part's end. */
function acknowledged(message: ServerMessage, outbox: Outbox): message is Extract<ServerMessage, { type: 'ack' | 'job.ack' | 'tests.ack' }> {
  if (message.type === 'ack') outbox.ack(message.upto);
  else if (message.type === 'job.ack') outbox.ackJob(message.jobId);
  else if (message.type === 'tests.ack') outbox.ackPart(message.partId);
  else return false;
  return true;
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
function ensureInstalled(tools: string, provider: ProviderId, adapter: ProviderAdapter, api?: ApiEndpoint | null): Promise<void> {
  const path = join(tools, 'bin', programFor(provider, api).bin);
  if (existsSync(path)) return Promise.resolve();
  return updateInstalled(tools, provider, adapter, api);
}

function updateInstalled(tools: string, provider: ProviderId, adapter: ProviderAdapter, api?: ApiEndpoint | null): Promise<void> {
  const path = join(tools, 'bin', programFor(provider, api).bin);
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

/* api: an API by the token at an address runs in the program of its protocol. */
function withInstall(adapter: ProviderAdapter, tools: string, provider: ProviderId, api?: ApiEndpoint | null): ProviderAdapter {
  return {
    ...adapter,
    async run(input): Promise<RunResult> {
      try {
        await ensureInstalled(tools, provider, adapter, api);
      } catch (err) {
        const output = `Could not install ${programFor(provider, api).name}: ${message(err)}`;
        return { ok: false, sessionId: null, result: '', output, error: 'agent_failed', limits: null };
      }
      return adapter.run(input);
    },
  };
}

/* The node these words set up is still the one that was here, so what waits in its outbox is still its own to say. */
const sameNode = (was: NodeState | null, server: string | undefined, subscriptionId: string | undefined): boolean => was?.server === server && was?.subscriptionId === subscriptionId;

async function setKey(dir: string, io: Io): Promise<number> {
  const [server, subscriptionId, provider, key, ...rest] = (await firstLine(io.stdin)).split(/\s+/);
  const was = readState(dir);
  try {
    if (rest.length) throw new Error('extra words');
    mkdirSync(dir, { recursive: true });
    writeState(dir, { server, subscriptionId, provider: provider === MACHINE ? null : provider, key } as NodeState);
  } catch {
    io.stderr.write(`${SET_KEY_LINE}.\n`);
    return 1;
  }
  /* An old removed waiting in the outbox would revoke the new key. The file named removed goes last, so a crash before
     it leaves a node that is cleared the next time. */
  if (isRemoved(dir) || !sameNode(was, server, subscriptionId)) clearOutbox(dir);
  /* A new key means Hornhoof took this machine back after a removal. */
  rmSync(join(dir, 'removed'), { force: true });
  return 0;
}

/* The node goes to another address of the same company's server, as the front door of its own machine is. It stays the
   node it was, with its key, so what waits in its outbox is still its own to say. */
async function setServer(dir: string, io: Io): Promise<number> {
  const server = (await firstLine(io.stdin)).trim();
  const was = readState(dir);
  if (!was || !WEB_ADDRESS.test(server) || !URL.canParse(server)) {
    io.stderr.write(`${SET_SERVER_LINE}.\n`);
    return 1;
  }
  writeState(dir, { ...was, server });
  return 0;
}

/* A machine ready for turns that could not prepare its browser says why. */
function withBrowserProblem(dir: string, word: string): string {
  const problem = word === 'ready' ? readBrowserError(dir) : null;
  return problem ? `browser_failed: ${problem}` : word;
}

async function status(dir: string, io: Io): Promise<number> {
  const state = readState(dir);
  /* spare: another machine of the plan runs Codex now, and this one takes over when that one is away. */
  const word = isRemoved(dir) ? 'removed' : !state ? 'no_key' : isSpare(dir) ? 'spare' : state.provider ? await planWord(dir, state.provider) : 'ready';
  io.stdout.write(withBrowserProblem(dir, word) + '\n');
  return 0;
}

async function prepareBrowserCommand(dir: string, repoArg: string | undefined, io: Io): Promise<number> {
  const res = await prepareAndVerifyBrowser({ dir, ...(repoArg ? { repoDir: resolve(repoArg) } : {}), verifyUser: agentUser() });
  if (!res.ok) {
    io.stderr.write(`Playwright browsers could not start: ${res.error}\n`);
    return 1;
  }
  if (res.status === 'not_needed') io.stdout.write('not_needed\n');
  else io.stdout.write(`ready: playwright@${res.version} ${res.browserVersion} (downloaded: ${res.downloaded})\n`);
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

/* A personal node that runs as root keeps its own files to itself. Its test runs get a user of their own, apart from the
   agents' sign-in and folders. */
function securedTestUser(dir: string, user: JobUser | null): JobUser | null {
  if (!user) return null;
  secureNode(dir, user);
  return userFor(dir, 'tests', true);
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
    const testUser = securedTestUser(dir, user);
    const checkBrowser = () => startupBrowserCheck(dir, user);
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
  const pick = (job: JobRun) => withInstall(builtinPick(job), tools, job.provider, job.api);
  const managed = (['anthropic_api', 'openai_api'] as const).map(provider => ({ provider, adapter: adapterFor(provider, { home: dir, tools }) }));
  const testUser = userFor(dir, 'tests');
  const verifyUser = testUser || agentUser();
  const checkBrowser = () => startupBrowserCheck(dir, verifyUser);
  const signIn = builtinKey(key, process.env.HORNHOOF_MACHINE_ID || null);
  return runNode({ dir, adapter: pick, programs: managedUpdates(tools, managed), builtin: { server, key: signIn }, log, testUser, build, checkBrowser });
}

/* What the node's updater and its machine's setup call, or the usage for anything else. */
async function upkeepCommand(dir: string, args: string[], io: Io): Promise<number> {
  if (args[0] === 'wait-update') return waitUpdate(dir, io);
  if (args[0] === 'prepare-browser') return prepareBrowserCommand(dir, args[1], io);
  io.stderr.write(USAGE + '\n');
  return 1;
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
    case 'set-server':
      return setServer(dir, io);
    default:
      return upkeepCommand(dir, args, io);
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
