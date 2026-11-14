import { createCoordinationRoute } from './echelons-store.js';
import { lastTaskNumber, lastTurnNumber } from './numbers.js';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, notExists, notInArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Ctx } from '../../app.js';
import { agentEvents, agents, companies, departments, people, tasks, turns, type TurnMessage, type TurnMode } from '../../db/schema.js';
import { CLOSED, note, published, refuse, type Task, type Tx, type Wake } from './engine.js';
import { keepWakes } from './outbox.js';
import { refuseNotUrgent } from './urgency.js';
import { handOff } from './pulses.js';
import { improvementsChanged, takeForPlanning } from '../improvements/store.js';
import { keepSnapshot } from './pipeline-report.js';
import { recordTurnSummary } from './wait-goals.js';
import { loggable } from '../../errors.js';
import { backlogChanged, readBacklog, takeBacklog, type BacklogItem } from '../backlog/store.js';
import { requireTurnkeyTeam } from './turnkey.js';

type Live = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'log'>>;
export type Turn = typeof turns.$inferSelect;
/* One task of a turn as the orchestrator or a head lays it out. department: the turn's, which it may leave out. from: the
   item of a department's list it was, and the person it comes from: whoever put the item into the turn, or for the
   orchestrator, whoever put it in the list. */
export type PlanItem = { department?: string; product?: string; title: string; brief: string; body: string; workKind?: Task['workKind']; riskClass?: Task['riskClass']; urgent?: boolean; from?: { item: string; personId: string } };
type Head = { id: string; name: string };
type Placed = PlanItem & { department: string; head: Head };
/* Who lays the turn out, the orchestrator or a head, and the run they do it in. */
export type By = { companyId: string; agentId: string; jobId: string };
/* Who lays tasks into a turn: the orchestrator or a head, who gives every task of a turn, and the person who did it by hand. */
type Planner = { agentId: string; personId?: string };
/* The top-level department whose turns a planner may touch: a head only its own, the orchestrator any (none named). */
export type Scope = string | null;

/* The people's words the orchestrator lays a turn out from: their newest messages to him, as many as he says, at most this. */
export const TURN_MESSAGES = 6;

const lockCompany = (tx: Tx, companyId: string) => tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for('update');

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
  const products = await db.select({ id: departments.id }).from(departments).where(eq(departments.parentId, departmentId));
  const places = [departmentId, ...products.map(p => p.id)];
  const staff = await db.select({ off: agents.switchedOffAt }).from(agents).where(and(inArray(agents.departmentId, places), eq(agents.kind, 'worker'), isNull(agents.removedAt)));
  return staff.length > 0 && staff.every(a => a.off);
}

/* A head takes what is placed with it as anyone else takes work. */
const headMayHold = (ctx: Ctx, by: Pick<By, 'agentId'>, companyId: string, item: PlanItem, head: Head) =>
  refuseNotUrgent(ctx, { agentId: by.agentId }, companyId, { urgent: item.urgent === true, productId: item.product ?? null }, [head.id]);

const notYourTurns = () => refuse(403, 'task_not_yours', "You lay out and change the turns of your own department only. Another department's work goes to its head, or to the orchestrator.");

/* The department a new turn is for: the one named, or the one its tasks name, and for a head its own. A turn holds the
   work of one department. */
function turnDepartment(scope: Scope, named: string | undefined, items: PlanItem[]): string {
  const given = new Set([named, ...items.map(i => i.department)].filter((d): d is string => Boolean(d)));
  if (scope && [...given].some(d => d !== scope)) throw notYourTurns();
  if (scope) return scope;
  if (given.size > 1) throw refuse(400, 'task_invalid', 'A turn holds the work of one department. Lay out a turn for each department, each with its own tasks.');
  const [department] = given;
  if (!department) throw refuse(400, 'task_invalid', 'Name the department whose turn it is.');
  return department;
}

/* A turn takes only the work of its own department: other work goes into a turn of the department it is for. */
function ofTurn(turn: Pick<Turn, 'number' | 'departmentId'>, items: PlanItem[]): PlanItem[] {
  const other = items.find(i => i.department && i.department !== turn.departmentId);
  if (other) throw refuse(400, 'task_invalid', `"${other.title}" is work of another department, and turn ${turn.number} holds the work of one. Lay it out in a turn of its own department with plan_turn.`);
  return items.map(i => ({ ...i, department: turn.departmentId! }));
}

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
      const [product] = await ctx.db.select({ id: departments.id }).from(departments).where(and(eq(departments.id, item.product), eq(departments.parentId, dept.id)));
      if (!product) throw refuse(404, 'department_unknown', `${item.product} is not a product of this department.`);
    }
    const head = await headOf(ctx.db, dept.id);
    if (!head) throw refuse(409, 'no_head', `"${item.title}": its department has no head yet. Propose staff for it first.`);
    if (await switchedOff(ctx.db, dept.id, head)) throw refuse(409, 'switched_off', `"${item.title}": its department is switched off right now. Give it no work until people switch it on.`);
    await headMayHold(ctx, by, companyId, item, head);
    placed.push({ ...item, department: dept.id, head });
  }
  return placed;
}

