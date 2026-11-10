/* A journal row's at is when its row changed, not when its transaction committed, and a prune deletes in batches, so the
   two sides are read a day further back than the later horizon. */
export const HORIZON_MARGIN_MS = 86_400_000;

/* A row's to_jsonb. */
export type Row = Record<string, unknown>;

export type JournalRow = { id: string; xact: string; at: Date; tbl: string; op: 'insert' | 'update' | 'delete'; key: Record<string, unknown>; cols: string[]; old: Row | null };

/* JSON with the columns sorted, so one key is one text whichever way a side wrote its columns. */
export function keyText(key: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(key).sort().map(column => [column, key[column]])));
}
