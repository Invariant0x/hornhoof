import { factsOf, sameShape, type Facts, type Query, type TableFacts } from './facts.js';
import { cutoffOf, differing, divergence, pathOf } from './plan.js';
import {
  backupsOf, consumedIds, FILE_HASH, handoversOf, horizonOf, journalIds, journalRows, keyText, lastChange, nonEmptyTables, openConflicts, parkedOf, restoresOf, rowsByKeys, rowsOf, type JournalRow, type Row,
} from './read.js';
import { ruleOf } from './rules.js';

/* A task with code: its number on the source, the branch by that number, and the machines the source's turns on it ran
   on with their last time. */
export type CodeLine = { task: string; number: number; branch: string; machines: { name: string; at: string }[] };

export type NameKeys = (q: Query, rows: (Row | null)[]) => Promise<void>;

export type SourceRequest = {
  compare: boolean;
  files: Map<string, Map<string, Record<string, unknown>>>;
};

/* Raised inside the leader's transaction when the leader changed between pre-reading the source and taking the table
   locks, so the merge rolls back at once, opens the gate, reads what more it needs from the source, and runs again. */
export class NeedMoreFromSource extends Error {
  constructor(readonly extra: { compare?: boolean; files?: { table: string; key: Record<string, unknown> }[] }) {
    super('More rows are needed from the merge source.');
  }
}

function rememberFileKey(files: Map<string, Map<string, Record<string, unknown>>>, table: string, key: Record<string, unknown>): void {
  const known = files.get(table) ?? new Map<string, Record<string, unknown>>();
  known.set(keyText(key), key);
  files.set(table, known);
}

export function noteMoreNeeded(request: SourceRequest, err: NeedMoreFromSource): void {
  if (err.extra.compare) request.compare = true;
  for (const item of err.extra.files ?? []) rememberFileKey(request.files, item.table, item.key);
}

type LoadedJournal = {
  cutoff: Date | null;
  ids: Map<string, Date>;
  rows: JournalRow[];
  rowsLoaded: boolean;
  rowsById: Set<string>;
  byTable: Map<string, Map<string, Row>>;
};

const keyOf = (t: TableFacts, row: Row): Record<string, unknown> => Object.fromEntries(t.key.map(name => [name, row[name]]));

function keysByTable(rows: JournalRow[]): Map<string, Record<string, unknown>[]> {
  const grouped = new Map<string, Map<string, Record<string, unknown>>>();
  for (const row of rows) {
    let keys = grouped.get(row.tbl);
    if (!keys) grouped.set(row.tbl, (keys = new Map()));
    keys.set(keyText(row.key), row.key);
  }
  return new Map([...grouped].map(([table, keys]) => [table, [...keys.values()]]));
}

async function loadJournalTable(src: Query, t: TableFacts, keys: Record<string, unknown>[], rows: JournalRow[], nameKeys: NameKeys): Promise<Map<string, Row>> {
  const xs = await rowsByKeys(src, t, keys);
  if (t.name === 'map_returns') {
    const oldRows = rows.filter(row => row.tbl === 'map_returns').map(row => row.old);
    await nameKeys(src, [...xs.values(), ...oldRows]);
  }
  return xs;
}

async function loadJournalTables(src: Query, facts: Facts, rows: JournalRow[], nameKeys: NameKeys): Promise<Map<string, Map<string, Row>>> {
  const byTable = new Map<string, Map<string, Row>>();
  const grouped = keysByTable(rows);
  for (const name of facts.order) {
    const keys = grouped.get(name);
    if (!keys || ruleOf(name).kind === 'skip') continue;
    byTable.set(name, await loadJournalTable(src, facts.tables.get(name)!, keys, rows, nameKeys));
  }
  return byTable;
}

async function readJournalSide(
  leader: Query,
  src: Query,
  facts: Facts,
  kept: boolean,
  forceCompare: boolean,
  nameKeys: NameKeys,
): Promise<{ horizon: Date | null; restores: string[]; journal: LoadedJournal | null; needsCompare: boolean }> {
  if (kept) return { horizon: null, restores: [], journal: null, needsCompare: true };
  const [horizon, restores, leaderHorizon, leaderRestores] = [await horizonOf(src), await restoresOf(src), await horizonOf(leader), await restoresOf(leader)];
  const cutoff = cutoffOf(horizon, leaderHorizon);
  const [ids, ownIds] = [await journalIds(src, cutoff), await journalIds(leader, cutoff)];
  const lacking = [...ids.keys()].filter(id => !ownIds.has(id));
  const parted = divergence(ids, ownIds, await consumedIds(leader, lacking));
  const byCompare = forceCompare || pathOf({ kept: false, leaderRestores, sourceRestores: restores, shared: parted.shared }) === 'compare';
  if (byCompare) return { horizon, restores, journal: { cutoff, ids, rows: [], rowsLoaded: false, rowsById: new Set(), byTable: new Map() }, needsCompare: true };
  const rows = await journalRows(src, parted.a);
  const byTable = await loadJournalTables(src, facts, rows, nameKeys);
  return { horizon, restores, journal: { cutoff, ids, rows, rowsLoaded: true, rowsById: new Set(parted.a), byTable }, needsCompare: false };
}

