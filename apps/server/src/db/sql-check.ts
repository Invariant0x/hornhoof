import type { A_Indirection, ColumnRef, FuncCall, Node } from 'libpg-query';
import { PARSER_DEADLINE_MS, startParserWorker, ThrowawayParser } from './sql-parser.js';

export const ONLY_STATEMENTS = 'This tool runs only SELECT, INSERT, UPDATE, DELETE and WITH statements; Hornhoof begins and commits the transaction itself.';

/* What the tool refuses by name: these reach other sessions, settings or large objects, or run query text the parser never
   sees. 'lo_*' stands for the prefix. This is the one list: what the database takes away from PUBLIC names the same functions. */
export const REFUSED_FUNCTIONS: string[] = [
  'pg_cancel_backend',
  'pg_terminate_backend',
  'pg_reload_conf',
  'set_config',
  'lo_*',
  'loread',
  'lowrite',
  'query_to_xml',
  'query_to_xmlschema',
  'query_to_xml_and_xmlschema',
  'ts_stat',
  'ts_rewrite',
];

const REFUSED_NAMES = new Set(REFUSED_FUNCTIONS.filter(name => !name.endsWith('*')));
const REFUSED_PREFIXES = REFUSED_FUNCTIONS.filter(name => name.endsWith('*')).map(name => name.slice(0, -1));
const FENCE_SCHEMAS = new Set(['net', 'net_local']);
const ROW_STATEMENTS = new Set(['SelectStmt', 'InsertStmt', 'UpdateStmt', 'DeleteStmt']);

export class SqlRefused extends Error {
  constructor(
    readonly kind: 'statement' | 'function' | 'syntax',
    message: string,
  ) {
    super(message);
    this.name = 'SqlRefused';
  }
}

/* The parser has already folded an unquoted name, and a quoted one in other case names another function. */
const isRefusedName = (name: string): boolean => REFUSED_NAMES.has(name) || REFUSED_PREFIXES.some(prefix => name.startsWith(prefix));
const ifRefused = (name: string | undefined): string | undefined => (name !== undefined && isRefusedName(name) ? name : undefined);

/* The names in a list of parser nodes; a star or an index in the list has none. */
const namesIn = (parts: Node[] = []): string[] => parts.flatMap(part => ('String' in part && part.String.sval) || []);

/* Every part but the last counts as a qualifier, as Postgres takes `db.net.f()` when db is the database it runs in. */
function refusedCall({ funcname }: FuncCall): string | undefined {
  const parts = namesIn(funcname);
  const inFence = parts.slice(0, -1).some(part => FENCE_SCHEMAS.has(part));
  return inFence ? parts.join('.') : ifRefused(parts.at(-1));
}

/* Postgres resolves `a.f` as the call f(a) when a has no such column, so a name in the last field counts as a call. A star
   there means every column of a, which calls nothing, and a lone name can only be a column. */
const refusedColumn = ({ fields = [] }: ColumnRef): string | undefined => (fields.length >= 2 ? ifRefused(namesIn(fields.slice(-1)).at(0)) : undefined);

/* `(x).f` is the call f(x) when x has no such field, wherever f stands in the chain. */
const refusedIndirection = ({ indirection }: A_Indirection): string | undefined => namesIn(indirection).find(isRefusedName);

function refusedNameIn(key: string, node: unknown): string | undefined {
  switch (key) {
    case 'FuncCall':
      return refusedCall(node as FuncCall);
    case 'ColumnRef':
      return refusedColumn(node as ColumnRef);
    case 'A_Indirection':
      return refusedIndirection(node as A_Indirection);
    default:
      return undefined;
  }
}

/* Every statement kind of the parser's grammar starts with a capital and ends in Stmt, and its version is pinned exactly; a
   field such as an INSERT's selectStmt starts small and only holds a kind. This looks at every level, as WITH takes a MERGE,
   and INTO stands on the leftmost branch of a set operation, not on the statement at the top. */
const STATEMENT_KIND = /^[A-Z]\w*Stmt$/;
const isRefusedStatement = (key: string): boolean => key === 'intoClause' || (STATEMENT_KIND.test(key) && !ROW_STATEMENTS.has(key));

const entriesInside = (value: unknown): [string, unknown][] => (typeof value === 'object' && value !== null ? Object.entries(value) : []);

/* Every key of the tree with its value, whatever kind of node holds it, so that a kind nobody listed cannot hide a call. A
   list of what waits, not recursion, as the parser can hand back a tree thousands of levels deep. What waits goes in last
   to first, so that it comes out in the order of the tree, and the first statement's fault is the one the text hears of. */
function* entriesOf(tree: unknown): Generator<[string, unknown]> {
  const waiting = entriesInside(tree).reverse();
  while (waiting.length > 0) {
    const entry = waiting.pop()!;
    yield entry;
    for (const inner of entriesInside(entry[1]).reverse()) waiting.push(inner);
  }
}

function refuseWhatTheTreeHolds(tree: unknown): void {
  for (const [key, value] of entriesOf(tree)) {
    if (isRefusedStatement(key)) throw new SqlRefused('statement', ONLY_STATEMENTS);
    const name = refusedNameIn(key, value);
    if (name) throw new SqlRefused('function', `This tool does not call ${name}.`);
  }
}

const parser = new ThrowawayParser(startParserWorker, PARSER_DEADLINE_MS);
const NOTHING_TO_CHECK = 'The text is empty.';
const PARSER_GAVE_OUT = 'The parser gave up on this text, so it cannot be checked. Write it shorter or less deeply nested.';

/* Whatever stops the parser stops the text. The library takes an empty text for a failure of its own, and a parser is not
   worth replacing over that. */
async function parsed(text: string): Promise<unknown> {
  if (text.trim() === '') throw new SqlRefused('syntax', NOTHING_TO_CHECK);
  const answer = await parser.parse(text);
  if ('tree' in answer) return JSON.parse(answer.tree);
  throw new SqlRefused('syntax', 'refused' in answer ? answer.refused : PARSER_GAVE_OUT);
}

/* The parser reads its own copy of the text. A NUL ends that copy, and half a surrogate pair is counted short when it is
   made, so that it loses the text's end, while the database gets all of it. Such a text could say more to the database
   than to this check. With the u flag the class matches only a half, never a whole pair. */
const READ_DIFFERENTLY = /[\0\uD800-\uDFFF]/u;
const UNREADABLE = 'The text holds a NUL or a broken Unicode character, so it cannot be checked.';

/* Stands between the head of Operations' text and the database: the database's rights are the first guard, this one sees
   what rights cannot, such as COMMIT or SET. It throws SqlRefused for a text that may not run. */
export async function checkAgentSql(text: string): Promise<void> {
  if (READ_DIFFERENTLY.test(text)) throw new SqlRefused('syntax', UNREADABLE);
  refuseWhatTheTreeHolds(await parsed(text));
}
