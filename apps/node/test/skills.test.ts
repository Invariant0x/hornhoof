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
