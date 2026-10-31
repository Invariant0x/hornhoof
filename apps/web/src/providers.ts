import type { ModelOption, ProviderId } from './types';

/* Product names stay as they are in every language. */
export const PROVIDER_NAMES: Record<ProviderId, string> = {
  claude: 'Claude', codex: 'Codex', kimi: 'Kimi', glm: 'GLM', anthropic_api: 'Anthropic', openai_api: 'OpenAI',
};

/* Plans a person connects on their own machine. */
export const PLAN_PROVIDERS = ['claude', 'codex', 'kimi', 'glm'] as const;
export type PlanProvider = (typeof PLAN_PROVIDERS)[number];

/* The levels a model thinks at. The Default model, and one the subscription does not run, which runs on the Default,
   take every level of the subscription's models. */
export function effortsOf(models: ModelOption[], model: string): string[] {
  const found = model ? models.find(m => m.id === model) : undefined;
  return found ? (found.efforts ?? []) : [...new Set(models.flatMap(m => m.efforts ?? []))];
}

/* The level the Default runs at, when Hornhoof knows it: Kimi at its most, else the model's own. */
export function defaultEffort(provider: ProviderId, models: ModelOption[], model: string): string | null {
  return provider === 'kimi' ? 'max' : (models.find(m => m.id === model)?.defaultEffort ?? null);
}
