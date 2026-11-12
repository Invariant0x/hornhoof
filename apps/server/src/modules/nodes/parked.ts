import type { NodeMessage } from '@hornhoof/protocol';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { loggable } from '../../errors.js';
import { queryOf } from '../merge/leader.js';
import type { NodeIdentity } from './hub.js';

/* After the server was taken over, the machine that led may come back with work the new leader never heard of: turns
   it sent out after its last change reached a copy. Until that machine's database is merged, a node that says
   something of a job the leader has no row of is believed: the job is left running, and what the node says of it is
   kept here, to be applied once the merge brought the job's row. */

export type ParkedKind = 'listed' | 'started' | 'event' | 'done';

const PENDING = `SELECT EXISTS (
  SELECT FROM net.handovers h JOIN public.machines m ON m.id = h.from_machine_id AND m.revoked_at IS NULL
   WHERE h.kind IN ('takeover', 'ceo')
     AND NOT EXISTS (SELECT FROM net.merges g
       WHERE g.source LIKE 'machine:' || m.id::text || ':led-%' AND g.created_at > h.at AND g.status IN ('merged', 'done'))
) AS pending`;

const CHECK_EVERY_MS = 1000;
const checked = new WeakMap<Db, { at: number; pending: boolean }>();

/* Whether the database of a machine the server was taken from still waits to be merged: a takeover, or the CEO's
   choice of a copy, from a machine that is still the company's, with no merge of what that machine led made after it
   and ended. Read at most once a second. */
export async function mergePending(db: Db, now = Date.now()): Promise<boolean> {
  const last = checked.get(db);
  if (last && now >= last.at && now - last.at < CHECK_EVERY_MS) return last.pending;
  const [row] = await queryOf(db)<{ pending: boolean }>(PENDING);
  const pending = row?.pending === true;
  checked.set(db, { at: now, pending });
  return pending;
}

/* What was read last counts no more: a takeover was recorded, or a merge ended. */
export function pendingChanged(db: Db): void {
  checked.delete(db);
}

/* The node as it is kept beside what it said: who it is, and nothing of its key. */
const kept = (node: NodeIdentity): NodeIdentity => (node.kind === 'node' ? { kind: 'node', nodeId: node.nodeId } : { kind: 'builtin', machine: node.machine });

/* Keeps what a node said of a job. That a node lists a job is kept once a job. What is kept of one job is told apart
   by its time, so each row's time is after the job's last one, however fast they came. */
export async function park(db: Db, o: { jobId: string; node: NodeIdentity; kind: ParkedKind; body: unknown }): Promise<void> {
  await queryOf(db)(
    `INSERT INTO net.parked (job_id, node, kind, body, at)
     SELECT $1::uuid, $2::jsonb, $3, $4::jsonb,
            GREATEST(clock_timestamp(), (SELECT max(p.at) + interval '1 microsecond' FROM net.parked p WHERE p.job_id = $1::uuid))
      WHERE $3 <> 'listed' OR NOT EXISTS (SELECT FROM net.parked p WHERE p.job_id = $1::uuid AND p.kind = 'listed')`,
    [o.jobId, JSON.stringify(kept(o.node)), o.kind, JSON.stringify(o.body ?? {})],
  );
}

const Node = z.union([z.object({ kind: z.literal('node'), nodeId: z.string() }), z.object({ kind: z.literal('builtin'), machine: z.string() })]);

/* The jobs something is kept of, each with the node it runs on: the one that listed it or said it started last, else
   the one that said anything of it last. */
export async function parkedJobs(db: Db): Promise<Map<string, NodeIdentity>> {
  const rows = await queryOf(db)<{ job: string; node: unknown }>(
    `SELECT DISTINCT ON (p.job_id) p.job_id::text AS job, p.node FROM net.parked p
      ORDER BY p.job_id, (p.kind IN ('listed', 'started')) DESC, p.at DESC, p.id DESC`,
  );
  const jobs = new Map<string, NodeIdentity>();
  for (const row of rows) {
    const node = Node.safeParse(row.node);
    if (node.success) jobs.set(row.job, node.data);
  }
  return jobs;
}

type Kept = { id: string; job: string; node: unknown; body: unknown };
type Handle = (ctx: Ctx, id: NodeIdentity, msg: NodeMessage) => Promise<void>;
const applying = new WeakSet<Db>();

/* Applies what was kept of each job whose row is there now: that it started, its events and its end, in the order
   they came, each in a transaction of its own with the mark that it was applied, so none is applied twice and a job
   whose message fails goes on from that message at the next run. Answers how many it applied. handle: what takes a
   node's message, which is the caller's to give. */
export async function applyParked(ctx: Ctx, handle: Handle): Promise<number> {
  if (applying.has(ctx.db)) return 0;
  applying.add(ctx.db);
  try {
    const q = queryOf(ctx.db);
    /* That a node listed a job says nothing once the job's row is there. */
    await q(`UPDATE net.parked p SET applied_at = clock_timestamp() WHERE p.applied_at IS NULL AND p.kind = 'listed' AND EXISTS (SELECT FROM public.jobs j WHERE j.id = p.job_id)`);
    const rows = await q<Kept>(
      `SELECT p.id::text AS id, p.job_id::text AS job, p.node, p.body FROM net.parked p
        WHERE p.applied_at IS NULL AND p.kind <> 'listed' AND EXISTS (SELECT FROM public.jobs j WHERE j.id = p.job_id)
        ORDER BY p.at, p.id`,
    );
    const failed = new Set<string>();
    let applied = 0;
    for (const row of rows) {
      if (failed.has(row.job)) continue;
      const node = Node.safeParse(row.node);
      try {
        const did = await ctx.db.transaction(async tx => {
          const scoped = { ...ctx, db: tx as unknown as Db };
          const [still] = await queryOf(scoped.db)<{ id: string }>('SELECT id::text AS id FROM net.parked WHERE id = $1::uuid AND applied_at IS NULL FOR UPDATE', [row.id]);
          if (!still) return false;
          /* A row that names no node this Hornhoof knows is marked and left: nothing can take it. */
          if (node.success) await handle(scoped, node.data, row.body as NodeMessage);
          await queryOf(scoped.db)('UPDATE net.parked SET applied_at = clock_timestamp() WHERE id = $1::uuid', [row.id]);
          return node.success;
        });
        if (did) applied += 1;
      } catch (err) {
        failed.add(row.job);
        ctx.log.warn({ error: loggable(err), job: row.job }, 'Could not apply what a node said of a job while its database was away. It is tried again in a minute.');
      }
    }
    return applied;
  } finally {
    applying.delete(ctx.db);
  }
}
