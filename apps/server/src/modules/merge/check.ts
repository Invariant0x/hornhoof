import type { Db } from '../../db/client.js';
import { withNamedKeys } from './apply.js';
import { factsOf, type Facts, type Query, type TableFacts } from './facts.js';
import { queryOf } from './leader.js';
import { differing } from './plan.js';
import { backupsOf, parkedOf, horizonOf, journalIds, journalRows, keyText, netTables, nonEmptyTables, openConflicts, restoresOf, rowsByKeys, rowsOf, type Row } from './read.js';
import { ruleOf } from './rules.js';
import type { MergeSource } from './source.js';

/* How many rows that nothing accounts for are named. */
const NAMED = 20;
const BATCH = 1000;

type Missing = { table: string; key: Record<string, unknown> };

const isCheckedTable = (name: string, byJournal: boolean): boolean => {
  const rule = ruleOf(name);
  return rule.kind !== 'skip' && (byJournal || rule.afterRestore !== 'skip');
};

const hasFiles = (t: TableFacts): boolean => t.columns.some(column => column.type === 'bytea');

async function checkedTables(src: Query, facts: Facts, byJournal: boolean): Promise<string[]> {
  const candidates = facts.order.filter(name => isCheckedTable(name, byJournal));
  const nonEmpty = await nonEmptyTables(src, candidates.filter(name => !hasFiles(facts.tables.get(name)!)));
  return candidates.filter(name => hasFiles(facts.tables.get(name)!) || nonEmpty.has(name));
}

/* What the leader's records say of rows of one table: the keys a conflict of any merge names, those a merge left to a
   skipped transaction or found under another key here, and the columns a merge wrote otherwise than the source has
   them. */
async function recordsOf(q: Query, table: string): Promise<{ named: Set<string>; rewritten: Map<string, Set<string>> }> {
  const named = new Set<string>();
  const rewritten = new Map<string, Set<string>>();
  for (const row of await q<{ key: Record<string, unknown> }>('SELECT key FROM net.merge_conflicts WHERE tbl = $1', [table])) named.add(keyText(row.key));
  for (const row of await q<{ key: Record<string, unknown>; how: string; cols: string[] }>('SELECT key, how, cols FROM net.merge_rows WHERE tbl = $1', [table])) {
    if (row.how !== 'rewritten') named.add(keyText(row.key));
    else rewritten.set(keyText(row.key), new Set([...(rewritten.get(keyText(row.key)) ?? []), ...row.cols]));
  }
  return { named, rewritten };
}

/* Whether everything the source holds is on the leader or listed there, read in a new snapshot of the source after the
   merge was applied. Only then may the source go. A row that is neither there nor listed keeps this failing and the
   source kept, the safe way. */
export async function complete(db: Db, mergeId: string, source: MergeSource): Promise<{ ok: boolean; missing: Missing[] }> {
  const q = queryOf(db);
  const src = source.query;
  const [merge] = await q<{ path: string | null; cutoff: Date | null; applied_at: Date | null; xact: string | null }>('SELECT path, cutoff, applied_at, xact FROM net.merges WHERE id = $1::uuid', [mergeId]);
  if (!merge?.path || !merge.applied_at) return { ok: false, missing: [] };
  const missing: Missing[] = [];
  const byJournal = merge.path === 'journal';
  const theirs = byJournal ? await journalIds(src, merge.cutoff) : new Map<string, Date>();

  /* By the journal, every change of the source since the two parted is on the leader or was dealt with by a merge. */
  if (byJournal) {
    const ids = [...theirs.keys()];
    const unknown: string[] = [];
    for (let from = 0; from < ids.length; from += BATCH) {
      const rows = await q<{ id: string }>(
        `SELECT v.value AS id FROM jsonb_array_elements_text($1::jsonb) v
         WHERE NOT EXISTS (SELECT 1 FROM net.journal j WHERE j.id = v.value::uuid) AND NOT EXISTS (SELECT 1 FROM net.merge_consumed c WHERE c.journal = v.value::uuid)`,
        [JSON.stringify(ids.slice(from, from + BATCH))],
      );
      unknown.push(...rows.map(row => row.id));
    }
    for (const row of await journalRows(src, unknown.slice(0, NAMED))) missing.push({ table: row.tbl, key: row.key });
  }

  /* The company's own later change or deletion of a row: the leader's journal names its key since the two parted, in a
     transaction that is not this merge's. By the journal, since the two parted means a row the source's journal lacks. */
  const changedSince = async (table: string, key: Record<string, unknown>): Promise<boolean> => {
    const rows = await q<{ id: string }>(
      'SELECT j.id FROM net.journal j WHERE j.tbl = $1 AND j.key = $2::jsonb AND ($3::timestamptz IS NULL OR j.at >= $3::timestamptz) AND ($4::uuid IS NULL OR j.xact <> $4::uuid)',
      [table, JSON.stringify(key), byJournal ? merge.cutoff : merge.applied_at, merge.xact],
    );
    return byJournal ? rows.some(row => !theirs.has(row.id)) : rows.length > 0;
  };

  const facts = await factsOf(q);
  for (const name of await checkedTables(src, facts, byJournal)) {
    const rule = ruleOf(name);
    const t = facts.tables.get(name) as TableFacts;
    const by = rule.kind === 'log' && rule.match && !(t.key.length === 1 && t.key[0] === rule.match) ? rule.match : undefined;
    const keyOf = (x: Row): Record<string, unknown> => Object.fromEntries(t.key.map(column => [column, x[column]]));
    const lookedUpBy = (x: Row): Record<string, unknown> => (by ? { [by]: x[by] } : keyOf(x));
    /* What names the row in the records: its key, or for a log what names it on both sides. */
    const named = (x: Row): Record<string, unknown> => (rule.kind === 'log' && rule.match ? { [rule.match]: x[rule.match] } : keyOf(x));
    let records: Awaited<ReturnType<typeof recordsOf>> | null = null;
    for await (const page of rowsOf(src, t)) {
      const found = await rowsByKeys(q, t, page.map(lookedUpBy), by);
      const ys = page.map(x => found.get(keyText(lookedUpBy(x))) ?? null);
      if (name === 'map_returns') {
        await withNamedKeys(src, page);
        await withNamedKeys(q, ys);
      }
      for (const [index, x] of page.entries()) {
        const y = ys[index]!;
        if (y && rule.kind !== 'rows') continue;
        const key = named(x);
        records ??= await recordsOf(q, name);
        const written = records.rewritten.get(keyText(key));
        if (y && differing(t, x, y).every(column => written?.has(column))) continue;
        if (records.named.has(keyText(key)) || (await changedSince(name, keyOf(x)))) continue;
        missing.push({ table: name, key });
      }
    }
  }

  /* Every bundle the source knew of and every conflict it left open is on the leader. */
  const held = new Set((await backupsOf(q)).map(row => String(row.id)));
  for (const backup of await backupsOf(src)) if (!held.has(String(backup.id))) missing.push({ table: 'net.backups', key: { id: backup.id } });
  /* And everything nodes told the source of jobs it had no row of. */
  const parked = new Set((await parkedOf(q)).map(row => String(row.id)));
  for (const row of await parkedOf(src)) if (!parked.has(String(row.id))) missing.push({ table: 'net.parked', key: { id: row.id } });
  for (const conflict of await openConflicts(src)) {
    const first = conflict.carried ?? conflict.id;
    const [there] = await q('SELECT 1 AS found FROM net.merge_conflicts WHERE id = $1::uuid OR carried = $1::uuid LIMIT 1', [first]);
    if (!there) missing.push({ table: 'net.merge_conflicts', key: { id: first } });
  }
  return { ok: missing.length === 0, missing: missing.slice(0, NAMED) };
}