const isComparedTable = (name: string): boolean => {
  const rule = ruleOf(name);
  return rule.kind !== 'skip' && rule.afterRestore !== 'skip';
};

async function readTablePages(src: Query, t: TableFacts, nameKeys: NameKeys): Promise<Row[][]> {
  const pages: Row[][] = [];
  for await (const page of rowsOf(src, t)) {
    if (t.name === 'map_returns') await nameKeys(src, page);
    pages.push(page);
  }
  return pages;
}

const fileColumns = (t: TableFacts): string[] => t.columns.filter(column => column.type === 'bytea').map(column => column.name);

const hasFiles = (t: TableFacts): boolean => fileColumns(t).length > 0;

async function readComparedTables(src: Query, facts: Facts, nameKeys: NameKeys): Promise<Map<string, Row[][]>> {
  const names = facts.order.filter(isComparedTable);
  const nonEmpty = await nonEmptyTables(src, names.filter(name => !hasFiles(facts.tables.get(name)!)));
  const compared = new Map<string, Row[][]>();
  for (const name of names) {
    const t = facts.tables.get(name)!;
    compared.set(name, hasFiles(t) || nonEmpty.has(name) ? await readTablePages(src, t, nameKeys) : []);
  }
  return compared;
}

async function readCompareSide(
  src: Query,
  facts: Facts,
  needsCompare: boolean,
  nameKeys: NameKeys,
): Promise<{ compared: Map<string, Row[][]> | null; last: Date | null }> {
  if (!needsCompare) return { compared: null, last: null };
  return { compared: await readComparedTables(src, facts, nameKeys), last: await lastChange(src) };
}

const hasFileHash = (row: Row, columns: string[]): boolean =>
  columns.some(name => typeof row[name] === 'string' && (row[name] as string).startsWith(FILE_HASH));

const needsFileBytes = (t: TableFacts, x: Row, y: Row | undefined): boolean => !y || differing(t, x, y).length > 0;

function candidateTableRows(name: string, journal: LoadedJournal | null, compared: Map<string, Row[][]> | null): Row[] {
  const fromJournal = [...(journal?.byTable.get(name)?.values() ?? [])];
  const fromCompare = (compared?.get(name) ?? []).flat();
  return [...fromJournal, ...fromCompare];
}

function wantedFileKeys(t: TableFacts, withHashes: Row[], onLeader: Map<string, Row>, extra: Map<string, Record<string, unknown>>): Map<string, Record<string, unknown>> {
  const keys = new Map(extra);
  for (const x of withHashes) {
    const key = keyOf(t, x);
    if (needsFileBytes(t, x, onLeader.get(keyText(key)))) keys.set(keyText(key), key);
  }
  return keys;
}

async function loadWholeRows(src: Query, t: TableFacts, wanted: Map<string, Record<string, unknown>>): Promise<Map<string, Row | null>> {
  if (wanted.size === 0) return new Map();
  const loaded = await rowsByKeys(src, t, [...wanted.values()], undefined, true);
  return new Map([...wanted.keys()].map(text => [text, loaded.get(text) ?? null]));
}

async function loadTableFiles(leader: Query, src: Query, t: TableFacts, rows: Row[], extra: Map<string, Record<string, unknown>>): Promise<Map<string, Row | null>> {
  const withHashes = rows.filter(row => hasFileHash(row, fileColumns(t)));
  const onLeader = withHashes.length > 0 ? await rowsByKeys(leader, t, withHashes.map(row => keyOf(t, row))) : new Map<string, Row>();
  return loadWholeRows(src, t, wantedFileKeys(t, withHashes, onLeader, extra));
}

async function readSourceFiles(
  leader: Query,
  src: Query,
  facts: Facts,
  journal: LoadedJournal | null,
  compared: Map<string, Row[][]> | null,
  requested: Map<string, Map<string, Record<string, unknown>>>,
): Promise<Map<string, Map<string, Row | null>>> {
  const files = new Map<string, Map<string, Row | null>>();
  for (const t of facts.tables.values()) {
    if (fileColumns(t).length === 0) continue;
    const rows = candidateTableRows(t.name, journal, compared);
    const extra = requested.get(t.name) ?? new Map<string, Record<string, unknown>>();
    files.set(t.name, await loadTableFiles(leader, src, t, rows, extra));
  }
  return files;
}