/* A scalar subquery: Postgres builds the set once, inside the database, regardless of how many messages it checks.
   Membership uses event ids alone: message and close timestamps may come from different clocks. */
function keptIds(tx: Tx, companyId: string) {
  const kept = tx.select({ id: sql<string>`jsonb_array_elements(${turns.messages})->>'id'`.as('id') }).from(turns).where(eq(turns.companyId, companyId)).as('kept');
  return tx.select({ ids: sql`coalesce(jsonb_object_agg(${kept.id}, true), '{}'::jsonb)` }).from(kept).where(isNotNull(kept.id));
}

/* The words of the message this run answers, and as many of the messages before it as he names, leaving out words a turn
   already keeps. A run that a task's news started answers no one, so it keeps none. Messages that came in meanwhile wait
   for the runs that answer them. Only the selected words leave the database. Keep this under the company lock so two
   planners cannot take the same message. */
export async function newWords(tx: Tx, by: By, words: number): Promise<TurnMessage[]> {
  const mine = and(eq(agentEvents.agentId, by.agentId), eq(agentEvents.kind, 'message'), isNotNull(agentEvents.personId));
  const [asked] = await tx.select({ seq: agentEvents.seq }).from(agentEvents).where(and(mine, eq(agentEvents.jobId, by.jobId))).orderBy(desc(agentEvents.seq)).limit(1);
  if (!asked) return [];
  const rows = await tx
    .select({ id: agentEvents.id, text: agentEvents.data, at: agentEvents.createdAt, by: people.name })
    .from(agentEvents)
    .innerJoin(people, eq(people.id, agentEvents.personId))
    .where(and(mine, lte(agentEvents.seq, asked.seq), sql`not (${keptIds(tx, by.companyId)} ? ${agentEvents.id}::text)`))
    .orderBy(desc(agentEvents.seq))
    .limit(Math.min(Math.max(words, 1), TURN_MESSAGES));
  return rows
    .reverse()
    .map(r => ({ id: r.id, by: r.by, text: typeof (r.text as { text?: unknown }).text === 'string' ? (r.text as { text: string }).text : '', at: r.at.toISOString() }))
    .filter(m => m.text.trim());
}

/* The person whose message this orchestrator run answers, not a name supplied to a tool. */
async function decidingPerson(tx: Tx, by: By): Promise<string | null> {
  const [message] = await tx
    .select({ personId: agentEvents.personId })
    .from(agentEvents)
    .where(and(eq(agentEvents.companyId, by.companyId), eq(agentEvents.agentId, by.agentId), eq(agentEvents.jobId, by.jobId), eq(agentEvents.kind, 'message'), isNotNull(agentEvents.personId)))
    .orderBy(desc(agentEvents.seq))
    .limit(1);
  return message?.personId ?? null;
}

/* Items of departments' lists as tasks of a turn: the item's text is the task's body, and its start the brief. */
const fromBacklog = (items: BacklogItem[], personOf: (item: BacklogItem) => string): PlanItem[] =>
  items.map(i => ({ department: i.departmentId, title: i.title, brief: i.text.replace(/\s+/g, ' ').trim().slice(0, 600), body: i.text, from: { item: i.id, personId: personOf(i) } }));

/* Every department whose list lost items hears of it. */
const listsChanged = (ctx: Pick<Ctx, 'bus'>, companyId: string, items: BacklogItem[]) => {
  for (const departmentId of new Set(items.map(i => i.departmentId))) backlogChanged(ctx, companyId, departmentId);
};

