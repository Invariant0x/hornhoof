import type { EchelonModel } from '@hornhoof/protocol/echelons';
/* Product assignment bands, not benchmark scores. Unclassified identities need an explicit catalog policy. */
const CAPABILITY: Readonly<Record<string, number>> = {
  'claude-haiku-5-5': 0,
  'claude-sonnet-5-5': 1,
  'claude-opus-5-5': 2,
  'claude-fable-5-1': 2,
  'gpt-6-luna': 0,
  'gpt-6-sol': 2,
  'gpt-6.1-sol': 2,
  'gpt-6.1-terra': 2,
  'gpt-6.2-sol': 2,
  'gpt-6-astra': 2,
  'gpt-6.2-astra': 2,
  'gemini-4-neon': 2,
  'gemini-4-carbon': 2,
  'gemini-4-argon': 2,
  'gemini-4-hydrogen': 1,
  'gemini-3.8-flash': 0,
  'kimi-code/k3.1-pro': 2,
};

const CLAUDE_PLAN_CAPABILITY: Readonly<Record<string, number>> = { opus: 2, fable: 2, sonnet: 1, haiku: 0 };
export const modelCapability = (model: string, provider?: string): number | null =>
  /* Grouped, so a mutant that turns one ?? into || still compiles. */
  ((provider === 'claude' ? CLAUDE_PLAN_CAPABILITY[model] : undefined) ?? CAPABILITY[model]) ?? null;
const PROVIDERS: Readonly<Record<string, string>> = { anthropic_api: 'claude', openai_api: 'codex' };
export const modelProvider = (provider: string): string => PROVIDERS[provider] ?? provider;
export type CheckerIdentity = EchelonModel;

export function reviewEligibility(producer: CheckerIdentity, checker: CheckerIdentity): string | null {
  if (producer.agentId === checker.agentId) return 'self_review';
  if (checker.capability < producer.capability) return 'weaker_model';
  return null;
}

export function sameChecker(left: CheckerIdentity, right: CheckerIdentity | null): boolean {
  return right !== null && (['agentId', 'subscriptionId', 'provider', 'model', 'capability'] as const).every(key => left[key] === right[key]);
}
