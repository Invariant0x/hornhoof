import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { machines } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import type { Sql } from '../keeper/lease-store.js';
import type { MoveReason } from '../keeper/switch-step.js';
import { queryOf } from '../merge/leader.js';
import { findThisMachine } from '../network/store.js';
import { builtinMachine } from '../nodes/nodes.js';

/* The CEO's request to move the server to another machine: one row of net.move at a time. preparing: the target gets
   its copy and commits come to wait for it; switching: the keepers hand the server over; failed: it did not move, and
   the row says why until it is taken off or replaced. */
type MoveState = 'preparing' | 'switching' | 'failed';

/* The request as the Machines tab shows it. machine: the target's row; leader: the hostname of the machine that led
   when it was asked; progress: how far the target's copy is while it is not ready. */
export type MoveView = { machine: string; state: MoveState; reason: MoveReason | null; leader: string; progress: number | null };

const nameOf = (hostname: string): string => hostname || 'This machine';
const unknown = () => new ApiError(404, 'not_found', 'This machine does not exist.', 'machine_unknown');
/* Each names its machine apart from its words, for a screen that says them in its own language. */
const alreadyLeader = (hostname: string) => new ApiError(409, 'conflict', `${nameOf(hostname)} runs the company server already.`, 'already_leader', { host: hostname });
const noNumber = (hostname: string) => new ApiError(409, 'conflict', `${nameOf(hostname)} cannot take the server now.`, 'no_number', { host: hostname });
const updating = () => new ApiError(409, 'conflict', 'Hornhoof is updating. Move the server once the update ended.', 'updating');
const switching = (hostname: string) => new ApiError(409, 'conflict', `The server is moving to ${hostname || 'another machine'} now.`, 'switching', { host: hostname });
const noRequest = () => new ApiError(404, 'not_found', 'Nobody asked to move the server to this machine.');
const tryAgain = () => new ApiError(503, 'unavailable', 'Try again in a minute.', 'try_again');

type Stored = { machine: string; state: MoveState; hostname: string };
const STORED = `SELECT v.machine_id::text AS machine, v.state, m.hostname FROM net.move v JOIN public.machines m ON m.id = v.machine_id FOR UPDATE OF v`;

/* Stores the CEO's request to move the server to this machine, in place of any request that is not switching yet,
   then ranks, so the target gets the data in the same call, and ends when that run ended. The machine that leads is
   there already; a machine with no number cannot take the server; while Hornhoof updates, and while the server is
   moving, nothing new is asked. A ranking that fails leaves the request stored, and the next run gives the copy. */
export async function askMove(ctx: Ctx, machineId: string, by: string): Promise<void> {
  const { db, config } = ctx;
  const [row] = await db.select().from(machines).where(and(eq(machines.id, machineId), isNull(machines.revokedAt)));
  if (!row) throw unknown();
  const leader = await findThisMachine(db, config);
  const host = await builtinMachine(db, config.hostId, row.companyId, config.machineId);
  if (row.id === leader?.id || row.id === host?.id) throw alreadyLeader(row.hostname);
  if (row.serverOrder === null) throw noNumber(row.hostname);
  if (ctx.updater.status()?.state === 'running') throw updating();
  /* Without the row of the machine this app runs on there is nobody to move the server from. */
  if (!leader) throw tryAgain();
  await db.transaction(async tx => {
    await tx.select(idOnly(machines)).from(machines).where(isNull(machines.revokedAt)).orderBy(asc(machines.id)).for('update');
    const q = queryOf(tx);
    const [stored] = await q<Stored>(STORED);
    if (stored?.state === 'switching') throw switching(stored.hostname);
    await q(
      `INSERT INTO net.move (machine_id, from_machine_id, asked_by, asked_at, state) VALUES ($1, $2, $3, clock_timestamp(), 'preparing')
       ON CONFLICT (id) DO UPDATE SET request = gen_random_uuid(), machine_id = EXCLUDED.machine_id, from_machine_id = EXCLUDED.from_machine_id, asked_by = EXCLUDED.asked_by,
         asked_at = EXCLUDED.asked_at, state = 'preparing', reason = NULL, ended_at = NULL`,
      [row.id, leader.id, by],
    );
  });
  try {
    await ctx.ranking.now({ rescore: false });
  } catch {
    throw tryAgain();
  }
}

/* Takes the request that names this machine off, whether it still prepares or failed. Once the server is moving,
   nothing calls it off. */
export async function cancelMove(ctx: Ctx, machineId: string): Promise<void> {
  await ctx.db.transaction(async tx => {
    const q = queryOf(tx);
    const [stored] = await q<Stored>(STORED);
    if (stored?.machine !== machineId) throw noRequest();
    if (stored.state === 'switching') throw switching(stored.hostname);
    await q('DELETE FROM net.move');
  });
}

export async function moveView(db: Db): Promise<MoveView | null> {
  const [row] = await queryOf(db)<MoveView>(
    `SELECT v.machine_id::text AS machine, v.state, v.reason, f.hostname AS leader, CASE WHEN t.copy_state IS DISTINCT FROM 'ready' THEN t.copy_progress END AS progress
       FROM net.move v JOIN public.machines f ON f.id = v.from_machine_id JOIN public.machines t ON t.id = v.machine_id`,
  );
  return row ?? null;
}

/* The hostname of the machine the server is asked to move to, while the request stands; null with none. */
export async function movingTo(db: Db): Promise<string | null> {
  const [row] = await queryOf(db)<{ hostname: string }>(`SELECT m.hostname FROM net.move v JOIN public.machines m ON m.id = v.machine_id WHERE v.state IN ('preparing', 'switching')`);
  return row ? row.hostname : null;
}

/* The row of the machine the server is asked to move to, while the request stands: preparing or switching. */
export async function moveTargetRow(db: Pick<Db, 'execute'>): Promise<string | null> {
  const [row] = await queryOf(db as Db)<{ machine: string }>(`SELECT machine_id::text AS machine FROM net.move WHERE state IN ('preparing', 'switching')`);
  return row?.machine ?? null;
}

/* For the keeper: the network id of the machine the server is asked to move to, while the request is preparing or
   switching. */
export async function moveTarget(sql: Sql): Promise<string | null> {
  const { rows } = await sql.query<{ target: string | null }>(
    `SELECT m.network_id AS target FROM net.move v JOIN public.machines m ON m.id = v.machine_id WHERE v.state IN ('preparing', 'switching') AND m.revoked_at IS NULL`,
  );
  return rows[0]?.target ?? null;
}

/* For the keeper that hands the server over: the request goes from preparing to switching, only when it is still the
   one the keeper saw. False when it was replaced, taken off or is no longer preparing. One statement, so it and a new
   request of the CEO's, which holds the row, never both go through. */
export async function claimMove(sql: Sql, request: string): Promise<boolean> {
  const { rows } = await sql.query(`UPDATE net.move SET state = 'switching' WHERE request = $1::uuid AND state = 'preparing' RETURNING 1`, [request]);
  return rows.length === 1;
}
