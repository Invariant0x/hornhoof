import { createHash } from 'node:crypto';
import { posix } from 'node:path';

/* What a run cannot read for itself: its clone holds one commit and no way to fetch another. The command line of a run
   holds 4000 characters, and the rest of the line needs the difference. */
export const PLAN_CHARS = 3600;
/* CRAP = CC^2 * (1 - coverage)^3 + CC, so complexity 2 stays at 6 with no coverage at all. */
const COULD_REACH_TEN = 3;
const LINTABLE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|clj|cljc|cljs|bb|java|go|rs|py)$/;
const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__|spec|specs)\/|\.(?:test|spec)\.[^/]+$/;
const DOCUMENT = /^(?!templates\/).*\.md$/;
const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const KINDS = { M: 'modified', A: 'added', D: 'deleted', T: 'modified' };
const LETTERS = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R' };
const PLAN_HEAD = /^v1 ([a-f0-9]{12}) ([a-f0-9]{12})( nolines)?$/;
const PATH_RESERVED = /[;'@>\n]/;
const NAME_RESERVED = /[;', \n]/;

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

const digestOf = body => createHash('sha256').update(body).digest('hex').slice(0, 8);

function checked(text, reserved) {
  if (reserved.test(text)) throw new Error(`plan_unsupported: ${text}`);
  return text;
}

const rangeText = ([start, count]) => (count === 1 ? `${start}` : `${start}+${count}`);

function changeItem(change, hunks) {
  const path = checked(change.path, PATH_RESERVED);
  const name = change.kind === 'renamed' ? `${checked(change.previousPath, PATH_RESERVED)}>${path}` : path;
  const ranges = (isSource(change.path) && hunks?.[change.path]) || [];
  return `${LETTERS[change.kind]} ${name}${ranges.length ? ` @${ranges.map(rangeText).join(',')}` : ''}`;
}

const grownText = ({ name, cc, base }) => `${checked(name, NAME_RESERVED)}=${cc}${base === null ? '' : `<${base}`}`;

function grownItems(grown) {
  return Object.entries(grown).flatMap(([cwd, functions]) => {
    const spaces = new Map();
    for (const item of functions) spaces.set(item.namespace, [...(spaces.get(item.namespace) ?? []), grownText(item)]);
    return [...spaces].map(([namespace, texts]) => `G ${cwd} ${namespace} ${texts.join(',')}`);
  });
}

/* Plain words, because the one who hands this to run_tests types it: an agent copies text it can read, and repeated the
   same wrong characters of a compressed plan twice. The digest catches what is still copied wrong. */
export function encodePlan(plan) {
  const head = `v1 ${plan.sha.slice(0, 12)} ${plan.base.slice(0, 12)}${plan.hunks ? '' : ' nolines'}`;
  const body = [head, ...plan.changes.map(change => changeItem(change, plan.hunks)), ...grownItems(plan.grown)].join(';');
  return `${body};#${digestOf(body)}`;
}

function refused() {
  throw new Error('plan_invalid');
}

function readRange(text) {
  const [start, count = '1'] = text.split('+');
  return [Number(start), Number(count)];
}

function readChange(item, plan) {
  const [name, ranges] = item.slice(2).split(' @');
  const [previousPath, path] = name.split('>');
  const change = item[0] === 'R' ? { kind: 'renamed', previousPath, path } : { kind: KINDS[item[0]], path: name };
  plan.changes.push(change);
  if (ranges) plan.hunks[change.path] = ranges.split(',').map(readRange);
}

function readFunction(text, namespace) {
  const found = /^(.+)=(\d+)(?:<(\d+))?$/.exec(text) ?? refused();
  return { namespace, name: found[1], cc: Number(found[2]), base: found[3] === undefined ? null : Number(found[3]) };
}

function readGrown(item, plan) {
  const found = /^G (\S+) (.+) (\S+)$/.exec(item) ?? refused();
  plan.grown[found[1]] = [...(plan.grown[found[1]] ?? []), ...found[3].split(',').map(text => readFunction(text, found[2]))];
}

function readItem(item, plan) {
  if (item.startsWith('G ')) return readGrown(item, plan);
  return /^[MADR] ./.test(item) ? readChange(item, plan) : refused();
}

export function decodePlan(text) {
  const at = text.lastIndexOf(';#');
  const body = text.slice(0, at);
  if (at < 0 || digestOf(body) !== text.slice(at + 2)) refused();
  const [head, ...items] = body.split(';');
  const found = PLAN_HEAD.exec(head) ?? refused();
  const plan = { sha: found[1], base: found[2], changes: [], hunks: {}, grown: {} };
  for (const item of items) readItem(item, plan);
  return found[3] ? { ...plan, hunks: null } : plan;
}
