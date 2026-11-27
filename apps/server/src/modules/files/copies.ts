import { rowsOf } from '../../db/selections.js';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson, type Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { ApiError } from '../../errors.js';
import { backupState, MAX_KEEP_DAYS, setKeepDays } from './backup.js';
import { copiesSet, copiesWanted, counted, countedTargets, MAX_COPIES, seats } from './place.js';
import { plainOf } from './seal.js';

/* The company's setting for how many machines keep each file, and how the store stands under it: the CEO's alone. */

type Tx = Pick<Db, 'execute'>;

/* What the machines' areas hold of files at most, each kept on wanted machines, one copy to a machine: the largest
   size U with wanted * U <= the sum over machines of min(area, U). A machine with more area than the others can pair it
   with holds no more than they do. */
export function pooledCapacity(areas: number[], wanted: number): number {
  if (wanted <= 0 || areas.length < wanted) return 0;
  const sorted = [...areas].sort((a, b) => b - a);
  let sum = sorted.reduce((total, area) => total + area, 0);
  let left = wanted;
  let at = 0;
  while (left > 1 && sorted[at]! > Math.floor(sum / left)) {
    sum -= sorted[at]!;
    left -= 1;
    at += 1;
  }
  return Math.floor(sum / left);
}

/* How the store stands: the copies asked for and kept, the machines that keep files, what the files take on them and
   what their areas could hold, the files kept fewer times than wanted, and what waits on a machine that is to let it go
   for room elsewhere. */
export type FileStoreState = {
  copies: number;
  effectiveCopies: number;
  machines: number;
  filesBytes: number;
  usedBytes: number;
  capacityBytes: number;
  underCopied: number;
  stuckBytes: number;
  backup: Awaited<ReturnType<typeof backupState>>;
};

export async function fileStoreState(ctx: Pick<Ctx, 'db' | 'files'>, now = new Date()): Promise<FileStoreState> {
  const { db } = ctx;
  const mine = await ctx.files.machineId(db);
  const all = await seats(db, mine, now);
  const copies = await copiesSet(db);
  const wanted = copiesWanted(copies, all);
  const ids = `{${counted(all).map(seat => seat.id).join(',')}}`;
  const [row] = rowsOf<{ files: string; used: string; under: string; stuck: string }>(
    await db.execute(sql`WITH g AS ${countedTargets(all)},
      held AS (SELECT f.sha256, f.sealed_size, (SELECT count(*) FROM g JOIN net.file_copies c ON c.sha256 = g.sha256 AND c.machine_id = g.machine_id AND c.verified WHERE g.sha256 = f.sha256) AS n
        FROM net.files f WHERE f.drop_at IS NULL)
      SELECT (SELECT coalesce(sum(size), 0) FROM net.files WHERE drop_at IS NULL) AS files,
        (SELECT coalesce(sum(f.sealed_size), 0) FROM net.file_copies c JOIN net.files f ON f.sha256 = c.sha256 WHERE c.machine_id = ANY(${ids}::uuid[])) AS used,
        (SELECT count(*) FROM held WHERE n < ${wanted}) AS under,
        (SELECT coalesce(sum(h.sealed_size), 0) FROM held h WHERE h.n < ${wanted} AND EXISTS (SELECT 1 FROM net.file_targets t JOIN net.file_copies c ON c.sha256 = t.sha256 AND c.machine_id = t.machine_id AND c.verified
          WHERE t.sha256 = h.sha256 AND NOT EXISTS (SELECT 1 FROM g WHERE g.sha256 = t.sha256 AND g.machine_id = t.machine_id))) AS stuck`),
  );
  return {
    copies,
    effectiveCopies: wanted,
    machines: counted(all).length,
    filesBytes: Number(row?.files ?? 0),
    usedBytes: Number(row?.used ?? 0),
    capacityBytes: pooledCapacity(
      counted(all).map(seat => seat.capacity),
      Math.max(1, wanted),
    ),
    underCopied: Number(row?.under ?? 0),
    stuckBytes: Number(row?.stuck ?? 0),
    backup: await backupState(db, mine),
  };
}

/* The most plain bytes the store holds of the company's files: what the machines that count hold of files kept as often as
   asked, each within its disk; none where no machine keeps files, as on a server outside a network. */
export async function storeCap(ctx: { db: Tx; files: Pick<Ctx['files'], 'machineId'> }, now = new Date()): Promise<number | null> {
  const all = counted(await seats(ctx.db, await ctx.files.machineId(ctx.db), now));
  if (all.length === 0) return null;
  return plainOf(pooledCapacity(all.map(seat => seat.capacity), Math.max(1, copiesWanted(await copiesSet(ctx.db), all))));
}

/* Sets the copies asked for; the store's next rounds place the copies wanted more, or let go of those wanted no more
   once the others keep the file. */
export async function setCopies(db: Tx, copies: number, by: string): Promise<void> {
  await db.execute(sql`INSERT INTO net.file_settings (copies, set_by) VALUES (${copies}, ${by})
    ON CONFLICT (one) DO UPDATE SET copies = excluded.copies, set_by = excluded.set_by, set_at = now()`);
}

/* The copies the CEO asks for, and the days the store's backup keeps a file no row names, either or both. */
const Settings = z
  .strictObject({ copies: z.number().int().min(1).max(MAX_COPIES).optional(), backupKeepDays: z.number().int().min(1).max(MAX_KEEP_DAYS).optional() })
  .refine(set => set.copies !== undefined || set.backupKeepDays !== undefined, 'Name the copies, the days the backup keeps a file, or both.');

export function fileCopiesRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  function ceo(me: Person): Person {
    if (!me.isOwner || me.viaHead) throw new ApiError(403, 'forbidden', "Only the CEO sets how many machines keep the company's files.", 'not_owner_session');
    return me;
  }

  app.get('/api/company/file-store', async req => {
    ceo(await requirePerson(req, db));
    return fileStoreState(ctx);
  });

  app.patch('/api/company/file-store', async req => {
    const me = ceo(await requirePerson(req, db));
    const { copies, backupKeepDays } = Settings.parse(req.body);
    const by = me.via ? `orchestrator:${me.via}` : `person:${me.id}`;
    if (copies !== undefined) await setCopies(db, copies, by);
    if (backupKeepDays !== undefined) await setKeepDays(db, backupKeepDays, by);
    return fileStoreState(ctx);
  });
}
