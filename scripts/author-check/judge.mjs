import { functionKey } from './plan.mjs';

const ENTRY = /\{:name "((?:[^"\\]|\\.)*)", :namespace "((?:[^"\\]|\\.)*)", :complexity (\d+), :coverage ([\d.]+|nil), :crap ([\d.]+|nil)\}/g;
/* An unavailable stage for one of these says what the change or the repository is, not that a tool let the check down. */
const DECLARED = new Set(['repo_has_no_formatter', 'nothing_to_lint', 'nothing_to_typecheck', 'nothing_selected', 'no_source_changed', 'no_coverage_adapter']);
const CRAP_LIMIT = 10;

const unescaped = text => text.replace(/\\(.)/g, '$1');
const numberOrNull = text => (text === 'nil' ? null : Number(text));

export function parseCrapEdn(text) {
  return [...text.matchAll(ENTRY)].map(([, name, namespace, complexity, coverage, crap]) => (
    { name: unescaped(name), namespace: unescaped(namespace), complexity: Number(complexity), coverage: numberOrNull(coverage), crap: numberOrNull(crap) }));
}

function verdictOf(entry, baseCc) {
  if (entry.crap === null) return 'unknown';
  if (entry.crap < CRAP_LIMIT) return 'ok';
  return baseCc !== null && entry.complexity <= baseCc ? 'touched' : 'fails';
}

/* Functions of one name in one namespace have nothing else to tell them apart, so the most complex meets the most complex. */
export function judgeFunctions(entries, base) {
  const left = new Map(Object.entries(base).map(([key, values]) => [key, [...values].sort((a, b) => b - a)]));
  const judged = [];
  const order = entries.map((entry, index) => ({ entry, index })).sort((a, b) => b.entry.complexity - a.entry.complexity);
  for (const { entry, index } of order) {
    const baseCc = left.get(functionKey(entry))?.shift() ?? null;
    judged[index] = { ...entry, baseCc, verdict: verdictOf(entry, baseCc) };
  }
  return judged;
}

/* A touched function stays out: the consumer of this number fails anything at 10, and this function is not to fail. */
export function worstCrap(judged) {
  if (judged.some(item => item.verdict === 'unknown')) return null;
  const counted = judged.filter(item => item.verdict !== 'touched').map(item => item.crap);
  return counted.length ? Math.max(...counted) : null;
}

export function parseLcov(text) {
  const files = {};
  let current = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) current = files[line.slice(3)] = {};
    const hit = /^DA:(\d+),(\d+)/.exec(line);
    if (hit) current[hit[1]] = Number(hit[2]);
  }
  return files;
}

/* Lines coverage does not know, such as a blank one, are not counted. A file coverage does not know makes it all unknown. */
export function changedLines(hunks, coverage, paths) {
  if (!paths.length || paths.some(path => !coverage[path])) return null;
  let covered = 0, total = 0;
  for (const path of paths) {
    for (const [start, count] of hunks[path] ?? []) {
      for (let line = start; line < start + count; line += 1) {
        if (coverage[path][line] === undefined) continue;
        total += 1;
        if (coverage[path][line] > 0) covered += 1;
      }
    }
  }
  return { covered, total };
}

export function parseVitestJson(text) {
  try {
    const { numTotalTests: total, numPassedTests: passed, numFailedTests: failed } = JSON.parse(text);
    return Number.isInteger(total) ? { passed, failed, skipped: total - passed - failed, total } : null;
  } catch { return null; }
}

export function parseTap(text) {
  const count = name => Number(new RegExp(`^# ${name} (\\d+)$`, 'm').exec(text ?? '')?.[1] ?? NaN);
  const total = count('tests');
  if (Number.isNaN(total)) return null;
  return { passed: count('pass'), failed: count('fail') + count('cancelled'), skipped: count('skipped') + count('todo'), total };
}

export const countDuplicates = output => (output.match(/^DUPLICATE /gm) ?? []).length;

export function exitCodeOf(stages) {
  if (stages.some(stage => stage.status === 'failed')) return 1;
  return stages.some(stage => stage.status === 'unavailable' && stage.name !== 'dryer' && !DECLARED.has(stage.reason)) ? 2 : 0;
}
