import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentEvent, Limits, ModelOption } from '@hornhoof/protocol';
import { asAgent, type JobUser } from '../isolation.js';
import { toldPlace } from '../program-folder.js';
import type { LoginIo, ProviderAdapter, RunInput, RunResult } from '../runner.js';
import { withProgramExit } from '../program-exit.js';
import { READY } from '../terminal/program-state.js';
import { Tmux } from '../terminal/tmux.js';
import { contentText, inputText, isRecord, objectLine, toolName } from './events.js';
import { agentDir, childEnv, ensureDir, exitsCleanly, firstLine, lastUrl, runInstaller, runProgram, tokensIn, writePrivate } from './process.js';
import { agyTokens } from '../turn-tokens.js';

type Options = { home: string; tools: string; bin?: string; user?: JobUser | null; person?: Person };

/* What agy 1.4.12 says in print mode and in `agy models` when it is not signed in. */
export const SIGNED_OUT = /authentication failed or timed out|authentication required|not logged into Antigravity|Please sign in/i;

/* agy 1.4.12's first-run setup, which its own screen shows once signed in on a machine where nobody passed it: the
   colors, then its terms of service with whether Google may use the interactions data. Read from the visible screen
   before agy's prompt shows, never from a conversation above it. */
const SETUP_COLORS = /Choose your color scheme:[\s\S]*\[Next\]/;
const SETUP_TERMS = /\[Previous\][ \t]+\[Done\]/;
type AgySetupStep = 'colors' | 'terms';

function agySetupStep(screen: string): AgySetupStep | null {
  if (SETUP_TERMS.test(screen)) return 'terms';
  return SETUP_COLORS.test(screen) ? 'colors' : null;
}

/* The node answers the colors itself, once for each agy: Enter takes the scheme agy offers first. It never presses again,
   as an Enter must never land on the terms, where it ticks or unticks the box, and a second one would if agy were slow to
   show them. The terms it leaves alone. Returns the step the screen shows. */
export async function pastColors(screen: string, enter: () => Promise<void>, pressed: { at: number }, now = Date.now()): Promise<AgySetupStep | null> {
  const step = agySetupStep(screen);
  if (step === 'colors' && pressed.at === -Infinity) {
    pressed.at = now;
    await enter();
  }
  return step;
}

/* How long agy has to show its terms after the node took its colors. An agy that still shows the colors then did not take
   the Enter, and the node starts it anew rather than press again. */
export const COLORS_WAIT_MS = 10_000;
export const colorsNotTaken = (step: AgySetupStep | null, pressed: { at: number }, now = Date.now()): boolean => step === 'colors' && now - pressed.at >= COLORS_WAIT_MS;

/* Why a turn ends at agy's colors. */
export const COLORS_NOT_TAKEN = 'Antigravity CLI did not take the colors of its first-run setup. The next turn starts it again.';

/* Why a turn ends at agy's terms. */
export const SETUP_NEEDED =
  "Antigravity CLI asks for its first setup on this machine: to accept its terms of service and choose whether Google may use the interactions data. Only the plan's owner can do it, by running the install command on the machine again, as for a sign-in. Hornhoof never accepts them for a person; the plan's turns wait for it.";

/* agy cuts each rules file, AGENTS.md among them, at 24,000 bytes on a line boundary, and has no setting for it. Longer
   instructions keep their start there, in whole lines well under that, and say where they are whole. */
const AGY_RULES = 24_000;
const AGY_START = 22_000;

/* What a rules file says to agy, and the whole text for the file it then names. room: what comes before it in that file. */
export function agyRules(text: string, file: string, room = 0): { rules: string; whole: string | null } {
  if (Buffer.byteLength(text) + room < AGY_RULES) return { rules: text, whole: null };
  const start: string[] = [];
  let bytes = 0;
  for (const line of text.split('\n')) {
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > AGY_START) break;
    start.push(line);
  }
  return { rules: `${start.join('\n')}\n\nThe rest of these instructions did not fit here. Read them whole in ${file} before you go on.`, whole: text };
}

/* Where Google's install script (antigravity.google/cli/install.sh) asks which release to download. */
const RELEASES = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app';

/* The release Google's install script picks for this machine. Nodes run glibc Linux. */
function platform(): string {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  return `${process.platform}_${arch}`;
}

/* Installs agy as Google's install script does: the release its manifest names, checked by its SHA-512, the program
   taken out of the archive. The script then lets agy set up the shell, which the node does not need. */
