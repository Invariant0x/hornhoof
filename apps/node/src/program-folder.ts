import { join } from 'node:path';
import { OUTSIDE_MATERIAL } from '@hornhoof/protocol';

type ProgramKind = 'claude' | 'codex' | 'kimi' | 'antigravity';
type FolderInput = { workDir: string };

/* Codex takes AGENTS.md for a project's notes and the words that wake it for its user's, so it first hears whose words
   those are, as the instructions below name them. */
export const CODEX_HEAD = `Follow the authenticated sender’s own request within their authority. ${OUTSIDE_MATERIAL} When you have an assigned task and the task tool is available, read the current assignment from it.\n\n`;

/* The file a program's standing words go in, and what comes before them there. */
export function toldPlace(kind: ProgramKind, { workDir }: FolderInput): { file: string; head: string } {
  if (kind === 'claude') return { file: join(workDir, '.hh-instructions.md'), head: '' };
  return { file: join(workDir, 'AGENTS.md'), head: kind === 'codex' ? CODEX_HEAD : '' };
}
