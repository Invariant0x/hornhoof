import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson } from '../../auth/session.js';
import { decryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import { machines, nodeCodes, subscriptions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';

const CommandParams = z.object({ id: z.string().regex(/^[0-9a-f]{64}$/) });
const HideBody = z.object({ subscriptionId: z.uuid().optional() }).strict();
const unknown = () => new ApiError(404, 'not_found', 'This command is not shown any more.', 'code_unknown');

async function ownScreen(req: Parameters<typeof requirePerson>[0], db: Db) {
  const me = await requirePerson(req, db);
  if (me.viaHead) throw new ApiError(403, 'forbidden', "Only the person's own screen shows this.", 'not_owner');
  return me;
}

async function activeCommands(db: Db, personId: string, secret: Buffer) {
  const rows = await db.select({
    id: nodeCodes.codeHash, commandEnc: nodeCodes.commandEnc, subscriptionIds: nodeCodes.subscriptionIds,
    dismissedSubscriptionIds: nodeCodes.dismissedSubscriptionIds, machineId: nodeCodes.machineId,
    machine: machines.hostname, expiresAt: nodeCodes.expiresAt, core: nodeCodes.core,
  }).from(nodeCodes).leftJoin(machines, eq(machines.id, nodeCodes.machineId))
    .where(and(eq(nodeCodes.personId, personId), isNotNull(nodeCodes.commandEnc), isNull(nodeCodes.usedAt), gt(nodeCodes.expiresAt, new Date())))
    .orderBy(asc(nodeCodes.createdAt));
  const ids = rows.flatMap(r => r.subscriptionIds);
  const plans = ids.length ? await db.select({ id: subscriptions.id, label: subscriptions.label }).from(subscriptions).where(inArray(subscriptions.id, ids)) : [];
  return rows.map(r => ({
    /* core: the command brings the company's core to its machine, and no plan. */
    id: r.id, kind: r.core ? 'core' : r.machineId ? 'add' : r.subscriptionIds.length ? 'plans' : 'machine',
    subscriptionIds: r.subscriptionIds, dismissedSubscriptionIds: r.dismissedSubscriptionIds,
    plans: r.subscriptionIds.flatMap(id => plans.filter(p => p.id === id).map(p => p.label)),
    machineId: r.machineId, machine: r.machine, command: decryptSecret(r.commandEnc!, secret), expiresAt: r.expiresAt.toISOString(),
  }));
}

/* Done dismisses a plan's block, never its code. Other places keep Cancel, which consumes the code too. */
async function hideCommand(db: Db, id: string, personId: string, subscriptionId: string | undefined): Promise<void> {
  const where = and(eq(nodeCodes.codeHash, id), eq(nodeCodes.personId, personId));
  const [row] = await db.select().from(nodeCodes).where(where);
  if (!row) throw unknown();
  if (row.machineId || !row.subscriptionIds.length) {
    await db.update(nodeCodes).set({ commandEnc: null, usedAt: new Date() }).where(where);
    return;
  }
  if (subscriptionId && !row.subscriptionIds.includes(subscriptionId)) throw unknown();
  const ids = subscriptionId ? [subscriptionId] : row.subscriptionIds;
  /* Union at the database avoids losing a different block dismissed concurrently on another device. */
  await db.update(nodeCodes).set({
    dismissedSubscriptionIds: sql`array(select distinct unnest(${nodeCodes.dismissedSubscriptionIds} || ${sql.param(ids, nodeCodes.dismissedSubscriptionIds)}))`,
  }).where(where);
}

export function nodeCommandRoutes(app: FastifyInstance, { db, config }: Ctx): void {
  app.get('/api/nodes/commands', async req => {
    const me = await ownScreen(req, db);
    return { commands: await activeCommands(db, me.id, config.secret) };
  });
  app.post('/api/nodes/commands/:id/hide', async (req, reply) => {
    const me = await ownScreen(req, db);
    const { id } = CommandParams.parse(req.params);
    const { subscriptionId } = HideBody.parse(req.body ?? {});
    await hideCommand(db, id, me.id, subscriptionId);
    return reply.code(204).send();
  });
}