/* Planned tasks wait in their turn without anyone holding them; work outside turns has none and starts at once. */
async function insertPlanned(tx: Tx, companyId: string, planner: Planner, turnId: string | null, items: Placed[], improvement?: string): Promise<Task[]> {
  const { agentId, personId } = planner;
  let n = await lastTaskNumber(tx, companyId);
  const rows: Task[] = [];
  for (const item of items) {
    const [row] = await tx
      .insert(tasks)
      .values({
        companyId,
        number: ++n,
        turnId,
        departmentId: item.department,
        productId: item.product ?? null,
        title: item.title.trim(),
        brief: item.brief.trim(),
        body: item.body,
        workKind: item.workKind,
        riskClass: item.riskClass,
        urgent: item.urgent,
        status: 'planned',
        createdByAgentId: agentId,
        createdByPersonId: item.from?.personId ?? null,
        updatedAt: new Date(),
      })
      .returning();
    await createCoordinationRoute(tx, row!);
    const actor = personId ? { personId } : { agentId };
    await note(tx, row!, { kind: 'created', actor, text: row!.brief, data: { planned: true, ...(item.from ? { backlog: item.from.item } : {}), ...(improvement ? { improvement } : {}) } });
    rows.push(row!);
  }
  return rows;
}

type Started = { task: Task; head: Head | null; off?: boolean };

/* A planned task goes to its department's head now. A department that lost its head meanwhile, or was switched off, sends
   it back to whoever planned it. */
async function start(tx: Tx, task: Task): Promise<Started | null> {
  const found = await headOf(tx, task.departmentId!);
  const off = !!found && (await switchedOff(tx, task.departmentId!, found));
  const head = found && !off ? { id: found.id, name: found.name } : null;
  const set = head ? { status: 'open' as const, assigneeAgentId: head.id } : { status: 'blocked' as const };
  const [row] = await tx
    .update(tasks)
    .set({ ...set, version: task.version + 1, updatedAt: new Date() })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, 'planned')))
    .returning();
  if (!row) return null;
  if (head) await note(tx, row, { kind: 'assigned', actor: { agentId: task.createdByAgentId! }, data: { assignee: head.id } });
  else await note(tx, row, { kind: 'blocked', actor: { agentId: task.createdByAgentId! }, text: off ? 'Its department is switched off, so it could not start.' : 'Its department has no head, so it could not start.' });
  const started = { task: row, head, off };
  await keepWakes(tx, row.companyId, wakesFor([started]));
  return started;
}

function wakesFor(started: Started[]): Wake[] {
  return started.map(s =>
    s.head
      ? { agentId: s.head.id, taskId: s.task.id, why: 'assigned' as const }
      : {
          agentId: s.task.createdByAgentId!,
          taskId: s.task.id,
          why: 'blocked' as const,
          text: s.off
            ? `#${s.task.number} could not start: its department is switched off. Tell the CEO, or cancel it.`
            : `#${s.task.number} could not start: its department has no head. Hire one, or cancel it.`,
        },
  );
}

async function announce(ctx: Live, started: Started[]): Promise<void> {
  for (const s of started) {
    published(ctx, s.task);
    await handOff(ctx, { agentId: s.task.createdByAgentId! }, s.task);
  }
}

/* Whether the turn has any open task, the work under its top tasks too: the first one found answers, none are counted. */
export async function liveIn(tx: Tx, companyId: string, turnId: string): Promise<boolean> {
  const [open] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.companyId, companyId), eq(tasks.turnId, turnId), notInArray(tasks.status, [...CLOSED])))
    .limit(1);
  return Boolean(open);
}

/* A turn that ran is over: its snapshot is kept before the next one opens. */
async function closeRunning(ctx: Live, tx: Tx, turnId: string): Promise<Turn> {
  const [closed] = await tx.update(turns).set({ status: 'closed', closedAt: new Date() }).where(eq(turns.id, turnId)).returning();
  await keepSnapshot(tx, closed!, ctx.log);
  await recordTurnSummary(tx, closed!);
  return closed!;
}

/* Opens the department's lowest planned turn when it has none open, and sends its tasks to their heads. An open turn with
   nothing left at its top closes first, and a planned turn whose tasks were all cancelled closes without starting, so the
   turns after them do not wait for nothing. Other departments' turns go on as they are. */
