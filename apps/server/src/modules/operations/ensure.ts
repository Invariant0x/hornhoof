import { idOnly } from '../../db/selections.js';
import { seedDefaultPipeline } from '../tracker/pipelines.js';
import { ensureOpenTurn } from '../tasks/turn-department.js';
import { and, asc, eq, isNotNull, isNull, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { agentChanges, agents, companies, departments, jobs } from '../../db/schema.js';
import { ApiError, loggable } from '../../errors.js';
import { orchestratorOf } from '../conversation/turn-records.js';
import { pump } from '../conversation/queue.js';
import { windowNode } from '../conversation/placement.js';
import { hireEmployee, type Hired, type HiredBy } from '../departments/hire.js';
import { appendEvent, listEvents } from '../events/store.js';
import type { Tx } from '../tasks/state.js';
import { resumeAgent } from '../tasks/wake.js';
import { placeableSubscriptions, spotIn, type Serving } from '../tools/staff.js';
import { holderOf, holds, isOperations, leftOut, missingRoles, PROGRAM_OPERATOR_ROLE, REQUIRED_OPERATIONS_ROLES } from './required.js';
import { notStep } from '../tools/steps.js';

/* How often Hornhoof looks again, for what no request tells it: an owner switched off, access taken away, a crash. */
const CHECK_MS = 5 * 60_000;

/* Hornhoof's own doing: no person decided it and the orchestrator did not act for one. */
const HORNHOOF: HiredBy = { personId: null, byOrchestrator: false };

const lockCompany = (tx: Tx, companyId: string) => tx.select(idOnly(companies)).from(companies).where(eq(companies.id, companyId)).for('update');

const operationsOf = async (tx: Tx, companyId: string) =>
  (await tx.select().from(departments).where(and(eq(departments.companyId, companyId), eq(departments.templateKey, 'operations'), isNull(departments.parentId))).orderBy(asc(departments.position)))[0];

async function createOperations(ctx: Ctx, tx: Tx, companyId: string) {
  const [last] = await tx.select({ n: max(departments.position) }).from(departments).where(eq(departments.companyId, companyId));
  const [dept] = await tx.insert(departments).values({ companyId, templateKey: 'operations', roleCode: 'OPS', position: (last?.n ?? -1) + 1 }).returning();
  await ensureOpenTurn(tx, companyId, dept!.id);
  await seedDefaultPipeline(ctx, tx, dept!, null);
  return dept!;
}

/* Under the company's lock, so two servers or two checks at once hire no one twice. */
async function hireMissing(ctx: Ctx, tx: Tx, companyId: string): Promise<{ departmentId: string; hired: Hired[] }> {
  await lockCompany(tx, companyId);
  const dept = (await operationsOf(tx, companyId)) ?? (await createOperations(ctx, tx, companyId));
  const missing = missingRoles(await staffOf(tx, dept.id));
  const hired: Hired[] = [];
  if (!missing.length) return { departmentId: dept.id, hired };
  const [plan] = await placeableSubscriptions({ db: tx }, companyId, spotIn(dept));
  for (const id of missing) {
    const role = ctx.templates.roles.get(id)!;
    const skills = role.skills.filter(s => s.on).map(s => s.id);
    hired.push(await hireEmployee(ctx, tx, { companyId, departmentId: dept.id }, { role: id, name: role.title.en, model: '', subscription: plan?.id ?? null, skills }, HORNHOOF));
  }
  return { departmentId: dept.id, hired };
}

const staffOf = (tx: Tx, departmentId: string) =>
  tx.select({ id: agents.id, name: agents.name, kind: agents.kind, roleKey: agents.roleKey }).from(agents).where(and(eq(agents.departmentId, departmentId), isNull(agents.removedAt)));

export type Present = { role: string; name: string };

/* What a card may hire into a department, under the company's lock when it is Operations, which has to end up with its
   required roles whatever the request said. A line of an applied proposal for a role someone holds by now is not a hire:
   Hornhoof may have filled it since the card was shown. Without a proposal it is a replacement someone asked for. */
export async function linesToHire<L extends { role: string }>(ctx: Pick<Ctx, 'templates'>, tx: Tx, dept: typeof departments.$inferSelect, lines: L[], fromProposal: boolean): Promise<{ lines: L[]; present: Present[] }> {
  if (!isOperations(dept)) return { lines, present: [] };
  await lockCompany(tx, dept.companyId);
  const staff = await staffOf(tx, dept.id);
  const left = leftOut(staff, lines);
  if (left.length) {
    const titles = left.map(role => ctx.templates.roles.get(role)!.title.en).join(', ');
    throw new ApiError(400, 'validation', `Operations must always have ${titles}. Keep them on the card.`, 'staff_invalid');
  }
  if (!fromProposal) return { lines, present: [] };
  const present = lines.flatMap(line => {
    const holder = holderOf(staff, line.role);
    return holder ? [{ role: line.role, name: holder.name }] : [];
  });
  return { lines: lines.filter(line => !holderOf(staff, line.role)), present };
}

/* The last employee in a role Operations must have stays. Switching it off is another thing, and allowed. */
export async function checkRemoval(ctx: Pick<Ctx, 'templates'>, tx: Tx, agent: { id: string; companyId: string; departmentId: string | null; name: string; kind: string; roleKey: string | null }): Promise<void> {
  const role = REQUIRED_OPERATIONS_ROLES.find(id => holds(agent, id));
  if (!role || !agent.departmentId) return;
  const [dept] = await tx.select().from(departments).where(eq(departments.id, agent.departmentId));
  if (!dept || !isOperations(dept)) return;
  await lockCompany(tx, agent.companyId);
  if ((await staffOf(tx, dept.id)).some(employee => employee.id !== agent.id && holds(employee, role))) return;
  const title = ctx.templates.roles.get(role)!.title.en;
  throw new ApiError(409, 'conflict', `Operations must always have a ${title}, and ${agent.name} is the last one. Switch ${agent.name} off instead, or have a replacement in place first.`, 'required_role');
}

/* The orchestrator sees who came in his window. Before his conversation begins there is nobody to tell, and a line there
   would keep him from greeting the CEO. */
export async function tellOrchestrator(ctx: Ctx, companyId: string, department: string, hired: Hired[]): Promise<void> {
  const orchestrator = await orchestratorOf(ctx, companyId);
  if (!orchestrator || !(await listEvents(ctx.db, orchestrator.id, 0, 1)).length) return;
  await appendEvent(ctx, { companyId, agentId: orchestrator.id, kind: 'applied', data: { proposalId: null, kind: 'staff', department, hired: hired.map(({ id, name, role }) => ({ id, name, role })) } });
}

type Operator = typeof agents.$inferSelect;

/* Whether an operator stays on its plan: one that may serve it, or one that may not with a turn running on it, which
   nobody stops. */
async function staysOnPlan(tx: Tx, operator: Operator, plans: Serving[]): Promise<boolean> {
  if (!operator.subscriptionId) return false;
  if (plans.some(p => p.id === operator.subscriptionId)) return true;
  const [running] = await tx.select(idOnly(jobs)).from(jobs).where(and(eq(jobs.agentId, operator.id), eq(jobs.status, 'running'), notStep)).limit(1);
  return Boolean(running);
}

/* Each operator that is on stands on a plan that may serve it, or waits for one: one it may not stand on is taken off once
   no turn runs on it, and the next that may serve takes its place. Returns who moved, and to which plan if any. */
async function placeOperators(tx: Tx, companyId: string): Promise<{ id: string; plan: string | null }[]> {
  await lockCompany(tx, companyId);
  const dept = await operationsOf(tx, companyId);
  if (!dept) return [];
  const operators = await tx
    .select()
    .from(agents)
    .where(and(eq(agents.departmentId, dept.id), eq(agents.roleKey, PROGRAM_OPERATOR_ROLE), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  const plans = await placeableSubscriptions({ db: tx }, companyId, spotIn(dept));
  const plan = plans[0]?.id ?? null;
  const moved: { id: string; plan: string | null }[] = [];
  for (const operator of operators) {
    if (plan === operator.subscriptionId || (await staysOnPlan(tx, operator, plans))) continue;
    /* Another plan may not know its model, so it starts on the Default. */
    await tx.update(agents).set({ subscriptionId: plan, model: '', effort: null }).where(eq(agents.id, operator.id));
    await tx.insert(agentChanges).values({ companyId, agentId: operator.id, ...HORNHOOF, field: 'subscription', before: operator.subscriptionId, after: plan });
    moved.push({ id: operator.id, plan });
  }
  return moved;
}

/* Gives a waiting operator the first plan that may serve it, and moves one off a plan that no longer may. No one is asked. */
export async function placeOperator(ctx: Ctx, companyId: string): Promise<void> {
  const moved = await ctx.db.transaction(tx => placeOperators(tx, companyId));
  if (moved.length) ctx.bus.publish(companyId, { type: 'org' });
  /* Turns that waited for a plan can go now, with the tasks it missed while it had none. */
  for (const { id } of moved.filter(m => m.plan)) {
    await resumeAgent(ctx, id);
    await pump(ctx, id);
  }
  await settleOperators(ctx, companyId);
}

/* Each operator stands on a machine of its plan from the start, so it is on the machine the next call for it finds. */
async function settleOperators(ctx: Ctx, companyId: string): Promise<void> {
  const operators = await ctx.db.select(idOnly(agents)).from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.roleKey, PROGRAM_OPERATOR_ROLE), isNull(agents.removedAt), isNull(agents.switchedOffAt), isNotNull(agents.subscriptionId)));
  for (const { id } of operators) await windowNode(ctx, id);
}

