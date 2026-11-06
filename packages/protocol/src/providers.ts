/* The programs and APIs a node can run. In its own file so a schema that names a provider need not import the index,
   which loads that schema first. */
export const PROVIDER_IDS = ['claude', 'codex', 'kimi', 'glm', 'anthropic_api', 'openai_api', 'antigravity'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
