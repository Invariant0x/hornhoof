import type { ProviderId } from '@hornhoof/protocol';
import type { JobUser } from '../isolation.js';
import type { ProviderAdapter } from '../runner.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { kimiAdapter } from './kimi.js';
import { antigravityAdapter } from './antigravity.js';

type Options = { home: string; tools: string; bin?: string; secret?: string | null; user?: JobUser | null };

/* The program each provider runs on: its file in tools/bin and the name people know it by. */
export function programFor(provider: ProviderId): { bin: 'claude' | 'codex' | 'kimi' | 'agy'; name: string } {
  if (provider === 'codex' || provider === 'openai_api') return { bin: 'codex', name: 'Codex' };
  if (provider === 'kimi') return { bin: 'kimi', name: 'Kimi Code' };
  if (provider === 'antigravity') return { bin: 'agy', name: 'Antigravity CLI' };
  return { bin: 'claude', name: 'Claude Code' };
}

/* bin overrides the program's path; tests point it at fake programs. */
export function adapterFor(provider: ProviderId, opts: Options): ProviderAdapter {
  switch (provider) {
    case 'claude':
      return claudeAdapter({ ...opts, mode: 'plan' });
    case 'anthropic_api':
      return claudeAdapter({ ...opts, mode: 'api_key' });
    case 'glm':
      return claudeAdapter({ ...opts, mode: 'glm' });
    case 'codex':
      return codexAdapter({ ...opts, mode: 'plan' });
    case 'openai_api':
      return codexAdapter({ ...opts, mode: 'api_key' });
    case 'kimi':
      return kimiAdapter(opts);
    case 'antigravity':
      return antigravityAdapter(opts);
  }
}
