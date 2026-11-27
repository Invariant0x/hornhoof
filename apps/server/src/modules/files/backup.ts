import { rowsOf } from '../../db/selections.js';
import { sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { FilesDb } from './files.js';
import { backupSettings } from './backup-settings.js';
import { NAMED, SET_ASIDE } from './named.js';
import { better, LOST_MS, machineSeats } from './place.js';
import { StoreRefused } from './store.js';

/* The store's own backup (#2056): versioned copies of the sealed files on a machine apart from the live copies, kept
   30 days, or the days the CEO set, after no row names them any more. A backup copy is never a live copy: the machine
   that keeps it reports none into net.file_copies, so it takes no copy's place and lets no copy go. The leading machine
   keeps it, in a folder of its own beside its live store, while no other machine keeps files. */

export const MAX_KEEP_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;
/* How many contents one round brings into the backup here, and one look of a machine names, so a store of many files
   comes in over a few. */
const BATCH = 200;

const listOf = (values: string[]) => `{${values.join(',')}}`;
const iso = (at: Date | string | null | undefined): string | null => (at == null ? null : new Date(at).toISOString());

/* Sets the days the backup keeps a content no row names; its next round lets go of what was kept longer. */
export async function setKeepDays(db: FilesDb, days: number, by: string): Promise<void> {
  await db.execute(sql`INSERT INTO net.file_backup_settings (keep_days, set_by) VALUES (${days}, ${by})
    ON CONFLICT (one) DO UPDATE SET keep_days = excluded.keep_days, set_by = excluded.set_by, set_at = now()`);
}

/* Whether a machine keeps the store's backup, or a content of it (sha256, when one is named): the machine picked for it,
   or one that still keeps that content as the backup moves off it. The leading keeper gives it what it is to keep, and
   takes back what only it keeps. */
export async function backsUpStore(db: FilesDb, machineId: string, sha256?: string): Promise<boolean> {
  const { machineId: picked } = await backupSettings(db);
  if (sha256 === undefined) return picked === machineId;
  const [row] = rowsOf<{ machine_id: string | null }>(await db.execute(sql`SELECT machine_id FROM net.file_backups WHERE sha256 = ${sha256}`));
  return row !== undefined && (picked === machineId || row.machine_id === machineId);
}

/* The machine the backup is on: the one picked, while it keeps files, away or not, so what only it keeps is not left
   behind; else, of those that keep files, other than the leading one and not lost, the last one live copies are placed
   on, so the backup takes the least from them. None: the leading machine keeps it. */
export async function pickBackupMachine(db: FilesDb, mine: string | null, now: Date): Promise<string | null> {
  const { machineId } = await backupSettings(db);
  const all = await machineSeats(db, mine, now);
  if (machineId !== null && all.some(seat => seat.id === machineId && seat.fit && !seat.leader)) return machineId;
  const here = all.find(seat => seat.leader)?.addresses ?? [];
  const next = all.filter(seat => seat.fit && !seat.leader && !seat.lost).sort(better(here)).at(-1);
  const picked = next?.id ?? null;
  if (picked !== machineId) await db.execute(sql`INSERT INTO net.file_backup_settings (machine_id) VALUES (${picked}) ON CONFLICT (one) DO UPDATE SET machine_id = EXCLUDED.machine_id`);
  return picked;
}

/* The store's backup round, as the leading app runs it with the store's round: it writes down which row names which
   content since when, takes into the backup each content a row names, keeps it here while no other machine is picked
   for it and lets go of what another keeps now, and lets go of the contents no row named for longer than the days kept. */
export async function backupRound(ctx: Pick<Ctx, 'db' | 'files'>, now: Date): Promise<void> {
  await recordNames(ctx.db, now);
  await ctx.db.execute(sql`INSERT INTO net.file_backups (sha256, size, sealed_sha256, sealed_size, salt, at)
    SELECT f.sha256, f.size, f.sealed_sha256, f.sealed_size, f.salt, ${now.toISOString()}::timestamptz FROM net.files f
    WHERE EXISTS (SELECT 1 FROM net.file_backup_names n WHERE n.sha256 = f.sha256 AND n.until IS NULL)
    ON CONFLICT (sha256) DO UPDATE SET drop_at = NULL WHERE net.file_backups.drop_at IS NOT NULL`);
  const { keepDays, machineId } = await backupSettings(ctx.db);
  const mine = await ctx.files.machineId(ctx.db);
  if (machineId === null) await keepHere(ctx, mine, now);
  else await releaseHere(ctx, mine);
  await prune(ctx, mine, now, keepDays);
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
async function keepHere(ctx: Pick<Ctx, 'db' | 'files'>, mine: string | null, now: Date): Promise<void> {
  const { db, files } = ctx;
  const live = files.store();
  const backup = files.backupStore();
  const waiting = rowsOf<{ sha256: string; sealed_sha256: string; sealed_size: string; salt: string }>(
    await db.execute(sql`SELECT sha256, sealed_sha256, sealed_size, salt FROM net.file_backups WHERE drop_at IS NULL AND (kept_at IS NULL OR machine_id IS DISTINCT FROM ${mine})
      ORDER BY at, sha256 LIMIT ${BATCH}`),
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

/* With the backup on another machine, lets go of what the backup folder here keeps that the record says is kept there,
   or that the backup lets go of; what it keeps for the backup machine to fetch, as one that kept it gave it back, stays. */
async function releaseHere(ctx: Pick<Ctx, 'db' | 'files'>, mine: string | null): Promise<void> {
  const backup = ctx.files.backupStore();
  const here = (await backup.list()).map(file => file.sha256);
  if (here.length === 0) return;
  const kept = new Set(
    rowsOf<{ sha256: string }>(
      await ctx.db.execute(sql`SELECT sha256 FROM net.file_backups WHERE sha256 = ANY(${listOf(here)}::text[]) AND machine_id IS NOT DISTINCT FROM ${mine} AND drop_at IS NULL`),
    ).map(row => row.sha256),
  );
  for (const sha256 of here) if (!kept.has(sha256)) await backup.remove(sha256);
}

/* Lets go of the names closed longer ago than the days kept, then of the contents no name is left of and no row names,
   unless a database set aside, which may be merged back, is there: a content kept here goes at once, one another machine
   keeps once it let it go. */
async function prune(ctx: Pick<Ctx, 'db' | 'files'>, mine: string | null, now: Date, keepDays: number): Promise<void> {
  const { db, files } = ctx;
  const before = new Date(now.getTime() - keepDays * DAY_MS).toISOString();
  if (rowsOf<{ aside: boolean }>(await db.execute(sql`SELECT ${SET_ASIDE} AS aside`))[0]?.aside) return;
  await db.execute(sql`DELETE FROM net.file_backup_names WHERE until IS NOT NULL AND until <= ${before}::timestamptz`);
  const going = rowsOf<{ sha256: string; elsewhere: boolean }>(
    await db.execute(sql`SELECT f.sha256, (f.kept_at IS NOT NULL AND f.machine_id IS DISTINCT FROM ${mine}) AS elsewhere FROM net.file_backups f
      WHERE f.drop_at IS NULL AND NOT EXISTS (SELECT 1 FROM net.file_backup_names n WHERE n.sha256 = f.sha256) AND NOT ${NAMED}`),
  );
  const unnamed = sql`NOT EXISTS (SELECT 1 FROM net.file_backup_names n WHERE n.sha256 = f.sha256) AND NOT ${NAMED}`;
  for (const { sha256, elsewhere } of going) {
    await files.backupStore().remove(sha256);
    if (elsewhere) await db.execute(sql`UPDATE net.file_backups f SET drop_at = ${now.toISOString()}::timestamptz WHERE f.sha256 = ${sha256} AND ${unnamed}`);
    else await db.execute(sql`DELETE FROM net.file_backups f WHERE f.sha256 = ${sha256} AND ${unnamed}`);
  }
  await db.execute(sql`DELETE FROM net.file_backups WHERE drop_at IS NOT NULL AND kept_at IS NULL`);
}

/* What a machine that keeps files is to do of the backup, besides its live copies. keep: it is the machine picked for
   the backup; hold: what it is to fetch into its backup folder; drop: what it lets go of from there; give: what only it
   keeps as the backup moves off it, to send back to the leading machine; clear: it keeps nothing of the backup any
   more, so its folder empties. */
export type BackupView = {
  /* give: and, for the machine picked, what a restore of the CEO asks it to send back to the live store. */
  keep: boolean;
  hold: { sha256: string; sealedSha256: string; sealedSize: number }[];
  drop: string[];
  give: string[];
  clear: boolean;
  keepDays: number;
};

export async function backupView(db: FilesDb, machineId: string, leader: string | null): Promise<BackupView> {
  const { keepDays, machineId: picked } = await backupSettings(db);
  const keep = picked === machineId;
  const hold = keep
    ? rowsOf<{ sha256: string; sealed_sha256: string; sealed_size: string }>(
        await db.execute(sql`SELECT sha256, sealed_sha256, sealed_size FROM net.file_backups WHERE drop_at IS NULL AND (kept_at IS NULL OR machine_id IS DISTINCT FROM ${machineId})
          ORDER BY at, sha256 LIMIT ${BATCH}`),
      ).map(row => ({ sha256: row.sha256, sealedSha256: row.sealed_sha256, sealedSize: Number(row.sealed_size) }))
    : [];
  const drop = rowsOf<{ sha256: string }>(
    await db.execute(sql`SELECT sha256 FROM net.file_backups WHERE machine_id = ${machineId} AND drop_at IS NOT NULL ORDER BY sha256 LIMIT ${BATCH}`),
  ).map(row => row.sha256);
  /* What the leading machine keeps a live copy of, the machine picked fetches from it; the rest it is given back. The
     machine picked gives back what a restore asks of it. */
  const give = keep
    ? rowsOf<{ sha256: string }>(
        await db.execute(sql`SELECT sha256 FROM net.file_backups WHERE machine_id = ${machineId} AND kept_at IS NOT NULL AND drop_at IS NULL AND restore_at IS NOT NULL
          ORDER BY restore_at, sha256 LIMIT ${BATCH}`),
      ).map(row => row.sha256)
    : rowsOf<{ sha256: string }>(
        await db.execute(sql`SELECT b.sha256 FROM net.file_backups b WHERE b.machine_id = ${machineId} AND b.kept_at IS NOT NULL AND b.drop_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM net.file_copies c WHERE c.sha256 = b.sha256 AND c.machine_id IS NOT DISTINCT FROM ${leader}) ORDER BY b.sha256 LIMIT ${BATCH}`),
      ).map(row => row.sha256);
  const clear = !keep && rowsOf(await db.execute(sql`SELECT 1 FROM net.file_backups WHERE machine_id = ${machineId} LIMIT 1`)).length === 0;
  return { keep, hold, drop, give, clear, keepDays };
}

/* What a machine said of its backup folder: what it keeps there now, what it let go of, and, in a census, every content
   in a span of names, so what it lost there is fetched again. Only the machine picked for the backup keeps for it. The
   answer names what it keeps there that the backup does not know. */
export async function takeBackupReport(db: FilesDb, machineId: string, report: { held: string[]; dropped: string[]; span?: { after: string; through: string } | undefined }, now = new Date()): Promise<string[]> {
  const { machineId: picked } = await backupSettings(db);
  const at = now.toISOString();
  if (report.span) {
    const { after, through } = report.span;
    await db.execute(sql`UPDATE net.file_backups SET machine_id = NULL, kept_at = NULL WHERE machine_id = ${machineId} AND sha256 COLLATE "C" > ${after} AND sha256 COLLATE "C" <= ${through}
      AND NOT (sha256 = ANY(${listOf(report.held)}::text[]))`);
  }
  if (report.held.length && picked === machineId) {
    await db.execute(sql`UPDATE net.file_backups SET machine_id = ${machineId}, kept_at = ${at}::timestamptz WHERE sha256 = ANY(${listOf(report.held)}::text[]) AND drop_at IS NULL
      AND (kept_at IS NULL OR machine_id IS DISTINCT FROM ${machineId})`);
  }
  if (report.dropped.length) {
    await db.execute(sql`DELETE FROM net.file_backups WHERE sha256 = ANY(${listOf(report.dropped)}::text[]) AND machine_id = ${machineId} AND drop_at IS NOT NULL`);
    await db.execute(sql`UPDATE net.file_backups SET machine_id = NULL, kept_at = NULL WHERE sha256 = ANY(${listOf(report.dropped)}::text[]) AND machine_id = ${machineId}`);
  }
  if (!report.held.length) return [];
  const known = new Set(rowsOf<{ sha256: string }>(await db.execute(sql`SELECT sha256 FROM net.file_backups WHERE sha256 = ANY(${listOf(report.held)}::text[])`)).map(row => row.sha256));
  return report.held.filter(sha256 => !known.has(sha256));
}

/* How the backup stands, for the CEO: the machine it is on, whether that one keeps no live copy and whether it is away,
   what it keeps and what is still to come to it, when it last took a content in, the earliest moment it can put the
   store back to, and the days. */
export async function backupState(db: FilesDb, here: string | null, now = new Date()) {
  const { keepDays, machineId } = await backupSettings(db);
  const on = machineId ?? here;
  const [held] = rowsOf<{ files: string; bytes: string; waiting: string; kept_at: Date | string | null }>(
    await db.execute(sql`SELECT count(*) FILTER (WHERE kept_at IS NOT NULL AND machine_id IS NOT DISTINCT FROM ${on}) AS files,
      coalesce(sum(sealed_size) FILTER (WHERE kept_at IS NOT NULL AND machine_id IS NOT DISTINCT FROM ${on}), 0) AS bytes,
      count(*) FILTER (WHERE drop_at IS NULL AND (kept_at IS NULL OR machine_id IS DISTINCT FROM ${on})) AS waiting,
      max(kept_at) FILTER (WHERE machine_id IS NOT DISTINCT FROM ${on}) AS kept_at FROM net.file_backups`),
  );
  const [oldest] = rowsOf<{ since: Date | string | null }>(await db.execute(sql`SELECT min(since) AS since FROM net.file_backup_names`));
  const apart = machineId !== null && rowsOf(await db.execute(sql`SELECT 1 FROM net.file_targets WHERE machine_id = ${machineId} LIMIT 1`)).length === 0;
  const [seen] = machineId === null ? [] : rowsOf<{ report_at: Date | string | null }>(await db.execute(sql`SELECT report_at FROM machines WHERE id = ${machineId}`));
  const away = seen !== undefined && (seen.report_at === null || now.getTime() - new Date(seen.report_at).getTime() >= LOST_MS);
  return {
    machineId: on,
    apart,
    away,
    files: Number(held?.files ?? 0),
    bytes: Number(held?.bytes ?? 0),
    waiting: Number(held?.waiting ?? 0),
    keptAt: iso(held?.kept_at),
    oldestAt: iso(oldest?.since),
    keepDays,
  };
}
