import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ownFs } from '../src/agent-fs.js';
import { placeSkills, skillsFolder } from '../src/skills.js';

const TDD = { name: 'dev-tdd', description: 'Test-driven development. Writes the test: then the code.', body: '# Test-driven development\n\nWrite the test first.' };
const DOCS = { name: 'dev-docs', description: 'Docs. Keeps the docs true.', body: '# Docs\n\nUpdate the README.' };

/* A copy of superpowers as the image keeps it: its manifest, licence and two skills, one with a script. */
function superpowers(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-sp-'));
  mkdirSync(join(dir, '.claude-plugin'));
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'superpowers', version: '7.0.0' }));
  writeFileSync(join(dir, 'LICENSE'), 'MIT License\n');
  for (const name of ['brainstorming', 'systematic-debugging']) {
    mkdirSync(join(dir, 'skills', name, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Use when.\n---\n\nWord for word.\n`);
    writeFileSync(join(dir, 'skills', name, 'scripts', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  }
  return dir;
}

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
    await placeSkills(ownFs, dir, 'claude', [TDD], null);
    const text = readFileSync(join(dir, '.claude', 'skills', 'dev-tdd', 'SKILL.md'), 'utf8');
    expect(text).toBe('---\nname: dev-tdd\ndescription: "Test-driven development. Writes the test: then the code."\n---\n\n# Test-driven development\n\nWrite the test first.\n');
  });

  it('takes away a skill turned off, and those of another program after a change of subscription', async () => {
    const dir = work();
    await placeSkills(ownFs, dir, 'claude', [TDD, DOCS], null);
    await placeSkills(ownFs, dir, 'claude', [TDD], null);
    expect(readdirSync(join(dir, '.claude', 'skills'))).toEqual(['dev-tdd']);
    await placeSkills(ownFs, dir, 'codex', [DOCS], null);
    expect(readdirSync(join(dir, '.claude', 'skills'))).toEqual([]);
    expect(readdirSync(join(dir, '.agents', 'skills'))).toEqual(['dev-docs']);
  });

  it("leaves a skill the agent made itself in the same folder", async () => {
    const dir = work();
    mkdirSync(join(dir, '.agents', 'skills', 'own'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'skills', 'own', 'SKILL.md'), 'mine');
    await placeSkills(ownFs, dir, 'kimi', [TDD], null);
    await placeSkills(ownFs, dir, 'kimi', [], null);
    expect(readdirSync(join(dir, '.agents', 'skills'))).toEqual(['own']);
  });

  it('copies the superpowers skills word for word with their licence for programs without the plugin', async () => {
    const dir = work();
    const sp = superpowers();
    await placeSkills(ownFs, dir, 'codex', [TDD], sp);
    const skills = join(dir, '.agents', 'skills');
    expect(readdirSync(skills).sort()).toEqual(['brainstorming', 'dev-tdd', 'systematic-debugging']);
    expect(readFileSync(join(skills, 'brainstorming', 'SKILL.md'), 'utf8')).toBe(readFileSync(join(sp, 'skills', 'brainstorming', 'SKILL.md'), 'utf8'));
    expect(readFileSync(join(skills, 'brainstorming', 'LICENSE'), 'utf8')).toBe('MIT License\n');
    expect(statSync(join(skills, 'systematic-debugging', 'scripts', 'run.sh')).mode & 0o111).not.toBe(0);
    /* Claude Code gets superpowers as its plugin instead. */
    await placeSkills(ownFs, dir, 'claude', [TDD], sp);
    expect(existsSync(join(skills, 'brainstorming'))).toBe(false);
    expect(readdirSync(join(dir, '.claude', 'skills'))).toEqual(['dev-tdd']);
  });

  it('keeps them out of a repository the agent folder is part of, and only them', async () => {
    const repo = work();
    git(repo, 'init', '-q');
    const dir = join(repo, 'work', 'agents', 'a [1]');
    mkdirSync(join(dir, '.agents', 'skills', 'own'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'skills', 'own', 'SKILL.md'), 'mine');
    await placeSkills(ownFs, dir, 'kimi', [TDD], superpowers());
    expect(added(repo)).toEqual(['work/agents/a [1]/.agents/skills/own/SKILL.md']);
    /* A turn later on another program, with other skills. */
    await placeSkills(ownFs, dir, 'claude', [DOCS], null);
    expect(added(repo)).toEqual(['work/agents/a [1]/.agents/skills/own/SKILL.md']);
  });

  it('keeps the block of each agent that places its skills in one repository at the same time', async () => {
    const repo = work();
    git(repo, 'init', '-q');
    const dirs = ['a1', 'a2', 'a3'].map(key => join(repo, 'work', key));
    for (const dir of dirs) mkdirSync(dir, { recursive: true });
    await Promise.all(dirs.map(dir => placeSkills(ownFs, dir, 'codex', [TDD], null)));
    expect(added(repo)).toEqual([]);
  });

  it('keeps them out of the agent folder made a repository, and of a worktree', async () => {
    const dir = work();
    git(dir, 'init', '-q');
    await placeSkills(ownFs, dir, 'codex', [TDD], superpowers());
    expect(added(dir)).toEqual([]);
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'start');
    const tree = join(work(), 'tree');
    git(dir, 'worktree', 'add', '-q', tree);
    await placeSkills(ownFs, tree, 'claude', [TDD], null);
    expect(added(tree)).toEqual([]);
  });

  it('keeps the block of each worktree of a repository, as they share its excludes', async () => {
    const dir = work();
    git(dir, 'init', '-q');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'start');
    const tree = join(work(), 'tree');
    git(dir, 'worktree', 'add', '-q', tree);
    await placeSkills(ownFs, dir, 'codex', [TDD], null);
    await placeSkills(ownFs, tree, 'codex', [DOCS], null);
    expect(added(dir)).toEqual([]);
    expect(added(tree)).toEqual([]);
  });

  it('copies superpowers again only when the image brings another version', async () => {
    const dir = work();
    const sp = superpowers();
    await placeSkills(ownFs, dir, 'antigravity', [], sp);
    const file = join(dir, '.agents', 'skills', 'brainstorming', 'SKILL.md');
    writeFileSync(file, 'changed by the agent');
    await placeSkills(ownFs, dir, 'antigravity', [], sp);
    expect(readFileSync(file, 'utf8')).toBe('changed by the agent');
    writeFileSync(join(sp, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'superpowers', version: '7.0.1' }));
    await placeSkills(ownFs, dir, 'antigravity', [], sp);
    expect(readFileSync(file, 'utf8')).toContain('Word for word.');
  });
});
