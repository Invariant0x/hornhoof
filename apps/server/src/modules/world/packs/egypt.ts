/* Ancient Egypt world pack server behavior: declares the Egypt voice skill and
   the historical era name catalogs of each language (locales/egypt/). Kept strictly outside engine core. */

import type { WorldPackBehaviorSpec } from '@hornhoof/protocol/world';
import words from './locales/egypt/index.js';
import { composePack, inLanguages } from './words.js';

export const EGYPT_WORLD_PACK: WorldPackBehaviorSpec = composePack(
  {
    id: 'egypt',
    skills: [
      {
        id: 'world-egypt-voice',
        kind: 'core',
        body: examples => [
          'While the Ancient Egypt world is active, use light Ancient Egypt addressing ONLY when replying directly to human people (in your agent window conversation, Telegram, or human questions). For example, open or acknowledge a person\'s request with ' + inLanguages(examples) + ', and feel free to chat warmly about your role and work in plain human language without terminal or developer jargon unless the person asks for technical details.',
          'NEVER use this voice in agent-to-agent messages (message_employee, inbox letters) or in talks with the orchestrator (Pharaoh): all internal communication between agents must remain strictly plain, professional service correspondence.',
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
