import { sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { FilesDb } from './files.js';
import { NAMED, SET_ASIDE } from './named.js';
import { StoreRefused } from './store.js';

/* The store's own backup (#2056): versioned copies of the sealed files on a machine apart from the live copies, kept
   30 days, or the days the CEO set, after no row names them any more. A backup copy is never a live copy: the machine
   that keeps it reports none into net.file_copies, so it takes no copy's place and lets no copy go. The leading machine
   keeps it, in a folder of its own beside its live store, until another machine is picked for it. */

export const KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/* How many contents one round brings into the backup here, so a store of many files comes in over a few rounds. */
const KEEP_BATCH = 200;

const rowsOf = <T>(answer: unknown): T[] => (Array.isArray(answer) ? answer : (answer as { rows: T[] }).rows);
const iso = (at: Date | string | null | undefined): string | null => (at == null ? null : new Date(at).toISOString());

/* The days the backup keeps a content no row names, and the machine other than the leading one picked to keep it. */
export async function backupSettings(db: FilesDb): Promise<{ keepDays: number; machineId: string | null }> {
  const [row] = rowsOf<{ keep_days: number; machine_id: string | null }>(await db.execute(sql`SELECT keep_days, machine_id FROM net.file_backup_settings`));
  return { keepDays: row?.keep_days ?? KEEP_DAYS, machineId: row?.machine_id ?? null };
}

/* Whether a machine keeps the store's backup, so the leading keeper gives it a file (sha256, when one is named) and
   takes one back from it in a restore. */
export async function backsUpStore(db: FilesDb, machineId: string, sha256?: string): Promise<boolean> {
  const { machineId: picked } = await backupSettings(db);
  if (picked === null || picked !== machineId) return false;
  return sha256 === undefined || rowsOf(await db.execute(sql`SELECT 1 FROM net.file_backups WHERE sha256 = ${sha256}`)).length === 1;
}

/* The machines other than the leading one that keep the store's backup: placement keeps live copies off them while the
   other machines that keep files are as many as the copies asked for. */
export async function storeBackupMachines(db: FilesDb): Promise<string[]> {
  const { machineId } = await backupSettings(db);
  return machineId === null ? [] : [machineId];
}

/* The store's backup round, as the leading app runs it with the store's round: it writes down which row names which
   content since when, takes into the backup each content a row names, keeps it here while no other machine is picked
   for it, and lets go of the contents no row named for longer than the days kept. */
export async function backupRound(ctx: Pick<Ctx, 'db' | 'files'>, now: Date): Promise<void> {
  await recordNames(ctx.db, now);
  await ctx.db.execute(sql`INSERT INTO net.file_backups (sha256, size, sealed_sha256, sealed_size, salt, at)
    SELECT f.sha256, f.size, f.sealed_sha256, f.sealed_size, f.salt, ${now.toISOString()}::timestamptz FROM net.files f
    WHERE EXISTS (SELECT 1 FROM net.file_backup_names n WHERE n.sha256 = f.sha256 AND n.until IS NULL) ON CONFLICT (sha256) DO NOTHING`);
  const { keepDays, machineId } = await backupSettings(ctx.db);
  if (machineId === null) await keepHere(ctx, now);
  await prune(ctx, now, keepDays, machineId);
  await ctx.files.backupStore().tidy(now);
}

/* A row deleted or given other bytes closes the name it had; a row with bytes and no open name opens one. */
async function recordNames(db: FilesDb, now: Date): Promise<void> {
  const at = now.toISOString();
  await db.execute(sql`UPDATE net.file_backup_names n SET until = greatest(n.since, ${at}::timestamptz) WHERE n.until IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.attachments a WHERE a.id = n.attachment_id AND a.sha256 = n.sha256)`);
  await db.execute(sql`INSERT INTO net.file_backup_names (attachment_id, company_id, sha256, "row", since)
    SELECT a.id, a.company_id, a.sha256, to_jsonb(a) - 'bytes', ${at}::timestamptz FROM public.attachments a
    WHERE a.sha256 IS NOT NULL AND NOT EXISTS (SELECT 1 FROM net.file_backup_names n WHERE n.attachment_id = a.id AND n.until IS NULL)`);
}

/* Copies into the backup folder here the contents it does not keep yet, from the live store; one the live store lacks
   is asked for, so a machine that keeps it sends it. A live copy sealed before is sealed again as its record says. */
async function keepHere(ctx: Pick<Ctx, 'db' | 'files'>, now: Date): Promise<void> {
  const { db, files } = ctx;
  const mine = await files.machineId(db);
  const live = files.store();
  const backup = files.backupStore();
  const waiting = rowsOf<{ sha256: string; sealed_sha256: string; sealed_size: string; salt: string }>(
    await db.execute(sql`SELECT sha256, sealed_sha256, sealed_size, salt FROM net.file_backups WHERE kept_at IS NULL OR machine_id IS DISTINCT FROM ${mine} ORDER BY at, sha256 LIMIT ${KEEP_BATCH}`),
  );
  for (const row of waiting) {
    if (!backup.has(row.sha256)) {
      const sealed = live.sealed(row.sha256);
      if (!sealed) {
        await db.execute(sql`UPDATE net.files SET wanted_at = ${now.toISOString()}::timestamptz WHERE sha256 = ${row.sha256} AND wanted_at IS NULL`);
        continue;
      }
      try {
        await backup.take(row.sha256, sealed.stream(), { sealedSha256: row.sealed_sha256, sealedSize: Number(row.sealed_size) }, { key: await files.key(db), salt: row.salt });
      } catch (err) {
        if (err instanceof StoreRefused) continue;
        throw err;
      }
    }
    await db.execute(sql`UPDATE net.file_backups SET machine_id = ${mine}, kept_at = ${now.toISOString()}::timestamptz WHERE sha256 = ${row.sha256}`);
  }
}

/* Lets go of the names closed longer ago than the days kept, then of the contents no name is left of and no row names,
   unless a database set aside, which may be merged back, is there. */
async function prune(ctx: Pick<Ctx, 'db' | 'files'>, now: Date, keepDays: number, machineId: string | null): Promise<void> {
  const { db, files } = ctx;
  const before = new Date(now.getTime() - keepDays * DAY_MS).toISOString();
  if (rowsOf<{ aside: boolean }>(await db.execute(sql`SELECT ${SET_ASIDE} AS aside`))[0]?.aside) return;
  await db.execute(sql`DELETE FROM net.file_backup_names WHERE until IS NOT NULL AND until <= ${before}::timestamptz`);
  const going = rowsOf<{ sha256: string }>(
    await db.execute(sql`SELECT f.sha256 FROM net.file_backups f WHERE NOT EXISTS (SELECT 1 FROM net.file_backup_names n WHERE n.sha256 = f.sha256) AND NOT ${NAMED}`),
  );
  for (const { sha256 } of going) {
    if (machineId === null) await files.backupStore().remove(sha256);
    await db.execute(sql`DELETE FROM net.file_backups f WHERE f.sha256 = ${sha256} AND NOT EXISTS (SELECT 1 FROM net.file_backup_names n WHERE n.sha256 = f.sha256) AND NOT ${NAMED}`);
  }
}

/* How the backup stands, for the CEO: the machine it is on, whether that one keeps no live copy, what it keeps and what
   is still on its way, when it last took a content in, the earliest moment it can put the store back to, and the days. */
export async function backupState(db: FilesDb, here: string | null) {
  const { keepDays, machineId } = await backupSettings(db);
  const on = machineId ?? here;
  const [held] = rowsOf<{ files: string; bytes: string; waiting: string; kept_at: Date | string | null }>(
    await db.execute(sql`SELECT count(*) FILTER (WHERE kept_at IS NOT NULL) AS files, coalesce(sum(sealed_size) FILTER (WHERE kept_at IS NOT NULL), 0) AS bytes,
      count(*) FILTER (WHERE kept_at IS NULL) AS waiting, max(kept_at) AS kept_at FROM net.file_backups`),
  );
  const [oldest] = rowsOf<{ since: Date | string | null }>(await db.execute(sql`SELECT min(since) AS since FROM net.file_backup_names`));
  const apart = machineId !== null && rowsOf(await db.execute(sql`SELECT 1 FROM net.file_targets WHERE machine_id = ${machineId} LIMIT 1`)).length === 0;
  return {
    machineId: on,
    apart,
    files: Number(held?.files ?? 0),
    bytes: Number(held?.bytes ?? 0),
    waiting: Number(held?.waiting ?? 0),
    keptAt: iso(held?.kept_at),
    oldestAt: iso(oldest?.since),
    keepDays,
  };
}
