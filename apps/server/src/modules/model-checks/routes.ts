import { MODEL_CHECK_KINDS, Case } from '@hornhoof/protocol';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf, listsDepartment } from '../../auth/access.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { departments, modelCheckDatasets, modelCheckEvaluations, modelChecks } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { mayChangeRules, ownDepartment } from '../departments/approval-policy.js';
import { isOn } from './lifecycle.js';
import { addLiveMiss, saveDataset, saveThresholds, type CheckPlace, type SavedSet } from './store.js';

/* What a person does with a department's checks. The owner, the CEO and the delegate set limits and send examples in, as with
   its approvals; whoever has the department reads the results. Examples never come back out: a report holds counts and the ids
   of open examples, so the held-out part stays away from whoever tunes a prompt. */

type CheckRow = typeof modelChecks.$inferSelect;

const DepartmentParams = z.object({ id: z.uuid() });
const CheckParams = z.object({ id: z.uuid(), kind: z.enum(MODEL_CHECK_KINDS) });
const ProductId = z.uuid().nullable();
const LimitsBody = z.strictObject({ productId: ProductId, thresholds: z.unknown() });
const SetBody = z.strictObject({ productId: ProductId, jsonl: z.string() });
const MissBody = z.strictObject({ productId: ProductId, example: z.unknown() });

export function modelCheckRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  /* Who may change a check of this department, and of which kind, before anything in the body is read. */
  const changer = async (me: Person, req: FastifyRequest) => {
    const { id, kind } = CheckParams.parse(req.params);
    const dept = await ownDepartment(db, me.companyId, id);
    if (!(await mayChangeRules(db, me, dept.id))) throw new ApiError(403, 'forbidden', 'Only this department\'s owner, the CEO or the CEO delegate changes its checks.', 'model_check_not_allowed');
    return { me, departmentId: dept.id, kind };
  };

  const placeOf = async ({ me, departmentId, kind }: Awaited<ReturnType<typeof changer>>, productId: string | null): Promise<CheckPlace> => {
    const [product] = productId ? await db.select(idOnly(departments)).from(departments).where(and(eq(departments.id, productId), eq(departments.parentId, departmentId))) : [null];
    if (productId && !product) throw new ApiError(400, 'validation', 'This product is not one of this department.', 'model_check_place');
    return { companyId: me.companyId, departmentId, productId, kind };
  };

  const logged = (req: FastifyRequest, me: Person, place: CheckPlace) => req.log.info({ departmentId: place.departmentId, productId: place.productId, kind: place.kind, personId: me.id, viaAgent: me.via ?? null }, 'model check changed');

  const setAnswer = (saved: SavedSet) => {
    if (saved.ok) return { version: saved.version, hash: saved.hash };
    throw new ApiError(400, 'validation', 'This set of examples was refused whole. Nothing of it was kept.', 'model_check_set', { problems: saved.problems });
  };

  const notAnExample = () => new ApiError(400, 'validation', 'This is not an example of this kind of check.', 'model_check_set', { problems: [{ line: 1, code: 'invalid_case' }] });

  const checkView = async (check: CheckRow, now: Date) => {
    const [set] = await db.select({ version: modelCheckDatasets.version, cases: modelCheckDatasets.cases, holdoutCases: modelCheckDatasets.holdoutCases, mustBlockCases: modelCheckDatasets.mustBlockCases }).from(modelCheckDatasets).where(eq(modelCheckDatasets.checkId, check.id)).orderBy(desc(modelCheckDatasets.version)).limit(1);
    const [run] = await db.select().from(modelCheckEvaluations).where(and(eq(modelCheckEvaluations.checkId, check.id), isNotNull(modelCheckEvaluations.metrics))).orderBy(desc(modelCheckEvaluations.finishedAt)).limit(1);
    return {
      kind: check.kind, productId: check.productId, on: isOn(check, now), status: check.status, offReason: check.offReason, validUntil: check.validUntil, thresholds: check.thresholds,
      set: set ?? null,
      lastRun: run ? { status: run.status, trigger: run.trigger, problems: run.problems, infraErrors: run.infraErrors, mustBlockMisses: run.mustBlockMisses, all: run.metrics, holdout: run.holdoutMetrics, missedDevCases: run.missedDevCases, finishedAt: run.finishedAt } : null,
    };
  };

  app.get('/api/departments/:id/model-checks', async req => {
    const me = await requirePerson(req, db);
    const dept = await ownDepartment(db, me.companyId, DepartmentParams.parse(req.params).id);
    if (!listsDepartment(await accessOf(db, me), dept.id)) throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
    const now = new Date();
    const checks = await db.select().from(modelChecks).where(eq(modelChecks.departmentId, dept.id)).orderBy(modelChecks.kind);
    return { canChange: await mayChangeRules(db, me, dept.id), checks: await Promise.all(checks.map(check => checkView(check, now))) };
  });

  app.put('/api/departments/:id/model-checks/:kind/thresholds', async req => {
    const who = await changer(await requirePerson(req, db), req);
    const body = LimitsBody.parse(req.body);
    const place = await placeOf(who, body.productId);
    if (!(await saveThresholds(ctx, place, who.me.id, body.thresholds, new Date()))) throw new ApiError(400, 'validation', 'Give each limit as a share from 0 to 1.', 'model_check_thresholds');
    logged(req, who.me, place);
    return { ok: true };
  });

  app.post('/api/departments/:id/model-checks/:kind/sets', async req => {
    const who = await changer(await requirePerson(req, db), req);
    const body = SetBody.parse(req.body);
    const place = await placeOf(who, body.productId);
    const saved = setAnswer(await saveDataset(ctx, place, Buffer.from(body.jsonl), { kind: 'person', id: who.me.id }, new Date()));
    logged(req, who.me, place);
    return saved;
  });

  app.post('/api/departments/:id/model-checks/:kind/misses', async req => {
    const who = await changer(await requirePerson(req, db), req);
    const body = MissBody.parse(req.body);
    const place = await placeOf(who, body.productId);
    const example = Case.safeParse(body.example);
    if (!example.success) throw notAnExample();
    const saved = setAnswer(await addLiveMiss(ctx, place, example.data, { kind: 'person', id: who.me.id }, new Date()));
    logged(req, who.me, place);
    return saved;
  });
}