export async function installAgy(tools: string, base = RELEASES, on = platform()): Promise<void> {
  const res = await fetch(`${base}/manifests/${on}.json`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Google's release server answered ${res.status} for ${on}.`);
  const manifest: unknown = await res.json();
  const { url, sha512 } = isRecord(manifest) ? manifest : {};
  if (typeof url !== 'string' || typeof sha512 !== 'string') throw new Error("Google's release manifest names no download.");
  const download = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!download.ok) throw new Error(`The download of Antigravity CLI answered ${download.status}.`);
  const archive = Buffer.from(await download.arrayBuffer());
  if (createHash('sha512').update(archive).digest('hex') !== sha512.toLowerCase()) throw new Error('The download of Antigravity CLI does not match its checksum.');
  const staging = mkdtempSync(join(ensureDir(tools), '.agy-'));
  try {
    const bin = join(staging, 'antigravity');
    if (url.split('?')[0]!.endsWith('.tar.gz')) {
      writeFileSync(join(staging, 'agy.tar.gz'), archive);
      const done = await runInstaller({ bin: 'tar', args: ['-xzf', join(staging, 'agy.tar.gz'), '-C', staging, 'antigravity'], timeoutMs: 60_000 });
      if (done.code !== 0) throw new Error(`Antigravity CLI could not be taken out of its archive: ${done.output.trim()}`);
    } else writeFileSync(bin, archive);
    chmodSync(bin, 0o755);
    renameSync(bin, join(ensureDir(join(tools, 'bin')), 'agy'));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

function agyModelLevel(name: string) {
  const named = /^(.*\S) \((\w+)\)$/.exec(name);
  const level = named?.[2]!.toLowerCase();
  return named && level && LEVELS.includes(level) ? { model: named[1]!, level } : null;
}

/* Equal names alone do not mean agy accepts the same --model value. */
function agyModelGroups(rows: ModelOption[]) {
  const groups = new Map<string, { id: string | null; levels: string[] }>();
  for (const row of rows) {
    const at = agyModelLevel(row.name);
    if (!at) continue;
    const id = row.id.endsWith(`-${at.level}`) ? row.id.slice(0, -at.level.length - 1) : null;
    const previous = groups.get(at.model);
    groups.set(at.model, { id: previous && previous.id !== id ? null : id, levels: [...(previous?.levels ?? []), at.level] });
  }
  return groups;
}

/* agy separates each model's id and name with a TAB or at least two spaces. Rows with several levels of one name
   become one model only when their ids share a base before the trailing -<level>: --model takes that base and --effort
   takes a level. A single level or mismatched ids keep their own ids and names. */
export function agyModels(listing: string): ModelOption[] {
  const rows = listing.split('\n').flatMap(line => {
    const row = /^(\S+)(?:\t+| {2,})(\S.*?)\s*$/.exec(line);
    return row ? [{ id: row[1]!.slice(0, 80), name: row[2]!.slice(0, 80) }] : [];
  });
  const groups = agyModelGroups(rows);
  const models: ModelOption[] = [];
  for (const row of rows) {
    const at = agyModelLevel(row.name);
    const group = at ? groups.get(at.model)! : null;
    if (!at || !group?.id || group.levels.length < 2) models.push(row);
    else if (!models.some(m => m.id === group.id)) models.push({ id: group.id, name: at.model, efforts: LEVELS.filter(l => group.levels.includes(l)) });
  }
  return models.slice(0, 60);
}

/* What a stream-json line of agy's print mode shows people. A reply comes in parts of one step and shows once the step is
   done; a tool step shows its call and how it ended. */
export function agyStream(): (line: unknown) => AgentEvent[] {
  const parts = new Map<unknown, string>();
  return line => {
    if (!isRecord(line) || line.event !== 'step_update' || !isRecord(line.step_update)) return [];
    const step = line.step_update;
    if (step.step_type === 'agent_response') {
      const text = (parts.get(step.step_index) ?? '') + (typeof step.text_delta === 'string' ? step.text_delta : '');
      if (step.state !== 'DONE') {
        parts.set(step.step_index, text);
        return [];
      }
      parts.delete(step.step_index);
      return text.trim() ? [{ kind: 'text', text }] : [];
    }
    if (step.step_type !== 'tool' || step.state !== 'DONE' || !isRecord(step.tool_info)) return [];
    const info = step.tool_info;
    const name = typeof info.name === 'string' ? info.name : String(step.tool_name ?? 'tool');
    const error = isRecord(info.error) ? String(info.error.message ?? info.error.type ?? 'failed') : null;
    return [
      { kind: 'tool', name: toolName(name), input: agyInput(info.parameters) },
      { kind: 'tool_result', ok: error === null, summary: error ?? contentText(info.output) },
    ];
  };
}

/* A tool's input as people read it: the command of a shell step, else its parameters. */
export function agyInput(parameters: unknown): string {
  return isRecord(parameters) && typeof parameters.CommandLine === 'string' ? parameters.CommandLine : inputText(parameters);
}

const AGY_LIMITS_WAIT_MS = 15_000;
const AGY_WINDOWS: Record<string, string> = {
  '5h': 'five_hour',
  '1d': 'one_day',
  '24h': 'one_day',
  daily: 'one_day',
  '7d': 'seven_day',
  weekly: 'seven_day',
  month: 'month',
  monthly: 'month',
};
const WINDOW_ORDER = ['five_hour', 'one_day', 'seven_day', 'month'];
const UNIT_MINS: Record<string, number> = { m: 1, h: 60, d: 1440 };

type AgyWindow = { name: string; utilization: number; resetsAt: string | null };

function agySpanName(key: string): string | null {
  const span = /^(\d+)([mhd])$/.exec(key);
  const mins = span ? Number(span[1]) * UNIT_MINS[span[2]!]! : 0;
  return mins > 0 && Number.isFinite(mins) ? `${mins}_minutes` : null;
}

function cleanWindowKey(key: string): string | null {
  return key.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || null;
}

function agyWindowName(raw: unknown): string | null {
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!key) return null;
  return AGY_WINDOWS[key] ?? (/^\d+[mhd]$/.test(key) ? agySpanName(key) : cleanWindowKey(key));
}

function agyBucketUsed(bucket: Record<string, unknown>): number | null {
  if (bucket.disabled === true) return 1;
  const left = bucket.remaining_fraction;
  return typeof left === 'number' && Number.isFinite(left) ? Math.min(1, Math.max(0, 1 - left)) : null;
}

function agyResetTime(raw: unknown): string | null {
  const at = typeof raw === 'string' ? new Date(raw) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toISOString() : null;
}

function agyBucket(entry: unknown): AgyWindow | null {
  if (!isRecord(entry)) return null;
  const name = agyWindowName(entry.window);
  const utilization = agyBucketUsed(entry);
  return name && utilization !== null ? { name, utilization, resetsAt: agyResetTime(entry.reset_time) } : null;
}

function laterReset(current: string | null, next: string | null): boolean {
  return next !== null && (current === null || Date.parse(next) > Date.parse(current));
}

function fullerWindow(current: AgyWindow, next: AgyWindow): AgyWindow {
  if (next.utilization !== current.utilization) return next.utilization > current.utilization ? next : current;
  return current.utilization >= 1 && laterReset(current.resetsAt, next.resetsAt) ? next : current;
}

function agyUsageGroups(page: unknown): unknown[] | null {
  const parsed = typeof page === 'string' ? objectLine(page) : page;
  if (!isRecord(parsed) || parsed.status !== 'SUCCESS' || !isRecord(parsed.command)) return null;
  const data = parsed.command.name === 'usage' && isRecord(parsed.command.data) ? parsed.command.data : null;
  return data && Array.isArray(data.groups) ? data.groups : null;
}

function windowRank(name: string): number {
  const at = WINDOW_ORDER.indexOf(name);
  return at >= 0 ? at : WINDOW_ORDER.length;
}

function collectAgyWindows(groups: unknown[]): AgyWindow[] {
  const byName = new Map<string, AgyWindow>();
  for (const group of groups) {
    const buckets = isRecord(group) && Array.isArray(group.buckets) ? group.buckets : [];
    for (const entry of buckets) {
      const w = agyBucket(entry);
      if (w) byName.set(w.name, byName.has(w.name) ? fullerWindow(byName.get(w.name)!, w) : w);
    }
  }
  return [...byName.values()].sort((a, b) => windowRank(a.name) - windowRank(b.name)).slice(0, 8);
}

/* The plan's limits from `agy --print=/usage --output-format json`: each group's remaining share and reset time turned
   into used shares by window, with the fuller group speaking for each window. */
export function agyUsageLimits(page: unknown): Limits | null {
  const groups = agyUsageGroups(page);
  const windows = groups ? collectAgyWindows(groups) : [];
  if (!windows.length) return null;
  return { status: windows.some(w => w.utilization >= 1) ? 'rejected' : 'allowed', windows, complete: true };
}

type AgyLimitsOptions = { bin?: string; home: string; tools: string; user?: JobUser | null; timeoutMs?: number; signal?: AbortSignal };

/* Asks agy for the plan's quota buckets in an empty folder of its home, so no repository rules or MCP servers load. */
export async function agyPlanLimits({ bin: givenBin, home, tools, user = null, timeoutMs = AGY_LIMITS_WAIT_MS, signal }: AgyLimitsOptions): Promise<Limits | null> {
  const bin = givenBin ?? join(tools, 'bin', 'agy');
  if (!existsSync(bin)) return null;
  try {
    const cwd = agentDir(join(ensureDir(home), '.hh-limits'), user);
    const env = childEnv(tools, { HOME: home, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' });
    const lines: string[] = [];
    const done = await runProgram({ bin, args: ['--print=/usage', '--output-format', 'json'], env, cwd, timeoutMs, signal, user, onLine: line => void lines.push(line) });
    return done.code === 0 && !done.timedOut ? agyUsageLimits(lines.join('\n')) : null;
  } catch {
    return null;
  }
}

/* agy keeps its sign-in in a file when the machine has no keyring, as in a node; where, it does not say. These are the
   files of its own folders whose names say they hold a token or a secret. */
function tokenFiles(home: string): string[] {
  return [join(home, '.gemini', 'antigravity-cli'), join(home, '.config', 'antigravity')].flatMap(dir => {
    try {
      return readdirSync(dir).filter(f => /token|secret|cred|oauth/i.test(f)).map(f => join(dir, f));
    } catch {
      return [];
    }
  });
}

/* What agy 1.4.12 shows a person who is not signed in, once they pick Google, and when Google refuses the code. */
const LOGIN_METHODS = /Select login method/;
const CODE_ASKED = /paste the authorization code/;
const REFUSED = /Got an error: (.+)/;

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/* Checks until the check passes; past the time, the error says what did not happen. */
async function until(check: () => Promise<boolean>, ms: number, error: string): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await pause(250)) if (await check()) return;
  throw new Error(error);
}

type SignIn = { bin: string; home: string; env: NodeJS.ProcessEnv; user: JobUser | null; recordingsDir: string; signedIn: () => Promise<boolean> };

/* agy signs in only from its own screen: it asks how, shows Google's link and waits for the code Google then shows. The
   node answers that screen in a hidden tmux session, wide enough to keep the link on one line, and the person answers the
   node: they open the link, sign in with Google and paste the code. */
async function signInOnScreen(io: LoginIo, { bin, home, env, user, recordingsDir, signedIn }: SignIn): Promise<void> {
  const tmux = new Tmux({ socket: 'hh-login', env, recordingsDir });
  const name = 'agy-login';
  const screen = () => tmux.screen(name);
  try {
    await tmux.launch(name, { cwd: home, command: user ? asAgent([bin], user) : [bin], cols: 1000, rows: 50 });
    await until(async () => LOGIN_METHODS.test(await screen()), 60_000, 'Antigravity CLI did not show its sign-in screen.');
    /* The first way it offers is Google's own sign-in. */
    await tmux.keys(name, 'Enter');
    let url: string | null = null;
    await until(async () => {
      const shown = await screen();
      url = CODE_ASKED.test(shown) ? lastUrl(shown) : null;
      return url !== null;
    }, 60_000, 'Antigravity CLI did not show a sign-in link.');
    writeFileSync(io.urlFile, url + '\n');
    io.output.write(`Open this link, sign in with your Google account and copy the code Google shows:\n${url}\nPaste the code here and press Enter: `);
    const code = await firstLine(io.input);
    if (!code) throw new Error('No code was pasted.');
    await tmux.keys(name, '-l', code);
    await tmux.keys(name, 'Enter');
    await until(async () => {
      const refused = REFUSED.exec(await screen());
      if (refused) throw new Error(`Google did not take the code: ${refused[1]!.trim()}`);
      return signedIn();
    }, 120_000, 'Antigravity CLI did not finish signing in.');
  } finally {
    await tmux.stopAll();
  }
}

/* How long the node looks at a new agy for its first-run setup or its prompt. An agy that shows neither by then is not held
   for its setup: a turn's start looks at its screen too. */
const SETUP_LOOK_MS = 30_000;

type Look = { bin: string; home: string; env: NodeJS.ProcessEnv; user: JobUser | null };

/* Whether agy shows its first-run setup when it starts here as a turn starts it. Its screen is the one mark of it: agy
   1.4.12 keeps none the node could read, as the settings.json that a person's Done left on a machine held just {}. The node
   presses nothing on it, and closes it at once. Each look has a tmux server of its own, which starts agy with this env. */
async function setupShown({ bin, home, env, user }: Look): Promise<boolean> {
  const dir = agentDir(join(home, '.hh-setup-check'), user);
  const command = [bin, '--dangerously-skip-permissions', '--settings', JSON.stringify({ trustedWorkspaces: [dir] })];
  const tmux = new Tmux({ socket: `hh-setup-${randomUUID()}`, env });
  const name = 'agy-setup-check';
  try {
    await tmux.launch(name, { cwd: dir, command: user ? asAgent(command, user) : command, cols: 120, rows: 40 });
    for (const end = Date.now() + SETUP_LOOK_MS; Date.now() < end && (await tmux.alive(name)); await pause(250)) {
      const screen = await tmux.screen(name, 0);
      if (agySetupStep(screen)) return true;
      if (READY.antigravity(screen)) return false;
    }
    return false;
  } finally {
    await tmux.stopAll();
  }
}

/* The person who runs the install command, on agy's session: they see its screen and answer it, until the session ends.
   None without a terminal of their own. */
export type Person = (io: LoginIo) => ((tmux: Tmux, session: string) => Promise<void>) | null;
/* Whether the command reads the terminal of the node's own process, the one the person who runs it sits at. */
export const ownTerminal = (input: NodeJS.ReadableStream, stdin: NodeJS.ReadableStream & { isTTY?: boolean }): boolean => input === stdin && stdin.isTTY === true;
const onOwnTerminal: Person = io =>
  ownTerminal(io.input, process.stdin)
    ? (tmux, session) => new Promise(resolve => tmux.attachHere(session).once('exit', () => resolve()).once('error', () => resolve()))
    : null;

const SETUP_HANDED =
  'Antigravity CLI asks you to accept its terms of service and to choose whether Google may use your interactions data. Hornhoof picked its colors and leaves this to you. Its own screen comes next: read it, then choose Done to accept, or press Ctrl+C twice to leave it for now.\n';

type SetUp = Look & { recordingsDir: string; person: Person };

/* What a starting agy comes to: its terms, once the node took its colors, or its prompt, when it is past its setup. */
async function cameTo(tmux: Tmux, name: string): Promise<'terms' | 'past'> {
  const colors = { at: -Infinity };
  for (const end = Date.now() + 60_000; Date.now() < end; await pause(250)) {
    const screen = await tmux.screen(name, 0);
    if (READY.antigravity(screen)) return 'past';
    if ((await pastColors(screen, () => tmux.keys(name, 'Enter'), colors)) === 'terms') return 'terms';
  }
  throw new Error('Antigravity CLI did not show its terms.');
}

/* agy's first-run setup, which its owner passes once on the machine after the sign-in. The node answers the colors in a
   hidden tmux session; the terms go to the person's own terminal, on agy's own screen, and the node presses nothing on
   them. It ends once agy shows its prompt or is closed, and a new agy then says whether it still asks for the setup. */
async function setUpOnScreen(io: LoginIo, { recordingsDir, person, ...look }: SetUp): Promise<void> {
  const answer = person(io);
  if (!answer) throw new Error('Its terms need the terminal of the person who runs the install command.');
  const tmux = new Tmux({ socket: 'hh-login', env: look.env, recordingsDir });
  const name = 'agy-setup';
  try {
    await tmux.launch(name, { cwd: look.home, command: look.user ? asAgent([look.bin], look.user) : [look.bin], cols: 120, rows: 40 });
    if ((await cameTo(tmux, name)) === 'past') return;
    io.output.write(SETUP_HANDED);
    let watching = true;
    void answer(tmux, name).finally(() => (watching = false));
    while (watching && (await tmux.alive(name)) && !READY.antigravity(await tmux.screen(name, 0))) await pause(250);
  } finally {
    await tmux.stopAll();
  }
  if (await setupShown(look)) throw new Error('Antigravity CLI was closed before its terms were accepted.');
}

/* agy reads AGENTS.md in the folder it works in as the folder's rules. */
function tellAgy(input: RunInput, instructions: string, user: JobUser | null): void {
  const whole = join(input.workDir, '.hh-instructions.md');
  const { file, head } = toldPlace('antigravity', input);
  const said = agyRules(instructions, whole, Buffer.byteLength(head));
  if (said.whole) writePrivate(whole, said.whole + '\n', user);
  writePrivate(file, head + said.rules + '\n', user);
}

export function antigravityAdapter({ home, tools, bin = join(tools, 'bin', 'agy'), user = null, person = onOwnTerminal }: Options): ProviderAdapter {
  /* agy has no setting for its folder: it keeps everything in HOME. It does not replace itself: the program in the node's
     tools folder stays as the node installed it, which agents on a root node could not write anyway. */
  const env = () => childEnv(tools, { HOME: ensureDir(home), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' });
  let listed: ModelOption[] = [];

  return {
    async install() {
      await installAgy(tools);
    },

    async loggedIn() {
      return exitsCleanly(bin, ['models'], env(), user);
    },

    /* What agy lists now, or what it listed before when it cannot list them, signed out or offline. */
    async models() {
      const done = await runProgram({ bin, args: ['models'], env: env(), timeoutMs: 30_000, user });
      if (done.code === 0) listed = agyModels(done.output);
      return listed;
    },

    async limits() {
      return agyPlanLimits({ bin, home, tools, user });
    },

    async login(io) {
      const signedIn = () => exitsCleanly(bin, ['models'], env(), user);
      await signInOnScreen(io, { bin, home, env: env(), user, recordingsDir: join(dirname(tools), '.hh-recordings'), signedIn });
    },

    async setupNeeded() {
      return setupShown({ bin, home, env: env(), user });
    },

    async setup(io) {
      await setUpOnScreen(io, { bin, home, env: env(), user, recordingsDir: join(dirname(tools), '.hh-recordings'), person });
    },

    async run(input: RunInput): Promise<RunResult> {
      const args = [`--print=${input.prompt}`, '--output-format', 'stream-json', '--print-timeout', '0s', '--dangerously-skip-permissions'];
      if (input.sessionId) args.push('--conversation', input.sessionId);
      if (input.model) args.push('--model', input.model);
      if (input.effort) args.push('--effort', input.effort);

      /* agy takes MCP servers from settings files only, and the token as a header in them: the folder's own file, which
         only the program's user reads, for this run alone. */
      const mcpJson = join(input.workDir, '.agents', 'mcp_config.json');
      if (input.tools) {
        agentDir(join(input.workDir, '.agents'), user);
        const server = { serverUrl: input.tools.url, headers: { Authorization: `Bearer ${input.tools.token}` } };
        writePrivate(mcpJson, JSON.stringify({ mcpServers: { hornhoof: server } }), user);
      }
      if (input.instructions) tellAgy(input, input.instructions, user);

      let sessionId: string | null = input.sessionId;
      let result: Record<string, unknown> | null = null;
      const read = agyStream();
      const done = await runProgram({
        bin,
        args,
        env: { ...env(), ...input.env },
        user,
        cwd: input.workDir,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        onLine(line) {
          const ev = objectLine(line);
          if (!ev) return;
          for (const event of read(ev)) input.onEvent?.(event);
          const step = isRecord(ev.step_update) ? ev.step_update : isRecord(ev.result) ? ev.result : ev;
          if (typeof step.conversation_id === 'string' && step.conversation_id) sessionId = step.conversation_id;
          if (ev.event === 'result' && isRecord(ev.result)) result = ev.result;
        },
      }).finally(() => {
        if (input.tools) rmSync(mcpJson, { force: true });
      });

      /* Assigned in onLine, which TypeScript does not follow. */
      const final = result as Record<string, unknown> | null;
      const answer = typeof final?.response === 'string' ? final.response.trimEnd() : '';
      const ended = withProgramExit(done.output, done);
      /* The result tells what the whole turn used. */
      const tokens = agyTokens(final?.usage);
      if (done.timedOut) return { ok: false, sessionId, result: '', ...ended, error: 'timeout', limits: null, tokens };
      if (done.code === 0 && final?.status === 'SUCCESS') return { ok: true, sessionId, result: answer, output: done.output, error: null, limits: null, tokens };
      const said = typeof final?.error === 'string' ? final.error : '';
      return { ok: false, sessionId, result: answer, ...ended, error: SIGNED_OUT.test(`${said}\n${done.output}`) ? 'not_logged_in' : 'agent_failed', limits: null, tokens };
    },

    async secrets() {
      return tokenFiles(home).flatMap(file => {
        const found = tokensIn(file);
        if (found.length) return found;
        /* A token kept as plain text. */
        try {
          return readFileSync(file, 'utf8').split(/\s+/).filter(word => word.length >= 20);
        } catch {
          return [];
        }
      });
    },
  };
}
