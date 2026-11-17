import { factsOf, sameShape, type Facts, type Query, type TableFacts } from './facts.js';
import { cutoffOf, differing, divergence, pathOf } from './plan.js';
import {
  backupsOf, consumedIds, FILE_HASH, handoversOf, horizonOf, journalIds, journalRows, keyText, lastChange, nonEmptyTables, openConflicts, parkedOf, restoresOf, rowsByKeys, rowsOf, type JournalRow, type Row,
} from './read.js';
import { ruleOf } from './rules.js';

/* A task with code: its number on the source, the branch by that number, and the machines the source's turns on it ran
   on with their last time. */
export type CodeLine = { task: string; number: number; branch: string; machines: { name: string; at: string }[] };

type NameKeys = (q: Query, rows: (Row | null)[]) => Promise<void>;

/* Common source interface for Merge: streaming page-by-page for a kept or uploaded database in the leader's own
   Postgres, and a pre-read snapshot for a peer machine over the network so no network read holds a leader transaction. */
export type MergeReader = {
  facts(): Promise<Facts>;
  companyId(): Promise<string | null>;
  horizon(): Promise<Date | null>;
  restores(): Promise<string[]>;
  journalIds(cutoff: Date | null): Promise<Map<string, Date>>;
  journalRows(ids: string[]): Promise<JournalRow[]>;
  rowsForJournal(t: TableFacts, keys: Record<string, unknown>[], rows: JournalRow[]): Promise<Map<string, Row>>;
  pagesOf(t: TableFacts): AsyncIterable<Row[]>;
  wholeOf(t: TableFacts, key: Record<string, unknown>): Promise<Row | null>;
  parked(): Promise<Row[]>;
  conflicts(): Promise<Row[]>;
  backups(): Promise<Row[]>;
  handovers(): Promise<Row[]>;
  codeFor(taskId: string): Promise<CodeLine | null>;
  lastChange(): Promise<Date | null>;
};

export type SourceRequest = {
  compare: boolean;
  files: Map<string, Map<string, Record<string, unknown>>>;
};

/* Raised inside the leader's transaction when the leader changed between pre-reading the source and taking the table
   locks, so the merge rolls back at once, opens the gate, reads what more it needs from the source, and runs again. */
export class NeedMoreFromSource extends Error {
  constructor(
    readonly extra: {
      compare?: boolean;
      journal?: boolean;
      cutoff?: Date | null;
      files?: { table: string; key: Record<string, unknown> }[];
    },
  ) {
    super('More rows are needed from the merge source.');
  }
}

function rememberFileKey(files: Map<string, Map<string, Record<string, unknown>>>, table: string, key: Record<string, unknown>): boolean {
  const known = files.get(table) ?? new Map<string, Record<string, unknown>>();
  const text = keyText(key);
  if (known.has(text)) return false;
  known.set(text, key);
  files.set(table, known);
  return true;
}

export function noteMoreNeeded(request: SourceRequest, snapshot: SourceSnapshot, err: NeedMoreFromSource): boolean {
  let progressed = false;
  if (err.extra.compare && !snapshot.hasCompare()) {
    request.compare = true;
    progressed = true;
  }
  if (err.extra.journal && !snapshot.hasJournalRows()) progressed = true;
  if (err.extra.cutoff !== undefined && snapshot.cutoffMovedBack(err.extra.cutoff)) progressed = true;
  for (const item of err.extra.files ?? []) {
    if (rememberFileKey(request.files, item.table, item.key)) progressed = true;
  }
  return progressed;
}

type LoadedJournal = {
  cutoff: Date | null;
  ids: Map<string, Date>;
  rows: JournalRow[];
  rowsLoaded: boolean;
  rowsById: Set<string>;
  byTable: Map<string, Map<string, Row>>;
};

const FILE_BATCH = 16;
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

