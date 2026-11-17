import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CredKind } from '@hornhoof/protocol';
import type { JobUser } from './isolation.js';
import { ensureDir, readPrivate, writePrivate } from './providers/process.js';

/* Where each kind of plan sign-in lives in the program's home. Claude Code takes its long token from
   CLAUDE_CODE_OAUTH_TOKEN, which the node sets from this file; Codex reads auth.json; Kimi Code reads its settings, which
   the node writes from the key; Claude Code in GLM mode reads glm-key. */
export const CRED_FILES: Record<CredKind, string> = { claude_token: 'claude-oauth-token', codex_auth: 'auth.json', kimi_key: 'kimi-key', glm_key: 'glm-key' };
/* Codex renews its own sign-in, so it runs on one machine of a plan at a time: the one holding this file. */
const LEASE_FILE = 'codex-lease';
/* A machine of a Codex plan that another machine runs: it is signed out of Codex here, whatever file a Codex that still
   runs on it writes, until it holds the plan again. */
const SPARE_FILE = 'codex-spare';

/* A token or key is one word, so it cannot break the settings it goes into. */
const WORD = /^[A-Za-z0-9._~+/=-]{8,4096}$/;

export const holdsLease = (dir: string): boolean => existsSync(join(dir, LEASE_FILE));

export const isSpare = (dir: string): boolean => existsSync(join(dir, SPARE_FILE));

export function takeLease(dir: string): void {
  writePrivate(join(dir, LEASE_FILE), '', null);
  rmSync(join(dir, SPARE_FILE), { force: true });
}

/* Another machine of the plan runs Codex now: this one keeps no sign-in of it, so it says it is signed out. */
export function giveUpLease(dir: string, home: string, user: JobUser | null = null): void {
  rmSync(join(dir, LEASE_FILE), { force: true });
  writePrivate(join(dir, SPARE_FILE), '', null);
  dropCredential(home, 'codex_auth', user);
}

/* The agents own the plan's home, so the node reads nothing there through a link. */
const read = readPrivate;

/* Keeps a plan's sign-in where its program reads it, readable by the agents' user alone. A Codex sign-in waits while
   another machine holds the plan's lease; false then. Throws on a value that is not a sign-in of that kind. */
export function applyCredential(dir: string, home: string, kind: CredKind, plain: Uint8Array, user: JobUser | null = null): boolean {
  const text = new TextDecoder().decode(plain);
  if (kind === 'codex_auth') {
    const auth: unknown = JSON.parse(text);
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new Error('A Codex sign-in is a JSON object.');
    if (!holdsLease(dir)) return false;
    writePrivate(join(ensureDir(home), CRED_FILES.codex_auth), text, user);
    return true;
  }
  const value = text.trim();
  if (!WORD.test(value)) throw new Error('A sign-in key is one word of letters, digits and signs.');
  writePrivate(join(ensureDir(home), CRED_FILES[kind]), value + '\n', user);
  if (kind === 'kimi_key') writePrivate(join(home, 'config.toml'), kimiConfig(read(join(home, 'config.toml')) ?? '', value), user);
  return true;
}

export function dropCredential(home: string, kind: CredKind, user: JobUser | null = null): void {
  rmSync(join(home, CRED_FILES[kind]), { force: true });
  const config = kind === 'kimi_key' ? read(join(home, 'config.toml')) : null;
  if (config !== null) writePrivate(join(home, 'config.toml'), withoutKimiKey(config), user);
}

/* The sign-in this node holds, to seal for the plan's other nodes. */
export function heldCredential(home: string, kind: CredKind): Uint8Array | null {
  const text = read(join(home, CRED_FILES[kind]));
  if (text === null) return null;
  return new TextEncoder().encode(kind === 'codex_auth' ? text : text.trim());
}

/* The keys and tokens given to this node, which no screen or log shows. Codex's tokens are its adapter's to name. */
export function credentialSecrets(home: string): string[] {
  return (['claude_token', 'kimi_key', 'glm_key'] as const).map(k => read(join(home, CRED_FILES[k]))?.trim() ?? '').filter(Boolean);
}

/* Kimi Code with a Kimi Code membership key: a provider of type kimi at the coding endpoint with the key, and the
   coding model on it, as https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers.html and
   .../configuration/config-files.html describe (checked 2026-11-02):
     [providers."<name>"]  type = "kimi", base_url = "https://api.kimi.com/coding/v1", api_key = "sk-..."
     [models."<alias>"]    provider = "<name>", model = "kimi-for-coding", max_context_size = 262144
   The alias is the one /login writes for that model, so an agent's model runs on a node signed in either way. */
const KIMI_PROVIDER = 'hornhoof-key';
const KIMI_MODEL = 'kimi-code/kimi-for-coding';
const KIMI_TABLES = [
  `[providers."${KIMI_PROVIDER}"]`,
  'type = "kimi"',
  'base_url = "https://api.kimi.com/coding/v1"',
  'api_key = "%KEY%"',
  '',
  `[models."${KIMI_MODEL}"]`,
  `provider = "${KIMI_PROVIDER}"`,
  'model = "kimi-for-coding"',
  'max_context_size = 262144',
  'display_name = "Kimi for Coding"',
  'capabilities = ["thinking", "always_thinking", "image_in", "video_in", "tool_use"]',
  '',
].join('\n');

/* A table this node writes: its provider with any of its own subtables, and the model, but not the model's overrides. */
function ours(header: string): boolean {
  const name = header.replace(/^\s*\[+\s*|\s*\]+\s*$/g, '');
  return name === `providers."${KIMI_PROVIDER}"` || name.startsWith(`providers."${KIMI_PROVIDER}".`) || name === `models."${KIMI_MODEL}"`;
}

function withoutKimiKey(config: string): string {
  const kept: string[] = [];
  let skip = false;
  for (const line of config.split('\n')) {
    if (/^\s*\[/.test(line)) skip = ours(line);
    if (!skip) kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

function kimiConfig(config: string, key: string): string {
  const rest = withoutKimiKey(config);
  const first = rest.search(/^\s*\[/m);
  const top = (first < 0 ? rest : rest.slice(0, first)).split('\n').filter(l => !/^\s*default_model\s*=/.test(l)).join('\n').trim();
  const tables = (first < 0 ? '' : rest.slice(first)).trim();
  return [`default_model = "${KIMI_MODEL}"`, top, tables, KIMI_TABLES.replace('%KEY%', key)].filter(Boolean).join('\n\n').replace(/\n*$/, '\n');
}
