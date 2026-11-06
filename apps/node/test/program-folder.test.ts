import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderId } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { ownFs } from '../src/agent-fs.js';
import { carrySession, CONTEXT_ROOT, codexRootFlags, freshStart, programDirOf, readyProgramFolder, toldPlace, treeFiles } from '../src/program-folder.js';
import { RULES, taskTree } from './program-folder-helpers.js';

const ALL: ProviderId[] = ['claude', 'codex', 'kimi', 'glm', 'anthropic_api', 'openai_api', 'antigravity'];
const C = '/data/agent/task-workspaces/one';
const T = `${C}/repo`;

describe('whether a session goes on in another folder', () => {
  it.each(ALL)('%s starts anew, as no live check has shown it can', provider => {
    expect(carrySession(provider)).toBe('fresh');
  });

  it('goes on only for a program a live check named', () => {
    expect(carrySession('codex', new Set<ProviderId>(['codex']))).toBe('carried');
    expect(carrySession('claude', new Set<ProviderId>(['codex']))).toBe('fresh');
  });
});

describe('where a program works and what it is told', () => {
  it('works in the worktree when it has one, and in its own folder otherwise', () => {
    expect(programDirOf({ workDir: C, programDir: T })).toBe(T);
    expect(programDirOf({ workDir: C })).toBe(C);
  });

  it.each([['codex'], ['kimi'], ['antigravity']] as const)('%s reads AGENTS.md of its own folder when it has no worktree', kind => {
    expect(toldPlace(kind, { workDir: C })).toEqual({ file: `${C}/AGENTS.md`, head: '' });
  });

  it('keeps Claude Code\'s file in the context folder, as it names the file when it starts', () => {
    expect(toldPlace('claude', { workDir: C, programDir: T })).toEqual({ file: `${C}/.hh-instructions.md`, head: '' });
  });

  it('gives Codex AGENTS.md in the context folder, above the repository\'s own', () => {
    expect(toldPlace('codex', { workDir: C, programDir: T })).toEqual({ file: `${C}/AGENTS.md`, head: '' });
    expect(codexRootFlags(true)).toEqual(['-c', `project_root_markers=["${CONTEXT_ROOT}"]`]);
    expect(codexRootFlags(false)).toEqual([]);
  });

  it('gives Kimi Code its project instructions in its own folder of the worktree', () => {
    expect(toldPlace('kimi', { workDir: C, programDir: T })).toEqual({ file: `${T}/.kimi-code/AGENTS.md`, head: '' });
  });

  it('gives Antigravity a rule that is always on, in its own folder of the worktree', () => {
    expect(toldPlace('antigravity', { workDir: C, programDir: T })).toEqual({ file: `${T}/.agents/rules/hornhoof.md`, head: '---\ntrigger: always_on\n---\n\n' });
  });

  it('names what each program needs in the worktree', () => {
    expect(treeFiles('claude')).toEqual([]);
    expect(treeFiles('anthropic_api')).toEqual([]);
    expect(treeFiles('glm')).toEqual([]);
    expect(treeFiles('codex')).toEqual([]);
    expect(treeFiles('openai_api')).toEqual([]);
    expect(treeFiles('kimi')).toEqual(['.kimi-code/AGENTS.md', '.kimi-code/mcp.json']);
    expect(treeFiles('antigravity')).toEqual(['.agents/rules/hornhoof.md', '.agents/mcp_config.json', '.agents/hooks.json']);
  });
});