async function readSourceCode(src: Query): Promise<Map<string, CodeLine>> {
  const rows = await src<{ id: string; number: number; name: string; at: Date }>(
    `SELECT t.id::text AS id, t.number, COALESCE(NULLIF(m.hostname, ''), 'the server') AS name, max(COALESCE(j.finished_at, j.started_at)) AS at
       FROM public.jobs j
       JOIN public.tasks t ON t.id = j.task_id
       LEFT JOIN public.nodes n ON n.id = j.node_id
       LEFT JOIN public.machines m ON m.id = n.machine_id
      GROUP BY t.id, t.number, 3
     HAVING max(COALESCE(j.finished_at, j.started_at)) IS NOT NULL
      ORDER BY t.id, 3`,
  );
  const code = new Map<string, CodeLine>();
  for (const row of rows) {
    let line = code.get(row.id);
    if (!line) code.set(row.id, (line = { task: row.id, number: row.number, branch: `task-${row.number}`, machines: [] }));
    line.machines.push({ name: row.name, at: new Date(row.at).toISOString() });
  }
  return code;
}

const cutoffMs = (at: Date | null): number => (at ? at.getTime() : -Infinity);

const cutoffMovedBack = (loaded: Date | null, asked: Date | null): boolean =>
  loaded !== null && cutoffMs(asked) < cutoffMs(loaded);

function filterIdsFrom(ids: Map<string, Date>, cutoff: Date | null): Map<string, Date> {
  if (!cutoff) return ids;
  const from = cutoff.getTime();
  return new Map([...ids].filter(([, at]) => at.getTime() >= from));
}

async function checkSourceReady(
  leader: Query,
  src: Query,
  merge: { id: string; companyId: string },
  anotherCompany: string,
  refuse: (reason: string) => never,
): Promise<{ facts: Facts; companyId: string | null }> {
  const [row] = await leader<{ status: string }>('SELECT status FROM net.merges WHERE id = $1::uuid', [merge.id]);
  if (row?.status !== 'pending') refuse('The merge was applied already.');
  const [leaderFacts, facts] = [await factsOf(leader), await factsOf(src)];
  const shape = sameShape(leaderFacts, facts);
  if (shape) refuse(shape);
  for (const name of leaderFacts.tables.keys()) ruleOf(name);
  const [theirs] = await src<{ id: string }>('SELECT id FROM public.companies LIMIT 1');
  const companyId = theirs?.id ?? null;
  if (companyId !== merge.companyId) refuse(anotherCompany);
  return { facts, companyId };
}

/* Everything a merge reads from its source, gathered before the gate of the app's writes closes and before the leader
   opens its write transaction, so no network read ever holds a transaction or delays a company write. */
export class SourceSnapshot {
  constructor(
    readonly facts: Facts,
    readonly companyId: string | null,
    readonly horizon: Date | null,
    readonly restores: string[],
    readonly parked: Row[],
    readonly conflicts: Row[],
    readonly backups: Row[],
    readonly handovers: Row[],
    readonly lastChange: Date | null,
    private readonly journal: LoadedJournal | null,
    private readonly compared: Map<string, Row[][]> | null,
    private readonly files: Map<string, Map<string, Row | null>>,
    private readonly code: Map<string, CodeLine>,
  ) {}

  journalIdsAt(cutoff: Date | null): Map<string, Date> {
    if (!this.journal || cutoffMovedBack(this.journal.cutoff, cutoff)) throw new NeedMoreFromSource({});
    return filterIdsFrom(this.journal.ids, cutoff);
  }

  journalRowsFor(ids: string[]): JournalRow[] {
    if (!this.journal?.rowsLoaded || ids.some(id => !this.journal!.rowsById.has(id))) throw new NeedMoreFromSource({});
    const wanted = new Set(ids);
    return this.journal.rows.filter(row => wanted.has(row.id));
  }

  rowsOfJournal(table: string): Map<string, Row> {
    return this.journal?.byTable.get(table) ?? new Map();
  }

  pagesOf(table: string): Row[][] {
    if (!this.compared) throw new NeedMoreFromSource({ compare: true });
    return this.compared.get(table) ?? [];
  }

  wholeOf(table: string, key: Record<string, unknown>): Row | null {
    const tableFiles = this.files.get(table);
    const text = keyText(key);
    if (!tableFiles?.has(text)) throw new NeedMoreFromSource({ files: [{ table, key }] });
    return tableFiles.get(text)!;
  }

  codeFor(taskId: string): CodeLine | null {
    return this.code.get(taskId) ?? null;
  }
}

export async function prepareSource(
  leader: Query,
  src: Query,
  merge: { id: string; kept: boolean; companyId: string },
  request: SourceRequest,
  nameKeys: NameKeys,
  anotherCompany: string,
  refuse: (reason: string) => never,
): Promise<SourceSnapshot> {
  const { facts, companyId } = await checkSourceReady(leader, src, merge, anotherCompany, refuse);
  const side = await readJournalSide(leader, src, facts, merge.kept, request.compare, nameKeys);
  const { compared, last } = await readCompareSide(src, facts, side.needsCompare, nameKeys);
  const [parked, conflicts, backups, handovers] = [await parkedOf(src), await openConflicts(src), await backupsOf(src), await handoversOf(src)];
  const files = await readSourceFiles(leader, src, facts, side.journal, compared, request.files);
  const code = await readSourceCode(src);
  return new SourceSnapshot(facts, companyId, side.horizon, side.restores, parked, conflicts, backups, handovers, last, side.journal, compared, files, code);
}
