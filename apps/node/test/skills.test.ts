import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ownFs, type AgentFs } from '../src/agent-fs.js';
import { agyRules } from '../src/providers/antigravity.js';
import { placeSkills, skillsFolder } from '../src/skills.js';

const TDD = { name: 'dev-tdd', description: 'Test-driven development. Writes the test: then the code.', body: '# Test-driven development\n\nWrite the test first.' };
const DOCS = { name: 'dev-docs', description: 'Docs. Keeps the docs true.', body: '# Docs\n\nUpdate the README.' };

const work = () => mkdtempSync(join(tmpdir(), 'hh-work-'));

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

/* What git add -A in the repository would take in. */
function added(repo: string): string[] {
  git(repo, 'add', '-A');
  return git(repo, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
}

describe('skills as files', () => {
  it('puts them where each program finds a project skill', () => {
    for (const provider of ['claude', 'anthropic_api', 'glm'] as const) expect(skillsFolder(provider)).toBe('.claude/skills');
    for (const provider of ['codex', 'openai_api', 'kimi', 'antigravity'] as const) expect(skillsFolder(provider)).toBe('.agents/skills');
  });

  it('writes each skill as a folder with its SKILL.md, named and described in its frontmatter', async () => {
    const dir = work();
    await placeSkills(ownFs, dir, 'claude', [TDD]);
    const text = readFileSync(join(dir, '.claude', 'skills', 'dev-tdd', 'SKILL.md'), 'utf8');
    expect(text).toBe('---\nname: dev-tdd\ndescription: "Test-driven development. Writes the test: then the code."\n---\n\n# Test-driven development\n\nWrite the test first.\n');
  });

  it('takes away a skill turned off, and those of another program after a change of subscription', async () => {
    const dir = work();
    await placeSkills(ownFs, dir, 'claude', [TDD, DOCS]);
    await placeSkills(ownFs, dir, 'claude', [TDD]);
    expect(readdirSync(join(dir, '.claude', 'skills'))).toEqual(['dev-tdd']);
    await placeSkills(ownFs, dir, 'codex', [DOCS]);
    expect(readdirSync(join(dir, '.claude', 'skills'))).toEqual([]);
    expect(readdirSync(join(dir, '.agents', 'skills'))).toEqual(['dev-docs']);
  });

  it('removes only skill folders, whatever the list of what it placed says, as the agent can write that list', async () => {
    const root = work();
    const dir = join(root, 'agent');
    mkdirSync(join(dir, 'repo'), { recursive: true });
    writeFileSync(join(dir, 'repo', 'main.go'), 'package main\n');
    writeFileSync(join(root, 'node.json'), 'key');
    const listed = ['repo', '../node.json', '.agents/skills/../../node.json', '.agents/skills/..', '.agents/skills', '/etc', '.claude/skills/a/b'];
    writeFileSync(join(dir, '.hh-skills.json'), JSON.stringify({ paths: listed }));
    await placeSkills(ownFs, dir, 'codex', [TDD]);
    expect(existsSync(join(dir, 'repo', 'main.go'))).toBe(true);
    expect(existsSync(join(root, 'node.json'))).toBe(true);
    expect(readdirSync(join(dir, '.agents', 'skills'))).toEqual(['dev-tdd']);
  });

  it("leaves a skill the agent made itself in the same folder", async () => {
    const dir = work();
    mkdirSync(join(dir, '.agents', 'skills', 'own'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'skills', 'own', 'SKILL.md'), 'mine');
    await placeSkills(ownFs, dir, 'kimi', [TDD]);
    await placeSkills(ownFs, dir, 'kimi', []);
    expect(readdirSync(join(dir, '.agents', 'skills'))).toEqual(['own']);
  });

  it("gives every program only the agent's own skills, and takes away the superpowers skills an earlier node copied", async () => {
    for (const provider of ['claude', 'anthropic_api', 'glm', 'codex', 'openai_api', 'kimi', 'antigravity'] as const) {
      const folder = skillsFolder(provider);
      const dir = work();
      mkdirSync(join(dir, folder, 'brainstorming'), { recursive: true });
      writeFileSync(join(dir, folder, 'brainstorming', 'SKILL.md'), 'Word for word.');
      writeFileSync(join(dir, '.hh-skills.json'), JSON.stringify({ paths: [`${folder}/brainstorming`], superpowers: '7.0.0' }));
      await placeSkills(ownFs, dir, provider, [TDD, DOCS]);
      expect(readdirSync(join(dir, folder)).sort(), provider).toEqual(['dev-docs', 'dev-tdd']);
      expect(JSON.parse(readFileSync(join(dir, '.hh-skills.json'), 'utf8')), provider).toEqual({ paths: [`${folder}/dev-tdd`, `${folder}/dev-docs`] });
    }
  });

  it('keeps them out of a repository the agent folder is part of, and only them', async () => {
    const repo = work();
    git(repo, 'init', '-q');
    const dir = join(repo, 'work', 'agents', 'a [1]');
    mkdirSync(join(dir, '.agents', 'skills', 'own'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'skills', 'own', 'SKILL.md'), 'mine');
    await placeSkills(ownFs, dir, 'kimi', [TDD]);
    expect(added(repo)).toEqual(['work/agents/a [1]/.agents/skills/own/SKILL.md']);
    /* A turn later on another program, with other skills. */
    await placeSkills(ownFs, dir, 'claude', [DOCS]);
    expect(added(repo)).toEqual(['work/agents/a [1]/.agents/skills/own/SKILL.md']);
  });

  it('keeps the block of each agent that places its skills in one repository at the same time', async () => {
    const repo = work();
    git(repo, 'init', '-q');
    const dirs = ['a1', 'a2', 'a3'].map(key => join(repo, 'work', key));
    for (const dir of dirs) mkdirSync(dir, { recursive: true });
    await Promise.all(dirs.map(dir => placeSkills(ownFs, dir, 'codex', [TDD])));
    expect(added(repo)).toEqual([]);
  });

  it('keeps them out of the agent folder made a repository, and of a worktree', async () => {
    const dir = work();
    git(dir, 'init', '-q');
    await placeSkills(ownFs, dir, 'codex', [TDD]);
    expect(added(dir)).toEqual([]);
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'start');
    const tree = join(work(), 'tree');
    git(dir, 'worktree', 'add', '-q', tree);
    await placeSkills(ownFs, tree, 'claude', [TDD]);
    expect(added(tree)).toEqual([]);
  });

  it("finds the repository as the agent's user sees it, never reading the agent's folder itself", async () => {
    const dir = work();
    /* What the agent's user sees: a .git file naming a git folder elsewhere, which the node itself cannot see. */
    const seen: Record<string, string> = { [join(dir, '.git')]: 'gitdir: /elsewhere/.git/worktrees/w\n', '/elsewhere/.git/worktrees/w/commondir': '../..\n' };
    const fs: AgentFs = {
      ...ownFs,
      kind: async path => (path in seen ? 'file' : null),
      read: async path => seen[path] ?? (path.startsWith('/elsewhere') ? null : ownFs.read(path)),
      write: async (path, data) => void (path.startsWith('/elsewhere') ? (seen[path] = data) : await ownFs.write(path, data)),
      mkdir: async path => (path.startsWith('/elsewhere') ? undefined : ownFs.mkdir(path)),
    };
    await placeSkills(fs, dir, 'codex', [TDD]);
    expect(seen['/elsewhere/.git/info/exclude']).toContain('\n/.agents/skills/dev-tdd/\n');
  });

  it('keeps the block of each worktree of a repository, as they share its excludes', async () => {
    const dir = work();
    git(dir, 'init', '-q');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'start');
    const tree = join(work(), 'tree');
    git(dir, 'worktree', 'add', '-q', tree);
    await placeSkills(ownFs, dir, 'codex', [TDD]);
    await placeSkills(ownFs, tree, 'codex', [DOCS]);
    expect(added(dir)).toEqual([]);
    expect(added(tree)).toEqual([]);
  });

  it('materializes the shipped dev-frontend-ui skill and AGENTS.md pointer for Antigravity within its 24 KB limit', async () => {
    const dir = work();
    const raw = readFileSync(fileURLToPath(new URL('../../../templates/skills/dev-frontend-ui.md', import.meta.url)), 'utf8');
    const body = `# User interface engineering\n\n${raw.replace(/^---[\s\S]*?---\n/, '').trimEnd()}`;
    const uiSkill = {
      name: 'dev-frontend-ui',
      description: 'User interface engineering. Builds the interface users meet on the design system: every state, every input, every size.',
      body,
    };
    const pointer = '## Skills\n\nYour other skills are files in your folder: .claude/skills/<name>/SKILL.md when you run in Claude Code, .agents/skills/<name>/SKILL.md in the other programs.\n\n- dev-frontend-ui: User interface engineering. Builds the interface users meet on the design system: every state, every input, every size.';
    const agy = agyRules(pointer, '.hh-instructions.md');
    expect(agy.whole).toBeNull();
    expect(agy.rules).toContain('- dev-frontend-ui: User interface engineering.');
    await placeSkills(ownFs, dir, 'antigravity', [uiSkill]);
    const skillPath = join(dir, '.agents', 'skills', 'dev-frontend-ui', 'SKILL.md');
    const placedText = readFileSync(skillPath, 'utf8');
    expect(Buffer.byteLength(placedText)).toBeLessThan(24_000);
    expect(placedText).toContain('name: dev-frontend-ui');
    expect(placedText).toMatch(/whole group|together as one group/i);
    expect(placedText).toMatch(/non-visual[\s\S]*in parallel/i);
    expect(placedText).toContain('scrollbar space');
    expect(placedText).toMatch(/Verify an affected web view[\s\S]*Chromium, Firefox and WebKit[\s\S]*screenshots and geometry evidence/);
  });
});
