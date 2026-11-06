import { join } from 'node:path';
import type { ProviderId } from '@hornhoof/protocol';
import type { AgentFs } from './agent-fs.js';

/* A skeleton for the failing tests of #573: every program as it is without a task's folder. */
export type ProgramKind = 'claude' | 'codex' | 'kimi' | 'antigravity';
export type FolderInput = { workDir: string; programDir?: string };
export const CONTEXT_ROOT = '.hh-context-root';
export const programDirOf = ({ workDir }: FolderInput): string => workDir;
export const carrySession = (provider: ProviderId, carries: ReadonlySet<ProviderId> = new Set()): 'carried' | 'fresh' => (carries.has(provider) ? 'fresh' : 'fresh');
export const codexRootFlags = (bound: boolean): string[] => (bound ? [] : []);
export const toldPlace = (kind: ProgramKind, { workDir }: FolderInput): { file: string; head: string } => ({ file: join(workDir, kind === 'claude' ? '.hh-instructions.md' : 'AGENTS.md'), head: '' });
export const treeFiles = (provider: ProviderId): string[] => (provider ? [] : []);
export const readyProgramFolder = async (fs: AgentFs, provider: ProviderId, contextDir: string, programDir: string, skillPaths: string[]): Promise<void> => {
  void [fs, provider, contextDir, programDir, skillPaths];
};
export const freshStart = (catchUp: string | null | undefined): { note: string; context: string } => ({ note: '', context: catchUp ?? '' });
