import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lte, max, notInArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, agents, companies, departments, people, tasks, turns, type TurnMessage } from '../../db/schema.js';
import { CLOSED, note, published, refuse, type Task, type Tx, type Wake } from './engine.js';
import { handOff } from './pulses.js';

type Live = Pick<Ctx, 'db' | 'bus'>;
export type Turn = typeof turns.$inferSelect;
/* One task of a turn as the orchestrator lays it out. */
export type PlanItem = { department: string; product?: string; title: string; brief: string; body: string };
type Head = { id: string; name: string };
type Placed = PlanItem & { head: Head };
/* The orchestrator and the run he lays the turn out in. */
export type By = { companyId: string; agentId: string; jobId: string };

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

/* A department is off when its head is, or when it has employees and every one of them is off. */
async function switchedOff(db: Live['db'] | Tx, departmentId: string, head: { off: Date | null }): Promise<boolean> {
  if (head.off) return true;
  const staff = await db.select({ off: agents.switchedOffAt }).from(agents).where(and(eq(agents.departmentId, departmentId), eq(agents.kind, 'worker'), isNull(agents.removedAt)));
  return staff.length > 0 && staff.every(a => a.off);
}

/* Every item names a department of the company, a product inside it, and the department has a head to take it. */
async function place(ctx: Live, companyId: string, items: PlanItem[]): Promise<Placed[]> {
  if (!items.length) throw refuse(400, 'task_invalid', 'A turn needs at least one task.');
  const placed: Placed[] = [];
  for (const item of items) {
    if (!item.title.trim()) throw refuse(400, 'task_invalid', 'Every task needs a title.');
    const [dept] = await ctx.db.select().from(departments).where(and(eq(departments.id, item.department), eq(departments.companyId, companyId), isNull(departments.parentId)));
    if (!dept) throw refuse(404, 'department_unknown', `There is no department ${item.department}. Call company for the ids.`);
    if (item.product) {
      const [product] = await ctx.db.select({ id: departments.id }).from(departments).where(and(eq(departments.id, item.product), eq(departments.parentId, dept.id)));
      if (!product) throw refuse(404, 'department_unknown', `${item.product} is not a product of this department.`);
    }
    const head = await headOf(ctx.db, dept.id);
    if (!head) throw refuse(409, 'no_head', `"${item.title}": its department has no head yet. Propose staff for it first.`);
    if (await switchedOff(ctx.db, dept.id, head)) throw refuse(409, 'switched_off', `"${item.title}": its department is switched off right now. Give it no work until people switch it on.`);
    placed.push({ ...item, head });
  }
  return placed;
}

/* The words of the message this run answers, and as many of the messages before it as he names, leaving out words a turn
   already keeps. A run that a task's news started answers no one, so it keeps none. Messages that came in meanwhile wait
   for the runs that answer them. */
async function newWords(tx: Tx, by: By, words: number): Promise<TurnMessage[]> {
  const mine = and(eq(agentEvents.agentId, by.agentId), eq(agentEvents.kind, 'message'), isNotNull(agentEvents.personId));
  const [asked] = await tx.select({ seq: agentEvents.seq }).from(agentEvents).where(and(mine, eq(agentEvents.jobId, by.jobId))).orderBy(desc(agentEvents.seq)).limit(1);
  if (!asked) return [];
  const kept = (await tx.select({ messages: turns.messages }).from(turns).where(eq(turns.companyId, by.companyId))).flatMap(t => t.messages.flatMap(m => (m.id ? [m.id] : [])));
  const rows = await tx
    .select({ id: agentEvents.id, text: agentEvents.data, at: agentEvents.createdAt, by: people.name })
    .from(agentEvents)
    .innerJoin(people, eq(people.id, agentEvents.personId))
    .where(and(mine, lte(agentEvents.seq, asked.seq), kept.length ? notInArray(agentEvents.id, kept) : undefined))
    .orderBy(desc(agentEvents.seq))
    .limit(Math.min(Math.max(words, 1), TURN_MESSAGES));
  return rows
    .reverse()
    .map(r => ({ id: r.id, by: r.by, text: typeof (r.text as { text?: unknown }).text === 'string' ? (r.text as { text: string }).text : '', at: r.at.toISOString() }))
    .filter(m => m.text.trim());
}

