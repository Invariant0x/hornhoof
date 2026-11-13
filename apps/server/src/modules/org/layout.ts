import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson } from '../../auth/session.js';
import { mapLayouts, type MapAnchors, type MapBlocks } from '../../db/schema.js';
import { ApiError } from '../../errors.js';

/* A map has a hub, its departments and its people; a person moves no more blocks than that, however large the company, and
   bends no more of its lines, each at no more places than a line needs. */
const MAX_BLOCKS = 500, MAX_LINES = 500, MAX_BENDS = 20;
/* Far beyond any company's map, so a block put there by mistake is still found by Fit. */
const FAR = 100_000;
const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const BLOCK = new RegExp(`^(?:hub|(?:dept|person):${ID})$`);
/* A line of the map: the people's way down to the hub, the trace to a department, the line to a person moved out of the
   people's row, or a department person's line to one of their departments. */
const LINE = new RegExp(`^(?:people|dept:${ID}|person:${ID}(?::dept:${ID})?)$`);

const Far = z.number().min(-FAR).max(FAR);
const At = z.object({ x: Far, y: Far }).strict();
/* The blocks a person moved, each to its new top left, and those they took back to the map's own place with null; the lines
   they bent, each with all its bends, and those they let run on their own again with null. */
const Placed = z.object({
  blocks: z.record(z.string().regex(BLOCK), At.nullable()).refine(b => Object.keys(b).length <= MAX_BLOCKS, `A map keeps at most ${MAX_BLOCKS} moved blocks.`).optional(),
  anchors: z.record(z.string().regex(LINE), z.array(z.tuple([Far, Far])).min(1).max(MAX_BENDS).nullable())
    .refine(a => Object.keys(a).length <= MAX_LINES, `A map keeps at most ${MAX_LINES} bent lines.`).optional(),
}).strict().refine(p => p.blocks || p.anchors, 'Give the blocks or the bends to keep.');

/* The changes to one kind of what a person keeps: a value for a key keeps it, null drops it. */
function changed<T>(was: Record<string, T> | undefined, by: Record<string, T | null> | undefined, most: number, what: string): Record<string, T> {
  const next: Record<string, T> = { ...was };
  for (const [key, value] of Object.entries(by ?? {})) {
    if (value) next[key] = value;
    else delete next[key];
  }
  if (Object.keys(next).length > most) throw new ApiError(400, 'validation', `A map keeps at most ${most} ${what}.`);
  return next;
}

/* Each person arranges the company map for themselves: anyone who sees it may, and nobody else's map moves with it. */
export function mapLayoutRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  app.get('/api/map/layout', async req => {
    const me = await requirePerson(req, db);
    const [row] = await db.select({ blocks: mapLayouts.blocks, anchors: mapLayouts.anchors }).from(mapLayouts).where(eq(mapLayouts.personId, me.id));
    return { blocks: row?.blocks ?? {}, anchors: row?.anchors ?? {} };
  });

  app.patch('/api/map/layout', async req => {
    const me = await requirePerson(req, db);
    const body = Placed.parse(req.body);
    return db.transaction(async tx => {
      const [row] = await tx.select({ blocks: mapLayouts.blocks, anchors: mapLayouts.anchors }).from(mapLayouts).where(eq(mapLayouts.personId, me.id)).for('update');
      const blocks: MapBlocks = changed(row?.blocks, body.blocks, MAX_BLOCKS, 'moved blocks');
      const anchors: MapAnchors = changed(row?.anchors, body.anchors, MAX_LINES, 'bent lines');
      await tx.insert(mapLayouts).values({ personId: me.id, companyId: me.companyId, blocks, anchors })
        .onConflictDoUpdate({ target: mapLayouts.personId, set: { blocks, anchors, updatedAt: new Date() } });
      return { blocks, anchors };
    });
  });

  /* Put back as it was: every block goes to where the map places it, and every line runs on its own way again. */
  app.delete('/api/map/layout', async (req, reply) => {
    const me = await requirePerson(req, db);
    await db.delete(mapLayouts).where(eq(mapLayouts.personId, me.id));
    return reply.code(204).send();
  });
}
