import { and, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { machines } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { freshState } from '../keeper/state.js';

/* How fast the leader sends to each machine, as its keeper last measured it, into the machines' rows: each live row
   the keeper names whose value differs gets the new one. A row it does not name keeps what it has, as after a week with
   nothing sent to it or after a change of leader. The rows written. */
export async function storeThroughput(ctx: Ctx, now = Date.now()): Promise<number> {
  const said = freshState(ctx.config.controlDir, now)?.throughput;
  if (!said) return 0;
  let written = 0;
  for (const [id, { mbps }] of Object.entries(said)) {
    if (!/^[0-9a-f-]{36}$/.test(id)) continue;
    const [row] = await ctx.db.select(only(machines, 'linkMbps')).from(machines).where(and(eq(machines.id, id), isNull(machines.revokedAt)));
    if (!row || row.linkMbps === mbps) continue;
    await ctx.db.update(machines).set({ linkMbps: mbps }).where(eq(machines.id, id));
    written += 1;
  }
  return written;
}
