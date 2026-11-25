import { LOCALES, localeInfo, SOURCE_LOCALE, type Texts } from '@hornhoof/protocol';
import type { WorldPackBehaviorSpec, WorldSkillChannelPolicy, WorldSkillKind } from '@hornhoof/protocol/world';

/* What a world pack says in one language, in a file named by the language's id under locales/<pack>/: its name, what its
   skills are called and the words its voice takes, and the names of its crew. A pack's other parts, its ids, the rules a
   skill gives an agent and the channels its voice may use, stay in the pack's own file and in English. */
export type PackWords = {
  label: string;
  skills: Readonly<Record<string, { title: string; description: string; voice?: { sample: string; salutations: readonly string[]; example?: string } }>>;
  ruler: string;
  employees: readonly string[];
};

/* What a voice says in one language, to show an agent how to address a person: the language's name in English, the short
   form of address, and a longer sentence that begins with it where the pack has one. */
export type VoiceExample = Readonly<{ language: string; name: string; sample: string; example?: string }>;

/* The examples as a phrase of the rule an agent is given: "Yes, my lord" ("Yes, my lord, ...") in English or ... in Russian. */
export const inLanguages = (examples: readonly VoiceExample[]): string =>
  examples.map(own => `"${own.sample}"${own.example ? ` ("${own.example}")` : ''} in ${own.name}`).join(' or ');

/* A pack without its words: what a pack is, whatever language it is read in. The rule a voice skill gives an agent is
   English, with the examples of each language's words put into it. */
export type PackBase = Readonly<{
  id: string;
  skills: readonly Readonly<{ id: string; kind: WorldSkillKind; body: string | ((examples: readonly VoiceExample[]) => string); channels?: WorldSkillChannelPolicy }>[];
}>;

/* Every language of the registry that has a file for the pack, which `load` brings by the language's id; English must have
   one. A pack's file names its own folder in `load`, as ./locales/<pack>/<id>.js. */
export async function packWords(pack: string, load: (language: string) => Promise<{ default: PackWords }>): Promise<Record<string, PackWords>> {
  const words: Record<string, PackWords> = {};
  for (const { id } of LOCALES) {
    try {
      words[id] = (await load(id)).default;
    } catch (error) {
      if (id === SOURCE_LOCALE) throw new Error(`The world pack ${pack} has no words in ${SOURCE_LOCALE}.`, { cause: error });
      console.warn(`The world pack ${pack} has no words in ${id} yet and reads in English.`, error);
    }
  }
  return words;
}

const texts = (of: (words: PackWords) => string | undefined, words: Record<string, PackWords>): Texts => {
  const out: Texts = { en: of(words[SOURCE_LOCALE]!) ?? '' };
  for (const [id, own] of Object.entries(words)) {
    const text = of(own);
    if (id !== SOURCE_LOCALE && text !== undefined) out[id] = text;
  }
  return out;
};

const voiceExamples = (skill: string, words: Record<string, PackWords>): VoiceExample[] =>
  LOCALES.flatMap(({ id }) => {
    const voice = words[id]?.skills[skill]?.voice;
    return voice ? [{ language: id, name: localeInfo(id)!.english, sample: voice.sample, ...(voice.example ? { example: voice.example } : {}) }] : [];
  });

/* The pack as the server and its validators read it: a name in each language, its skills with theirs, and the crew's
   names by language. The words a voice takes in every language make one list, as a person may write in any of them. */
export function composePack(base: PackBase, words: Record<string, PackWords>): WorldPackBehaviorSpec {
  const employees: { en: readonly string[] } & Record<string, readonly string[] | undefined> = { en: words[SOURCE_LOCALE]!.employees };
  for (const [id, own] of Object.entries(words)) if (id !== SOURCE_LOCALE) employees[id] = own.employees;
  return {
    id: base.id,
    label: texts(own => own.label, words),
    skills: base.skills.map(skill => ({
      id: skill.id,
      kind: skill.kind,
      title: texts(own => own.skills[skill.id]?.title, words),
      description: texts(own => own.skills[skill.id]?.description, words),
      body: typeof skill.body === 'string' ? skill.body : skill.body(voiceExamples(skill.id, words)),
      ...(skill.channels
        ? {
            voice: {
              samples: texts(own => own.skills[skill.id]?.voice?.sample, words),
              salutations: [...new Set(Object.values(words).flatMap(own => own.skills[skill.id]?.voice?.salutations ?? []))],
              channels: skill.channels,
            },
          }
        : {}),
    })),
    names: { ruler: texts(own => own.ruler, words), employees },
  };
}
