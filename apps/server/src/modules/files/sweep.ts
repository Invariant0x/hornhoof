import { sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { refreshFileHolders } from './network.js';

/* What the leading app does with the store each minute: picks the machines that hold the files, marks a content no row
   names any more, lets it go a day later, removes it from this machine's store, and forgets it once no machine keeps it. */

/* A content no row names waits this long before it goes: an upload may still be between the store and its row. */
export const UNUSED_MS = 86_400_000;
/* At most this many contents leave this machine's store in one round. */
const DROP_BATCH = 500;

const rowsOf = <T>(answer: unknown): T[] => (Array.isArray(answer) ? answer : (answer as { rows: T[] }).rows);

/* The rows that name a content of the store. Theme files and refused merges name them too once they keep them there. */
const NAMED = sql`EXISTS (SELECT 1 FROM public.attachments a WHERE a.sha256 = f.sha256)`;

/* Marks the contents no row names since now, and those named again as in use, and gives the ones unused for a day their
   time to go. Says how many are to go now. */
export async function markUnused(db: Pick<Db, 'execute'>, now: Date): Promise<number> {
  const at = now.toISOString();
  await db.execute(sql`UPDATE net.files f SET unused_since = NULL WHERE f.unused_since IS NOT NULL AND f.drop_at IS NULL AND ${NAMED}`);
  await db.execute(sql`UPDATE net.files f SET unused_since = ${at}::timestamptz WHERE f.unused_since IS NULL AND f.drop_at IS NULL AND NOT ${NAMED}`);
  const going = await db.execute(sql`UPDATE net.files f SET drop_at = ${at}::timestamptz WHERE f.drop_at IS NULL
    AND f.unused_since <= ${new Date(now.getTime() - UNUSED_MS).toISOString()}::timestamptz AND NOT ${NAMED} RETURNING f.sha256`);
  return rowsOf(going).length;
}

/* Removes from this machine's store the contents whose time came, each under its record's lock, so an upload of the
   same content, which takes that lock to name it again, either comes first and keeps it, or comes after and finds it
   gone and writes it again. Then forgets the copies of machines that are gone and the contents no machine keeps. */
export async function dropDue(ctx: Pick<Ctx, 'db' | 'files'>, now: Date): Promise<number> {
  const { db, files } = ctx;
  const mine = await files.machineId(db);
  const store = files.store();
  const due = rowsOf<{ sha256: string }>(
    await db.execute(sql`SELECT sha256 FROM net.files WHERE drop_at <= ${now.toISOString()}::timestamptz ORDER BY drop_at LIMIT ${DROP_BATCH}`),
  );
  let dropped = 0;
  for (const { sha256 } of due) {
    await db.transaction(async tx => {
      const [still] = rowsOf<{ sha256: string }>(
        await tx.execute(sql`SELECT sha256 FROM net.files WHERE sha256 = ${sha256} AND drop_at <= ${now.toISOString()}::timestamptz FOR UPDATE`),
      );
      if (!still) return;
      await store.remove(sha256);
      if (mine) await tx.execute(sql`DELETE FROM net.file_copies WHERE sha256 = ${sha256} AND machine_id = ${mine}`);
      dropped++;
    });
  }
  await db.execute(sql`DELETE FROM net.file_copies c WHERE NOT EXISTS (SELECT 1 FROM machines m WHERE m.id = c.machine_id AND m.revoked_at IS NULL)`);
  await db.execute(sql`DELETE FROM net.files f WHERE f.drop_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM net.file_copies c WHERE c.sha256 = f.sha256)`);
  return dropped;
}

/* The store's round: holders first, so a content's holders are known before it is marked. */
export async function storeRound(ctx: Pick<Ctx, 'db' | 'files'>, now: Date): Promise<void> {
  await refreshFileHolders(ctx.db, now);
  await markUnused(ctx.db, now);
  await dropDue(ctx, now);
}
