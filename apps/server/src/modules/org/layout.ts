import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson } from '../../auth/session.js';
import { mapLayouts, type MapBlocks } from '../../db/schema.js';
import { ApiError } from '../../errors.js';

/* A map has a hub, its departments and its people; a person moves no more blocks than that, however large the company. */
const MAX_BLOCKS = 500;
/* Far beyond any company's map, so a block put there by mistake is still found by Fit. */
const FAR = 100_000;
const BLOCK = /^(?:hub|(?:dept|person):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const At = z.object({ x: z.number().min(-FAR).max(FAR), y: z.number().min(-FAR).max(FAR) }).strict();
/* The blocks a person moved, each to its new top left, and those they took back to the map's own place with null. */
const Placed = z.object({
  blocks: z.record(z.string().regex(BLOCK), At.nullable()).refine(b => Object.keys(b).length <= MAX_BLOCKS, `A map keeps at most ${MAX_BLOCKS} moved blocks.`),
}).strict();

/* Each person arranges the company map for themselves: anyone who sees it may, and nobody else's map moves with it. */
export function mapLayoutRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  app.get('/api/map/layout', async req => {
    const me = await requirePerson(req, db);
    const [row] = await db.select({ blocks: mapLayouts.blocks }).from(mapLayouts).where(eq(mapLayouts.personId, me.id));
    return { blocks: row?.blocks ?? {} };
  });

  app.patch('/api/map/layout', async req => {
    const me = await requirePerson(req, db);
    const body = Placed.parse(req.body);
    const blocks = await db.transaction(async tx => {
      const [row] = await tx.select({ blocks: mapLayouts.blocks }).from(mapLayouts).where(eq(mapLayouts.personId, me.id)).for('update');
      const next: MapBlocks = { ...row?.blocks };
      for (const [key, at] of Object.entries(body.blocks)) {
        if (at) next[key] = at;
        else delete next[key];
      }
      if (Object.keys(next).length > MAX_BLOCKS) throw new ApiError(400, 'validation', `A map keeps at most ${MAX_BLOCKS} moved blocks.`);
      await tx.insert(mapLayouts).values({ personId: me.id, companyId: me.companyId, blocks: next })
        .onConflictDoUpdate({ target: mapLayouts.personId, set: { blocks: next, updatedAt: new Date() } });
      return next;
    });
    return { blocks };
  });

  /* Put back as it was: every block goes to where the map places it. */
  app.delete('/api/map/layout', async (req, reply) => {
    const me = await requirePerson(req, db);
    await db.delete(mapLayouts).where(eq(mapLayouts.personId, me.id));
    return reply.code(204).send();
  });
}
