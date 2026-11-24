/* Human-only read-only HTTP routes for Stage 1 world achievements and public-safe showcase payloads:
   - GET /api/world/rewards          (company achievements and verified counts)
   - GET /api/world/rewards/showcase (public-safe showcase and share cards with zero private data) */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { ApiError } from '../../errors.js';
import { readCompanyRewards } from './rewards-read.js';

const EmptyQuerySchema = z.object({}).strict();

function assertHumanRewardsReader(me: Person): void {
  if (me.via || me.assistant) {
    throw new ApiError(403, 'forbidden', 'Game achievements are visible to human company members only.');
  }
}

export function registerWorldRewardsRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/world/rewards', async req => {
    const me = await requirePerson(req, ctx.db);
    assertHumanRewardsReader(me);
    EmptyQuerySchema.parse(req.query);
    return readCompanyRewards(ctx, me.companyId, me.id);
  });

  app.get('/api/world/rewards/showcase', async req => {
    const me = await requirePerson(req, ctx.db);
    assertHumanRewardsReader(me);
    EmptyQuerySchema.parse(req.query);
    const rewards = await readCompanyRewards(ctx, me.companyId, me.id);
    return rewards.showcase;
  });
}
