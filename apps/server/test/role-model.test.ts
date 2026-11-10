import { describe, expect, it } from 'vitest';
import { modelForTier } from '../src/modules/agents/role-model.js';

const plan = (...ids: string[]) => ids.map(id => ({ id, name: id }));
const CLAUDE = plan('fable', 'opus', 'sonnet', 'haiku');

describe('the model a role of a tier runs on a plan', () => {
  it('takes the strongest for the top tier, the next for deep, the middle one for standard and the lightest for fast', () => {
    expect(['top', 'deep', 'standard', 'fast'].map(tier => modelForTier(tier as 'top', 'claude', CLAUDE))).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
  });

  it('keeps the costliest model for the top tier alone, whatever order the plan lists its models in', () => {
    expect(modelForTier('deep', 'claude', plan('fable', 'opus'))).toBe('opus');
    expect(modelForTier('top', 'claude', plan('opus', 'fable'))).toBe('fable');
    expect(modelForTier('deep', 'anthropic_api', plan('claude-fable-5-1', 'claude-opus-5-5'))).toBe('claude-opus-5-5');
    expect(modelForTier('deep', 'claude', plan('fable'))).toBe('fable');
  });

  it('takes the nearest stronger model when the plan has none of the tier, and the nearest weaker when it has none stronger', () => {
    expect(modelForTier('standard', 'claude', plan('opus', 'haiku'))).toBe('opus');
    expect(modelForTier('fast', 'kimi', plan('kimi-code/k3.1-pro'))).toBe('kimi-code/k3.1-pro');
    expect(modelForTier('standard', 'codex', plan('gpt-6.1-sol', 'gpt-6-luna'))).toBe('gpt-6.1-sol');
    expect(modelForTier('fast', 'codex', plan('gpt-6.1-sol', 'gpt-6-luna'))).toBe('gpt-6-luna');
    expect(modelForTier('top', 'claude', plan('sonnet', 'haiku'))).toBe('sonnet');
  });

  it('names no model when the plan runs none Hornhoof knows the strength of', () => {
    expect(modelForTier('deep', 'glm', plan('glm-new'))).toBeNull();
    expect(modelForTier('deep', 'claude', [])).toBeNull();
  });
});
