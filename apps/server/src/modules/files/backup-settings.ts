import { rowsOf } from '../../db/selections.js';
import { sql } from 'drizzle-orm';
import type { FilesDb } from './files.js';

/* What the store's backup is set to: the days it keeps a content no row names, and the machine picked to keep it. Its own
   module, so placement reads which machine keeps the backup without importing the backup, which places by it. */

export const KEEP_DAYS = 30;

/* The days the backup keeps a content no row names, and the machine other than the leading one picked to keep it. */
export async function backupSettings(db: FilesDb): Promise<{ keepDays: number; machineId: string | null }> {
  const [row] = rowsOf<{ keep_days: number; machine_id: string | null }>(await db.execute(sql`SELECT keep_days, machine_id FROM net.file_backup_settings`));
  return { keepDays: row?.keep_days ?? KEEP_DAYS, machineId: row?.machine_id ?? null };
}

/* The machines other than the leading one that keep the store's backup: placement keeps live copies off them while the
   other machines that keep files are as many as the copies asked for. */
export async function storeBackupMachines(db: FilesDb): Promise<string[]> {
  const { machineId } = await backupSettings(db);
  return machineId === null ? [] : [machineId];
}
