import { LOCALES } from '@hornhoof/protocol';
import { pickNextWorldEraName } from '@hornhoof/protocol/world';
import { describe, expect, it } from 'vitest';
import { DUNGEON_WORLD_PACK } from '../src/modules/world/packs/dungeon.js';
import { EGYPT_WORLD_PACK } from '../src/modules/world/packs/egypt.js';
import { SPACE_WORLD_PACK } from '../src/modules/world/packs/space.js';

const PACKS = [EGYPT_WORLD_PACK, SPACE_WORLD_PACK, DUNGEON_WORLD_PACK];

/* What a pack says is in a file per language next to it (locales/<pack>/<id>.ts): a language of the registry has all of it. */
describe('the words of a world pack, a file per language', () => {
  it.each(PACKS.map(pack => [pack.id, pack] as const))('%s has its name, skills, voice and crew in every language of the registry', (_id, pack) => {
    for (const { id: language } of LOCALES) {
      expect(pack.label[language]?.trim(), `${pack.id} label ${language}`).toBeTruthy();
      for (const skill of pack.skills) {
        expect(skill.title[language]?.trim(), `${skill.id} title ${language}`).toBeTruthy();
        expect(skill.description[language]?.trim(), `${skill.id} description ${language}`).toBeTruthy();
        expect(skill.voice?.samples[language]?.trim(), `${skill.id} sample ${language}`).toBeTruthy();
      }
      expect(pack.names.ruler[language]?.trim(), `${pack.id} ruler ${language}`).toBeTruthy();
      expect(pack.names.employees[language]?.length, `${pack.id} crew ${language}`).toBe(pack.names.employees.en.length);
    }
  });

  it('read the voice of every language as one list of words a person may be answered with', () => {
    const voice = EGYPT_WORLD_PACK.skills[0]!.voice!;
    expect(voice.salutations).toEqual(expect.arrayContaining(['Yes, my lord', 'Да, повелитель']));
    expect(new Set(voice.salutations).size).toBe(voice.salutations.length);
  });

  it('name an employee from the crew of the language, and from English where a language has none', () => {
    expect(EGYPT_WORLD_PACK.names.employees.ru).toContain(pickNextWorldEraName(EGYPT_WORLD_PACK, 'ru', [], 'worker'));
    const english = { ...EGYPT_WORLD_PACK, names: { ...EGYPT_WORLD_PACK.names, employees: { en: EGYPT_WORLD_PACK.names.employees.en } } };
    expect(EGYPT_WORLD_PACK.names.employees.en).toContain(pickNextWorldEraName(english, 'ru', [], 'worker'));
  });
});
