import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ProviderId, SkillFile } from '@hornhoof/protocol';
import type { AgentFs } from './agent-fs.js';

/* obra/superpowers at the commit the image pins, under its MIT licence: Claude Code loads it as a plugin, the other
   programs get its skills as files. */
export const SUPERPOWERS = '/opt/hornhoof/superpowers';

/* The image's copy, or none on a machine without it. */
export const superpowersIn = (dir = SUPERPOWERS): string | null => (existsSync(join(dir, '.claude-plugin', 'plugin.json')) ? dir : null);

/* The plugins Claude Code loads for each session: superpowers, when the machine has it. */
export const claudePlugins = (): string[] => {
  const dir = superpowersIn();
  return dir ? [dir] : [];
};

const CLAUDE: ReadonlySet<ProviderId> = new Set(['claude', 'anthropic_api', 'glm']);

/* Where a program finds a project's skills: Claude Code in .claude/skills, Codex, Kimi Code and Antigravity in
   .agents/skills. Each agent's folder is its project, so it sees only its own. */
export const skillsFolder = (provider: ProviderId): string => (CLAUDE.has(provider) ? '.claude/skills' : '.agents/skills');

/* What the node put in the agent's folder last time, so what it no longer gives goes and the agent's own stays. */
const PLACED = '.hh-skills.json';
type Placed = { paths: string[]; superpowers: string | null };

/* A string in double quotes is YAML too, whatever the description says. */
const skillText = (s: SkillFile) => `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${s.body}\n`;

function versionOf(superpowers: string): string {
  const { version } = JSON.parse(readFileSync(join(superpowers, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: unknown };
  return String(version);
}

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

const END = "# end of Hornhoof's skill files";
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

/* Names what the node writes in the agent's folder in its repository's excludes, one block for each folder of each
   checkout, so git add in that repository takes none of it in; an agent's own files there stay seen. */
async function exclude(fs: AgentFs, workDir: string, paths: string[]): Promise<void> {
  const repo = await repoOf(fs, workDir);
  if (!repo) return;
  const head = `# Hornhoof's skill files in /${repo.at} of the checkout ${repo.gitDir}`;
  await inTurn(repo.exclude, async () => {
    const lines = ((await fs.read(repo.exclude)) ?? '').split('\n');
    const from = lines.indexOf(head);
    const to = from < 0 ? -1 : lines.indexOf(END, from);
    const kept = to < 0 ? lines : [...lines.slice(0, from), ...lines.slice(to + 1)];
    while (kept.length && !kept[kept.length - 1]) kept.pop();
    const block = paths.length ? [head, ...paths.map(p => pattern(repo.at ? `${repo.at}/${p}` : p)), END] : [];
    await fs.mkdir(dirname(repo.exclude));
    await fs.write(repo.exclude, `${[...kept, ...block].join('\n')}\n`);
  });
}

async function placed(fs: AgentFs, workDir: string): Promise<Placed> {
  try {
    const data = JSON.parse((await fs.read(join(workDir, PLACED))) ?? '{}') as Partial<Placed>;
    return { paths: Array.isArray(data.paths) ? data.paths.filter(p => typeof p === 'string') : [], superpowers: typeof data.superpowers === 'string' ? data.superpowers : null };
  } catch {
    return { paths: [], superpowers: null };
  }
}

/* Writes the agent's skills where its program finds them before each turn, so a changed skill reaches the program
   without starting it again. A program without the superpowers plugin gets its skills copied in, each with the licence. */
export async function placeSkills(fs: AgentFs, workDir: string, provider: ProviderId, skills: SkillFile[], superpowers: string | null): Promise<void> {
  const folder = skillsFolder(provider);
  const before = await placed(fs, workDir);
  const ours = new Set(skills.map(s => `${folder}/${s.name}`));
  const copied = !CLAUDE.has(provider) && superpowers ? readdirSync(join(superpowers, 'skills')).filter(name => !ours.has(`${folder}/${name}`)) : [];
  const version = copied.length ? versionOf(superpowers!) : null;
  const theirs = new Set(copied.map(name => `${folder}/${name}`));
  const fresh = version !== before.superpowers;
  await exclude(fs, workDir, [...[...ours, ...theirs].map(p => `${p}/`), PLACED]);

  for (const path of before.paths) if (!ours.has(path) && (!theirs.has(path) || fresh)) await fs.remove(join(workDir, path));
  await fs.mkdir(join(workDir, folder));
  for (const skill of skills) {
    await fs.mkdir(join(workDir, folder, skill.name));
    await fs.write(join(workDir, folder, skill.name, 'SKILL.md'), skillText(skill));
  }
  for (const name of copied) {
    const to = join(workDir, folder, name);
    if (!fresh && before.paths.includes(`${folder}/${name}`)) continue;
    await fs.remove(to);
    await fs.copy(join(superpowers!, 'skills', name), to);
    await fs.copy(join(superpowers!, 'LICENSE'), join(to, 'LICENSE'));
  }
  await fs.write(join(workDir, PLACED), JSON.stringify({ paths: [...ours, ...theirs], superpowers: version } satisfies Placed));
}
