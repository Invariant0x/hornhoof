import { join } from 'node:path';
import { isLintable, ownerOf } from '../author-check/plan.mjs';

/* The parts the whole suite runs in, one on each of the four runners, and how many test files make a part worth its own. */
export const PARTS = 4;
export const FILES_PER_PART = 20;
const WHOLE = Array.from({ length: PARTS }, (_, i) => i + 1);

/* The tests of a selection in parts, each part the files of each suite it runs: as many parts as the files fill, every file in
   exactly one. A change that reaches no test has one part, which runs the checks alone. */
export function partsOf(selection) {
  const files = selection.packages.flatMap(item => item.units.map(unit => [item.packageId, unit.file]));
  const parts = Array.from({ length: Math.min(PARTS, Math.max(1, Math.ceil(files.length / FILES_PER_PART))) }, () => ({}));
  files.forEach(([suite, file], i) => (parts[i % parts.length][suite] ??= []).push(file));
  return parts;
}

/* How many files one eslint takes. It keeps the types it asked of every file it linted, and the whole server in one run
   needs more memory than node allows on a small machine, where a third of it does not. */
export const LINT_FILES = 300;

/* The files of the change the lint reads, one group for each workspace: eslint keeps every TypeScript program it builds, so
   one for each, as npm run lint runs it, stays inside node's memory. A workspace with more files than one run takes is
   linted in several. */
function lintGroups(changes, suites) {
  const groups = new Map();
  for (const change of changes) {
    if (change.kind === 'deleted' || !isLintable(change.path)) continue;
    const key = ownerOf(suites, change.path)?.root ?? '.';
    groups.set(key, [...(groups.get(key) ?? []), change.path]);
  }
  return [...groups.values()].flatMap(files => Array.from({ length: Math.ceil(files.length / LINT_FILES) }, (_, i) => files.slice(i * LINT_FILES, (i + 1) * LINT_FILES)));
}

/* What a run on GitHub checks of a change since a passed commit, when the selection chose its tests. */
export function planOf(base, changes, selection, suites) {
  return { base, lint: lintGroups(changes, suites), parts: partsOf(selection) };
}

/* The first job's outputs: the parts to run, the plan for them and the commit it stands on; without a plan, the whole suite. */
export function outputsOf(plan) {
  if (!plan) return `parts=${JSON.stringify(WHOLE)}\nselection=\nbase=\n`;
  return `parts=${JSON.stringify(plan.parts.map((_, i) => i + 1))}\nselection=${JSON.stringify(plan)}\nbase=${plan.base}\n`;
}

/* The whole lint without a plan; with one, the files the change left. */
export function lintCommands(plan) {
  if (!plan) return [{ program: 'npm', args: ['run', 'lint'], cwd: '.' }];
  return plan.lint.map(files => ({ program: 'npx', args: ['--no-install', 'eslint', ...files], cwd: '.' }));
}

/* Each suite of a part with its files, through the node's own invocation, so they run as on a node. Vitest gets the two
   workers each part of the whole suite has. */
export async function invocationsOf(part, suites, { root, dir }, build) {
  const found = [];
  for (const [id, files] of Object.entries(part)) {
    const suite = suites.find(item => item.id === id);
    if (!suite) throw new Error(`The test environment has no suite ${id}`);
    const { command, env } = await build(suite, files, { checkout: root, filesPath: join(dir, `files-${id}.json`), shard: { index: 1, count: 1 } });
    found.push({ command: suite.split.kind === 'vitest-shard' ? { ...command, args: [...command.args, '--maxWorkers=2'] } : command, env });
  }
  return found;
}

/* Every command runs even when one before it failed, so one run shows all that is wrong. */
export async function runAll(invocations, exec) {
  let failed = false;
  for (const { command, env } of invocations) failed = (await exec(command, env)) !== 0 || failed;
  return failed ? 1 : 0;
}
