import { idOnly, only } from '../../db/selections.js';
import { createCoordinationRoute } from './echelons-store.js';
import { lastTaskNumber } from './numbers.js';
import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, agents, companies, departments, tasks, turns } from '../../db/schema.js';
import { note, published } from './events.js';
import { refuse, taskSpot, type Task, type Tx, type Wake } from './state.js';
import { newTrackerFields, type TrackerFields, type TrackerInput } from '../tracker/task-fields.js';
import { keepWakes } from './outbox.js';
import { givePlace, turnsAhead, waitsText } from './slots.js';
import { refuseNotUrgent } from './urgency.js';
import { handOff } from './pulses.js';
import { nudgeTrackerKeepers } from '../tracker/nudge.js';
import { improvementsChanged, takeForPlanning } from '../improvements/store.js';
import { backlogChanged, readBacklog, takeBacklog, type BacklogItem } from '../backlog/store.js';

type Live = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'log'>>;
export type Turn = typeof turns.$inferSelect;
/* One task as the orchestrator or a head gives it. department: a head's own, which it may leave out. from: the item of a
   department's list it was, and the person it comes from: whoever took the item to work, or for the orchestrator, whoever
   put it in the list. */
export type PlanItem = { department?: string; product?: string; title: string; brief: string; body: string; workKind?: Task['workKind']; riskClass?: Task['riskClass']; urgent?: boolean; small?: boolean; from?: { item: string; personId: string } } & TrackerInput;
type Head = { id: string; name: string };
type Placed = PlanItem & { department: string; head: Head; tracker: TrackerFields };
/* Who gives the work, the orchestrator or a head, and the run they do it in. */
export type By = { companyId: string; agentId: string; jobId: string };
/* Who gives tasks: the orchestrator or a head, and the person who did it by hand. */
type Planner = { agentId: string; personId?: string };
/* The top-level department whose work and turns a planner may touch: a head only its own, the orchestrator any (none named). */
export type Scope = string | null;

const lockCompany = (tx: Tx, companyId: string) => tx.select(idOnly(companies)).from(companies).where(eq(companies.id, companyId)).for('no key update');

async function headOf(db: Live['db'] | Tx, departmentId: string) {
  const [head] = await db
    .select({ id: agents.id, name: agents.name, off: agents.switchedOffAt })
    .from(agents)
    .where(and(eq(agents.departmentId, departmentId), eq(agents.kind, 'head'), isNull(agents.removedAt)))
    .orderBy(asc(agents.createdAt));
  return head ?? null;
}

/* A department is off when its head is, or when it has employees, in it or in its products, and every one of them is off. */
async function switchedOff(db: Live['db'] | Tx, departmentId: string, head: { off: Date | null }): Promise<boolean> {
  if (head.off) return true;
  const products = await db.select(idOnly(departments)).from(departments).where(eq(departments.parentId, departmentId));
  const places = [departmentId, ...products.map(p => p.id)];
  const staff = await db.select({ off: agents.switchedOffAt }).from(agents).where(and(inArray(agents.departmentId, places), eq(agents.kind, 'worker'), isNull(agents.removedAt)));
  return staff.length > 0 && staff.every(a => a.off);
}

/* A head takes what is placed with it as anyone else takes work. */
const headMayHold = (ctx: Ctx, by: Pick<By, 'agentId'>, companyId: string, item: PlanItem, head: Head) =>
  refuseNotUrgent(ctx, { agentId: by.agentId }, companyId, { urgent: item.urgent === true, productId: item.product ?? null }, [head.id]);

const notYourTurns = () => refuse(403, 'task_not_yours', "You give work to and change the turn of your own department only. Another department's work goes to its head, or to the orchestrator.");

/* A turn this planner may change: of its own department, for a head. */
function inScope<T extends Pick<Turn, 'departmentId'>>(turn: T, scope: Scope): T {
  if (scope && turn.departmentId !== scope) throw notYourTurns();
  return turn;
}

/* Every item names a department of the company, a product inside it, and the department has a head to take it. */
async function place(ctx: Ctx, by: Pick<By, 'agentId'>, companyId: string, items: PlanItem[]): Promise<Placed[]> {
  if (!items.length) throw refuse(400, 'task_invalid', 'A turn needs at least one task.');
  const placed: Placed[] = [];
  for (const item of items) {
    if (!item.title.trim()) throw refuse(400, 'task_invalid', 'Every task needs a title.');
    if (!item.department) throw refuse(400, 'task_invalid', `"${item.title}" names no department.`);
    const [dept] = await ctx.db.select().from(departments).where(and(eq(departments.id, item.department), eq(departments.companyId, companyId), isNull(departments.parentId)));
    if (!dept) throw refuse(404, 'department_unknown', `There is no department ${item.department}. Call company for the ids.`);
    if (item.product) {
      const [product] = await ctx.db.select(idOnly(departments)).from(departments).where(and(eq(departments.id, item.product), eq(departments.parentId, dept.id)));
      if (!product) throw refuse(404, 'department_unknown', `${item.product} is not a product of this department.`);
    }
    const head = await headOf(ctx.db, dept.id);
    if (!head) throw refuse(409, 'no_head', `"${item.title}": its department has no head yet. Propose staff for it first.`);
    if (await switchedOff(ctx.db, dept.id, head)) throw refuse(409, 'switched_off', `"${item.title}": its department is switched off right now. Give it no work until people switch it on.`);
    await headMayHold(ctx, by, companyId, item, head);
    const tracker = await newTrackerFields(ctx, companyId, taskSpot({ departmentId: dept.id, productId: item.product ?? null }), null, item, head.id);
    placed.push({ ...item, department: dept.id, head, tracker });
  }
  return placed;
}

