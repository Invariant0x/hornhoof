import { WAIT_SOURCE_KINDS } from '@hornhoof/protocol/waits';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson } from '../../auth/session.js';
import { waitPolicies } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { mayChangeRules, ownDepartment } from './approval-policy.js';

/* How long a department gives each kind of wait, as its owner, the CEO or the delegate set it. Each change is a new version:
   waits already bound keep the dates they have. No number is made up here, and the first one set makes the department strict. */

const IdParams = z.object({ id: z.uuid() });
const KindParams = z.object({ id: z.uuid(), kind: z.enum(WAIT_SOURCE_KINDS) });
const Span = z.number().int().positive().max(366 * 24 * 3_600_000);
const PolicyBody = z.strictObject({ stage: z.string().trim().max(40).default(''), ownerMs: Span, headMs: Span, decisionMs: Span, reviewIntervalMs: Span })
  .refine(p => p.ownerMs <= p.headMs && p.headMs <= p.decisionMs, 'The owner\'s date comes first, then the head\'s, then the decision\'s.');

const newest = (rows: (typeof waitPolicies.$inferSelect)[]) => {
  const seen = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!seen.has(`${row.kind}:${row.stage}`)) seen.set(`${row.kind}:${row.stage}`, row);
  return [...seen.values()].map(({ kind, stage, version, ownerMs, headMs, decisionMs, reviewIntervalMs }) => ({ kind, stage, version, ownerMs, headMs, decisionMs, reviewIntervalMs }));
};

/* What the department gives each kind of wait now. */
export async function departmentWaitPolicies(ctx: Pick<Ctx, 'db'>, departmentId: string) {
  return newest(await ctx.db.select().from(waitPolicies).where(eq(waitPolicies.departmentId, departmentId)).orderBy(desc(waitPolicies.version)));
}

export function waitPolicyRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  app.get('/api/departments/:id/wait-policy', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const dept = await ownDepartment(db, me.companyId, id);
    return { policies: await departmentWaitPolicies(ctx, dept.id), canChange: await mayChangeRules(db, me, dept.id) };
  });

  app.put('/api/departments/:id/wait-policy/:kind', async req => {
    const me = await requirePerson(req, db);
    const { id, kind } = KindParams.parse(req.params);
    const body = PolicyBody.parse(req.body);
    const dept = await ownDepartment(db, me.companyId, id);
    if (!(await mayChangeRules(db, me, dept.id))) throw new ApiError(403, 'forbidden', 'Only the owner of this department, the CEO or the CEO delegate set its dates.', 'decision_not_allowed');
    await db.transaction(async tx => {
      const [last] = await tx.select(only(waitPolicies, 'version')).from(waitPolicies)
        .where(and(eq(waitPolicies.departmentId, dept.id), eq(waitPolicies.kind, kind), eq(waitPolicies.stage, body.stage))).orderBy(desc(waitPolicies.version)).limit(1).for('update');
      await tx.insert(waitPolicies).values({ companyId: me.companyId, departmentId: dept.id, kind, version: (last?.version ?? 0) + 1, ...body, createdByPersonId: me.id });
    });
    return { policies: await departmentWaitPolicies(ctx, dept.id) };
  });
}