async function* streamTablePages(src: Query, t: TableFacts, nameKeys: NameKeys): AsyncGenerator<Row[]> {
  for await (const page of rowsOf(src, t)) {
    if (t.name === 'map_returns') await nameKeys(src, page);
    yield page;
  }
}

async function readTablePages(src: Query, t: TableFacts, nameKeys: NameKeys): Promise<Row[][]> {
  const pages: Row[][] = [];
  for await (const page of streamTablePages(src, t, nameKeys)) pages.push(page);
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
  const entries = [...wanted.entries()];
  const result = new Map<string, Row | null>();
  for (let from = 0; from < entries.length; from += FILE_BATCH) {
    const slice = entries.slice(from, from + FILE_BATCH);
    const loaded = await rowsByKeys(src, t, slice.map(([, key]) => key), undefined, true);
    for (const [text] of slice) result.set(text, loaded.get(text) ?? null);
  }
  return result;
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

async function readTaskCodeLine(src: Query, taskId: string): Promise<CodeLine | null> {
  const [there] = await src<{ number: number }>('SELECT number FROM public.tasks WHERE id = $1::uuid', [taskId]);
  if (!there) return null;
  const machines = await src<{ name: string; at: Date }>(
    `SELECT COALESCE(NULLIF(m.hostname, ''), 'the server') AS name, max(COALESCE(j.finished_at, j.started_at)) AS at
     FROM public.jobs j LEFT JOIN public.nodes n ON n.id = j.node_id LEFT JOIN public.machines m ON m.id = n.machine_id
     WHERE j.task_id = $1::uuid GROUP BY 1 HAVING max(COALESCE(j.finished_at, j.started_at)) IS NOT NULL ORDER BY 1`,
    [taskId],
  );
  return machines.length > 0
    ? { task: taskId, number: there.number, branch: `task-${there.number}`, machines: machines.map(m => ({ name: m.name, at: new Date(m.at).toISOString() })) }
    : null;
}

/* Streaming reader for kept and uploaded databases in the leader's own Postgres: reads 500-row pages and individual
   file rows on demand inside the transaction without holding equal rows in memory. */
export function liveMergeReader(src: Query, nameKeys: NameKeys): MergeReader {
  let parkedCache: Promise<Row[]> | undefined;
  return {
    facts: () => factsOf(src),
    companyId: async () => (await src<{ id: string }>('SELECT id FROM public.companies LIMIT 1'))[0]?.id ?? null,
    horizon: () => horizonOf(src),
    restores: () => restoresOf(src),
    journalIds: cutoff => journalIds(src, cutoff),
    journalRows: ids => journalRows(src, ids),
    rowsForJournal: (t, keys, rows) => loadJournalTable(src, t, keys, rows, nameKeys),
    pagesOf: t => streamTablePages(src, t, nameKeys),
    wholeOf: async (t, key) => (await rowsByKeys(src, t, [key], undefined, true)).values().next().value ?? null,
    parked: () => (parkedCache ??= parkedOf(src)),
    conflicts: () => openConflicts(src),
    backups: () => backupsOf(src),
    handovers: () => handoversOf(src),
    codeFor: taskId => readTaskCodeLine(src, taskId),
    lastChange: () => lastChange(src),
  };
}

const cutoffMs = (at: Date | null): number => (at ? at.getTime() : -Infinity);

const isCutoffEarlier = (loaded: Date | null, asked: Date | null): boolean =>
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

/* Everything a peer merge reads from its remote source, gathered before the gate of the app's writes closes and before
   the leader opens its write transaction, so no network read ever holds a transaction or delays a company write. */
class SourceSnapshot implements MergeReader {
  constructor(
    private readonly sourceFacts: Facts,
    private readonly sourceCompanyId: string | null,
    private readonly sourceHorizon: Date | null,
    private readonly sourceRestores: string[],
    private readonly sourceParked: Row[],
    private readonly sourceConflicts: Row[],
    private readonly sourceBackups: Row[],
    private readonly sourceHandovers: Row[],
    private readonly sourceLastChange: Date | null,
    private readonly journal: LoadedJournal | null,
    private readonly compared: Map<string, Row[][]> | null,
    private readonly files: Map<string, Map<string, Row | null>>,
    private readonly code: Map<string, CodeLine>,
  ) {}

  hasCompare(): boolean {
    return this.compared !== null;
  }

  hasJournalRows(): boolean {
    return Boolean(this.journal?.rowsLoaded);
  }

  cutoffMovedBack(cutoff: Date | null): boolean {
    return !this.journal || isCutoffEarlier(this.journal.cutoff, cutoff);
  }

  facts(): Promise<Facts> {
    return Promise.resolve(this.sourceFacts);
  }

  companyId(): Promise<string | null> {
    return Promise.resolve(this.sourceCompanyId);
  }

  horizon(): Promise<Date | null> {
    return Promise.resolve(this.sourceHorizon);
  }

  restores(): Promise<string[]> {
    return Promise.resolve(this.sourceRestores);
  }

  journalIds(cutoff: Date | null): Promise<Map<string, Date>> {
    if (!this.journal || isCutoffEarlier(this.journal.cutoff, cutoff)) throw new NeedMoreFromSource({ cutoff });
    return Promise.resolve(filterIdsFrom(this.journal.ids, cutoff));
  }

  journalRows(ids: string[]): Promise<JournalRow[]> {
    if (!this.journal?.rowsLoaded || ids.some(id => !this.journal!.rowsById.has(id))) throw new NeedMoreFromSource({ journal: true });
    const wanted = new Set(ids);
    return Promise.resolve(this.journal.rows.filter(row => wanted.has(row.id)));
  }

  rowsForJournal(t: TableFacts): Promise<Map<string, Row>> {
    return Promise.resolve(this.journal?.byTable.get(t.name) ?? new Map());
  }

  async *pagesOf(t: TableFacts): AsyncGenerator<Row[]> {
    if (!this.compared) throw new NeedMoreFromSource({ compare: true });
    for (const page of this.compared.get(t.name) ?? []) yield page;
  }

  wholeOf(t: TableFacts, key: Record<string, unknown>): Promise<Row | null> {
    const tableFiles = this.files.get(t.name);
    const text = keyText(key);
    if (!tableFiles?.has(text)) throw new NeedMoreFromSource({ files: [{ table: t.name, key }] });
    return Promise.resolve(tableFiles.get(text)!);
  }

  parked(): Promise<Row[]> {
    return Promise.resolve(this.sourceParked);
  }

  conflicts(): Promise<Row[]> {
    return Promise.resolve(this.sourceConflicts);
  }

  backups(): Promise<Row[]> {
    return Promise.resolve(this.sourceBackups);
  }

  handovers(): Promise<Row[]> {
    return Promise.resolve(this.sourceHandovers);
  }

  codeFor(taskId: string): Promise<CodeLine | null> {
    return Promise.resolve(this.code.get(taskId) ?? null);
  }

  lastChange(): Promise<Date | null> {
    return Promise.resolve(this.sourceLastChange);
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
  const forceCompare = request.compare;
  request.compare = false;
  const { facts, companyId } = await checkSourceReady(leader, src, merge, anotherCompany, refuse);
  const side = await readJournalSide(leader, src, facts, merge.kept, forceCompare, nameKeys);
  const { compared, last } = await readCompareSide(src, facts, side.needsCompare, nameKeys);
  const [parked, conflicts, backups, handovers] = [await parkedOf(src), await openConflicts(src), await backupsOf(src), await handoversOf(src)];
  const files = await readSourceFiles(leader, src, facts, side.journal, compared, request.files);
  const code = await readSourceCode(src);
  return new SourceSnapshot(facts, companyId, side.horizon, side.restores, parked, conflicts, backups, handovers, last, side.journal, compared, files, code);
}
