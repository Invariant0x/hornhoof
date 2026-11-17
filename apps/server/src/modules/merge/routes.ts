import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { ApiError } from '../../errors.js';
import { conflictsOf, pick, type ConflictView } from './picks.js';

const MergeParams = z.object({ id: z.uuid() });
const ListQuery = z.object({ settled: z.enum(['0', '1']).optional() });
const PickBody = z
  .object({
    ids: z.array(z.uuid()).min(1).max(500).optional(),
    merge: z.uuid().optional(),
    table: z.string().trim().min(1).max(63).optional(),
    take: z.enum(['here', 'there', 'value']),
    value: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/* How many of a merge's conflicts the CEO's card reads at most. */
const SHOWN = 500;

/* What a merge left for the CEO: the conflicts about people, access, plans, machines and protected records, which
   only he settles, by himself or through the orchestrator. Nobody else reads them. */
export function mergeRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  function ceo(me: Person): Person {
    if (!me.isOwner || me.viaHead) throw new ApiError(403, 'forbidden', 'Only the CEO settles these, by himself or through the orchestrator.', 'not_owner_session');
    return me;
  }

  /* The CEO's conflicts of one merge, open ones unless the settled are asked for. */
  app.get('/api/merges/:id/conflicts', async req => {
    const me = ceo(await requirePerson(req, db));
    const { id } = MergeParams.parse(req.params);
    const settled = ListQuery.parse(req.query).settled === '1';
    const conflicts: ConflictView[] = [];
    for (let after: string | undefined; conflicts.length < SHOWN; ) {
      const page = await conflictsOf(db, { kind: 'ceo', personId: me.id }, { merge: id, settled, after, limit: 100 });
      conflicts.push(...page.conflicts.filter(conflict => conflict.whose === 'ceo'));
      if (!page.more) break;
      after = page.conflicts.at(-1)!.id;
    }
    return { conflicts };
  });

  /* The CEO settles conflicts, his own or any other: one, a list, or every open one of a merge or of a table. */
  app.post('/api/merges/pick', async req => {
    const me = ceo(await requirePerson(req, db));
    const { ids, merge, table, take, value } = PickBody.parse(req.body);
    return pick(ctx, { kind: 'ceo', personId: me.id }, { ids, merge, table }, take, value);
  });
}
