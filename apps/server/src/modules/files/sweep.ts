import { sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { backupRound } from './backup.js';
import { recordFile } from './files.js';
import { NAMED, SET_ASIDE } from './named.js';
import { countedNow, keptElsewhere, placeFiles, trimTargets } from './place.js';

/* What the leading app does with the store each minute: picks the machines that keep each file, marks a content no row
   names any more, lets it go a day later, removes it from this machine's store, and forgets it once no machine keeps it.
   It lets go of the files this machine is not picked for once their copies stand elsewhere, past what it keeps of them. */

/* A content no row names waits this long before it goes: an upload may still be between the store and its row. */
export const UNUSED_MS = 86_400_000;
/* At most this many contents leave this machine's store in one round, and as many of its copies are checked. */
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

/* Removes from this machine's store the contents whose time came, each under its record's lock, so an upload of the
   same content, which takes that lock to name it again, either comes first and keeps it, or comes after and finds it
   gone and writes it again. A content a row came to name after its time was given, as a moved file's row does, is kept
   and in use again. Then forgets the copies of machines that are gone and the contents no machine keeps. */
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
      const [still] = rowsOf<{ sha256: string; named: boolean }>(
        await tx.execute(sql`SELECT f.sha256, ${NAMED} AS named FROM net.files f WHERE f.sha256 = ${sha256} AND f.drop_at <= ${now.toISOString()}::timestamptz FOR UPDATE OF f`),
      );
      if (!still) return;
      if (still.named) {
        await tx.execute(sql`UPDATE net.files SET drop_at = NULL, unused_since = NULL WHERE sha256 = ${sha256}`);
        return;
      }
      await store.remove(sha256);
      if (mine) await tx.execute(sql`DELETE FROM net.file_copies WHERE sha256 = ${sha256} AND machine_id = ${mine}`);
      dropped++;
    });
  }
  await db.execute(sql`DELETE FROM net.file_copies c WHERE NOT EXISTS (SELECT 1 FROM machines m WHERE m.id = c.machine_id AND m.revoked_at IS NULL)`);
  await db.execute(sql`DELETE FROM net.files f WHERE f.drop_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM net.file_copies c WHERE c.sha256 = f.sha256)`);
  return dropped;
}

/* The copies this machine is recorded to keep, a page a round, against its store: one its disk lost is forgotten, so
   the machines that hold it count truly, and a read asks them for it. Says how many were lost. */
export async function checkOwnCopies(ctx: Pick<Ctx, 'db' | 'files'>): Promise<number> {
  const { db, files } = ctx;
  const mine = await files.machineId(db);
  if (!mine) return 0;
  const store = files.store();
  const page = rowsOf<{ sha256: string }>(
    await db.execute(sql`SELECT sha256 FROM net.file_copies WHERE machine_id = ${mine} AND sha256 COLLATE "C" > ${files.checkedThrough} ORDER BY sha256 COLLATE "C" LIMIT ${DROP_BATCH}`),
  ).map(row => row.sha256);
  const lost = page.filter(sha256 => !store.has(sha256));
  if (lost.length) await db.execute(sql`DELETE FROM net.file_copies WHERE machine_id = ${mine} AND sha256 = ANY(${`{${lost.join(',')}}`}::text[])`);
  files.checkedThrough = page.length < DROP_BATCH ? '' : page.at(-1)!;
  return lost.length;
}

/* The contents rows name that the store has no record of, as a merge brings them: one this machine keeps is recorded
   with its copy here, so the machines that hold the files take it too. One kept elsewhere is recorded once a machine
   that keeps it sends it (modules/files/network). Says how many were recorded. */
export async function adoptNamed(ctx: Pick<Ctx, 'db' | 'files'>): Promise<number> {
  const { db, files } = ctx;
  const store = files.store();
  const named = rowsOf<{ sha256: string; size: string | null }>(await db.execute(sql`${namedUnrecorded(sql`true`)} LIMIT ${DROP_BATCH}`));
  let adopted = 0;
  for (const { sha256, size } of named) {
    if (size === null || !store.has(sha256)) continue;
    await recordFile(db, { sha256, size: Number(size), ...(await store.sealedFacts(sha256)) }, await files.machineId(db));
    adopted++;
  }
  return adopted;
}

