import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/* The release relies on the repository's own CI for its exact commit, or on none where the repository has none. No text an agent
   or a person reads says it needs a whole run of Hornhoof's machines: not a template, a skill, the guide, the repository's own
   documents, the words of a tool or the refusal of the terminal. */
const FORBIDDEN: { rule: RegExp; says: string }[] = [
  { rule: /\bevery test (?:of a release )?runs? together\b/i, says: 'every test runs together' },
  { rule: /\bonce per (?:release|turn)\b/i, says: 'a whole suite once per release' },
  { rule: /\bthe turn's whole release run\b|\bwhole release (?:run|suite)\b|\bfull release run\b|\brelease's (?:whole|full) (?:run|suite)\b|\bwhole run of (?:the|its|a) release\b|\bfull run of (?:the|its|a) release\b/i, says: 'a whole run of the release' },
  { rule: /\brecord run\b|\bpassed whole run\b/i, says: 'a record run' },
  { rule: /\brun_tests\b[^.\n]{0,60}\brelease scope\b|\brelease needs run_tests\b/i, says: 'a release that needs run_tests' },
];

const FILES = {
  directories: ['templates', 'guide'],
  files: ['docs/check-queue.md', '.hornhoof/author-check.md', 'AGENTS.md', 'CONTRIBUTING.md', 'apps/node/src/command-guard.ts', 'apps/server/src/modules/testruns/tools.ts', 'apps/server/src/modules/tasks/tools.ts', 'apps/server/src/modules/tasks/wake.ts', 'apps/server/src/modules/tools/approval-policy.ts'],
};

function markdownUnder(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? markdownUnder(path) : path.endsWith('.md') ? [path] : [];
  });
}

const files = (): string[] => [...FILES.directories.flatMap(directory => markdownUnder(join(ROOT, directory))), ...FILES.files.map(file => join(ROOT, file))];
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

describe("no text says a release needs a run of Hornhoof's machines", () => {
  it('scans every template, skill and guide page and the other texts that told agents the rule', () => {
    const scanned = files().map(path => relative(ROOT, path));
    expect(scanned.length).toBeGreaterThan(150);
    for (const named of ['templates/skills/hh-run-checks.md', 'templates/skills/dev-ci-release.md', 'templates/skills/dev-testing-policy.md', 'templates/skills/dev-lead.md', 'templates/skills/orch-plan-turn.md', 'templates/echelons/development.md', 'guide/free-machines.md', 'guide/tasks-and-turns.md']) expect(scanned, named).toContain(named);
  });

  it.each(FORBIDDEN)('finds no text saying $says', ({ rule }) => {
    const found = files().flatMap(path => (read(relative(ROOT, path)).split('\n').flatMap((line, index) => (rule.test(line) ? [`${relative(ROOT, path)}:${index + 1}: ${line.trim().slice(0, 140)}`] : []))));
    expect(found).toEqual([]);
  });

  /* What replaced the rule, said in the places an agent or a person looks first. */
  it.each([
    ['templates/skills/hh-run-checks.md', /A release does not use run_tests: it relies on the repository's own CI for its exact commit/],
    ['templates/skills/dev-ci-release.md', /The release relies on the repository's own CI for that exact commit/],
    ['templates/skills/dev-testing-policy.md', /the repository's CI runs for the release/],
    ['templates/skills/orch-plan-turn.md', /resting on the repository's own CI for that commit/],
    ['templates/skills/hh-head.md', /on the repository's green CI for that exact commit, or with no run where the repository has no CI/],
    ['guide/free-machines.md', /A release does not use it: it relies on the repository's own CI/],
    ['guide/tasks-and-turns.md', /The repository's own CI must be green on the exact commit of the turn branch[^\n]*a repository with no CI records with no run/],
    ['docs/check-queue.md', /the repository's own CI runs it for the exact commit of a release/],
    ['.hornhoof/author-check.md', /The whole suite runs in the repository's CI, on the exact commit a release records/],
    ['apps/node/src/command-guard.ts', /the repository's CI runs it for the release/],
  ])('says in %s that the release relies on the repository\'s CI', (path, said) => {
    expect(read(path)).toMatch(said);
  });
});