async function openNext(ctx: Live, tx: Tx, companyId: string, departmentId: string): Promise<{ turn: Turn; started: Started[] } | null> {
  const ofDepartment = and(eq(turns.companyId, companyId), eq(turns.departmentId, departmentId));
  for (;;) {
    const [open] = await tx.select({ id: turns.id }).from(turns).where(and(ofDepartment, eq(turns.status, 'open')));
    if (open) {
      if (await liveIn(tx, companyId, open.id)) return null;
      await closeRunning(ctx, tx, open.id);
      continue;
    }
    const [next] = await tx.select().from(turns).where(and(ofDepartment, eq(turns.status, 'planned'))).orderBy(asc(turns.number)).limit(1);
    if (!next) return null;
    const planned = await tx.select().from(tasks).where(and(eq(tasks.turnId, next.id), eq(tasks.status, 'planned'))).orderBy(asc(tasks.number));
    const at = new Date();
    if (!planned.length) {
      await tx.update(turns).set({ status: 'closed', openedAt: at, closedAt: at }).where(eq(turns.id, next.id));
      continue;
    }
    const [turn] = await tx.update(turns).set({ status: 'open', openedAt: at }).where(eq(turns.id, next.id)).returning();
    const started: Started[] = [];
    for (const task of planned) {
      const s = await start(tx, task);
      if (s) started.push(s);
    }
    return { turn: turn!, started };
  }
}

export const turnName = (t: Pick<Turn, 'number' | 'title' | 'goal'>) => `Turn ${t.number} "${t.title || t.goal}"`;
const whoGot = (started: Started[]) =>
  started.map(s => (s.head ? `#${s.task.number} to ${s.head.name}` : s.off ? `#${s.task.number} waits: its department is switched off` : `#${s.task.number} has no head to go to`)).join(', ');
const numbers = (rows: Task[]) => rows.map(t => `#${t.number}`).join(', ');

export type TurnMove = { turn: Turn; text: string; wakes: Wake[] };

/* A new turn of one department with its tasks, in the mode it runs in: it starts at once when the department runs no turn,
   else it waits after the department's planned ones. */
export async function planTurn(ctx: Ctx, by: By, input: { department?: string; title: string; goal: string; mode: TurnMode; tasks: PlanItem[]; words?: number; improvement?: string; backlog?: string[] }, scope: Scope = null): Promise<TurnMove> {
  const { companyId, agentId } = by;
  const ids = input.backlog ?? [];
  const listed = await readBacklog(ctx.db, companyId, ids);
  const all = [...input.tasks, ...fromBacklog(listed, i => i.createdByPersonId)];
  const department = turnDepartment(scope, input.department, all);
  if (input.mode === 'turnkey') await requireTurnkeyTeam(ctx.db, companyId, department);
  const items = await place(ctx, by, companyId, all.map(i => ({ ...i, department })));
  const done = await ctx.db.transaction(async tx => {
    await lockCompany(tx, companyId);
    const last = await lastTurnNumber(tx, companyId);
    const messages = await newWords(tx, by, input.words ?? 1);
    const taken = await takeBacklog(tx, companyId, ids);
    const [turn] = await tx
      .insert(turns)
      .values({ companyId, departmentId: department, number: last + 1, title: input.title.trim(), goal: input.goal.trim(), status: 'planned', mode: input.mode, messages, createdByAgentId: agentId })
      .returning();
    const planned = await insertPlanned(tx, companyId, { agentId }, turn!.id, items, input.improvement);
    if (input.improvement) await takeForPlanning(tx, companyId, input.improvement, await decidingPerson(tx, by));
    const opened = await openNext(ctx, tx, companyId, department);
    return { turn: opened?.turn ?? turn!, planned, opened, taken };
  });
  ctx.bus.publish(companyId, { type: 'org' });
  listsChanged(ctx, companyId, done.taken);
  if (input.improvement) improvementsChanged(ctx, companyId);
  if (done.opened) {
    await announce(ctx, done.opened.started);
    return { turn: done.turn, text: `${turnName(done.turn)} started: ${whoGot(done.opened.started)}.`, wakes: wakesFor(done.opened.started) };
  }
  for (const t of done.planned) published(ctx, t);
  return { turn: done.turn, text: `${turnName(done.turn)} planned with ${numbers(done.planned)}. It starts by itself when the turns of its department before it are done.`, wakes: [] };
}

async function liveTurn(tx: Tx | Live['db'], companyId: string, number: number, scope: Scope = null): Promise<Turn> {
  const [turn] = await tx.select().from(turns).where(and(eq(turns.companyId, companyId), eq(turns.number, number)));
  if (!turn) throw refuse(404, 'turn_unknown', `There is no turn ${number}. Call turns to see them.`);
  if (turn.status === 'closed') throw refuse(409, 'turn_unknown', `Turn ${number} is over. Add the work to its department's open turn or plan a new one.`);
  return inScope(turn, scope);
}

/* More tasks of the turn's own department for a turn that has not closed: in the open one they go out at once, in a planned
   one they wait with it. */