/* After a plan came or went: the check repeats it, so a failure here does not fail what the person did. */
export async function tryPlaceOperator(ctx: Ctx, companyId: string): Promise<void> {
  await placeOperator(ctx, companyId).catch((err: unknown) => ctx.log.error({ error: loggable(err) }, 'Placing the program operator failed.'));
}

/* Brings Operations to its full staff and places its operator. Running it again changes nothing. */
export async function ensureOperations(ctx: Ctx, companyId: string): Promise<void> {
  const { departmentId, hired } = await ctx.db.transaction(tx => hireMissing(ctx, tx, companyId));
  if (hired.length) {
    ctx.bus.publish(companyId, { type: 'org' });
    await tellOrchestrator(ctx, companyId, departmentId, hired);
  }
  await placeOperator(ctx, companyId);
}

/* One company's trouble does not keep the others from their check. */
export async function checkOperations(ctx: Ctx, failed: (err: unknown) => void): Promise<void> {
  try {
    for (const { id } of await ctx.db.select(idOnly(companies)).from(companies)) await ensureOperations(ctx, id).catch(failed);
  } catch (err) {
    failed(err);
  }
}

/* The check hires, so it runs only while the app leads: as it starts leading, and again every few minutes. */
export function startOperationsCheck(app: FastifyInstance, ctx: Ctx): void {
  const failed = (err: unknown) => app.log.error({ error: loggable(err) }, 'Keeping Operations in full failed.');
  let timer: NodeJS.Timeout | null = null;
  ctx.mode.whenLead(
    async () => {
      timer = setInterval(() => void checkOperations(ctx, failed), CHECK_MS);
      timer.unref();
      await checkOperations(ctx, failed);
    },
    () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  );
}
