import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson } from '../../auth/session.js';
import { machines, nodeConnections, nodes } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { connectionHistory } from './connection-history.js';

const IdParams = z.object({ id: z.uuid() });

export function connectionRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  /* For whoever sees the machine on the machines screen: its owner, and who sees the whole company. */
  app.get('/api/machines/:id/connections', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const [machine] = await db
      .select(idOnly(machines))
      .from(machines)
      .where(and(eq(machines.id, id), eq(machines.companyId, me.companyId), isNull(machines.revokedAt), me.scopeKind === 'company' ? undefined : eq(machines.personId, me.id)));
    if (!machine) throw new ApiError(404, 'not_found', 'This machine does not exist.', 'machine_unknown');
    /* The drops of the machine's nodes: those of its built-in node, which has none of its own, stay in the table. */
    const rows = await db
      .select({
        nodeId: nodes.id,
        subscriptionId: nodes.subscriptionId,
        connectedAt: nodeConnections.connectedAt,
        disconnectedAt: nodeConnections.disconnectedAt,
        cause: nodeConnections.cause,
        closeCode: nodeConnections.closeCode,
        closeReason: nodeConnections.closeReason,
        error: nodeConnections.error,
        report: nodeConnections.report,
      })
      .from(nodeConnections)
      .innerJoin(nodes, eq(nodes.id, nodeConnections.nodeId))
      .where(eq(nodeConnections.machineId, machine.id));
    return connectionHistory(rows, new Date());
  });
}
