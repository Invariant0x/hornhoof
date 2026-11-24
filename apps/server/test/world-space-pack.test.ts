/* Stage 9 second test pack on the server: the orbital station brings its own human-only voice and
   era names through the same registry, with no change to server core code. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { containsWorldVoicePhrase, validateWorldPackBehavior } from '@hornhoof/protocol/world';
import { describe, expect, it } from 'vitest';
import { createWorldPackRegistry, worldSkillsForTheme } from '../src/modules/world/packs/index.js';
import { DUNGEON_WORLD_PACK } from '../src/modules/world/packs/dungeon.js';
import { EGYPT_WORLD_PACK } from '../src/modules/world/packs/egypt.js';
import { SPACE_WORLD_PACK } from '../src/modules/world/packs/space.js';

describe('Stage 9 space station test pack (server)', () => {
  it('validates, keeps its voice to people only and differs from the other packs', () => {
    expect(validateWorldPackBehavior(SPACE_WORLD_PACK)).toEqual([]);
    const voice = SPACE_WORLD_PACK.skills[0]!.voice!;
    expect(voice.samples).toEqual({ en: 'Aye, Captain', ru: 'Есть, капитан' });
    expect(voice.channels).toEqual({
      humanChat: true,
      agentToAgent: false,
      orchestrator: false,
      tasks: false,
      commits: false,
      code: false,
      documents: false,
      externalPosts: false,
      preservesMeaningAndBadNews: true,
    });
    for (const other of [EGYPT_WORLD_PACK, DUNGEON_WORLD_PACK]) {
      expect(SPACE_WORLD_PACK.id).not.toBe(other.id);
      expect(SPACE_WORLD_PACK.skills[0]!.id).not.toBe(other.skills[0]!.id);
      expect(voice.samples.ru).not.toBe(other.skills[0]!.voice!.samples.ru);
    }
    expect(containsWorldVoicePhrase('Есть, капитан, отчет готов', SPACE_WORLD_PACK)).toBe(true);
    expect(containsWorldVoicePhrase('Отчет готов', SPACE_WORLD_PACK)).toBe(false);
  });

  it('gives enough distinct crew names in both languages and a ruler name', () => {
    for (const lang of ['en', 'ru'] as const) {
      const names = SPACE_WORLD_PACK.names.employees[lang];
      expect(names.length).toBeGreaterThanOrEqual(30);
      expect(new Set(names.map(n => n.toLowerCase())).size).toBe(names.length);
      expect(SPACE_WORLD_PACK.names.ruler[lang].trim()).not.toBe('');
    }
  });

  it('plugs into the same registry and gives its skills only while it is the company theme', () => {
    const packs = createWorldPackRegistry([EGYPT_WORLD_PACK, SPACE_WORLD_PACK]);
    expect(worldSkillsForTheme(packs, 'space').map(s => s.id)).toEqual(['world-space-voice']);
    expect(worldSkillsForTheme(packs, 'egypt').map(s => s.id)).toEqual(['world-egypt-voice']);
    expect(worldSkillsForTheme(packs, 'cyberpunk')).toEqual([]);
    for (const file of ['../../packages/protocol/src/world.ts', 'src/modules/agents/instructions.ts', 'src/modules/world/routes.ts']) {
      const body = readFileSync(join(process.cwd(), file), 'utf8');
      expect(body, file).not.toMatch(/\b(captain|admiral)\b|капитан/i);
    }
  });
});
