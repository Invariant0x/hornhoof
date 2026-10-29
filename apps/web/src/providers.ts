import type { ProviderId } from './types';

/* Product names stay as they are in every language. */
export const PROVIDER_NAMES: Record<ProviderId, string> = {
  claude: 'Claude', codex: 'Codex', kimi: 'Kimi', glm: 'GLM', anthropic_api: 'Anthropic', openai_api: 'OpenAI',
};

/* Plans a person connects on their own machine. */
export const PLAN_PROVIDERS = ['claude', 'codex', 'kimi', 'glm'] as const;
export type PlanProvider = (typeof PLAN_PROVIDERS)[number];
