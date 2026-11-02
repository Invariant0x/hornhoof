import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Account, ProviderId } from '@hornhoof/protocol';
import type { JobUser } from './isolation.js';
import { runProgram } from './providers/process.js';

const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : null);
const account = (email: unknown, tier: unknown): Account => ({ email: text(email, 200), tier: text(tier, 40) });

/* Codex keeps an id token from ChatGPT: its middle part names the address and the ChatGPT plan. It is read for the
   screen only, so its signature is not checked. */
function codexAccount(home: string): Account | null {
  try {
    const auth = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'));
    const token = auth?.tokens?.id_token;
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object') return null;
    return account(claims.email, claims['https://api.openai.com/auth']?.chatgpt_plan_type);
  } catch {
    return null;
  }
}

/* Claude Code says it in its sign-in status. With a long token it knows neither, and both are null. */
async function claudeAccount(bin: string, env: NodeJS.ProcessEnv, user: JobUser | null): Promise<Account | null> {
  const done = await runProgram({ bin, args: ['auth', 'status', '--json'], env, timeoutMs: 30_000, user });
  /* Warnings on stderr come in the same output, so the status is the object in it. */
  const json = done.output.slice(done.output.indexOf('{'), done.output.lastIndexOf('}') + 1);
  try {
    const status = JSON.parse(json);
    return status?.loggedIn === true ? account(status.email, status.subscriptionType) : null;
  } catch {
    return null;
  }
}

export async function readAccount(provider: ProviderId, home: string, env: NodeJS.ProcessEnv, bin: string = provider, user: JobUser | null = null): Promise<Account | null> {
  if (provider === 'codex') return codexAccount(home);
  if (provider === 'claude') return claudeAccount(bin, env, user);
  return null;
}
