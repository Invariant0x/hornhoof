import type { FilesDb } from './files.js';

/* The store's own backup (#2056): versioned copies of the sealed files on a machine apart from the live copies, kept
   30 days. A backup copy is never a live copy: the machine that keeps it reports none into net.file_copies, so it takes
   no copy's place and lets no copy go. Until #2056 lands, no machine keeps the backup. */

/* Whether a machine keeps the store's backup, so the leading keeper gives it a file (sha256, when one is named) and
   takes one back from it in a restore. */
export async function backsUpStore(_db: FilesDb, _machineId: string, _sha256?: string): Promise<boolean> {
  return false;
}

/* The machines that keep the store's backup: the last ones picked for live copies, and none of them while the other
   machines that keep files are as many as the copies asked for. */
export async function storeBackupMachines(_db: FilesDb): Promise<string[]> {
  return [];
}