export async function addTasks(ctx: Ctx, by: By, number: number, items: PlanItem[], words = 1, improvement?: string, backlog: string[] = [], scope: Scope = null): Promise<TurnMove> {
  const { companyId, agentId } = by;
  const before = await liveTurn(ctx.db, companyId, number, scope);
  const listed = await readBacklog(ctx.db, companyId, backlog);
  const placed = await place(ctx, by, companyId, ofTurn(before, [...items, ...fromBacklog(listed, i => i.createdByPersonId)]));
  const done = await ctx.db.transaction(async tx => {
    await lockCompany(tx, companyId);
    const turn = await liveTurn(tx, companyId, number, scope);
    const said = await newWords(tx, by, words);
    const taken = await takeBacklog(tx, companyId, backlog);
    const [kept] = said.length ? await tx.update(turns).set({ messages: [...turn.messages, ...said] }).where(eq(turns.id, turn.id)).returning() : [turn];
    const planned = await insertPlanned(tx, companyId, { agentId }, turn.id, placed, improvement);
    if (improvement) await takeForPlanning(tx, companyId, improvement, await decidingPerson(tx, by));
    const started: Started[] = [];
    if (turn.status === 'open') for (const task of planned) {
      const s = await start(tx, task);
      if (s) started.push(s);
    }
    return { turn: kept!, planned, started, taken };
  });
  ctx.bus.publish(companyId, { type: 'org' });
  listsChanged(ctx, companyId, done.taken);
  if (improvement) improvementsChanged(ctx, companyId);
  if (done.turn.status === 'open') {
    await announce(ctx, done.started);
    return { turn: done.turn, text: `Added to ${turnName(done.turn)}: ${whoGot(done.started)}.`, wakes: wakesFor(done.started) };
  }
  for (const t of done.planned) published(ctx, t);
  return { turn: done.turn, text: `Added ${numbers(done.planned)} to ${turnName(done.turn)}; they start with it.`, wakes: [] };
}

/* The work outside turns of each piece's department: a head's only of its own, which it may leave out, and the
   orchestrator's of the department it names. */
function outsideTurns(scope: Scope, items: PlanItem[]): PlanItem[] {
  if (scope && items.some(i => i.department && i.department !== scope)) throw notYourTurns();
  return scope ? items.map(i => ({ ...i, department: scope })) : items;
}

/* Work given outside every turn: urgent or standalone tasks that are no goal of a turn. Each goes to its department's head
   at once, whatever turn the department runs or waits for, and no turn holds it or waits for it. */
export async function giveOutsideTurns(ctx: Ctx, by: By, items: PlanItem[], improvement?: string, backlog: string[] = [], scope: Scope = null): Promise<{ text: string; wakes: Wake[] }> {
  const { companyId, agentId } = by;
  const listed = await readBacklog(ctx.db, companyId, backlog);
  const placed = await place(ctx, by, companyId, outsideTurns(scope, [...items, ...fromBacklog(listed, i => i.createdByPersonId)]));
  const done = await ctx.db.transaction(async tx => {
    await lockCompany(tx, companyId);
    const taken = await takeBacklog(tx, companyId, backlog);
    const planned = await insertPlanned(tx, companyId, { agentId }, null, placed, improvement);
    if (improvement) await takeForPlanning(tx, companyId, improvement, await decidingPerson(tx, by));
    const started: Started[] = [];
    for (const task of planned) {
      const s = await start(tx, task);
      if (s) started.push(s);
    }
    return { started, taken };
  });
  ctx.bus.publish(companyId, { type: 'org' });
  listsChanged(ctx, companyId, done.taken);
  if (improvement) improvementsChanged(ctx, companyId);
  await announce(ctx, done.started);
  return { text: `Given outside turns: ${whoGot(done.started)}.`, wakes: wakesFor(done.started) };
}

/* The department's next turn takes what a person puts into it from the department's list: its first planned one, or else
   a new one named by the items, which starts at once when the department runs no turn. The person picks the mode: the
   items join a planned turn of that mode only, so no turn runs half in each. The orchestrator gives these tasks as he gives
   every task of a turn, so they go and come back the same way. */
