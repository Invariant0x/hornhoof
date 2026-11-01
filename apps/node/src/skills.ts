import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderId, SkillFile } from '@hornhoof/protocol';
import type { AgentFs } from './agent-fs.js';

/* obra/superpowers at the commit the image pins, under its MIT licence: Claude Code loads it as a plugin, the other
   programs get its skills as files. */
export const SUPERPOWERS = '/opt/hornhoof/superpowers';

/* The image's copy, or none on a machine without it. */
export const superpowersIn = (dir = SUPERPOWERS): string | null => (existsSync(join(dir, '.claude-plugin', 'plugin.json')) ? dir : null);

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
