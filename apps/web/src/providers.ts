import { effortFor, effortsOf } from '@hornhoof/protocol/efforts';
import type { ModelOption, ProviderId } from './types';

/* Product names stay as they are in every language. */
export const PROVIDER_NAMES: Record<ProviderId, string> = {
  claude: 'Claude', codex: 'Codex', kimi: 'Kimi', glm: 'GLM', antigravity: 'Antigravity', anthropic_api: 'Anthropic', openai_api: 'OpenAI',
  openrouter: 'OpenRouter', custom_api: 'API',
};

/* The program an agent runs in its terminal, by its subscription. */
export const PROGRAM_NAMES: Record<ProviderId, string> = {
  claude: 'Claude', codex: 'Codex', kimi: 'Kimi', glm: 'GLM', antigravity: 'Antigravity', anthropic_api: 'Claude', openai_api: 'Codex',
  openrouter: 'Claude', custom_api: 'Claude',
};

/* Plans a person connects on their own machine. */
export const PLAN_PROVIDERS = ['claude', 'codex', 'kimi', 'glm', 'antigravity'] as const;
export type PlanProvider = (typeof PLAN_PROVIDERS)[number];

/* Default follows the role's fitted level, else the model's own default where Hornhoof knows it. */
export function defaultEffort(provider: ProviderId, models: ModelOption[], model: string, roleEffort?: string): string | null {
  const fitted = effortFor(null, effortsOf(models, model), roleEffort);
  if (fitted) return fitted;
  if (!model && (provider === 'claude' || provider === 'anthropic_api')) return 'medium';
  return models.find(m => m.id === model)?.defaultEffort ?? null;
}
