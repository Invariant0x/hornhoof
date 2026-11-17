import { describe, expect, it } from 'vitest';
import { modelCapability, modelProvider, reviewEligibility, sameChecker } from '../src/modules/tasks/echelons-policy.js';

const author = { agentId: '00000000-0000-4000-8000-000000000001', subscriptionId: '00000000-0000-4000-8000-000000000002',
  provider: 'claude', model: 'claude-opus-5-5', capability: 2 };
const reviewer = { ...author, agentId: '00000000-0000-4000-8000-000000000003' };

describe('pure checker policy', () => {
  it('keeps an unknown model unclassified instead of assuming a capable checker', () => {
    expect(modelCapability('unclassified-model')).toBeNull();
    expect(modelCapability('claude-haiku-5-5')).toBe(0);
    expect(modelCapability('claude-opus-5-5')).toBe(2);
  });

  it('recognizes API and subscription providers as the same vendor', () => {
    expect(modelProvider('anthropic_api')).toBe('claude');
    expect(modelProvider('openai_api')).toBe('codex');
    expect(modelProvider('kimi')).toBe('kimi');
  });

  it.each([['opus', 2], ['fable', 2], ['sonnet', 1], ['haiku', 0]] as const)('classifies the trusted Claude Code alias %s', (model, capability) => {
    expect(modelCapability(model, 'claude')).toBe(capability);
    expect(modelCapability(model, 'codex')).toBeNull();
    expect(modelCapability(model, 'anthropic_api')).toBeNull();
  });

  it.each([['gemini-4-argon', 'antigravity'], ['kimi-code/k3.1-pro', 'kimi'], ['gpt-6.2-sol', 'codex'], ['gpt-6.2-astra', 'codex']] as const)('puts the flagship %s in the strong band', (model, provider) => {
    expect(modelCapability(model, provider)).toBe(2);
  });

  it('does not classify Claude Default or an unknown alias from a catalog comment', () => {
    expect(modelCapability('', 'claude')).toBeNull();
    expect(modelCapability('default', 'claude')).toBeNull();
    expect(modelCapability('unknown', 'claude')).toBeNull();
  });

  it('refuses self review even on a different subscription and provider', () => {
    expect(reviewEligibility(author, { ...author, subscriptionId: reviewer.agentId, provider: 'codex' })).toBe('self_review');
  });

  it('allows another checker on the same subscription at equal capability', () => {
    expect(reviewEligibility(author, reviewer)).toBeNull();
  });

  it('allows a stronger checker and refuses a weaker checker regardless of provider', () => {
    expect(reviewEligibility({ ...author, capability: 1 }, reviewer)).toBeNull();
    expect(reviewEligibility(author, { ...reviewer, provider: 'codex', capability: 1 })).toBe('weaker_model');
  });

  it.each([
    { agentId: author.agentId }, { subscriptionId: author.agentId }, { provider: 'codex' }, { model: 'gpt-6.1-sol' }, { capability: 1 },
  ])('refuses a changed assigned identity: %j', changed => {
    expect(sameChecker(reviewer, { ...reviewer, ...changed })).toBe(false);
  });

  it('accepts the exact recorded identity and refuses a missing identity', () => {
    expect(sameChecker(reviewer, { ...reviewer })).toBe(true);
    expect(sameChecker(reviewer, null)).toBe(false);
  });
});