/* Planned tasks wait in their turn without anyone holding them. */
async function insertPlanned(tx: Tx, companyId: string, agentId: string, turnId: string, items: Placed[]): Promise<Task[]> {
  const [last] = await tx.select({ n: max(tasks.number) }).from(tasks).where(eq(tasks.companyId, companyId));
  let n = last?.n ?? 0;
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
        status: 'planned',
        createdByAgentId: agentId,
        updatedAt: new Date(),
      })
      .returning();
    await note(tx, row!, { kind: 'created', actor: { agentId }, text: row!.brief, data: { planned: true } });
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
  return { task: row, head, off };
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

const liveAtTop = (turnId: string) => and(eq(tasks.turnId, turnId), isNull(tasks.parentId), notInArray(tasks.status, [...CLOSED]));

/* Opens the lowest planned turn when none is open, and sends its tasks to their heads. An open turn with nothing left at
   its top closes first, and a planned turn whose tasks were all cancelled closes without starting, so the turns after
   them do not wait for nothing. */
async function openNext(tx: Tx, companyId: string): Promise<{ turn: Turn; started: Started[] } | null> {
  for (;;) {
    const [open] = await tx.select({ id: turns.id }).from(turns).where(and(eq(turns.companyId, companyId), eq(turns.status, 'open')));
    if (open) {
      const [left] = await tx.select({ n: count() }).from(tasks).where(liveAtTop(open.id));
      if (Number(left?.n ?? 0)) return null;
      await tx.update(turns).set({ status: 'closed', closedAt: new Date() }).where(eq(turns.id, open.id));
      continue;
    }
    const [next] = await tx.select().from(turns).where(and(eq(turns.companyId, companyId), eq(turns.status, 'planned'))).orderBy(asc(turns.number)).limit(1);
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

/* A new turn with its tasks: it starts at once when no turn runs, else it waits after the planned ones. */
export async function planTurn(ctx: Live, by: By, input: { title: string; goal: string; tasks: PlanItem[]; words?: number }): Promise<TurnMove> {
  const { companyId, agentId } = by;
  const items = await place(ctx, companyId, input.tasks);
  const done = await ctx.db.transaction(async tx => {
    await lockCompany(tx, companyId);
    const [last] = await tx.select({ n: max(turns.number) }).from(turns).where(eq(turns.companyId, companyId));
    const messages = await newWords(tx, by, input.words ?? 1);
    const [turn] = await tx
      .insert(turns)
      .values({ companyId, number: (last?.n ?? 0) + 1, title: input.title.trim(), goal: input.goal.trim(), status: 'planned', messages, createdByAgentId: agentId })
      .returning();
    const planned = await insertPlanned(tx, companyId, agentId, turn!.id, items);
    const opened = await openNext(tx, companyId);
    return { turn: opened?.turn ?? turn!, planned, opened };
  });
  ctx.bus.publish(companyId, { type: 'org' });
  if (done.opened) {
    await announce(ctx, done.opened.started);
    return { turn: done.turn, text: `${turnName(done.turn)} started: ${whoGot(done.opened.started)}.`, wakes: wakesFor(done.opened.started) };
  }
  for (const t of done.planned) published(ctx, t);
  return { turn: done.turn, text: `${turnName(done.turn)} planned with ${numbers(done.planned)}. It starts by itself when the turns before it are done.`, wakes: [] };
}

async function liveTurn(tx: Tx | Live['db'], companyId: string, number: number): Promise<Turn> {
  const [turn] = await tx.select().from(turns).where(and(eq(turns.companyId, companyId), eq(turns.number, number)));
  if (!turn) throw refuse(404, 'turn_unknown', `There is no turn ${number}. Call turns to see them.`);
  if (turn.status === 'closed') throw refuse(409, 'turn_unknown', `Turn ${number} is over. Add the work to the open turn or plan a new one.`);
  return turn;
}

/* More tasks for a turn that has not closed: in the open one they go out at once, in a planned one they wait with it. */
export async function addTasks(ctx: Live, by: By, number: number, items: PlanItem[], words = 1): Promise<TurnMove> {
  const { companyId, agentId } = by;
  await liveTurn(ctx.db, companyId, number);
  const placed = await place(ctx, companyId, items);
  const done = await ctx.db.transaction(async tx => {
    await lockCompany(tx, companyId);
    const turn = await liveTurn(tx, companyId, number);
    const said = await newWords(tx, by, words);
    const [kept] = said.length ? await tx.update(turns).set({ messages: [...turn.messages, ...said] }).where(eq(turns.id, turn.id)).returning() : [turn];
    const planned = await insertPlanned(tx, companyId, agentId, turn.id, placed);
    const started: Started[] = [];
    if (turn.status === 'open') for (const task of planned) {
      const s = await start(tx, task);
      if (s) started.push(s);
    }
    return { turn: kept!, planned, started };
  });
  ctx.bus.publish(companyId, { type: 'org' });
  if (done.turn.status === 'open') {
    await announce(ctx, done.started);
    return { turn: done.turn, text: `Added to ${turnName(done.turn)}: ${whoGot(done.started)}.`, wakes: wakesFor(done.started) };
  }
  for (const t of done.planned) published(ctx, t);
  return { turn: done.turn, text: `Added ${numbers(done.planned)} to ${turnName(done.turn)}; they start with it.`, wakes: [] };
}

/* A new name or main point for a turn that has not closed. */
export async function editTurn(ctx: Live, companyId: string, number: number, change: { title?: string; goal?: string }): Promise<Turn> {
  const turn = await liveTurn(ctx.db, companyId, number);
  const set = { ...(change.title?.trim() ? { title: change.title.trim() } : {}), ...(change.goal?.trim() ? { goal: change.goal.trim() } : {}) };
  if (!Object.keys(set).length) return turn;
  const [row] = await ctx.db.update(turns).set(set).where(eq(turns.id, turn.id)).returning();
  ctx.bus.publish(companyId, { type: 'org' });
  return row!;
}

/* After a task closed: when it was the last open task at the top of the open turn, the turn is over and the next planned
   one starts. note tells the orchestrator what happened. */
export async function settle(ctx: Live, task: Pick<Task, 'turnId' | 'companyId' | 'status'>): Promise<{ wakes: Wake[]; note: string } | null> {
  if (!task.turnId || !CLOSED.includes(task.status)) return null;
  const turnId = task.turnId;
  const done = await ctx.db.transaction(async tx => {
    await lockCompany(tx, task.companyId);
    const [turn] = await tx.select().from(turns).where(and(eq(turns.id, turnId), eq(turns.status, 'open')));
    if (!turn) return null;
    const [left] = await tx.select({ n: count() }).from(tasks).where(liveAtTop(turnId));
    if (Number(left?.n ?? 0)) return null;
    const [closed] = await tx.update(turns).set({ status: 'closed', closedAt: new Date() }).where(eq(turns.id, turnId)).returning();
    return { closed: closed!, opened: await openNext(tx, task.companyId) };
  });
  if (!done) return null;
  ctx.bus.publish(task.companyId, { type: 'org' });
  const over = `That was the last open task of ${turnName(done.closed)}, so the turn is over.`;
  if (!done.opened) return { wakes: [], note: `${over} No turn is planned next; plan one with plan_turn when people ask for more.` };
  await announce(ctx, done.opened.started);
  return { wakes: wakesFor(done.opened.started), note: `${over} ${turnName(done.opened.turn)} started: ${whoGot(done.opened.started)}.` };
}

/* Adds what settle said to the orchestrator: to a wake he already gets on the task, else as a turn of its own. When he
   made the move himself, the note goes into his tool's answer instead. */
export function tell(wakes: Wake[], settled: { wakes: Wake[]; note: string } | null, orchestratorId: string | null, taskId: string, actorId?: string): Wake[] {
  if (!settled) return wakes;
  const all = [...wakes, ...settled.wakes];
  if (!orchestratorId || orchestratorId === actorId) return all;
  const his = all.find(w => w.agentId === orchestratorId && w.taskId === taskId);
  if (his) his.note = settled.note;
  else all.push({ agentId: orchestratorId, taskId, why: 'turn', note: settled.note });
  return all;
}

/* Turns as the tracker and the orchestrator read them, newest closed ones last kept. */
export async function turnRows(ctx: Live, companyId: string): Promise<Turn[]> {
  const live = await ctx.db.select().from(turns).where(and(eq(turns.companyId, companyId), inArray(turns.status, ['open', 'planned']))).orderBy(asc(turns.number));
  const closed = await ctx.db.select().from(turns).where(and(eq(turns.companyId, companyId), eq(turns.status, 'closed'))).orderBy(desc(turns.number)).limit(20);
  return [...closed.reverse(), ...live];
}
