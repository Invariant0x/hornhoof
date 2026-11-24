import { sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { recordFile } from './files.js';
import { NAMED, SET_ASIDE } from './named.js';

/* What the app does with the store each minute: records a content a row names that a merge brought, marks a content no
   row names any more, lets it go a day later and removes it from the store. */

/* A content no row names waits this long before it goes: an upload may still be between the store and its row. */
export const UNUSED_MS = 86_400_000;
/* At most this many contents leave the store in one round. */
const DROP_BATCH = 500;

const rowsOf = <T>(answer: unknown): T[] => (Array.isArray(answer) ? answer : (answer as { rows: T[] }).rows);

/* The contents a row names and no record describes, with the size the row gives, among those `which` lets through: the
   content of a file's row, as a merge brings it, or of one a merge refused and keeps until someone picks a side. */
export function namedUnrecorded(which: SQL): SQL {
  return sql`SELECT n.sha256, max(n.size) AS size FROM (
      SELECT a.sha256, a.size::bigint AS size FROM public.attachments a WHERE a.sha256 IS NOT NULL
      UNION ALL
      SELECT v.side ->> 'sha256', (v.side ->> 'size')::bigint FROM net.merge_conflicts c CROSS JOIN LATERAL (VALUES (c.here), (c.there)) AS v(side)
        WHERE c.tbl = 'attachments' AND c.picked IS NULL AND v.side ->> 'sha256' IS NOT NULL
    ) n WHERE ${which} AND NOT EXISTS (SELECT 1 FROM net.files f WHERE f.sha256 = n.sha256) GROUP BY n.sha256`;
}

export { SET_ASIDE } from './named.js';

/* Marks the contents no row names since now, and those named again as in use, and gives the ones unused for a day their
   time to go, unless a database set aside is there. Says how many are to go now. */
export async function markUnused(db: Pick<Db, 'execute'>, now: Date): Promise<number> {
  const at = now.toISOString();
  await db.execute(sql`UPDATE net.files f SET unused_since = NULL WHERE f.unused_since IS NOT NULL AND f.drop_at IS NULL AND ${NAMED}`);
  await db.execute(sql`UPDATE net.files f SET unused_since = ${at}::timestamptz WHERE f.unused_since IS NULL AND f.drop_at IS NULL AND NOT ${NAMED}`);
  const going = await db.execute(sql`UPDATE net.files f SET drop_at = ${at}::timestamptz WHERE f.drop_at IS NULL
    AND f.unused_since <= ${new Date(now.getTime() - UNUSED_MS).toISOString()}::timestamptz AND NOT ${NAMED} AND NOT ${SET_ASIDE} RETURNING f.sha256`);
  return rowsOf(going).length;
}

/* Removes from the store the contents whose time came, each under its record's lock, so an upload of the same content,
   which takes that lock to name it again, either comes first and keeps it, or comes after and finds it gone and writes it
   again. A content a row came to name after its time was given, as a moved file's row does, is kept and in use again. */
export async function dropDue(ctx: Pick<Ctx, 'db' | 'files'>, now: Date): Promise<number> {
  const { db, files } = ctx;
  const store = files.store();
  const due = rowsOf<{ sha256: string }>(
    await db.execute(sql`SELECT sha256 FROM net.files WHERE drop_at <= ${now.toISOString()}::timestamptz ORDER BY drop_at LIMIT ${DROP_BATCH}`),
  );
  let dropped = 0;
  for (const { sha256 } of due) {
    await db.transaction(async tx => {
      const [still] = rowsOf<{ sha256: string; named: boolean }>(
        await tx.execute(sql`SELECT f.sha256, ${NAMED} AS named FROM net.files f WHERE f.sha256 = ${sha256} AND f.drop_at <= ${now.toISOString()}::timestamptz FOR UPDATE OF f`),
      );
      if (!still) return;
      if (still.named) {
        await tx.execute(sql`UPDATE net.files SET drop_at = NULL, unused_since = NULL WHERE sha256 = ${sha256}`);
        return;
      }
      await store.remove(sha256);
      await tx.execute(sql`DELETE FROM net.files WHERE sha256 = ${sha256}`);
      dropped++;
    });
  }
  return dropped;
}

/* The contents rows name that the store has no record of, as a merge brings them: one the store keeps is recorded. Says
   how many were. */
export async function adoptNamed(ctx: Pick<Ctx, 'db' | 'files'>): Promise<number> {
  const { db, files } = ctx;
  const store = files.store();
  const named = rowsOf<{ sha256: string; size: string | null }>(await db.execute(sql`${namedUnrecorded(sql`true`)} LIMIT ${DROP_BATCH}`));
  let adopted = 0;
  for (const { sha256, size } of named) {
    if (size === null || !store.has(sha256)) continue;
    await recordFile(db, { sha256, size: Number(size), ...(await store.sealedFacts(sha256)) });
    adopted++;
  }
  return adopted;
}

/* The store's round: what a merge brought is recorded before contents are marked, so none a row names goes. */
export async function storeRound(ctx: Pick<Ctx, 'db' | 'files'>, now: Date): Promise<void> {
  await adoptNamed(ctx);
  await markUnused(ctx.db, now);
  await dropDue(ctx, now);
}
