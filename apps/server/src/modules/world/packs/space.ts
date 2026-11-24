/* Orbital station test world pack server behavior (Stage 9): proves a third world brings its own
   human-only voice skill and crew name lists through the same registry, with zero changes to
   engine or server core code. */

import type { WorldPackBehaviorSpec } from '@hornhoof/protocol/world';

export const SPACE_WORLD_PACK: WorldPackBehaviorSpec = {
  id: 'space',
  label: {
    en: 'Orbital Station',
    ru: 'Орбитальная станция',
  },
  skills: [
    {
      id: 'world-space-voice',
      kind: 'core',
      title: {
        en: 'Orbital Station voice',
        ru: 'Голос Орбитальной станции',
      },
      description: {
        en: 'Addresses human people in the voice of an orbital station crew while keeping all internal work neutral.',
        ru: 'Обращается к людям как экипаж орбитальной станции, оставляя всю служебную работу обычной.',
      },
      body: [
        'While the Orbital Station world is active, use light crew addressing ONLY when replying directly to human people (in your agent window conversation, Telegram, or human questions). For example, open or acknowledge a person\'s request with "Есть, капитан" in Russian or "Aye, Captain" in English, then answer warmly in plain human language without terminal or developer jargon unless the person asks for technical details.',
        'NEVER use this voice in agent-to-agent messages (message_employee, inbox letters) or in talks with the orchestrator (Fleet Admiral): all internal communication between agents must remain strictly plain, professional service correspondence.',
        'NEVER use this voice in source code, code comments, git commits, branch names, pull requests, task titles, task descriptions, task comments, reports, documents, spreadsheets, social media posts, or anything published or sent outside Hornhoof.',
        'Voice is only a brief form of address. It must NEVER alter factual meaning, soften failures, omit risks, or hide bad news.',
      ].join('\n\n'),
      voice: {
        samples: {
          en: 'Aye, Captain',
          ru: 'Есть, капитан',
        },
        salutations: ['Есть, капитан', 'Так точно, капитан', 'Aye, Captain', 'Aye aye, Captain'],
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
    ruler: {
      en: 'Fleet Admiral Vega',
      ru: 'Адмирал Вега',
    },
    employees: {
      en: [
        'Orion', 'Lyra', 'Altair', 'Nova', 'Rigel', 'Cassia',
        'Deneb', 'Mira', 'Atlas', 'Electra', 'Castor', 'Pollux',
        'Sirius', 'Capella', 'Antares', 'Bellatrix', 'Elara', 'Kepler',
        'Halley', 'Leda', 'Phoebe', 'Titania', 'Oberon', 'Rhea',
        'Hyperion', 'Cosmo', 'Selene', 'Talos', 'Zenith', 'Aurora',
        'Ceres', 'Draco', 'Io', 'Nadir', 'Quasar', 'Vesta',
      ],
      ru: [
        'Орион', 'Лира', 'Альтаир', 'Нова', 'Ригель', 'Кассия',
        'Денеб', 'Мира', 'Атлас', 'Электра', 'Кастор', 'Поллукс',
        'Сириус', 'Капелла', 'Антарес', 'Беллатрикс', 'Элара', 'Кеплер',
        'Галлей', 'Леда', 'Феба', 'Титания', 'Оберон', 'Рея',
        'Гиперион', 'Космо', 'Селена', 'Талос', 'Зенит', 'Аврора',
        'Церера', 'Драко', 'Ио', 'Надир', 'Квазар', 'Веста',
      ],
    },
  },
};