/* How the old database of a copy, or what a machine uploaded, is dealt with. fast: it never wrote and holds nothing the
   leader lacks, so it is merged by its ids alone. left_out: it holds nothing but what a database the CEO left out held.
   whole: it is compared row by row, as any database that came back. */
type FastWay = 'fast' | 'left_out' | 'whole';

/* Decides that from a few columns alone, so it runs before the two shapes are compared and a copy of an older schema
   merges. A copy that never held a term wrote nothing of its own: every row it holds came from the leader, with its
   journal row in the same transaction, so whatever it holds that the leader lacks is what the leader deleted since.
   Only a restore takes rows from the leader that it did not delete itself: a source that lacks one of the leader's
   restores is compared whole, unless the CEO left out the database that restore set aside, and then the copy, which
   holds no more than that database did, is left out with it. restoreAt: the time of the newest such restore. */
export async function fastWay(db: Db, source: MergeSource): Promise<{ way: FastWay; restoreAt: Date | null }> {
  const q = queryOf(db);
  const src = source.query;
  const whole = { way: 'whole' as const, restoreAt: null };
  const [state] = await src<{ there: boolean }>(`SELECT to_regclass('net_local.state') IS NOT NULL AS there`);
  /* A term that ended in a planned handover wrote nothing the new leader lacks: such a database counts as a copy. */
  if (state?.there && (await src(`SELECT 1 AS led FROM net_local.state s WHERE to_jsonb(s) ->> 'handed_lsn' IS NULL LIMIT 1`)).length > 0) return whole;

  const theirs = new Set(await restoresOf(src));
  const lacking = (await q<{ attempt: string; kept: string | null; at: Date | string }>('SELECT attempt, kept, dumped_at AS at FROM net.restores ORDER BY at, attempt')).filter(row => !theirs.has(row.attempt));
  let restoreAt: Date | null = null;
  for (const restore of lacking) {
    const [merge] = restore.kept ? await q<{ fork: string | null; merged_at: unknown; status: string }>('SELECT fork, merged_at, status FROM net.merges WHERE source = $1', [`kept:${restore.kept}`]) : [];
    if (!merge || merge.fork === null || merge.merged_at !== null || (merge.status !== 'removing' && merge.status !== 'done')) return whole;
    const at = new Date(restore.at);
    if (!restoreAt || at > restoreAt) restoreAt = at;
  }
  if (lacking.length > 0) return { way: 'left_out', restoreAt };

  /* Every change the source knows of, from where the leader's own journal begins, is on the leader or was dealt with. */
  const ids = [...(await journalIds(src, await horizonOf(q))).keys()];
  for (let from = 0; from < ids.length; from += BATCH) {
    const unknown = await q<{ id: string }>(
      `SELECT v.value AS id FROM jsonb_array_elements_text($1::jsonb) v
       WHERE NOT EXISTS (SELECT 1 FROM net.journal j WHERE j.id = v.value::uuid) AND NOT EXISTS (SELECT 1 FROM net.merge_consumed c WHERE c.journal = v.value::uuid) LIMIT 1`,
      [JSON.stringify(ids.slice(from, from + BATCH))],
    );
    if (unknown.length > 0) return whole;
  }
  const tables = await netTables(src);
  if (tables.has('merge_conflicts') && (await src('SELECT 1 AS open FROM net.merge_conflicts WHERE picked IS NULL LIMIT 1')).length > 0) return whole;
  if (tables.has('backups')) {
    const held = new Set((await q<{ id: string }>('SELECT id FROM net.backups')).map(row => row.id));
    if ((await src<{ id: string }>('SELECT id FROM net.backups')).some(row => !held.has(row.id))) return whole;
  }
  return { way: 'fast', restoreAt: null };
}
