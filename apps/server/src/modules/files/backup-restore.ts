import { rowsOf } from '../../db/selections.js';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { ApiError } from '../../errors.js';
import type { FilesDb } from './files.js';
import { recordFile } from './files.js';
import { placeFiles } from './place.js';
import { StoreRefused } from './store.js';

/* A restore from the store's backup (#2056), the CEO's alone: one file, or every file of the company, as it was at a
   moment the backup reaches back to. A dry run first names what it would do and its digest; the restore itself names
   that digest and does it only while it is still what the dry run showed. A file deleted since comes back as its row
   was, one given other bytes since gets back the bytes it had; files that came after the moment stay as they are. */

const Restore = z.strictObject({
  attachmentId: z.uuid().optional(),
  at: z.iso.datetime({ offset: true }).optional(),
  dryRun: z.boolean(),
  digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
type Ask = z.infer<typeof Restore>;

type Name = { attachment_id: string; sha256: string; row: Record<string, unknown> };
/* What a restore does for one file. again: its row comes back; back: its row gets back the bytes it had. ready: a copy of
   those bytes is there to come back, live or in the backup, and whatever its row names is still there. */
export type RestoreItem = { attachmentId: string; name: string; action: 'again' | 'back'; sha256: string; size: number; ready: boolean; reason?: string };
type Planned = RestoreItem & { row: Record<string, unknown> };

/* The tables a row of attachments names, by its column: a row comes back only while each it names is there. */
const NAMES = { company_id: 'companies', job_id: 'jobs', agent_id: 'agents', person_id: 'people', request_id: 'requests', operator_case_id: 'program_operator_cases', task_id: 'tasks', test_run_id: 'test_runs' } as const;

/* The names the restore puts back: at a moment, those of then; for one file with no moment, the one it had before its
   name last changed. */
async function namesOf(db: FilesDb, companyId: string, ask: Ask): Promise<Name[]> {
  const one = ask.attachmentId ? sql`AND n.attachment_id = ${ask.attachmentId}` : sql``;
  if (ask.at) {
    const at = new Date(ask.at).toISOString();
    return rowsOf<Name>(
      await db.execute(sql`SELECT n.attachment_id, n.sha256, n."row" FROM net.file_backup_names n WHERE n.company_id = ${companyId} ${one}
        AND n.since <= ${at}::timestamptz AND (n.until IS NULL OR n.until > ${at}::timestamptz) ORDER BY n.attachment_id`),
    );
  }
  return rowsOf<Name>(
    await db.execute(sql`SELECT n.attachment_id, n.sha256, n."row" FROM net.file_backup_names n WHERE n.company_id = ${companyId} ${one}
      AND n.until IS NOT NULL ORDER BY n.until DESC LIMIT 1`),
  );
}

/* Whether a copy of a content is there to come back: live, or kept by the backup. */
async function contentThere(db: FilesDb, sha256: string): Promise<boolean> {
  const [row] = rowsOf<{ there: boolean }>(
    await db.execute(sql`SELECT (EXISTS (SELECT 1 FROM net.files WHERE sha256 = ${sha256} AND drop_at IS NULL)
      OR EXISTS (SELECT 1 FROM net.file_backups WHERE sha256 = ${sha256} AND kept_at IS NOT NULL AND drop_at IS NULL)) AS there`),
  );
  return row?.there === true;
}

/* What of a row is gone that it names, so it cannot come back. */
async function goneOf(db: FilesDb, row: Record<string, unknown>): Promise<string | null> {
  for (const [column, table] of Object.entries(NAMES)) {
    const id = row[column];
    if (typeof id !== 'string') continue;
    const [found] = rowsOf<{ there: boolean }>(await db.execute(sql`SELECT EXISTS (SELECT 1 FROM ${sql.identifier(table)} WHERE id = ${id}::uuid) AS there`));
    if (!found?.there) return `${column.replace(/_id$/, '').replace('_', ' ')} gone`;
  }
  return null;
}

export async function restorePlan(db: FilesDb, companyId: string, ask: Ask): Promise<{ at: string | null; digest: string; items: Planned[] }> {
  if (!ask.attachmentId && !ask.at) throw new ApiError(400, 'validation', 'A restore of every file names the moment to go back to.');
  const items: Planned[] = [];
  for (const name of await namesOf(db, companyId, ask)) {
    const [now] = rowsOf<{ sha256: string | null }>(await db.execute(sql`SELECT sha256 FROM attachments WHERE id = ${name.attachment_id} AND company_id = ${companyId}`));
    if (now && now.sha256 === name.sha256) continue;
    const action = now ? 'back' : 'again';
    const gone = action === 'again' ? await goneOf(db, name.row) : null;
    const there = await contentThere(db, name.sha256);
    const reason = !there ? 'no copy kept' : gone;
    items.push({
      attachmentId: name.attachment_id,
      name: String(name.row.name ?? ''),
      action,
      sha256: name.sha256,
      size: Number(name.row.size ?? 0),
      ready: reason === null,
      ...(reason ? { reason } : {}),
      row: name.row,
    });
  }
  const at = ask.at ? new Date(ask.at).toISOString() : null;
  const hash = createHash('sha256').update(`${at ?? ''}\n`);
  for (const item of [...items].sort((a, b) => a.attachmentId.localeCompare(b.attachmentId))) hash.update(`${item.attachmentId} ${item.action} ${item.sha256}\n`);
  return { at, digest: hash.digest('hex'), items };
}

/* Brings a content back into the live store, from the backup folder here, checked to open with the store key to bytes of
   its name; a content kept by another machine is asked of it, and comes back once it sent it. */
export async function bringBack(ctx: Pick<Ctx, 'db' | 'files'>, sha256: string): Promise<'live' | 'waiting' | 'refused' | 'gone'> {
  const { db, files } = ctx;
  if (rowsOf(await db.execute(sql`SELECT 1 FROM net.files WHERE sha256 = ${sha256} AND drop_at IS NULL`)).length) return 'live';
  const [kept] = rowsOf<{ size: string; sealed_size: string }>(
    await db.execute(sql`SELECT size, sealed_size FROM net.file_backups WHERE sha256 = ${sha256} AND kept_at IS NOT NULL AND drop_at IS NULL`),
  );
  if (!kept) return 'gone';
  const here = files.backupStore().sealed(sha256);
  if (!here) {
    await db.execute(sql`UPDATE net.file_backups SET restore_at = now() WHERE sha256 = ${sha256}`);
    return 'waiting';
  }
  const live = files.store();
  await live.remove(sha256);
  try {
    await live.takeOpened(sha256, here.stream(), await files.key(db), Number(kept.sealed_size));
  } catch (err) {
    if (err instanceof StoreRefused) return 'refused';
    throw err;
  }
  const mine = await files.machineId(db);
  await recordFile(db, { sha256, size: Number(kept.size), ...(await live.sealedFacts(sha256)) }, mine);
  await placeFiles(db, mine, { only: [sha256] });
  return 'live';
}

/* Puts one row back as the plan says: again as it was, or back to the bytes it had. A row whose names went meanwhile
   stays as it is. */
async function putBack(db: FilesDb, companyId: string, item: Planned): Promise<boolean> {
  if (item.action === 'back') {
    const changed = await db.execute(sql`UPDATE attachments SET sha256 = ${item.sha256}, size = ${item.size} WHERE id = ${item.attachmentId} AND company_id = ${companyId} RETURNING id`);
    return rowsOf(changed).length === 1;
  }
  if (item.row.company_id !== companyId) return false;
  const added = await db.execute(sql`INSERT INTO attachments SELECT * FROM jsonb_populate_record(NULL::attachments, ${JSON.stringify(item.row)}::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id`);
  return rowsOf(added).length === 1;
}

export function backupRestoreRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  function ceo(me: Person): Person {
    if (!me.isOwner || me.viaHead) throw new ApiError(403, 'forbidden', "Only the CEO puts the company's files back from the store's backup, by himself or through the orchestrator.", 'not_owner_session');
    return me;
  }

  app.post('/api/company/file-store/backup/restore', async req => {
    const me = ceo(await requirePerson(req, db));
    const ask = Restore.parse(req.body);
    if (!ask.dryRun && !ask.digest) throw new ApiError(400, 'validation', 'A restore names the digest its dry run gave.');
    const plan = await restorePlan(db, me.companyId, ask);
    const shown = (item: Planned): RestoreItem => ({
      attachmentId: item.attachmentId,
      name: item.name,
      action: item.action,
      sha256: item.sha256,
      size: item.size,
      ready: item.ready,
      ...(item.reason ? { reason: item.reason } : {}),
    });
    if (ask.dryRun) return { at: plan.at, digest: plan.digest, items: plan.items.map(shown) };
    if (ask.digest !== plan.digest) throw new ApiError(409, 'conflict', 'The files to put back are not those the dry run showed any more: run it dry again.', 'restore_changed');
    let applied = 0;
    let waiting = 0;
    const items: (RestoreItem & { status: string })[] = [];
    for (const item of plan.items) {
      const content = item.ready ? await bringBack(ctx, item.sha256) : 'gone';
      if (content === 'waiting') waiting++;
      const put = content === 'live' && (await db.transaction(tx => putBack(tx as unknown as FilesDb, me.companyId, item)).catch(() => false));
      if (put) applied++;
      items.push({ ...shown(item), status: put ? 'done' : content === 'live' ? 'refused' : content });
    }
    return { at: plan.at, digest: plan.digest, applied, waiting, items };
  });
}
