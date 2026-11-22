/* Subterranean Dungeon test world pack server behavior: proves a second world pack
   brings its own distinct human-only voice skill and era name lists with zero changes
   to engine or server core code. */

import type { WorldPackBehaviorSpec } from '@hornhoof/protocol/world';

export const DUNGEON_WORLD_PACK: WorldPackBehaviorSpec = {
  id: 'dungeon',
  label: {
    en: 'Subterranean Dungeon',
    ru: 'Подземелье',
  },
  skills: [
    {
      id: 'world-dungeon-voice',
      kind: 'core',
      title: {
        en: 'Subterranean Dungeon voice',
        ru: 'Голос Подземелья',
      },
      description: {
        en: 'Addresses human people in the voice of the Subterranean Dungeon while keeping all internal work neutral.',
        ru: 'Обращается к людям в стиле Подземелья, оставляя всю служебную работу обычной.',
      },
      body: [
        'While the Subterranean Dungeon world is active, use light subterranean hall addressing ONLY when replying directly to human people (in simple chat, Telegram, or human questions). For example, open or acknowledge a person\'s request with "Слушаюсь, хранитель глубин" in Russian or "As you command, Keeper of the Deep" in English, then answer warmly in plain human language without terminal or developer jargon unless the person asks for technical details.',
        'NEVER use this voice in agent-to-agent messages (message_employee, inbox letters) or in talks with the orchestrator (Delve Lord): all internal communication between agents must remain strictly plain, professional service correspondence.',
        'NEVER use this voice in source code, code comments, git commits, branch names, pull requests, task titles, task descriptions, task comments, reports, documents, spreadsheets, social media posts, or anything published or sent outside Hornhoof.',
        'Voice is only a brief form of address. It must NEVER alter factual meaning, soften failures, omit risks, or hide bad news.',
      ].join('\n\n'),
      voice: {
        samples: {
          en: 'As you command, Keeper of the Deep',
          ru: 'Слушаюсь, хранитель глубин',
        },
        salutations: [
          'Слушаюсь, хранитель глубин',
          'Хранитель глубин',
          'As you command, Keeper of the Deep',
          'Keeper of the Deep',
        ],
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
      en: 'Delve Lord Borin',
      ru: 'Владыка Борин',
    },
    employees: {
      en: [
        'Thrain', 'Veyra', 'Orsik', 'Durn', 'Kaelith', 'Brimstone',
        'Rurik', 'Helga', 'Tordek', 'Nala', 'Barendd', 'Morgran',
        'Torbera', 'Flint', 'Eberk', 'Dagnal', 'Brottor', 'Vistra',
        'Delg', 'Kildrak', 'Sannl', 'Ulfgar', 'Mardred', 'Taklinn',
        'Harbek', 'Kathra', 'Rangrim', 'Eldeth', 'Baern', 'Riswynn',
        'Adrik', 'Audhild', 'Darrak', 'Falkrunn', 'Gardain', 'Gunnloda',
        'Oskar', 'Ilde', 'Traubon', 'Diesa', 'Veit', 'Liftrasa',
      ],
      ru: [
        'Траин', 'Вейра', 'Орсик', 'Дурн', 'Каэлит', 'Бримстоун',
        'Рурик', 'Хельга', 'Тордек', 'Нала', 'Баренд', 'Моргран',
        'Торбера', 'Флинт', 'Эберк', 'Дагнал', 'Броттор', 'Вистра',
        'Дельг', 'Килдрак', 'Саннл', 'Ульфгар', 'Мардред', 'Таклин',
        'Харбек', 'Катра', 'Рангрим', 'Эльдет', 'Баэрн', 'Рисвин',
        'Адрик', 'Аудхильд', 'Даррак', 'Фалькрун', 'Гардаин', 'Гуннлода',
        'Оскар', 'Ильда', 'Траубон', 'Диеса', 'Вейт', 'Лифтраса',
      ],
    },
  },
};
