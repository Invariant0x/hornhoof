import { createHash } from 'node:crypto';
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentEvent, ModelOption } from '@hornhoof/protocol';
import { asAgent, type JobUser } from '../isolation.js';
import type { LoginIo, ProviderAdapter, RunInput, RunResult } from '../runner.js';
import { withProgramExit } from '../program-exit.js';
import { Tmux } from '../terminal/tmux.js';
import { contentText, inputText, isRecord, objectLine, toolName } from './events.js';
import { childEnv, ensureDir, exitsCleanly, firstLine, lastUrl, runProgram, tokensIn, writePrivate } from './process.js';

type Options = { home: string; tools: string; bin?: string; user?: JobUser | null };

/* What agy 1.4.12 says in print mode and in `agy models` when it is not signed in. */
export const SIGNED_OUT = /authentication failed or timed out|authentication required|not logged into Antigravity|Please sign in/i;

/* agy cuts each rules file, AGENTS.md among them, at 24,000 bytes on a line boundary, and has no setting for it. Longer
   instructions keep their start there, in whole lines well under that, and say where they are whole. */
const AGY_RULES = 24_000;
const AGY_START = 22_000;

/* What AGENTS.md says to agy, and the whole text for the file it then names. */
export function agyRules(text: string, file: string): { rules: string; whole: string | null } {
  if (Buffer.byteLength(text) < AGY_RULES) return { rules: text, whole: null };
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
      const done = await runProgram({ bin: 'tar', args: ['-xzf', join(staging, 'agy.tar.gz'), '-C', staging, 'antigravity'], env: process.env, timeoutMs: 60_000 });
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

/* A folder in the agent's own folder that its program's user may use. */
function agentDir(path: string, user: JobUser | null): string {
  mkdirSync(path, { recursive: true });
  if (user) chownSync(path, user.uid, user.gid);
  return path;
}

export function antigravityAdapter({ home, tools, bin = join(tools, 'bin', 'agy'), user = null }: Options): ProviderAdapter {
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

    async login(io) {
      const signedIn = () => exitsCleanly(bin, ['models'], env(), user);
      await signInOnScreen(io, { bin, home, env: env(), user, recordingsDir: join(dirname(tools), '.hh-recordings'), signedIn });
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
      /* agy reads AGENTS.md in the folder it works in as the folder's rules. */
      if (input.instructions) {
        const file = join(input.workDir, '.hh-instructions.md');
        const { rules, whole } = agyRules(input.instructions, file);
        if (whole) writePrivate(file, whole + '\n', user);
        writePrivate(join(input.workDir, 'AGENTS.md'), rules + '\n', user);
      }

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
      if (done.timedOut) return { ok: false, sessionId, result: '', ...ended, error: 'timeout', limits: null };
      if (done.code === 0 && final?.status === 'SUCCESS') return { ok: true, sessionId, result: answer, output: done.output, error: null, limits: null };
      const said = typeof final?.error === 'string' ? final.error : '';
      return { ok: false, sessionId, result: answer, ...ended, error: SIGNED_OUT.test(`${said}\n${done.output}`) ? 'not_logged_in' : 'agent_failed', limits: null };
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
