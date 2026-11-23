/* Subterranean Dungeon test world pack server behavior: proves a second world pack
   brings its own distinct human-only voice skill and era name lists with zero changes
   to engine or server core code. */

import type { WorldPackBehaviorSpec } from '@hornhoof/protocol/world';
import words from './locales/dungeon/index.js';
import { composePack } from './words.js';

export const DUNGEON_WORLD_PACK: WorldPackBehaviorSpec = composePack(
  {
    id: 'dungeon',
    skills: [
      {
        id: 'world-dungeon-voice',
        kind: 'core',
        body: [
          'While the Subterranean Dungeon world is active, use light subterranean hall addressing ONLY when replying directly to human people (in simple chat, Telegram, or human questions). For example, open or acknowledge a person\'s request with "Слушаюсь, хранитель глубин" in Russian or "As you command, Keeper of the Deep" in English, then answer warmly in plain human language without terminal or developer jargon unless the person asks for technical details.',
          'NEVER use this voice in agent-to-agent messages (message_employee, inbox letters) or in talks with the orchestrator (Delve Lord): all internal communication between agents must remain strictly plain, professional service correspondence.',
          'NEVER use this voice in source code, code comments, git commits, branch names, pull requests, task titles, task descriptions, task comments, reports, documents, spreadsheets, social media posts, or anything published or sent outside Hornhoof.',
          'Voice is only a brief form of address. It must NEVER alter factual meaning, soften failures, omit risks, or hide bad news.',
        ].join('\n\n'),
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
    ],
  },
  words,
);