/* The person whose message this orchestrator run answers, not a name supplied to a tool. */
async function decidingPerson(tx: Tx, by: By): Promise<string | null> {
  const [message] = await tx
    .select(only(agentEvents, 'personId'))
    .from(agentEvents)
    .where(and(eq(agentEvents.companyId, by.companyId), eq(agentEvents.agentId, by.agentId), eq(agentEvents.jobId, by.jobId), eq(agentEvents.kind, 'message'), isNotNull(agentEvents.personId)))
    .orderBy(desc(agentEvents.seq))
    .limit(1);
  return message?.personId ?? null;
}

/* Items of departments' lists as tasks: the item's text is the task's body, and its start the brief. */
const fromBacklog = (items: BacklogItem[], personOf: (item: BacklogItem) => string): PlanItem[] =>
  items.map(i => ({ department: i.departmentId, title: i.title, brief: i.text.replace(/\s+/g, ' ').trim().slice(0, 600), body: i.text, from: { item: i.id, personId: personOf(i) } }));

/* Every department whose list lost items hears of it. */
const listsChanged = (ctx: Pick<Ctx, 'bus'>, companyId: string, items: BacklogItem[]) => {
  for (const departmentId of new Set(items.map(i => i.departmentId))) backlogChanged(ctx, companyId, departmentId);
};

/* Work goes to its department's head at once: no turn holds it until its result is accepted into the turn's branch. */
async function insertGiven(tx: Tx, companyId: string, planner: Planner, items: Placed[], improvement?: string): Promise<Given[]> {
  const { agentId, personId } = planner;
  let n = await lastTaskNumber(tx, companyId);
  const given: Given[] = [];
  for (const item of items) {
    /* Whether it joins a slot of its department's turn, or waits in the queue for the next one: nobody holds it until then. */
    const place = await givePlace(tx, item, item.head.id);
    const [row] = await tx
      .insert(tasks)
      .values({
        ...item.tracker,
        companyId,
        number: ++n,
        departmentId: item.department,
        productId: item.product ?? null,
        title: item.title.trim(),
        brief: item.brief.trim(),
        body: item.body,
        workKind: item.workKind,
        riskClass: item.riskClass,
        urgent: item.urgent,
        small: item.small === true,
        status: 'open',
        ...place,
        createdByAgentId: agentId,
        createdByPersonId: item.from?.personId ?? null,
        updatedAt: new Date(),
      })
      .returning();
    await createCoordinationRoute(tx, row!);
    const actor = personId ? { personId } : { agentId };
    await note(tx, row!, { kind: 'created', actor, text: row!.brief, data: { toStatus: row!.status, ...(item.from ? { backlog: item.from.item } : {}), ...(improvement ? { improvement } : {}) } });
    if (!place.queuedAt) await note(tx, row!, { kind: 'assigned', actor: { agentId }, data: { assignee: item.head.id } });
    given.push({ task: row!, head: item.head, queued: await turnsAhead(tx, row!) });
  }
  await keepWakes(tx, companyId, wakesFor(given));
  return given;
}

/* queued: how many turns ahead a task waits in the queue, none for one that was given out. */
type Given = { task: Task; head: Head; queued: number | null };

const wakesFor = (given: Given[]): Wake[] => given.filter(g => g.queued === null).map(g => ({ agentId: g.head.id, taskId: g.task.id, why: 'assigned' as const }));

async function announce(ctx: Live, given: Given[]): Promise<void> {
  for (const g of given) {
    published(ctx, g.task);
    if (g.queued === null) await handOff(ctx, { agentId: g.task.createdByAgentId! }, g.task);
  }
  for (const departmentId of new Set(given.map(g => g.task.departmentId))) await nudgeTrackerKeepers(ctx, { companyId: given[0]!.task.companyId, departmentId }, given[0]!.task.createdByAgentId);
}

export const turnName = (t: Pick<Turn, 'number' | 'title' | 'goal'>) => `Turn ${t.number} "${t.title || t.goal}"`;
const whoGot = (given: Given[]) => given.map(g => (g.queued === null ? `#${g.task.number} to ${g.head.name}` : `#${g.task.number} ${waitsText(g.queued)}`)).join(', ');

