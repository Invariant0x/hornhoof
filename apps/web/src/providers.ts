import type { ModelOption, ProviderId } from './types';

/* Product names stay as they are in every language. */
export const PROVIDER_NAMES: Record<ProviderId, string> = {
  claude: 'Claude', codex: 'Codex', kimi: 'Kimi', glm: 'GLM', anthropic_api: 'Anthropic', openai_api: 'OpenAI',
};

/* The program an agent runs in its terminal, by its subscription. */
export const PROGRAM_NAMES: Record<ProviderId, string> = {
  claude: 'Claude', codex: 'Codex', kimi: 'Kimi', glm: 'GLM', anthropic_api: 'Claude', openai_api: 'Codex',
};

/* Plans a person connects on their own machine. */
export const PLAN_PROVIDERS = ['claude', 'codex', 'kimi', 'glm'] as const;
export type PlanProvider = (typeof PLAN_PROVIDERS)[number];

/* The levels a model thinks at. The program picks the Default model itself, and one the subscription does not run runs
   on it, so they take only the levels every model that names some takes. */
export function effortsOf(models: ModelOption[], model: string): string[] {
  const found = model ? models.find(m => m.id === model) : undefined;
  if (found) return found.efforts ?? [];
  const named = models.flatMap(m => (m.efforts?.length ? [m.efforts] : []));
  return named.length ? named[0]!.filter(level => named.every(list => list.includes(level))) : [];
}

/* The level the Default runs at, when Hornhoof knows it: Kimi at the most its model takes, Claude Code's Default model,
   Opus 5.5, at medium, else the model's own. */
export function defaultEffort(provider: ProviderId, models: ModelOption[], model: string): string | null {
  if (!model && (provider === 'claude' || provider === 'anthropic_api')) return 'medium';
  if (provider !== 'kimi') return models.find(m => m.id === model)?.defaultEffort ?? null;
  const efforts = effortsOf(models, model);
  return efforts.length && !efforts.includes('max') ? efforts[efforts.length - 1]! : 'max';
}
