import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { EventBus } from '../events/bus.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/* Queue writers may publish through their context. Keep those events private until the entire operator move commits. */
export async function operatorTransaction<T>(ctx: Ctx, run: (tx: Tx, inside: Ctx) => Promise<T>): Promise<T> {
  const events: Parameters<EventBus['publish']>[] = [];
  const bus = new EventBus();
  bus.publish = (...event) => { events.push(event); };
  const result = await ctx.db.transaction(tx => run(tx, { ...ctx, db: tx as unknown as Db, bus }));
  for (const event of events) ctx.bus.publish(...event);
  return result;
}