/* The work of each piece's department: a head's only of its own, which it may leave out, and the orchestrator's of the
   department it names. */
function ownWork(scope: Scope, items: PlanItem[]): PlanItem[] {
  if (scope && items.some(i => i.department && i.department !== scope)) throw notYourTurns();
  return scope ? items.map(i => ({ ...i, department: scope })) : items;
}

/* Tasks given to their departments' heads, who take them on at once. No turn holds them: each joins its department's open
   turn as its result is accepted into the turn's branch, and the turn is a release, not a list of goals. */
export async function giveTasks(ctx: Ctx, by: By, items: PlanItem[], improvement?: string, backlog: string[] = [], scope: Scope = null): Promise<{ text: string; wakes: Wake[] }> {
  const { companyId, agentId } = by;
  const listed = await readBacklog(ctx.db, companyId, backlog);
  if (scope && items.some(i => i.askedByPersonId)) throw refuse(403, 'task_not_yours', 'Only the orchestrator names the person whose request work carries out.');
  const placed = await place(ctx, by, companyId, ownWork(scope, [...items, ...fromBacklog(listed, i => i.createdByPersonId)]));
  const done = await ctx.db.transaction(async tx => {
    await lockCompany(tx, companyId);
    const taken = await takeBacklog(tx, companyId, backlog);
    const given = await insertGiven(tx, companyId, { agentId }, placed, improvement);
    if (improvement) await takeForPlanning(tx, companyId, improvement, await decidingPerson(tx, by), ctx.config.feedbackInbox);
    return { given, taken };
  });
  ctx.bus.publish(companyId, { type: 'org' });
  listsChanged(ctx, companyId, done.taken);
  if (improvement) improvementsChanged(ctx, companyId);
  await announce(ctx, done.given);
  return { text: `Given: ${whoGot(done.given)}.`, wakes: wakesFor(done.given) };
}

/* What a person takes from a department's list goes to work at once, given by the orchestrator as he gives every task, so
   it goes and comes back the same way. */
export async function scheduleBacklog(ctx: Ctx, by: { companyId: string; agentId: string; personId: string }, departmentId: string, ids: string[]): Promise<{ tasks: Task[]; wakes: Wake[] }> {
  const { companyId, agentId, personId } = by;
  const listed = await readBacklog(ctx.db, companyId, ids, departmentId);
  const placed = await place(ctx, { agentId }, companyId, fromBacklog(listed, () => personId));
  const done = await ctx.db.transaction(async tx => {
    await lockCompany(tx, companyId);
    const taken = await takeBacklog(tx, companyId, ids, departmentId);
    return { given: await insertGiven(tx, companyId, { agentId, personId }, placed), taken };
  });
  ctx.bus.publish(companyId, { type: 'org' });
  listsChanged(ctx, companyId, done.taken);
  await announce(ctx, done.given);
  return { tasks: done.given.map(g => g.task), wakes: wakesFor(done.given) };
}

/* A new name or main point for a department's open turn. */
export async function editTurn(ctx: Live, companyId: string, number: number, change: { title?: string; goal?: string }, scope: Scope = null): Promise<Turn> {
  const [turn] = await ctx.db.select().from(turns).where(and(eq(turns.companyId, companyId), eq(turns.number, number)));
  if (!turn) throw refuse(404, 'turn_unknown', `There is no turn ${number}. Call turns to see them.`);
  if (turn.status === 'closed') throw refuse(409, 'turn_unknown', `Turn ${number} is released: its tag closed it.`);
  inScope(turn, scope);
  const set = { ...(change.title?.trim() ? { title: change.title.trim() } : {}), ...(change.goal?.trim() ? { goal: change.goal.trim() } : {}) };
  if (!Object.keys(set).length) return turn;
  const [row] = await ctx.db.update(turns).set(set).where(and(eq(turns.id, turn.id), eq(turns.status, 'open'))).returning();
  if (!row) throw refuse(409, 'turn_unknown', `Turn ${number} was released meanwhile.`);
  ctx.bus.publish(companyId, { type: 'org' });
  return row;
}

/* Turns as the tracker, the orchestrator and a head read them, newest closed ones last kept: a department's own, or the
   whole company's. */
export async function turnRows(ctx: Live, companyId: string, departmentId?: string): Promise<Turn[]> {
  const place = and(eq(turns.companyId, companyId), departmentId ? eq(turns.departmentId, departmentId) : undefined);
  const live = await ctx.db.select().from(turns).where(and(place, eq(turns.status, 'open'))).orderBy(asc(turns.number));
  const closed = await ctx.db.select().from(turns).where(and(place, eq(turns.status, 'closed'))).orderBy(desc(turns.number)).limit(20);
  return [...closed.reverse(), ...live];
}