describe('getting a task\'s folders ready for a program', () => {
  it.each(['kimi', 'antigravity'] as const)('keeps what %s needs out of git status', async provider => {
    const { context, tree, status } = taskTree();
    await readyProgramFolder(ownFs, provider, context, tree, []);
    for (const file of treeFiles(provider)) {
      mkdirSync(join(tree, file, '..'), { recursive: true });
      writeFileSync(join(tree, file), 'written by Hornhoof\n');
    }
    expect(status()).toBe('');
    expect(readFileSync(join(tree, 'AGENTS.md'), 'utf8')).toBe(RULES);
  });

  it('still shows an agent\'s own new files in git status', async () => {
    const { context, tree, status } = taskTree();
    await readyProgramFolder(ownFs, 'antigravity', context, tree, []);
    writeFileSync(join(tree, 'work.txt'), 'mine\n');
    mkdirSync(join(tree, '.agents'), { recursive: true });
    writeFileSync(join(tree, '.agents', 'mine.md'), 'mine\n');
    expect(status().split('\n').filter(Boolean).sort()).toEqual(['?? .agents/', '?? work.txt']);
  });

  it('marks the context folder as Codex\'s root, outside the repository', async () => {
    const { context, tree, status } = taskTree();
    await readyProgramFolder(ownFs, 'codex', context, tree, []);
    expect(existsSync(join(context, CONTEXT_ROOT))).toBe(true);
    expect(status()).toBe('');
  });

  it('writes no mark for a program that does not read it', async () => {
    const { context, tree } = taskTree();
    await readyProgramFolder(ownFs, 'claude', context, tree, []);
    expect(existsSync(join(context, CONTEXT_ROOT))).toBe(false);
  });

  it('refuses what the repository tracks in a place it needs, and leaves it as it is', async () => {
    const { context, tree, status } = taskTree(undefined, { '.agents/hooks.json': '{"theirs":true}\n' });
    await expect(readyProgramFolder(ownFs, 'antigravity', context, tree, [])).rejects.toThrow('.agents/hooks.json');
    expect(readFileSync(join(tree, '.agents', 'hooks.json'), 'utf8')).toBe('{"theirs":true}\n');
    expect(status()).toBe('');
  });

  it('refuses a skill of the repository with the name of the agent\'s', async () => {
    const { context, tree } = taskTree(undefined, { '.claude/skills/review/SKILL.md': 'theirs\n' });
    await expect(readyProgramFolder(ownFs, 'claude', context, tree, ['.claude/skills/review'])).rejects.toThrow('.claude/skills/review');
  });

  it('knows its own files on the next turn', async () => {
    const { context, tree } = taskTree();
    await readyProgramFolder(ownFs, 'kimi', context, tree, []);
    mkdirSync(join(tree, '.kimi-code'), { recursive: true });
    writeFileSync(join(tree, '.kimi-code', 'mcp.json'), '{}\n');
    await expect(readyProgramFolder(ownFs, 'kimi', context, tree, [])).resolves.toBeUndefined();
  });

  it('takes a list that makes no sense as no list', async () => {
    const { context, tree } = taskTree(undefined, { '.kimi-code/mcp.json': 'theirs\n' });
    writeFileSync(join(context, '.hh-tree-files.json'), 'not json');
    await expect(readyProgramFolder(ownFs, 'kimi', context, tree, [])).rejects.toThrow('.kimi-code/mcp.json');
  });

  it('starts nothing when the worktree is not there', async () => {
    const { context, tree } = taskTree();
    await expect(readyProgramFolder(ownFs, 'claude', context, join(tree, 'gone'), [])).rejects.toThrow("The task's folder is not there");
  });
});

describe('a session that starts anew in a task\'s folder', () => {
  it('tells people, and the agent what came with it', () => {
    const { note, context } = freshStart('What the task is about.');
    expect(note).toContain('new session');
    expect(note).toContain('The old session stays');
    expect(context).toContain('new session');
    expect(context).toContain('What the task is about.');
  });

  it('says so when nothing came with it', () => {
    const { note, context } = freshStart(null);
    expect(note).toContain('No catch-up');
    expect(context).toContain('new session');
  });

  it('keeps a catch-up short', () => {
    const { context } = freshStart('x'.repeat(100_000));
    expect(context.length).toBeLessThan(9_000);
  });
});
