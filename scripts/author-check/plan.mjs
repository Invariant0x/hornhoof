import { Buffer } from 'node:buffer';
import { posix } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

/* What a run cannot read for itself: its clone holds one commit and no way to fetch another. The command line of a run
   holds 4000 characters, and the rest of the line needs the difference. */
export const PLAN_CHARS = 3600;
/* CRAP = CC^2 * (1 - coverage)^3 + CC, so complexity 2 stays at 6 with no coverage at all. A function left out of the
   base table is below this, and anything at 10 now has grown over it. */
const COULD_REACH_TEN = 3;
const LINTABLE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|clj|cljc|cljs|bb|java|go|rs|py)$/;
const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__|spec|specs)\/|\.(?:test|spec)\.[^/]+$/;
const DOCUMENT = /^(?!templates\/).*\.md$/;
const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const KINDS = { M: 'modified', A: 'added', D: 'deleted', T: 'modified' };

export const isCode = path => CODE.test(path);
export const isLintable = path => LINTABLE.test(path);
export const isSource = path => CODE.test(path) && !TEST_PATH.test(path);
export const isDocument = path => DOCUMENT.test(path);
export const functionKey = ({ namespace, name }) => `${namespace} ${name}`;

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

export function baseTable(entries) {
  const table = {};
  for (const entry of entries) if (entry.complexity >= COULD_REACH_TEN) (table[functionKey(entry)] ??= []).push(entry.complexity);
  for (const values of Object.values(table)) values.sort((a, b) => b - a);
  return table;
}

function filesOfBase(changes, cwdOfPath) {
  const groups = new Map();
  for (const change of changes) {
    if (change.kind === 'added' || change.kind === 'deleted' || !isSource(change.path)) continue;
    const cwd = cwdOfPath(change.path);
    /* Under its new path, so a moved function keeps its namespace and is not taken for a new one. */
    groups.set(cwd, [...(groups.get(cwd) ?? []), { path: posix.relative(cwd, change.path), from: change.previousPath ?? change.path }]);
  }
  return groups;
}

export function buildPlan({ sha, base, cwdOf: cwdOfPath }, { git, complexity }) {
  const changes = parseNameStatus(git(['diff', '--name-status', '-z', '--find-renames', base, sha]));
  const hunks = parseHunks(git(['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--find-renames', '--src-prefix=a/', '--dst-prefix=b/', base, sha]));
  const baseCc = {};
  for (const [cwd, files] of filesOfBase(changes, cwdOfPath)) baseCc[cwd] = baseTable(complexity(cwd, files));
  return { v: 1, sha, base, changes, hunks, baseCc };
}

export const encodePlan = plan => gzipSync(Buffer.from(JSON.stringify(plan)), { level: 9 }).toString('base64url');

export function decodePlan(text) {
  let plan;
  try { plan = JSON.parse(gunzipSync(Buffer.from(text, 'base64url')).toString('utf8')); }
  catch { throw new Error('plan_invalid'); }
  if (plan.v !== 1 || !Array.isArray(plan.changes)) throw new Error('plan_invalid');
  return plan;
}