export async function scheduleBacklog(ctx: Ctx, by: { companyId: string; agentId: string; personId: string }, departmentId: string, ids: string[], mode: TurnMode = 'echelons'): Promise<{ turn: Turn; tasks: Task[]; wakes: Wake[] }> {
  const { companyId, agentId, personId } = by;
  if (mode === 'turnkey') await requireTurnkeyTeam(ctx.db, companyId, departmentId);
  const listed = await readBacklog(ctx.db, companyId, ids, departmentId);
  const placed = await place(ctx, { agentId }, companyId, fromBacklog(listed, () => personId));
  const done = await ctx.db.transaction(async tx => {
    await lockCompany(tx, companyId);
    const taken = await takeBacklog(tx, companyId, ids, departmentId);
    const [next] = await tx.select().from(turns).where(and(eq(turns.companyId, companyId), eq(turns.departmentId, departmentId), eq(turns.status, 'planned'), eq(turns.mode, mode))).orderBy(asc(turns.number)).limit(1);
    const last = next ? 0 : await lastTurnNumber(tx, companyId);
    const goal = taken.map(i => i.title).join('; ').slice(0, 600);
    const [turn] = next ? [next] : await tx.insert(turns).values({ companyId, departmentId, number: last + 1, goal, status: 'planned', mode, createdByAgentId: agentId, startedBy: personId }).returning();
    const planned = await insertPlanned(tx, companyId, { agentId, personId }, turn!.id, placed);
    const opened = await openNext(ctx, tx, companyId, departmentId);
    return { turn: opened?.turn.id === turn!.id ? opened.turn : turn!, planned, opened, taken };
  });
  ctx.bus.publish(companyId, { type: 'org' });
  listsChanged(ctx, companyId, done.taken);
  if (!done.opened) {
    for (const t of done.planned) published(ctx, t);
    return { turn: done.turn, tasks: done.planned, wakes: [] };
  }
  await announce(ctx, done.opened.started);
  return { turn: done.turn, tasks: done.planned, wakes: wakesFor(done.opened.started) };
}

const modeFixed = (turn: Pick<Turn, 'number' | 'mode'>) => refuse(409, 'turn_mode_fixed', `Turn ${turn.number} has started in ${turn.mode}, so it keeps that mode: a turn never runs half in each. Plan other work in a new turn.`);

/* A new name or main point for a turn that has not closed, or another mode while it is planned. */
export async function editTurn(ctx: Live, companyId: string, number: number, change: { title?: string; goal?: string; mode?: TurnMode }, scope: Scope = null): Promise<Turn> {
  const turn = await liveTurn(ctx.db, companyId, number, scope);
  const remode = change.mode !== undefined && change.mode !== turn.mode;
  if (remode && turn.status !== 'planned') throw modeFixed(turn);
  if (remode && change.mode === 'turnkey') await requireTurnkeyTeam(ctx.db, companyId, turn.departmentId!);
  const set = { ...(change.title?.trim() ? { title: change.title.trim() } : {}), ...(change.goal?.trim() ? { goal: change.goal.trim() } : {}), ...(remode ? { mode: change.mode } : {}) };
  if (!Object.keys(set).length) return turn;
  const [row] = await ctx.db.update(turns).set(set).where(and(eq(turns.id, turn.id), remode ? eq(turns.status, 'planned') : undefined)).returning();
  if (!row) throw modeFixed(turn);
  ctx.bus.publish(companyId, { type: 'org' });
  return row!;
}

async function requiredTurn(tx: Tx, companyId: string, number: number): Promise<Turn> {
  const [turn] = await tx.select().from(turns).where(and(eq(turns.companyId, companyId), eq(turns.number, number)));
  if (!turn) throw refuse(404, 'turn_unknown', `There is no turn ${number}. Call turns to see them.`);
  return turn;
}

function movingTasks(rows: Task[]): Set<string> {
  const moving = new Set(rows.filter(t => !t.parentId && !CLOSED.includes(t.status)).map(t => t.id));
  for (;;) {
    const before = moving.size;
    for (const row of rows) if (row.parentId && moving.has(row.parentId)) moving.add(row.id);
    if (moving.size === before) return moving;
  }
}

async function moveTasks(tx: Tx, by: Pick<By, 'companyId' | 'agentId'>, source: Turn, target: Turn, rows: Task[]): Promise<Task[]> {
  const moving = movingTasks(rows);
  const moved = moving.size
    ? await tx.update(tasks).set({ turnId: target.id }).where(and(eq(tasks.companyId, by.companyId), eq(tasks.turnId, source.id), inArray(tasks.id, [...moving]))).returning()
    : [];
  for (const root of rows.filter(t => !t.parentId)) {
    const isMoved = moving.has(root.id);
    await note(tx, root, {
      kind: 'updated',
      actor: { agentId: by.agentId },
      text: isMoved ? `Moved from Turn ${source.number} to Turn ${target.number} by merge.` : `Turn ${source.number} merged into Turn ${target.number}; this closed task stays in the source as history.`,
      data: { fields: isMoved ? ['turn'] : [], from: source.number, to: target.number, moved: isMoved },
    });
  }
  return moved;
}

