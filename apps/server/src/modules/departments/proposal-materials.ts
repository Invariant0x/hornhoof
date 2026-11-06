import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { proposals } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { visibleDecisions } from '../tasks/decisions.js';
import type { Tx } from '../tasks/engine.js';

const Params = z.strictObject({ id: z.uuid() });
const ContentParams = Params.extend({ materialId: z.uuid() });
const unavailable = () => new ApiError(503, 'unavailable', 'The materials for this proposal are not available yet. Keep your answer and try again later.', 'source_producer_unavailable');

/* A public stamp or staged private package cannot inherit legacy application
   permission. Hold the real source row until the surrounding apply commits. */
export async function refuseUnclassifiedProposal(tx: Tx, companyId: string, id: string, kind: 'structure' | 'staff', departmentId: string | null = null): Promise<void> {
  const [source] = await tx.select({ revision: proposals.materialRevision, digest: proposals.materialDigest, snapshot: proposals.materialSnapshot }).from(proposals)
    .where(and(eq(proposals.id, id), eq(proposals.companyId, companyId), eq(proposals.kind, kind), eq(proposals.status, 'pending'), kind === 'staff' ? eq(proposals.departmentId, departmentId!) : undefined)).for('update');
  if (source && (source.revision !== null || source.digest !== null || source.snapshot !== null)) throw unavailable();
}

/* Native documents must come from the sealed actual proposal and its current
   classification/disclosure producer, never a reconstruction of mutable items. */
async function unavailableProposalMaterials(ctx: Pick<Ctx, 'db' | 'computer'>, me: Person, id: string): Promise<never> {
  const visible = await visibleDecisions(ctx, me);
  if (!visible.proposals.some(item => item.proposal.id === id)) throw new ApiError(404, 'not_found', 'There is no such proposal you can see.');
  throw unavailable();
}

export function proposalMaterialRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/proposals/:id/materials', async (req, reply) => {
    const me = await requirePerson(req, ctx.db);
    const { id } = Params.parse(req.params);
    reply.header('cache-control', 'private, no-store');
    return unavailableProposalMaterials(ctx, me, id);
  });
  for (const mode of ['content', 'download'] as const) app.get(`/api/proposals/:id/materials/:materialId/${mode}`, async (req, reply) => {
    const me = await requirePerson(req, ctx.db);
    const { id } = ContentParams.parse(req.params);
    reply.header('cache-control', 'private, no-store');
    return unavailableProposalMaterials(ctx, me, id);
  });
}
