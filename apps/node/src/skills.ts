import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ProviderId, SkillFile } from '@hornhoof/protocol';
import type { AgentFs } from './agent-fs.js';

const CLAUDE: ReadonlySet<ProviderId> = new Set(['claude', 'anthropic_api', 'glm']);

/* Where a program finds a project's skills: Claude Code in .claude/skills, Codex, Kimi Code and Antigravity in
   .agents/skills. Each agent's folder is its project, so it sees only its own. */
export const skillsFolder = (provider: ProviderId): string => (CLAUDE.has(provider) ? '.claude/skills' : '.agents/skills');

/* What the node put in the agent's folder last time, so what it no longer gives goes and the agent's own stays. */
const PLACED = '.hh-skills.json';
type Placed = { paths: string[] };

/* A string in double quotes is YAML too, whatever the description says. */
const skillText = (s: SkillFile) => `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${s.body}\n`;

/* The exclude file of the repository the agent's folder is part of, the nearest .git above it as programs find a
   project's root, where the folder is in it, and the git folder of its checkout. A worktree's .git is a file that names
   its git folder, and that one the common folder whose excludes git reads for every worktree. All of it is read as the
   agent's user, as the agent may have left links there; a .git file that names no git folder is no repository. */
async function repoOf(fs: AgentFs, workDir: string): Promise<{ exclude: string; at: string; gitDir: string } | null> {
  for (let dir = workDir; ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git');
    const kind = await fs.kind(dotGit);
    if (kind) {
      const named = kind === 'file' ? /^gitdir: (.+)$/m.exec((await fs.read(dotGit).catch(() => null)) ?? '')?.[1] : dotGit;
      if (!named) return null;
      const gitDir = resolve(dir, named);
      const common = await fs.read(join(gitDir, 'commondir')).catch(() => null);
      return { exclude: join(common ? resolve(gitDir, common.trim()) : gitDir, 'info', 'exclude'), at: relative(dir, workDir).split(sep).join('/'), gitDir };
    }
    if (dirname(dir) === dir) return null;
  }
}

/* A path from the repository's root, its wildcards taken as plain characters. */
const pattern = (path: string) => `/${path.replace(/[\\*?[\]!#]/g, c => `\\${c}`)}`;

/* One change at a time to each exclude file, as agents in one repository place their skills at the same time and each
   would write back the file it read before the other's block was in. */
const editing = new Map<string, Promise<unknown>>();

function inTurn<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const run = (editing.get(path) ?? Promise.resolve()).then(fn);
  const settled = run.catch(() => undefined);
  editing.set(path, settled);
  void settled.then(() => {
    if (editing.get(path) === settled) editing.delete(path);
  });
  return run;
}

/* Names what the node writes in the agent's folder in its repository's excludes, one block for each kind of file in each
   folder of each checkout, so git add in that repository takes none of it in; an agent's own files there stay seen. */
export async function excludeInRepo(fs: AgentFs, workDir: string, paths: string[], what = 'skill files'): Promise<void> {
  const repo = await repoOf(fs, workDir);
  if (!repo) return;
  const head = `# Hornhoof's ${what} in /${repo.at} of the checkout ${repo.gitDir}`;
  const end = `# end of Hornhoof's ${what}`;
  await inTurn(repo.exclude, async () => {
    const lines = ((await fs.read(repo.exclude)) ?? '').split('\n');
    const from = lines.indexOf(head);
    const to = from < 0 ? -1 : lines.indexOf(end, from);
    const kept = to < 0 ? lines : [...lines.slice(0, from), ...lines.slice(to + 1)];
    while (kept.length && !kept[kept.length - 1]) kept.pop();
    const block = paths.length ? [head, ...paths.map(p => pattern(repo.at ? `${repo.at}/${p}` : p)), end] : [];
    await fs.mkdir(dirname(repo.exclude));
    await fs.write(repo.exclude, `${[...kept, ...block].join('\n')}\n`);
  });
}

/* A skill folder the node may have placed: one folder right inside a skills folder. */
const SKILL_PATH = /^\.(claude|agents)\/skills\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/* What the node placed last time, as far as it is skill folders: the agent can write the list too. */
async function placed(fs: AgentFs, workDir: string): Promise<Placed> {
  try {
    const data = JSON.parse((await fs.read(join(workDir, PLACED))) ?? '{}') as Partial<Placed>;
    return { paths: Array.isArray(data.paths) ? data.paths.filter((p): p is string => typeof p === 'string' && SKILL_PATH.test(p)) : [] };
  } catch {
    return { paths: [] };
  }
}

/* Writes the agent's skills where its program finds them before each turn, so a changed skill reaches the program
   without starting it again. */
export async function placeSkills(fs: AgentFs, workDir: string, provider: ProviderId, skills: SkillFile[]): Promise<void> {
  const folder = skillsFolder(provider);
  const before = await placed(fs, workDir);
  const ours = new Set(skills.map(s => `${folder}/${s.name}`));
  await excludeInRepo(fs, workDir, [...[...ours].map(p => `${p}/`), PLACED]);

  for (const path of before.paths) if (!ours.has(path)) await fs.remove(join(workDir, path));
  await fs.mkdir(join(workDir, folder));
  for (const skill of skills) {
    await fs.mkdir(join(workDir, folder, skill.name));
    await fs.write(join(workDir, folder, skill.name, 'SKILL.md'), skillText(skill));
  }
  await fs.write(join(workDir, PLACED), JSON.stringify({ paths: [...ours] } satisfies Placed));
}
