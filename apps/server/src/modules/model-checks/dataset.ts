import { createHash } from 'node:crypto';
import { Case, type ModelCheckKind } from '@hornhoof/protocol';

/* A set of examples is the bytes of a JSONL file: each version is immutable, and its hash is of those very bytes. A file
   with one bad line is refused whole, as a run over part of what was labelled would prove less than it says. */

type ProblemCode = 'not_utf8' | 'empty' | 'empty_line' | 'not_json' | 'invalid_case' | 'wrong_kind' | 'input_kind' | 'expected_form' | 'must_block_expected' | 'class_unknown' | 'expected_weaker' | 'self_labelled' | 'duplicate_id' | 'no_incident';
export type DatasetProblem = { line: number; code: ProblemCode };
export type Dataset = { hash: string; cases: Case[]; holdout: number; mustBlock: number };
export type Party = Case['labelledBy'];
export type DatasetRules = { kind: ModelCheckKind; authors: readonly Party[] };
type Refused = { ok: false; problems: DatasetProblem[] };
type Parsed = { ok: true; dataset: Dataset } | Refused;

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const refused = (line: number, code: ProblemCode): Refused => ({ ok: false, problems: [{ line, code }] });
const sameParty = (a: Party, b: Party): boolean => a.kind === b.kind && a.id === b.id;

/* Whether an expected result asks to stop: a block, or a person to look at it. */
export const asksToStop = (expected: Case['expected']): boolean => ('classId' in expected ? expected.requiresHuman : expected.decision === 'block');

function classEntry(row: Case) {
  if (row.input.kind !== 'support_classification' || !('classId' in row.expected)) return null;
  const { classId, requiresHuman } = row.expected;
  return { requiresHuman, entry: row.input.taxonomy.find(entry => entry.classId === classId) };
}

const isUnknownClass = (row: Case): boolean => {
  const found = classEntry(row);
  return found !== null && !found.entry;
};
const weakensList = (row: Case): boolean => {
  const found = classEntry(row);
  return found?.entry?.requiresHuman === true && !found.requiresHuman;
};

const CASE_RULES: readonly [ProblemCode, (row: Case, rules: DatasetRules) => boolean][] = [
  ['wrong_kind', (row, rules) => row.kind !== rules.kind],
  ['input_kind', row => row.input.kind !== row.kind],
  ['expected_form', row => 'classId' in row.expected !== (row.kind === 'support_classification')],
  ['must_block_expected', row => row.mustBlock && !asksToStop(row.expected)],
  ['class_unknown', isUnknownClass],
  ['expected_weaker', weakensList],
  ['self_labelled', (row, rules) => rules.authors.some(author => sameParty(author, row.labelledBy))],
];

function parsedJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function readCase(line: string, rules: DatasetRules): Case | ProblemCode {
  if (line.trim() === '') return 'empty_line';
  const json = parsedJson(line);
  if (json === undefined) return 'not_json';
  const shaped = Case.safeParse(json);
  if (!shaped.success) return 'invalid_case';
  const broken = CASE_RULES.find(([, isBroken]) => isBroken(shaped.data, rules));
  return broken ? broken[0] : shaped.data;
}

function decoded(raw: Buffer): string | null {
  try {
    return UTF8.decode(raw);
  } catch {
    return null;
  }
}

const linesOf = (text: string): string[] => text.replace(/\n$/, '').split('\n');

function readLines(lines: readonly string[], rules: DatasetRules) {
  const cases: Case[] = [];
  const problems: DatasetProblem[] = [];
  const seen = new Set<string>();
  lines.forEach((line, index) => {
    const read = readCase(line, rules);
    const code = typeof read === 'string' ? read : seen.has(read.id) ? 'duplicate_id' : null;
    if (code) return void problems.push({ line: index + 1, code });
    const row = read as Case;
    seen.add(row.id);
    cases.push(row);
  });
  return { cases, problems };
}

export function parseDataset(raw: Buffer, rules: DatasetRules): Parsed {
  const text = decoded(raw);
  if (text === null) return refused(0, 'not_utf8');
  if (text.trim() === '') return refused(0, 'empty');
  const { cases, problems } = readLines(linesOf(text), rules);
  if (problems.length) return { ok: false, problems };
  const count = (test: (row: Case) => boolean) => cases.filter(test).length;
  return { ok: true, dataset: { hash: createHash('sha256').update(raw).digest('hex'), cases, holdout: count(row => row.split === 'holdout'), mustBlock: count(row => row.mustBlock) } };
}

const NEW_LINE = 0x0a;
const closed = (raw: Buffer): Buffer => (raw.at(-1) === NEW_LINE ? raw : Buffer.concat([raw, Buffer.from('\n')]));

/* A miss found in real work becomes one more example, with every earlier byte as it was, so it makes a new version. */
export function withLiveMiss(raw: Buffer, miss: Case, rules: DatasetRules): { ok: true; raw: Buffer; dataset: Dataset } | Refused {
  if (miss.sourceIncidentId === null) return refused(linesOf(raw.toString('utf8')).length + 1, 'no_incident');
  const next = Buffer.concat([closed(raw), Buffer.from(`${JSON.stringify(miss)}\n`)]);
  const parsed = parseDataset(next, rules);
  return parsed.ok ? { ok: true, raw: next, dataset: parsed.dataset } : parsed;
}
