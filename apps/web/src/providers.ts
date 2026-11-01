import { effortsOf, topEffort } from '@hornhoof/protocol/efforts';
import type { ModelOption, ProviderId } from './types';

/* Product names stay as they are in every language. */
export const PROVIDER_NAMES: Record<ProviderId, string> = {
  claude: 'Claude', codex: 'Codex', kimi: 'Kimi', glm: 'GLM', antigravity: 'Antigravity', anthropic_api: 'Anthropic', openai_api: 'OpenAI',
};

/* The program an agent runs in its terminal, by its subscription. */
export const PROGRAM_NAMES: Record<ProviderId, string> = {
  claude: 'Claude', codex: 'Codex', kimi: 'Kimi', glm: 'GLM', antigravity: 'Antigravity', anthropic_api: 'Claude', openai_api: 'Codex',
};

/* Plans a person connects on their own machine. */
export const PLAN_PROVIDERS = ['claude', 'codex', 'kimi', 'glm', 'antigravity'] as const;
export type PlanProvider = (typeof PLAN_PROVIDERS)[number];

/* The level the Default runs at, when Hornhoof knows it: Kimi and Codex at the most their model takes, Claude Code's
   Default model, Opus 5.5, at medium, else the model's own. */
export function defaultEffort(provider: ProviderId, models: ModelOption[], model: string): string | null {
  const top = topEffort(provider, effortsOf(models, model));
  if (top) return top;
  if (!model && (provider === 'claude' || provider === 'anthropic_api')) return 'medium';
  return models.find(m => m.id === model)?.defaultEffort ?? null;
}
