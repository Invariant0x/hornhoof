import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Limits } from '@hornhoof/protocol';
import { ownFs, type AgentFs } from '../agent-fs.js';
import { bridgeEnv, readJson, type TermProgram } from '../terminal/programs.js';
import { kimiUsageLimits } from '../terminal/transcripts.js';
import { KIMI_MCP_START } from './mcp-start.js';
import { KIMI_NO_AUTO_UPDATE } from './session-updates.js';

/* Kimi Code in a native terminal: how it launches, the files it reads first, where it logs and its plan's limits. */

/* Kimi Code's plan page, on its own servers only: the sign-in token goes nowhere else. KIMI_CODE_BASE_URL is Kimi's own
   way to point it elsewhere. */
const KIMI_BASE = 'https://api.kimi.com/coding/v1';
const KIMI_GLOBAL_BASE = 'https://api.kimi.ai/coding/v1';

export const kimiProgram: TermProgram = {
  kind: 'kimi',
  launch({ bin, home, sessionId, model, effort, urls }) {
    /* --auto decides everything on its own, as the others run without approvals. Kimi names a new session only when the
       first message starts it, and its start hook tells the host. */
    const command = [bin, '--auto', ...(sessionId ? ['-S', sessionId] : []), ...(model ? ['-m', model] : [])];
    /* The agent's folder is trusted, so Kimi reads the tools and instructions Hornhoof leaves there without asking. Kimi
       has no flag for effort; it reads this setting over its own. */
    const thinking: Record<string, string> = effort ? { KIMI_MODEL_THINKING_EFFORT: effort } : {};
    return { command, env: { KIMI_CODE_HOME: home, KIMI_CODE_TRUST_WORKSPACE: '1', PI_PROGRAM_STATUS: '1', ...KIMI_NO_AUTO_UPDATE, ...thinking, ...bridgeEnv(urls, KIMI_HOOK_LIMITS) }, sessionId };
  },
  limits: kimiPlanLimits,
};

/* Hornhoof's hooks in Kimi's settings: the start names the session, the prompt opens a person's turn before Kimi goes on. */
/* Kimi Code gives every hook thirty seconds unless it asks for more
   (packages/agent-core-v2/src/features/externalHooks/internal/matchHooks.ts, DEFAULT_HOOK_TIMEOUT_SECONDS). */
const KIMI_HOOK_LIMITS = { '*': 30_000 };

const KIMI_HOOKS = [
  ['SessionStart', 'start'],
  ['UserPromptSubmit', 'prompt'],
  ['UserPromptQueued', 'queued'],
  ['Stop', 'stop'],
  ['StopFailure', 'stop'],
  ['Interrupt', 'interrupt'],
  ['PreToolUse', 'tool'],
  ['PostToolUse', 'tooldone'],
  ['PostToolUseFailure', 'toolfail'],
  ['SessionEnd', 'end'],
] as const;

/* Kimi has no flags for tools or hooks. Its tools come from the agent folder's .kimi-code/mcp.json, through the bridge,
   and its hooks from config.toml in its home, which the person's own settings share: Hornhoof's are added at the end
   once. Settings that list their hooks on one line could take no more, and are left alone. */
export async function prepareKimi(home: string, workDir: string, mcpUrl: string, fs: AgentFs = ownFs): Promise<void> {
  const dir = join(workDir, '.kimi-code');
  await fs.mkdir(dir);
  await fs.write(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { hornhoof: { transport: 'http', url: mcpUrl, ...KIMI_MCP_START } } }, null, 2));
  const file = join(home, 'config.toml');
  /* A home that was never signed in has none yet. */
  const config = (await fs.read(file)) ?? '';
  const entries = config.split(/\[\[hooks\]\]/).slice(1);
  const missing = KIMI_HOOKS.filter(([name, event]) => !entries.some(entry => new RegExp(`event\\s*=\\s*"${name}"`).test(entry) && entry.includes(`"hh-hook ${event}"`)));
  if (!missing.length || /^\s*hooks\s*=/m.test(config)) return;
  const added = missing.map(([name, event]) => `[[hooks]]\nevent = "${name}"\ncommand = "hh-hook ${event}"\n`).join('\n');
  await fs.mkdir(home);
  await fs.write(file, `${config}${config && !config.endsWith('\n') ? '\n' : ''}${config ? '\n' : ''}${added}`);
}

/* Kimi Code keeps a session's log by the folder's workspace and the session's id; the main agent has its own log. */
export function findKimiWire(home: string, sessionId: string): string | null {
  if (!/^[\w-]+$/.test(sessionId)) return null;
  const root = join(home, 'sessions');
  if (!existsSync(root)) return null;
  for (const workspace of readdirSync(root)) {
    const file = join(root, workspace, sessionId, 'agents', 'main', 'wire.jsonl');
    if (existsSync(file)) return file;
  }
  return null;
}

/* What Kimi's /usage shows, asked with the token Kimi keeps fresh while it runs. A token that went stale gives nothing,
   and the host keeps what it knew. */
export async function kimiPlanLimits(home: string): Promise<Limits | null> {
  const { access_token: token, expires_at: expires } = readJson(join(home, 'credentials', 'kimi-code.json'));
  if (typeof token !== 'string' || !token) return null;
  /* Kimi alone renews its token, with a lock its own processes share; a token that ran out would only be refused. */
  if (typeof expires === 'number' && expires * 1000 < Date.now() + 30_000) return null;
  let config = '';
  try {
    config = readFileSync(join(home, 'config.toml'), 'utf8');
  } catch {
    /* Signed in without settings: the default servers. */
  }
  const base = process.env.KIMI_CODE_BASE_URL ?? (config.includes(KIMI_GLOBAL_BASE) ? KIMI_GLOBAL_BASE : KIMI_BASE);
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/usages`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    return res.ok ? kimiUsageLimits(await res.json()) : null;
  } catch {
    return null;
  }
}
