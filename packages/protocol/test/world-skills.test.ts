/* Stage 7 protocol tests: theme-agnostic world pack skills, voice channel boundaries,
   validation and voice-leakage detection without any hardcoded theme names in engine core. */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPANY_THEME,
  STANDARD_COMPANY_THEMES,
  WORLD_VOICE_CHANNELS,
  WORLD_VOICE_FORBIDDEN_CHANNELS,
  WorldThemeUpdateSchema,
  containsWorldVoicePhrase,
  isWorldVoiceAllowed,
  validateWorldPackBehavior,
  type WorldPackBehaviorSpec,
} from '../src/world.js';

const SAMPLE_PACK: WorldPackBehaviorSpec = {
  id: 'orbital-station',
  label: { en: 'Orbital Station', ru: 'Орбитальная станция' },
  skills: [
    {
      id: 'world-orbital-voice',
      kind: 'core',
      title: { en: 'Orbital voice', ru: 'Голос станции' },
      description: {
        en: 'Addresses humans as Commander in direct chat only.',
        ru: 'Обращается к людям как к командиру только в прямом разговоре.',
      },
      body: [
        'Use light station addressing ("Yes, Commander" / "Так точно, командир") ONLY when replying directly to a human person in chat, Telegram, or human questions.',
        'NEVER use this voice in agent-to-agent messages, inbox letters, or talks with the orchestrator: internal agent communication stays strictly neutral and service-only.',
        'NEVER use this voice in code, comments, git commits, task texts, documents, spreadsheets, posts, or any external output.',
        'Voice never alters meaning, never softens errors, and never hides bad news.',
      ].join('\n'),
      voice: {
        samples: { en: 'Yes, Commander', ru: 'Так точно, командир' },
        salutations: ['Yes, Commander', 'Commander', 'Так точно, командир'],
        channels: {
          humanChat: true,
          agentToAgent: false,
          orchestrator: false,
          tasks: false,
          commits: false,
          code: false,
          documents: false,
          externalPosts: false,
          preservesMeaningAndBadNews: true,
        },
      },
    },
  ],
  names: {
    ruler: { en: 'Flight Director Vega', ru: 'Директор Вега' },
    employees: {
      en: ['Astra', 'Orion', 'Lyra'],
      ru: ['Астра', 'Орион', 'Лира'],
    },
  },
};

describe('Stage 7 world pack skills and voice boundary contract', () => {
  it('defines theme-free standard company themes with cyberpunk as default', () => {
    expect(DEFAULT_COMPANY_THEME).toBe('cyberpunk');
    expect(STANDARD_COMPANY_THEMES).toEqual(['cyberpunk', 'light', 'matrix', 'pixel']);
  });

  it('allows world voice strictly in human_chat and forbids all internal and external work channels', () => {
    expect(isWorldVoiceAllowed('human_chat')).toBe(true);
    expect(WORLD_VOICE_FORBIDDEN_CHANNELS).toEqual([
      'agent_to_agent',
      'orchestrator',
      'task',
      'commit',
      'code',
      'document',
      'external_post',
    ]);
    for (const channel of WORLD_VOICE_FORBIDDEN_CHANNELS) {
      expect(isWorldVoiceAllowed(channel), channel).toBe(false);
    }
    expect(WORLD_VOICE_CHANNELS).toEqual(['human_chat', ...WORLD_VOICE_FORBIDDEN_CHANNELS]);
  });

  it('validates a well-formed world pack behavior spec and rejects missing voice rules or empty names', () => {
    expect(validateWorldPackBehavior(SAMPLE_PACK)).toEqual([]);

    const missingVoice: WorldPackBehaviorSpec = { ...SAMPLE_PACK, skills: [] };
    expect(validateWorldPackBehavior(missingVoice).length).toBeGreaterThan(0);

    const missingNames: WorldPackBehaviorSpec = {
      ...SAMPLE_PACK,
      names: { ruler: { en: 'Dir', ru: 'Дир' }, employees: { en: [], ru: ['Астра'] } },
    };
    expect(validateWorldPackBehavior(missingNames).length).toBeGreaterThan(0);
  });

  it('detects pack voice salutations in text using only the pack definition', () => {
    expect(containsWorldVoicePhrase('Так точно, командир, сборка готова.', SAMPLE_PACK)).toBe(true);
    expect(containsWorldVoicePhrase('Yes, commander, tests passed.', SAMPLE_PACK)).toBe(true);
    expect(containsWorldVoicePhrase('fix(world): update theme endpoint', SAMPLE_PACK)).toBe(false);
    expect(containsWorldVoicePhrase('Task #12 ready for review with passing logs.', SAMPLE_PACK)).toBe(false);
  });

  it('validates company theme update payloads strictly', () => {
    expect(WorldThemeUpdateSchema.parse({ theme: 'cyberpunk' })).toEqual({ theme: 'cyberpunk' });
    expect(WorldThemeUpdateSchema.parse({ theme: 'orbital-station' })).toEqual({ theme: 'orbital-station' });
    expect(() => WorldThemeUpdateSchema.parse({ theme: '' })).toThrow();
    expect(() => WorldThemeUpdateSchema.parse({ theme: '../etc' })).toThrow();
    expect(() => WorldThemeUpdateSchema.parse({ theme: 'cyberpunk', extra: true })).toThrow();
  });
});
