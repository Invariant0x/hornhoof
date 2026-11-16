import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { SubView } from '../src/types';
import { shortName, subName } from '../src/ui/subscription';

const plan = (provider: SubView['provider'], tier: string | null) => ({ kind: 'personal', provider, label: provider, last4: null, tier }) as SubView;
const key = (provider: SubView['provider'], label: string, last4: string) => ({ kind: 'api_key', provider, label, last4, tier: null }) as SubView;

/* The name the list and a card show by the sign of how a connection is paid: one short line, in every language. */
describe('shortName', () => {
  it.each([
    ['claude', 'max', 'Claude Max'],
    ['codex', 'pro', 'Codex Pro'],
    ['codex', 'Plus', 'Codex Plus'],
    ['kimi', null, 'Kimi'],
    ['glm', '', 'GLM'],
  ] as const)('names a %s plan on tier %j as %s, its tier with a capital as the machine tells it in small letters', (provider, tier, name) => {
    for (const t of [en, ru]) expect(shortName(t, plan(provider, tier))).toBe(name);
  });

  it('names a key by its provider, or the name a compatible API was given, and how the key ends', () => {
    for (const t of [en, ru]) {
      expect(shortName(t, key('openrouter', 'OpenRouter', 'WXYZ'))).toBe('OpenRouter ••••WXYZ');
      expect(shortName(t, key('custom_api', 'Acme LLM', 'M3N4'))).toBe('Acme LLM ••••M3N4');
    }
  });

  it('keeps the full name in words for what reads the page aloud', () => {
    expect(subName(en, key('openrouter', 'OpenRouter', 'WXYZ'))).toBe('OpenRouter key ending WXYZ');
    expect(subName(ru, key('custom_api', 'Acme LLM', 'M3N4'))).toBe('Ключ Acme LLM, заканчивается на M3N4');
    expect(subName(en, plan('claude', 'max'))).toBe('Claude');
  });
});
