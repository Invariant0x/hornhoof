import { join } from 'node:path';
import type { ProviderId } from '@hornhoof/protocol';
import type { AgentFs } from './agent-fs.js';
import { excludeInRepo } from './skills.js';

/* Where a program works when its turn belongs to a task: in the task's worktree T, a repository's folder right inside the
   task's context folder C. The worktree belongs to the repository, so what Hornhoof tells a program stays out of its git
   status and off every file it tracks. What each program reads comes from its maker's documents; only a live check of the
   program itself can show it does so. */
export type ProgramKind = 'claude' | 'codex' | 'kimi' | 'antigravity';
export type FolderInput = { workDir: string; programDir?: string };

export const programDirOf = ({ workDir, programDir }: FolderInput): string => programDir ?? workDir;

/* The programs a live check showed going on with a session from another folder. None has had that check, so each starts anew:
   a session is not carried on a guess. A check of a program adds it here, with what its session needs moved. */
export const CARRIES: ReadonlySet<ProviderId> = new Set();

export const carrySession = (provider: ProviderId, carries: ReadonlySet<ProviderId> = CARRIES): 'carried' | 'fresh' => (carries.has(provider) ? 'carried' : 'fresh');

const kindOf = (provider: ProviderId): ProgramKind => {
  if (provider === 'codex' || provider === 'openai_api') return 'codex';
  if (provider === 'kimi' || provider === 'antigravity') return provider;
  return 'claude';
};

/* Codex reads AGENTS.md from its project's root down to where it works, one file a folder, and takes what its markers name as
   that root (project_root_markers). With this mark C is the root: it reads Hornhoof's words in C and the repository's in T. */
export const CONTEXT_ROOT = '.hh-context-root';
export const codexRootFlags = (bound: boolean): string[] => (bound ? ['-c', `project_root_markers=["${CONTEXT_ROOT}"]`] : []);

const AGY_RULE = '.agents/rules/hornhoof.md';
/* A rules file of agy counts only with a trigger at its start. */
const AGY_ALWAYS = '---\ntrigger: always_on\n---\n\n';
const KIMI_TOLD = '.kimi-code/AGENTS.md';

/* What each program needs inside the worktree, as it reads these only from there: Kimi Code its project's instructions and
   tools, Antigravity its workspace's rules, tools and hooks. Claude Code and Codex need nothing there. */
const TREE_FILES: Record<ProgramKind, string[]> = {
  claude: [],
  codex: [],
  kimi: [KIMI_TOLD, '.kimi-code/mcp.json'],
  antigravity: [AGY_RULE, '.agents/mcp_config.json', '.agents/hooks.json'],
};
export const treeFiles = (provider: ProviderId): string[] => TREE_FILES[kindOf(provider)];

/* The file a program's standing words go in, and what comes before them there. */
export function toldPlace(kind: ProgramKind, { workDir, programDir }: FolderInput): { file: string; head: string } {
  if (kind === 'claude') return { file: join(workDir, '.hh-instructions.md'), head: '' };
  if (programDir && kind === 'kimi') return { file: join(programDir, KIMI_TOLD), head: '' };
  if (programDir && kind === 'antigravity') return { file: join(programDir, AGY_RULE), head: AGY_ALWAYS };
  return { file: join(workDir, 'AGENTS.md'), head: '' };
}

/* What Hornhoof placed in this worktree, kept in C. The agent can write it too, so it says only what may be written over
   again, under the agent's own user, and never what may go. */
const TREE_LIST = '.hh-tree-files.json';

async function placedInTree(fs: AgentFs, contextDir: string): Promise<string[]> {
  try {
    const list: unknown = JSON.parse((await fs.read(join(contextDir, TREE_LIST))) ?? '[]');
    return Array.isArray(list) ? list.filter((path): path is string => typeof path === 'string') : [];
  } catch {
    return [];
  }
}

/* Whether anything already stands where Hornhoof must write: a file the repository tracks, or the agent's own. */
async function inTheWay(fs: AgentFs, programDir: string, paths: string[], placed: string[]): Promise<string[]> {
  const taken = await Promise.all(paths.map(async path => (!placed.includes(path) && (await fs.kind(join(programDir, path))) ? [path] : [])));
  return taken.flat();
}

/* Gets a task's folders ready for a program, before anything is written there. It does not start where it would write over
   something, or where a missing worktree would make it work in another folder without a word. */
export async function readyProgramFolder(fs: AgentFs, provider: ProviderId, contextDir: string, programDir: string, skillPaths: string[]): Promise<void> {
  if ((await fs.kind(programDir)) !== 'dir') throw new Error("The task's folder is not there, so its program did not start.");
  const files = treeFiles(provider);
  const placed = await placedInTree(fs, contextDir);
  const paths = [...files, ...skillPaths];
  const taken = await inTheWay(fs, programDir, paths, placed);
  if (taken.length) throw new Error(`The program did not start: Hornhoof must write ${taken.join(', ')} in the task's folder, and something else is there.`);
  await fs.write(join(contextDir, TREE_LIST), JSON.stringify([...new Set([...placed, ...paths])]));
  if (files.length) await excludeInRepo(fs, programDir, files, 'program files');
  if (kindOf(provider) === 'codex') await fs.write(join(contextDir, CONTEXT_ROOT), '');
}

const CATCH_UP_MOST = 8000;

/* What a session that starts anew in a task's folder says to people, and what it knows from before. */
export function freshStart(catchUp: string | null | undefined): { note: string; context: string } {
  const known = catchUp ? (catchUp.length > CATCH_UP_MOST ? `${catchUp.slice(0, CATCH_UP_MOST - 1)}…` : catchUp) : null;
  const said = known ? `It has a short catch-up of ${known.length} characters on the task.` : 'No catch-up came with it.';
  return {
    note: `Hornhoof started a new session in this task's folder, as this program's session is not proven to go on there. The old session stays as it was. ${said}`,
    context: [`You work in a new session in this task's folder. Your earlier session stays as it was, and you do not have it here.`, known].filter(Boolean).join('\n\n'),
  };
}