async function startMoved(tx: Tx, target: Turn, rows: Task[], moved: Task[]): Promise<Started[]> {
  const started: Started[] = [];
  if (target.status !== 'open') return started;
  for (const root of rows.filter(t => !t.parentId)) {
    const row = moved.find(t => t.id === root.id);
    if (row?.status !== 'planned') continue;
    const s = await start(tx, row);
    if (s) started.push(s);
  }
  return started;
}

type StoredMerge = { source: Turn; target: Turn | null; moved: Task[]; started: Started[] };

async function storeMerge(tx: Tx, by: Pick<By, 'companyId' | 'agentId'>, sourceNumber: number, targetNumber: number, scope: Scope): Promise<StoredMerge> {
  const source = inScope(await requiredTurn(tx, by.companyId, sourceNumber), scope);
  if (source.status === 'closed') return { source, target: null, moved: [], started: [] };
  if (source.status !== 'planned') throw refuse(409, 'turn_open', `Turn ${sourceNumber} is running. Only a planned turn can be merged.`);
  const target = await requiredTurn(tx, by.companyId, targetNumber);
  if (target.status === 'closed') throw refuse(409, 'turn_unknown', `Turn ${targetNumber} is over. Add the work to its department's open turn or plan a new one.`);
  if (target.departmentId !== source.departmentId) throw refuse(409, 'turn_department', `Turns ${sourceNumber} and ${targetNumber} are of different departments. Merge only turns of the same department: each department runs its own.`);
  if (target.mode !== source.mode) throw refuse(409, 'turn_mode_fixed', `Turn ${sourceNumber} runs in ${source.mode} and turn ${targetNumber} in ${target.mode}. Merge only turns of the same mode, so no turn runs half in each.`);
  const rows = await tx.select().from(tasks).where(and(eq(tasks.companyId, by.companyId), eq(tasks.turnId, source.id))).orderBy(asc(tasks.number));
  const moved = await moveTasks(tx, by, source, target, rows);
  const [closed] = await tx.update(turns).set({ status: 'closed', closedAt: new Date() }).where(and(eq(turns.id, source.id), eq(turns.status, 'planned'))).returning();
  if (!closed) throw refuse(409, 'turn_open', `Turn ${sourceNumber} changed meanwhile. Read it again.`);
  return { source: closed, target, moved, started: await startMoved(tx, target, rows, moved) };
}

/* Moves the unfinished trees of a planned turn into another live turn of its department. Closed roots stay with the source
   as its history. */
export async function mergeTurn(ctx: Live, by: Pick<By, 'companyId' | 'agentId'>, sourceNumber: number, targetNumber: number, scope: Scope = null): Promise<TurnMove> {
  if (sourceNumber === targetNumber) throw refuse(400, 'task_invalid', 'A turn cannot merge into itself.');
  const done = await ctx.db.transaction(async tx => {
    await lockCompany(tx, by.companyId);
    return storeMerge(tx, by, sourceNumber, targetNumber, scope);
  });
  ctx.bus.publish(by.companyId, { type: 'org' });
  for (const task of done.moved) published(ctx, task);
  if (done.started.length) await announce(ctx, done.started);
  if (!done.target) return { turn: done.source, text: `${turnName(done.source)} is already closed; nothing was moved.`, wakes: [] };
  const movedRoots = done.moved.filter(t => !t.parentId);
  const what = movedRoots.length ? ` Moved ${numbers(movedRoots)}.` : ' No unfinished work remained.';
  return { turn: done.target, text: `Merged ${turnName(done.source)} into ${turnName(done.target)}.${what} ${turnName(done.source)} is closed.`, wakes: wakesFor(done.started) };
}

async function storeSettle(ctx: Live, tx: Tx, task: Pick<Task, 'turnId' | 'companyId' | 'status'>) {
  const turnId = task.turnId!;
  const [turn] = await tx.select().from(turns).where(and(eq(turns.id, turnId), inArray(turns.status, ['open', 'planned'])));
  if (!turn) return null;
  if (await liveIn(tx, task.companyId, turnId)) return null;
  if (turn.status === 'planned') {
    const [closed] = await tx.update(turns).set({ status: 'closed', closedAt: new Date() }).where(eq(turns.id, turnId)).returning();
    return { closed: closed!, planned: true, opened: null };
  }
  const closed = await closeRunning(ctx, tx, turnId);
  return { closed, planned: false, opened: await openNext(ctx, tx, task.companyId, turn.departmentId!) };
}

