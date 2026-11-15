/* The programs and APIs a node can run. In its own file so a schema that names a provider need not import the index,
   which loads that schema first. */
export const PROVIDER_IDS = ['claude', 'codex', 'kimi', 'glm', 'anthropic_api', 'openai_api', 'antigravity', 'openrouter', 'custom_api'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/* The connections a company pays for by the token, with a key: the Claude API, the OpenAI API, OpenRouter, and any API
   that speaks one of their protocols at an address the company names. */
export const API_PROVIDERS = ['anthropic_api', 'openai_api', 'openrouter', 'custom_api'] as const satisfies readonly ProviderId[];
export type ApiProvider = (typeof API_PROVIDERS)[number];
export const isApiProvider = (provider: string): provider is ApiProvider => (API_PROVIDERS as readonly string[]).includes(provider);

/* The protocol an API speaks: Anthropic's Messages, which Claude Code runs on, or OpenAI's, which Codex runs on. */
export const API_PROTOCOLS = ['anthropic', 'openai'] as const;
export type ApiProtocol = (typeof API_PROTOCOLS)[number];
export type ApiEndpoint = { baseUrl: string; protocol: ApiProtocol };

const OPENROUTER: Record<ApiProtocol, string> = { anthropic: 'https://openrouter.ai/api', openai: 'https://openrouter.ai/api/v1' };

/* Where an API connection's program sends its calls and in which protocol. The Claude and OpenAI APIs have their own;
   OpenRouter speaks both, Anthropic's unless the connection says otherwise; any other API needs both said. Null for a
   plan, or a compatible API that lacks one of them. */
export function apiEndpoint(provider: ProviderId, own: { baseUrl?: string | null; protocol?: ApiProtocol | null }): ApiEndpoint | null {
  switch (provider) {
    case 'anthropic_api':
      return { baseUrl: 'https://api.anthropic.com', protocol: 'anthropic' };
    case 'openai_api':
      return { baseUrl: 'https://api.openai.com/v1', protocol: 'openai' };
    case 'openrouter': {
      const protocol = own.protocol ?? 'anthropic';
      return { baseUrl: OPENROUTER[protocol], protocol };
    }
    case 'custom_api':
      return own.baseUrl && own.protocol ? { baseUrl: own.baseUrl.replace(/\/+$/, ''), protocol: own.protocol } : null;
    case 'claude':
    case 'codex':
    case 'kimi':
    case 'glm':
    case 'antigravity':
      return null;
  }
}
