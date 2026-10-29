import type { ProviderId } from '@hornhoof/protocol';
import type { ProviderAdapter } from '../runner.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { kimiAdapter } from './kimi.js';

type Options = { home: string; tools: string; bin?: string; secret?: string | null };

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
  }
}