/* The files this machine keeps and is not picked for, as an upload with no room here or a read left them: those whose
   copies wanted stand on machines picked for them go, the longest kept first, until what is left fits the room for
   them. One of them a row names again, or an upload records again, under its record's lock, is kept. Says how many went. */
export async function trimTransit(ctx: Pick<Ctx, 'db' | 'files'>, now: Date): Promise<number> {
  const { db, files } = ctx;
  const mine = await files.machineId(db);
  if (!mine) return 0;
  const { ids, wanted } = await countedNow(db, mine, now);
  if (wanted === 0) return 0;
  const loose = rowsOf<{ sha256: string; size: string; spare: boolean }>(
    await db.execute(sql`SELECT c.sha256, f.sealed_size AS size, ${keptElsewhere(sql`c.sha256`, mine, ids)} >= ${wanted} AS spare
      FROM net.file_copies c JOIN net.files f ON f.sha256 = c.sha256 WHERE c.machine_id = ${mine}
      AND NOT EXISTS (SELECT 1 FROM net.file_targets t WHERE t.sha256 = c.sha256 AND t.machine_id = ${mine}) ORDER BY c.at, c.sha256`),
  );
  let over = loose.reduce((sum, row) => sum + Number(row.size), 0) - files.transitRoom();
  let gone = 0;
  for (const row of loose) {
    if (over <= 0) break;
    if (!row.spare) continue;
    await db.transaction(async tx => {
      const [still] = rowsOf<{ sha256: string }>(
        await tx.execute(sql`SELECT f.sha256 FROM net.files f WHERE f.sha256 = ${row.sha256} AND NOT EXISTS (SELECT 1 FROM net.file_targets t WHERE t.sha256 = f.sha256 AND t.machine_id = ${mine})
          AND ${keptElsewhere(sql`f.sha256`, mine, ids)} >= ${wanted} FOR UPDATE OF f`),
      );
      if (!still) return;
      await files.store().remove(row.sha256);
      await tx.execute(sql`DELETE FROM net.file_copies WHERE sha256 = ${row.sha256} AND machine_id = ${mine}`);
      over -= Number(row.size);
      gone++;
    });
  }
  return gone;
}

/* A gift no word that the machine keeps the file followed within a day is forgotten. */
const GIFT_LIFE_MS = 86_400_000;

/* The store's round: the files are placed, and the targets they need no more let go of, before contents are marked,
   so the copies of a file are known before any goes. */
export async function storeRound(ctx: Pick<Ctx, 'db' | 'files'>, now: Date): Promise<void> {
  const { db, files } = ctx;
  await adoptNamed(ctx);
  const mine = await files.machineId(db);
  files.placedThrough = (await placeFiles(db, mine, { now, after: files.placedThrough })).through;
  files.trimmedThrough = (await trimTargets(db, mine, { now, after: files.trimmedThrough })).through;
  /* The backup takes in what rows name before the live store lets go of what none names. */
  await backupRound(ctx, now);
  await markUnused(db, now);
  await dropDue(ctx, now);
  await trimTransit(ctx, now);
  await db.execute(sql`DELETE FROM net.file_gives WHERE at < ${new Date(now.getTime() - GIFT_LIFE_MS).toISOString()}::timestamptz`);
  await db.execute(sql`DELETE FROM net.file_wants WHERE until < ${now.toISOString()}::timestamptz`);
  await checkOwnCopies(ctx);
  /* What the files take on the leading machine, which has no keeper of them to say so, for the CEO's cards. */
  if (mine) {
    await db.execute(sql`UPDATE machines SET file_store_used_bytes = (SELECT coalesce(sum(f.sealed_size), 0) FROM net.file_copies c JOIN net.files f ON f.sha256 = c.sha256
      WHERE c.machine_id = ${mine}) WHERE id = ${mine}`);
  }
}