/* What settle says of a turn that closed, and whom it tells besides the orchestrator: the head of the turn's department. */
export type Settled = { wakes: Wake[]; note: string; headId: string | null };

/* After a task closed: when it was the last open task at the top of its department's open turn, the turn is over and the
   department's next planned one starts. A planned turn with no unfinished roots closes without waiting to start. */
export async function settle(ctx: Live, task: Pick<Task, 'turnId' | 'companyId' | 'status'>): Promise<Settled | null> {
  if (!task.turnId || !CLOSED.includes(task.status)) return null;
  const done = await ctx.db.transaction(async tx => {
    await lockCompany(tx, task.companyId);
    return storeSettle(ctx, tx, task);
  });
  if (!done) return null;
  ctx.bus.publish(task.companyId, { type: 'org' });
  const head = done.closed.departmentId ? await headOf(ctx.db, done.closed.departmentId) : null;
  const headId = head && !head.off ? head.id : null;
  if (done.planned) return { wakes: [], note: `${turnName(done.closed)} has no unfinished tasks, so it is closed.`, headId };
  const over = `That was the last open task of ${turnName(done.closed)}, so the turn is over.`;
  if (!done.opened) return { wakes: [], note: `${over} No turn of its department is planned next; plan one with plan_turn when people ask for more.`, headId };
  await announce(ctx, done.opened.started);
  return { wakes: wakesFor(done.opened.started), note: `${over} ${turnName(done.opened.turn)} started: ${whoGot(done.opened.started)}.`, headId };
}

/* Adds what settle said to the orchestrator and to the head of the turn's department: to a wake they already get on the
   task, else as a turn of its own. Whoever made the move hears it in the tool's answer instead. */
export function tell(wakes: Wake[], settled: Settled | null, orchestratorId: string | null, taskId: string, actorId?: string): Wake[] {
  if (!settled) return wakes;
  const all = [...wakes, ...settled.wakes];
  for (const id of new Set([orchestratorId, settled.headId])) {
    if (!id || id === actorId) continue;
    const theirs = all.find(w => w.agentId === id && w.taskId === taskId);
    if (theirs) theirs.note = settled.note;
    else all.push({ agentId: id, taskId, why: 'turn', note: settled.note });
  }
  return all;
}

/* A department's planned turn starts once the department runs none: one planned before departments ran turns of their own
   waited for another department's. One whose department runs a turn waits for it, closed or not, as settle closes it.
   The wakes are for the heads that got its tasks. */
export async function startWaitingTurns(ctx: Live): Promise<Wake[]> {
  const open = alias(turns, 'open_turn');
  const waiting = await ctx.db
    .selectDistinct({ companyId: turns.companyId, departmentId: turns.departmentId })
    .from(turns)
    .where(and(eq(turns.status, 'planned'), isNotNull(turns.departmentId), notExists(ctx.db.select({ id: open.id }).from(open).where(and(eq(open.companyId, turns.companyId), eq(open.departmentId, turns.departmentId), eq(open.status, 'open'))))));
  const wakes: Wake[] = [];
  /* One department's trouble keeps no other department or company from starting its turn. */
  for (const { companyId, departmentId } of waiting) {
    try {
      const opened = await ctx.db.transaction(async tx => {
        await lockCompany(tx, companyId);
        const [running] = await tx.select({ id: turns.id }).from(turns).where(and(eq(turns.companyId, companyId), eq(turns.departmentId, departmentId!), eq(turns.status, 'open')));
        return running ? null : openNext(ctx, tx, companyId, departmentId!);
      });
      if (!opened) continue;
      wakes.push(...wakesFor(opened.started));
      ctx.bus.publish(companyId, { type: 'org' });
      await announce(ctx, opened.started);
    } catch (err) {
      ctx.log?.error({ error: loggable(err), companyId, departmentId }, 'Starting the waiting turn of a department failed.');
    }
  }
  return wakes;
}

/* Turns as the tracker, the orchestrator and a head read them, newest closed ones last kept: a department's own, or the
   whole company's. */
export async function turnRows(ctx: Live, companyId: string, departmentId?: string): Promise<Turn[]> {
  const place = and(eq(turns.companyId, companyId), departmentId ? eq(turns.departmentId, departmentId) : undefined);
  const live = await ctx.db.select().from(turns).where(and(place, inArray(turns.status, ['open', 'planned']))).orderBy(asc(turns.number));
  const closed = await ctx.db.select().from(turns).where(and(place, eq(turns.status, 'closed'))).orderBy(desc(turns.number)).limit(20);
  return [...closed.reverse(), ...live];
}
