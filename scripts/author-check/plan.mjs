import { posix } from 'node:path';

/* CRAP = CC^2 * (1 - coverage)^3 + CC, so complexity 2 stays at 6 with no coverage at all. */
const COULD_REACH_TEN = 3;
const LINTABLE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|clj|cljc|cljs|bb|java|go|rs|py)$/;
const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__|spec|specs)\/|\.(?:test|spec)\.[^/]+$/;
const DOCUMENT = /^(?!templates\/|(?:AGENTS|CONTRIBUTING|CHANGELOG)\.md$)(?!.*(?:^|\/)(?:test|tests|__tests__)\/).*\.md$/;
const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const KINDS = { M: 'modified', A: 'added', D: 'deleted', T: 'modified' };

export const isCode = path => CODE.test(path);
export const isLintable = path => LINTABLE.test(path);
export const isSource = path => CODE.test(path) && !TEST_PATH.test(path);
export const isDocument = path => DOCUMENT.test(path);
export function ownerOf(suites, path) {
  return suites.filter(suite => suite.root === '.' || path === suite.root || path.startsWith(`${suite.root}/`))
    .sort((a, b) => b.root.length - a.root.length)[0];
}
export const cwdOf = (suites, path) => ownerOf(suites, path)?.run.cwd ?? '.';

export function parseNameStatus(raw) {
  const parts = raw.split('\0');
  parts.pop();
  const changes = [];
  while (parts.length) {
    const status = parts.shift(), path = parts.shift();
    changes.push(/^[RC]/.test(status) ? { kind: 'renamed', previousPath: path, path: parts.shift() } : { kind: KINDS[status] ?? 'modified', path });
  }
  return changes;
}

const lineCount = text => (text === undefined ? 1 : Number(text));

/* The lines a hunk holds are skipped by count, so changed text that looks like a header stays text. */
export function parseHunks(diff) {
  const hunks = {};
  let path = null, skip = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('\\')) continue;
    if (skip > 0) { skip -= 1; continue; }
    if (line.startsWith('+++ ')) { path = line === '+++ /dev/null' ? null : line.slice('+++ b/'.length); continue; }
    const found = HUNK.exec(line);
    if (!found) continue;
    const added = lineCount(found[3]);
    skip = lineCount(found[1]) + added;
    if (added && path) (hunks[path] ??= []).push([Number(found[2]), added]);
  }
  return hunks;
}

/* Functions of one name in one namespace have nothing else to tell them apart, so the most complex meets the most complex. */
export function grownFunctions(head, base) {
  const before = new Map();
  for (const { namespace, name, complexity } of base) before.set(`${namespace} ${name}`, [...(before.get(`${namespace} ${name}`) ?? []), complexity].sort((a, b) => b - a));
  const grown = [];
  for (const { namespace, name, complexity } of [...head].sort((a, b) => b.complexity - a.complexity)) {
    const was = before.get(`${namespace} ${name}`)?.shift() ?? null;
    if (complexity >= COULD_REACH_TEN && (was === null || complexity > was)) grown.push({ namespace, name, cc: complexity, base: was });
  }
  return grown;
}

function sourcesByFolder(changes, cwdOfPath) {
  const groups = new Map();
  for (const change of changes) {
    if (change.kind === 'deleted' || !isSource(change.path)) continue;
    const cwd = cwdOfPath(change.path), path = posix.relative(cwd, change.path);
    const group = groups.get(cwd) ?? { head: [], base: [] };
    group.head.push({ path, from: change.path });
    /* Under its new path, so a moved function keeps its namespace and is not taken for a new one. */
    if (change.kind !== 'added') group.base.push({ path, from: change.previousPath ?? change.path });
    groups.set(cwd, group);
  }
  return groups;
}

export function buildPlan({ sha, base, cwdOf: cwdOfPath }, { git, complexity }) {
  const changes = parseNameStatus(git(['diff', '--name-status', '-z', '--find-renames', base, sha]));
  const hunks = parseHunks(git(['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--find-renames', '--src-prefix=a/', '--dst-prefix=b/', base, sha]));
  const grown = {};
  for (const [cwd, files] of sourcesByFolder(changes, cwdOfPath)) {
    const found = grownFunctions(complexity(cwd, sha, files.head), files.base.length ? complexity(cwd, base, files.base) : []);
    if (found.length) grown[cwd] = found;
  }
  return { sha, base, changes, hunks, grown };
}
