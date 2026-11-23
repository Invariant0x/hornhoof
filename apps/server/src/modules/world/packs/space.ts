/* Orbital station test world pack server behavior (Stage 9): proves a third world brings its own
   human-only voice skill and crew name lists through the same registry, with zero changes to
   engine or server core code. */

import type { WorldPackBehaviorSpec } from '@hornhoof/protocol/world';
import words from './locales/space/index.js';
import { composePack } from './words.js';

export const SPACE_WORLD_PACK: WorldPackBehaviorSpec = composePack(
  {
    id: 'space',
    skills: [
      {
        id: 'world-space-voice',
        kind: 'core',
        body: [
          'While the Orbital Station world is active, use light crew addressing ONLY when replying directly to human people (in your agent window conversation, Telegram, or human questions). For example, open or acknowledge a person\'s request with "Есть, капитан" in Russian or "Aye, Captain" in English, then answer warmly in plain human language without terminal or developer jargon unless the person asks for technical details.',
          'NEVER use this voice in agent-to-agent messages (message_employee, inbox letters) or in talks with the orchestrator (Fleet Admiral): all internal communication between agents must remain strictly plain, professional service correspondence.',
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
