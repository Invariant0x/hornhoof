import { and, asc, count, desc, eq, gt, inArray, isNull, max, ne, notInArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { accessOf, canReach, type Spot } from '../../auth/access.js';
import type { Db } from '../../db/client.js';
import { agents, attachments, companies, departments, jobs, people, requests, subscriptions, taskEvents, tasks, turns, type DecisionTopic, type RequestOption, type TaskEventKind } from '../../db/schema.js';
import { ApiError, type ErrorReason } from '../../errors.js';
import { dropEarlierWakes, keepWakes } from './outbox.js';
import { returnAlongLine } from '../org/map-state.js';
import { handOff } from './pulses.js';

export type Task = typeof tasks.$inferSelect;
export type Request = typeof requests.$inferSelect;
/* Who moves a task: a person from the web app, or an agent from its tools. */
export type Actor = { personId: string; agentId?: undefined } | { agentId: string; personId?: undefined };
export type WakeWhy = 'assigned' | 'review' | 'changes' | 'stuck_at_gate' | 'done' | 'reported' | 'blocked' | 'cancelled' | 'answered' | 'comment' | 'updated' | 'reminder' | 'go_on' | 'turn' | 'switched' | 'explain' | 'subtasks' | 'after_cancelled' | 'merge' | 'unblocked' | 'tests' | 'work' | 'turn_review' | 'reviewed' | 'review_passed';
/* An agent that has to act on a task now; Hornhoof queues a turn for it. note: what else it should know, after the rest. */
export type Wake = { agentId: string; taskId: string; why: WakeWhy; text?: string; note?: string };
export type Moved = { task: Task; wakes: Wake[] };

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/* The templates name a department's gate roles, for the review of a turn; without them none opens. */
type Live = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'templates'>>;

export const CLOSED: readonly Task['status'][] = ['done', 'cancelled'];
/* The send-back at one gate that also calls the head in. */
export const GATE_ROUNDS = 3;
/* Turns in a row that end without moving the task before a person is asked to step in. */
export const SILENT_TURNS = 3;
/* Turns in a row an agent may go on in, saying how far it got or working until its time runs out, before a person is asked:
   about six hours of work without handing anything in. */
export const GOING_ON_TURNS = 8;
const COMMIT = /^[0-9a-f]{40}$/;

const STATUS_CODES = { 400: 'validation', 403: 'forbidden', 404: 'not_found', 409: 'conflict' } as const;
export const refuse = (status: keyof typeof STATUS_CODES, reason: ErrorReason, message: string) => new ApiError(status, STATUS_CODES[status], message, reason);

const notYours = (t: Task, what: string) => refuse(403, 'task_not_yours', `#${t.number} ${what}.`);

export async function loadTask(db: Db, taskId: string): Promise<Task> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw refuse(404, 'task_unknown', `There is no task ${taskId}.`);
  return task;
}

function stillOpen(task: Task): void {
  if (CLOSED.includes(task.status)) throw refuse(409, 'task_closed', `#${task.number} is ${task.status} already.`);
}

/* Work under a task that is still open: a task is done only once all of it is. */
async function refuseOpenUnder(db: Db | Tx, task: Task): Promise<void> {
  const open = await db.select({ number: tasks.number }).from(tasks).where(and(eq(tasks.parentId, task.id), notInArray(tasks.status, [...CLOSED]))).orderBy(asc(tasks.number));
  if (open.length) throw refuse(409, 'task_invalid', `#${task.number} still has open subtasks: ${open.map(t => `#${t.number}`).join(', ')}. Wait for them, or cancel them first.`);
}

/* The last work under a task closed: whoever holds the task hears it can go on, once for all of it, unless it closed that
   work itself. When the code of a department's turn is in, the review of the turn opens instead, with the same move;
   opened takes it. A review of the turn that closes tells the head itself. */
async function workUnderDone(tx: Tx, templates: Live['templates'], closed: Task, actorId: string | undefined, opened: Task[]): Promise<Wake[]> {
  const [parent] = await tx.select().from(tasks).where(eq(tasks.id, closed.parentId!));
  const holder = parent?.assigneeAgentId;
  if (!parent || CLOSED.includes(parent.status) || !holder || (await isTurnReview(tx, closed.id))) return [];
  const [open] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.parentId, parent.id), notInArray(tasks.status, [...CLOSED]))).limit(1);
  if (open) return [];
  const due = templates ? await reviewDue(tx, parent) : null;
  let note: string | undefined;
  if (due?.waiting.length) {
    note = `The review of the turn opens by itself once the department's other code of the turn, under ${listed(due.waiting)}, is in, and checks the code under this task with it. Give the final check only after its verdicts.`;
  } else if (due) {
    const review = await openTurnReview(tx, templates!, parent, holder, due.covered);
    if ('row' in review) {
      opened.push(review.row);
      return review.wakes;
    }
    note = review.note;
  }
  return holder === actorId ? [] : [{ agentId: holder, taskId: parent.id, why: 'subtasks', ...(note ? { note } : {}) }];
}

const reviewMark = sql`${taskEvents.data}->>'turnReview' = 'true'`;

/* A review of a department's whole turn: its created note says so. */
async function isTurnReview(db: Db | Tx, taskId: string): Promise<boolean> {
  const [made] = await db.select({ id: taskEvents.id }).from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.kind, 'created'), reviewMark)).limit(1);
  return Boolean(made);
}

/* The note a task was created with. */
async function createdData(db: Db | Tx, taskId: string): Promise<Record<string, unknown>> {
  const [made] = await db.select({ data: taskEvents.data }).from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.kind, 'created'))).limit(1);
  return made?.data ?? {};
}

/* How a reviewer is woken back to the task it checks: the review of a turn names the turn's branch. */
export async function reviewWake(db: Db | Tx, task: Task): Promise<Pick<Wake, 'why' | 'text'>> {
  if (!task.turnId || !(await isTurnReview(db, task.id))) return { why: 'review' };
  const [turn] = await db.select({ number: turns.number }).from(turns).where(eq(turns.id, task.turnId));
  return { why: 'turn_review', text: `turn-${turn!.number}` };
}

/* A department's turn gets its review once code given out for it (without gates of its own, inTurnReview) was merged into
   the turn's branch, under the department's tasks of the turn that no review checked yet, each review once: the fixes it
   asks for go in without a second one. covered: those tasks that have such code under them; waiting: the ones whose code
   is still going on, which the review waits for. Null when none is due. */
async function reviewDue(db: Db | Tx, parent: Task): Promise<{ covered: Task[]; waiting: Task[] } | null> {
  if (parent.executorAgentId || !parent.turnId || !parent.departmentId) return null;
  const ofTurn = and(eq(tasks.companyId, parent.companyId), eq(tasks.turnId, parent.turnId), eq(tasks.departmentId, parent.departmentId));
  const reviews = await db
    .select({ data: taskEvents.data })
    .from(taskEvents)
    .where(and(inArray(taskEvents.taskId, db.select({ id: tasks.id }).from(tasks).where(ofTurn)), eq(taskEvents.kind, 'created'), reviewMark));
  const checked = new Set(reviews.flatMap(r => (Array.isArray(r.data.covers) ? (r.data.covers as string[]) : [])));
  if (checked.has(parent.id)) return null;
  const own = (await db.select().from(tasks).where(and(ofTurn, isNull(tasks.executorAgentId), ne(tasks.status, 'cancelled'))).orderBy(asc(tasks.number))).filter(t => !checked.has(t.id));
  const code = await db
    .select({ id: tasks.id, parentId: tasks.parentId, status: tasks.status })
    .from(tasks)
    .innerJoin(taskEvents, and(eq(taskEvents.taskId, tasks.id), eq(taskEvents.kind, 'created'), sql`${taskEvents.data}->>'inTurnReview' = 'true'`))
    .where(inArray(tasks.parentId, own.map(t => t.id)));
  if (!code.length) return null;
  const [merged] = await db
    .select({ id: taskEvents.id })
    .from(taskEvents)
    .where(and(inArray(taskEvents.taskId, code.map(c => c.id)), eq(taskEvents.kind, 'submitted'), sql`${taskEvents.data}->>'merged' = 'true'`))
    .limit(1);
  if (!merged) return null;
  const covered = own.filter(t => code.some(c => c.parentId === t.id));
  const waiting = covered.filter(t => code.some(c => c.parentId === t.id && !CLOSED.includes(c.status)));
  return { covered, waiting };
}

/* The gate roles of a department in their order, by the first employee of each, one that is on before one that is off. */
export async function gateLeads(db: Db | Tx, templates: Ctx['templates'], departmentId: string, executor: string): Promise<string[]> {
  const staff = await db.select().from(agents).where(and(eq(agents.departmentId, departmentId), isNull(agents.removedAt))).orderBy(asc(agents.createdAt));
  const gate = (a: typeof agents.$inferSelect) => (a.roleKey ? templates.roles.get(a.roleKey)?.gate : null) ?? null;
  const seen = new Set<string>();
  return staff
    .filter(a => a.id !== executor && gate(a) !== null)
    .sort((a, b) => gate(a)! - gate(b)! || Number(!!a.switchedOffAt) - Number(!!b.switchedOffAt))
    .filter(a => !seen.has(a.roleKey!) && seen.add(a.roleKey!))
    .map(a => a.id);
}

/* The review of a department's turn: every gate role checks the turn's branch at once, of each one of each maker's
   models, the least busy. The head gives the work and gets the verdicts. With nobody to check it, a note for the head,
   who hears the work under its task is done as without a review. Inside the move that closed the last work, which holds
   the company and the task, as a new task takes them. covered: the department's tasks of the turn it checks. */
async function openTurnReview(tx: Tx, templates: Ctx['templates'], parent: Task, head: string, covered: Task[]): Promise<{ row: Task; wakes: Wake[] } | { note?: string }> {
  const leads = await gateLeads(tx, templates, parent.departmentId!, head);
  const draft = { ...parent, executorAgentId: head, gates: leads };
  const roles = await Promise.all(leads.map((_, i) => panelFor(tx, draft, i + 1)));
  const panel = [...new Set(roles.flatMap(p => p.panel))];
  /* A role none of whose reviewers has a subscription does not check it, and the head hears who. */
  const unable = roles.filter(p => !p.panel.length).flatMap(p => p.idle);
  if (!panel.length) {
    const who = joined(unable.map(a => a.name));
    return unable.length ? { note: `Nobody could review the turn: ${who} ${unable.length === 1 ? 'has' : 'have'} no subscription to run on. Give them one on their cards, or give the final check without the review.` } : {};
  }
  const [turn] = await tx.select({ number: turns.number }).from(turns).where(eq(turns.id, parent.turnId!));
  const [last] = await tx.select({ n: max(tasks.number) }).from(tasks).where(eq(tasks.companyId, parent.companyId));
  const branch = `turn-${turn!.number}`;
  const titles = joined(covered.map(t => `"${t.title}"`));
  const under = joined(covered.map(t => `#${t.number} "${t.title}"`));
  const [row] = await tx
    .insert(tasks)
    .values({
      companyId: parent.companyId,
      number: (last?.n ?? 0) + 1,
      turnId: parent.turnId,
      parentId: parent.id,
      departmentId: parent.departmentId,
      productId: parent.productId,
      title: `Review of turn ${turn!.number}`,
      brief: `Every reviewer checks all that turn ${turn!.number} changed for ${titles} at once, on ${branch}.`,
      body: `Review ${branch} against the main line: everything the turn changed under ${under}. The verdicts go to the head in one list.`,
      status: 'review',
      stage: 1,
      assigneeAgentId: panel[0]!,
      executorAgentId: head,
      gates: leads,
      panel,
      createdByAgentId: head,
      updatedAt: new Date(),
    })
    .returning();
  await note(tx, row!, {
    kind: 'created',
    actor: { agentId: head },
    text: row!.brief,
    data: { assignee: panel[0], gates: leads, after: [], panel, unable: unable.map(a => a.id), covers: covered.map(t => t.id), turnReview: true },
  });
  return { row: row!, wakes: panel.map(agentId => ({ agentId, taskId: row!.id, why: 'turn_review', text: branch })) };
}

/* Names as a reader says them: "A", "A and B", "A, B and C". */
function joined(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
}

/* Task numbers as a reader says them: "#2", "#2 and #3", "#2, #3 and #4". */
export function listed(rows: Pick<Task, 'number'>[]): string {
  return joined(rows.map(t => `#${t.number}`));
}

/* The tasks this one comes after that are not done yet, by number. */
export async function openAfter(db: Db | Tx, task: Pick<Task, 'after'>): Promise<Pick<Task, 'id' | 'number' | 'status'>[]> {
  if (!task.after.length) return [];
  return db.select({ id: tasks.id, number: tasks.number, status: tasks.status }).from(tasks).where(and(inArray(tasks.id, task.after), ne(tasks.status, 'done'))).orderBy(asc(tasks.number));
}

/* A task that still waits for what it comes after takes no work in for it. */
async function refuseWaiting(db: Db | Tx, task: Task): Promise<void> {
  const open = await openAfter(db, task);
  if (open.length) throw refuse(409, 'task_invalid', `#${task.number} waits for ${listed(open)} first. You are woken once it can start.`);
}

/* What a task comes after: tasks of the company in its own turn, each once and none cancelled. hold: they stay as read
   until the transaction ends, so none is done meanwhile unseen. */
async function checkAfter(db: Db | Tx, companyId: string, turnId: string | null, ids: string[], hold = false): Promise<Task[]> {
  if (new Set(ids).size !== ids.length) throw refuse(400, 'task_invalid', 'A task it comes after is listed twice.');
  const read = db.select().from(tasks).where(inArray(tasks.id, ids));
  const rows = ids.length ? await (hold ? read.orderBy(asc(tasks.id)).for('share') : read) : [];
  for (const id of ids) {
    const t = rows.find(r => r.id === id);
    if (!t || t.companyId !== companyId) throw refuse(400, 'task_invalid', `There is no task ${id} to come after.`);
    if (t.turnId !== turnId) throw refuse(400, 'task_invalid', `#${t.number} is in another turn. A task comes only after tasks of its own turn.`);
    if (t.status === 'cancelled') throw refuse(400, 'task_invalid', `#${t.number} is cancelled, so nothing can come after it.`);
  }
  return rows;
}

/* A task never waits for itself, also not through the tasks it comes after. */
async function refuseCircle(db: Db | Tx, task: Task, ids: string[]): Promise<void> {
  const seen = new Set<string>();
  let level = ids;
  while (level.length) {
    if (level.includes(task.id)) throw refuse(400, 'task_invalid', `#${task.number} would wait for itself through what it comes after.`);
    const rows = await db.select({ after: tasks.after }).from(tasks).where(inArray(tasks.id, level));
    level = rows.flatMap(r => r.after).filter(id => !seen.has(id) && Boolean(seen.add(id)));
  }
}

/* A task never waits for a task it is part of, however far up: that one is done only once the work under it is. */
async function refuseAbove(db: Db | Tx, parentId: string | null, ids: string[]): Promise<void> {
  for (let id = ids.length ? parentId : null; id; ) {
    const [up] = await db.select({ id: tasks.id, number: tasks.number, parentId: tasks.parentId }).from(tasks).where(eq(tasks.id, id));
    if (!up) return;
    if (ids.includes(up.id)) throw refuse(400, 'task_invalid', `#${up.number} is the task this work is part of, so it cannot come after it: #${up.number} is done only once the work under it is.`);
    id = up.parentId;
  }
}

/* Nor for work under it, however far down: that work is part of it. */
async function refuseBelow(db: Db | Tx, task: Task, ids: string[]): Promise<void> {
  let level = ids.length ? [task.id] : [];
  while (level.length) {
    const rows = await db.select({ id: tasks.id, number: tasks.number }).from(tasks).where(inArray(tasks.parentId, level));
    const under = rows.find(r => ids.includes(r.id));
    if (under) throw refuse(400, 'task_invalid', `#${under.number} is work under #${task.number}, so #${task.number} cannot come after it: the work under a task is part of it.`);
    level = rows.map(r => r.id);
  }
}

/* A task is done: each task that came after it and waits for nothing else any more goes on with whoever holds it, and
   its log says why. rows: the tasks that started. Two tasks it waits for done at once would each see the other still
   open, so the waiting tasks are taken first and the second to be done sees the first. */
async function startAfter(tx: Tx, done: Task): Promise<{ wakes: Wake[]; rows: Task[] }> {
  const waiting = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.companyId, done.companyId), sql`${tasks.after} @> ${JSON.stringify([done.id])}::jsonb`, notInArray(tasks.status, [...CLOSED])))
    .orderBy(asc(tasks.number))
    .for('update');
  const wakes: Wake[] = [];
  const rows: Task[] = [];
  for (const t of waiting) {
    if ((await openAfter(tx, t)).length) continue;
    const [row] = await tx.update(tasks).set({ version: sql`${tasks.version} + 1`, updatedAt: new Date() }).where(eq(tasks.id, t.id)).returning();
    const before = await tx.select({ number: tasks.number }).from(tasks).where(inArray(tasks.id, t.after)).orderBy(asc(tasks.number));
    await tx.insert(taskEvents).values({ companyId: t.companyId, taskId: t.id, kind: 'started', text: `${listed(before)} ${before.length === 1 ? 'is' : 'are'} done, so it starts now.` });
    /* One that waits for a person's answer goes on with the answer. */
    if (row!.assigneeAgentId && ['open', 'working'].includes(row!.status)) wakes.push({ agentId: row!.assigneeAgentId, taskId: row!.id, why: 'assigned' });
    rows.push(row!);
  }
  return { wakes, rows };
}

/* Where a task sits, for the stream: its product inside its department, or the department; none for the orchestrator's. */
export const taskSpot = (t: Pick<Task, 'departmentId' | 'productId'>): Spot =>
  t.productId ? { departmentId: t.productId, parentId: t.departmentId } : { departmentId: t.departmentId, parentId: null };

const actorColumns = (a: Actor) => ({ personId: a.personId ?? null, agentId: a.agentId ?? null });

/* returned: the agent gives its work back to the one above it with this move, which the map shows on their line. */
type Note = { kind: TaskEventKind; actor: Actor; text?: string; data?: Record<string, unknown>; returned?: true };

export async function note(tx: Tx | Db, task: Pick<Task, 'id' | 'companyId'>, n: Note): Promise<{ id: number; createdAt: Date }> {
  const [row] = await tx
    .insert(taskEvents)
    .values({ companyId: task.companyId, taskId: task.id, kind: n.kind, ...actorColumns(n.actor), text: n.text ?? '', data: n.data ?? {} })
    .returning({ id: taskEvents.id, createdAt: taskEvents.createdAt });
  return row!;
}

/* A move by which an agent gives its work back lights its line to the one above it on the map: the task, when it did. */
async function givesBack(tx: Tx, row: Task, n: Note, event: { id: number; createdAt: Date }): Promise<Task | null> {
  if (!n.returned || !n.actor.agentId) return null;
  return (await returnAlongLine(tx, { agentId: n.actor.agentId, sourceKey: `task:${event.id}`, sourceTaskId: row.id, returnedAt: event.createdAt })) ? row : null;
}

/* The map reads its lines again when one of them changed, in the company of what changed it. */
function linesMoved(ctx: Live, changed: { companyId: string } | null): void {
  if (changed) ctx.bus.publish(changed.companyId, { type: 'org' });
}

/* One move: the task changes only if nobody moved it since it was read, and the move is written to its log. */
/* wakes: the turns the move needs, kept with it until they are queued. */
async function move(ctx: Live, task: Task, set: Partial<Task>, n: Note, also?: (tx: Tx, row: Task) => Promise<void>, wakes: Wake[] = []): Promise<Task> {
  let started: Task[] = [];
  const opened: Task[] = [];
  let lit: Task | null = null;
  const row = await ctx.db.transaction(async tx => {
    /* Two changes at once to what tasks come after would each miss the other's half of a circle: they go one at a time in
       a company, and the circle is looked for once it is this one's turn. What it comes after now is held until the move
       is kept, so one of them done meanwhile is seen, or sees this task wait for it. */
    if (set.after?.length) {
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, task.companyId)).for('update');
      await tx.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, set.after)).orderBy(asc(tasks.id)).for('share');
      await refuseCircle(tx, task, set.after);
    }
    /* Two tasks under one parent closing at once would each see the other still open, and nobody would hear that all of
       the work under it is closed: one that closes takes its parent first, so they close one after the other. */
    if (set.status && CLOSED.includes(set.status) && task.parentId) {
      /* The last of it may open the review of its turn, a new task: the company first, as a new task takes it. */
      if (!set.after?.length) await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, task.companyId)).for('update');
      await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, task.parentId)).for('update');
    }
    const [row] = await tx
      .update(tasks)
      .set({ ...set, version: task.version + 1, updatedAt: new Date() })
      .where(and(eq(tasks.id, task.id), eq(tasks.version, task.version)))
      .returning();
    if (!row) throw refuse(409, 'task_changed', `#${task.number} changed meanwhile. Read it again.`);
    /* Done means all of it: work under it still open would go on under a finished task, and the turn with it. */
    if (set.status === 'done') await refuseOpenUnder(tx, task);
    await dropEarlierWakes(tx, task.id);
    lit = await givesBack(tx, row, n, await note(tx, row, n));
    await also?.(tx, row);
    if (CLOSED.includes(row.status) && row.parentId) wakes.push(...(await workUnderDone(tx, ctx.templates, row, n.actor.agentId, opened)));
    /* What waited for it starts with the same move, so its turn is kept with it. */
    if (row.status === 'done') {
      const after = await startAfter(tx, row);
      wakes.push(...after.wakes);
      started = after.rows;
    }
    await keepWakes(tx, task.companyId, wakes);
    return row;
  });
  published(ctx, row);
  for (const t of [...started, ...opened]) published(ctx, t);
  linesMoved(ctx, lit);
  await handOff(ctx, n.actor, row);
  return row;
}

export function published(ctx: Pick<Ctx, 'bus'>, task: Task): void {
  ctx.bus.publish(task.companyId, { type: 'task', id: task.id, spot: taskSpot(task) });
}

/* Whoever gave the task, when that was an agent other than the one acting. */
export const giver = (task: Task, why: WakeWhy, actorId?: string, text?: string): Wake[] =>
  task.createdByAgentId && task.createdByAgentId !== actorId ? [{ agentId: task.createdByAgentId, taskId: task.id, why, ...(text ? { text } : {}) }] : [];

/* Whoever gave out a task that is done hears it only for a task of its own: work under a bigger task is heard of once,
   when the last of it closes. */
const doneFor = (task: Task, actorId?: string): Wake[] => (task.parentId ? [] : giver(task, 'done', actorId));

const closing = () => ({ status: 'done' as const, closedAt: new Date(), assigneeAgentId: null, silent: 0 });

/* Whether the task's work lives in a repository: its product's, else its department's. */
export async function inRepository(db: Db | Tx, task: Pick<Task, 'departmentId' | 'productId'>): Promise<boolean> {
  const ids = [task.productId, task.departmentId].filter((x): x is string => Boolean(x));
  if (!ids.length) return false;
  const rows = await db.select({ repoUrl: departments.repoUrl }).from(departments).where(inArray(departments.id, ids));
  return rows.some(r => r.repoUrl);
}

/* The task passed its last gate. Work in a repository goes back to its executor, who merges its branch into the turn's
   branch and hands that in, which closes it; whoever gave it out decides when the executor is switched off. Other work is
   done. done: the wakes a finished task needs. */
async function passedGates(db: Db | Tx, task: Task, done: Wake[]): Promise<{ set: Partial<Task>; wakes: Wake[] }> {
  if (!task.executorAgentId || !(await inRepository(db, task))) return { set: { ...closing(), panel: [] }, wakes: done };
  const [executor] = await db.select({ name: agents.name, off: agents.switchedOffAt }).from(agents).where(eq(agents.id, task.executorAgentId));
  const merging = { status: 'open' as const, stage: 0, panel: [], merging: true, silent: 0 };
  if (executor?.off && task.createdByAgentId && task.createdByAgentId !== task.executorAgentId) {
    const text = `${executor.name} does it and is switched off, and it passed its gates: its branch waits to be merged into the turn's branch. Give it to someone who is on with update_task, or tell the CEO it waits for ${executor.name}.`;
    return { set: { ...merging, assigneeAgentId: task.createdByAgentId }, wakes: [{ agentId: task.createdByAgentId, taskId: task.id, why: 'switched', text }] };
  }
  /* The turn's branch is named after the turn's number. */
  const [turn] = task.turnId ? await db.select({ number: turns.number }).from(turns).where(eq(turns.id, task.turnId)) : [];
  return { set: { ...merging, assigneeAgentId: task.executorAgentId }, wakes: [{ agentId: task.executorAgentId, taskId: task.id, why: 'merge', ...(turn ? { text: `turn-${turn.number}` } : {}) }] };
}

/* Whether the task waits for a person's word other than Hornhoof's note that it stood still. */
async function waitsForPerson(db: Db | Tx, taskId: string): Promise<boolean> {
  const [open] = await db.select({ id: requests.id }).from(requests).where(and(eq(requests.taskId, taskId), eq(requests.status, 'open'), notInArray(requests.kind, ['stuck']))).limit(1);
  return !!open;
}

/* Hornhoof's notes that the task stood still are over once it moves again: handed on, handed in or reported. */
async function letStuckGo(tx: Tx, taskId: string): Promise<boolean> {
  const gone = await tx.update(requests).set({ status: 'withdrawn', answeredAt: new Date() }).where(and(eq(requests.taskId, taskId), eq(requests.status, 'open'), eq(requests.kind, 'stuck'))).returning({ id: requests.id });
  return gone.length > 0;
}

/* The notes go with the move, and people hear of it once the move is in. */
function stuckGoes(ctx: Live, task: Task): { also: (tx: Tx) => Promise<void>; tell: () => void } {
  let gone = false;
  return {
    also: async tx => {
      gone = await letStuckGo(tx, task.id);
    },
    tell: () => {
      if (gone) ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
    },
  };
}

export type NewTask = {
  title: string;
  brief: string;
  body: string;
  departmentId: string | null;
  productId?: string | null;
  parentId?: string | null;
  assigneeAgentId: string;
  /* A member task: the assignee executes it and its gates review it in order. */
  executor?: boolean;
  gates?: string[];
  /* Tasks of the same turn that must be done first. */
  after?: string[];
  /* Code given out without gates of its own: the review of its department's turn checks it. */
  inTurnReview?: boolean;
};

/* A live employee or orchestrator of the company. */
async function liveAgent(db: Db | Tx, companyId: string | null, id: string) {
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, id), isNull(agents.removedAt)));
  if (!agent || (companyId && agent.companyId !== companyId)) throw refuse(400, 'task_invalid', `There is no employee ${id}.`);
  return agent;
}

/* A live agent that can take a turn: one without a subscription would never wake for the task, one switched off not
   until it is on again. A gate may be off: its role's employees that are on check the work. */
async function workingAgent(db: Db | Tx, companyId: string | null, id: string, gate = false) {
  const agent = await liveAgent(db, companyId, id);
  if (agent.switchedOffAt && !gate) throw refuse(409, 'switched_off', `${agent.name} is switched off right now. Give the work to someone who is on.`);
  const [sub] = agent.subscriptionId
    ? await db.select({ id: subscriptions.id }).from(subscriptions).where(and(eq(subscriptions.id, agent.subscriptionId), isNull(subscriptions.removedAt)))
    : [];
  if (!sub) throw refuse(409, 'no_subscription', `${agent.name} has no subscription to run on. Give them one on their card first.`);
  return agent;
}

async function checkGates(db: Db, companyId: string, executor: string, gates: string[]): Promise<void> {
  if (new Set(gates).size !== gates.length) throw refuse(400, 'task_invalid', 'A gate is listed twice.');
  if (gates.includes(executor)) throw refuse(400, 'task_invalid', 'Whoever does the work never passes its gate. Pick another reviewer.');
  for (const id of gates) await workingAgent(db, companyId, id, true);
}

export async function createTask(ctx: Live, actor: Actor, input: NewTask): Promise<Moved> {
  const assignee = await workingAgent(ctx.db, null, input.assigneeAgentId);
  const gates = input.executor ? (input.gates ?? []) : [];
  if (!input.executor && input.gates?.length) throw refuse(400, 'task_invalid', 'Only a task with an executor has gates.');
  if (input.executor) await checkGates(ctx.db, assignee.companyId, assignee.id, gates);
  if (!input.title.trim()) throw refuse(400, 'task_invalid', 'A task needs a title.');
  const parent = input.parentId ? await loadTask(ctx.db, input.parentId) : null;
  if (parent) stillOpen(parent);
  let waits = false;
  const task = await ctx.db.transaction(async tx => {
    /* Numbers go up one by one per company, so creating tasks waits on the company row. */
    await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, assignee.companyId)).for('update');
    /* A parent cancelled meanwhile takes no new work; one cancelled after this waits and cancels the new task with it. */
    if (parent) {
      const [now] = await tx.select().from(tasks).where(eq(tasks.id, parent.id)).for('update');
      stillOpen(now!);
      /* Its gates check the work as handed in; more work under it starts once they send it back. */
      if (now!.stage > 0) throw refuse(409, 'task_invalid', `#${now!.number} is being checked at its gates, so no work goes under it now. Give it once the gates send it back, or as a task of its own.`);
      /* Nor while it waits for what it comes after: its work starts with it. */
      const open = await openAfter(tx, now!);
      if (open.length) throw refuse(409, 'task_invalid', `#${now!.number} waits for ${listed(open)} first, so no work goes under it yet. You are woken once it can start.`);
    }
    const [last] = await tx.select({ n: max(tasks.number) }).from(tasks).where(eq(tasks.companyId, assignee.companyId));
    const [turn] = parent ? [] : await tx.select({ id: turns.id }).from(turns).where(and(eq(turns.companyId, assignee.companyId), eq(turns.status, 'open')));
    const turnId = parent ? parent.turnId : (turn?.id ?? null);
    /* One of them done at this moment would not see the new task wait for it, so they are held while it is decided
       whether it waits: that one is done after the task is made, and starts it. */
    const after = await checkAfter(tx, assignee.companyId, turnId, input.after ?? [], true);
    await refuseAbove(tx, parent?.id ?? null, input.after ?? []);
    waits = after.some(t => t.status !== 'done');
    const [row] = await tx
      .insert(tasks)
      .values({
        companyId: assignee.companyId,
        number: (last?.n ?? 0) + 1,
        turnId,
        parentId: parent?.id ?? null,
        departmentId: input.departmentId,
        productId: input.productId ?? null,
        title: input.title.trim(),
        brief: input.brief.trim(),
        body: input.body,
        assigneeAgentId: assignee.id,
        executorAgentId: input.executor ? assignee.id : null,
        gates,
        after: input.after ?? [],
        createdByPersonId: actor.personId ?? null,
        createdByAgentId: actor.agentId ?? null,
        updatedAt: new Date(),
      })
      .returning();
    await note(tx, row!, { kind: 'created', actor, text: row!.brief, data: { assignee: assignee.id, gates, after: row!.after, ...(input.inTurnReview ? { inTurnReview: true } : {}) } });
    /* One that waits for what it comes after is not given out yet: the move that finishes the last of them wakes its holder. */
    if (!waits) await keepWakes(tx, row!.companyId, [{ agentId: assignee.id, taskId: row!.id, why: 'assigned' }]);
    return row!;
  });
  published(ctx, task);
  await handOff(ctx, actor, task);
  return { task, wakes: waits ? [] : [{ agentId: assignee.id, taskId: task.id, why: 'assigned' }] };
}

/* The executor hands its work to the first gate, or finishes a task without gates. */
export async function submit(ctx: Live, agentId: string, taskId: string, r: { summary: string; evidence: string }): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  if (!task.executorAgentId) throw refuse(400, 'task_invalid', `#${task.number} has no executor; its owner closes it with report.`);
  if (task.executorAgentId !== agentId || task.stage !== 0) throw notYours(task, 'is not waiting for your work');
  if (task.status === 'waiting' && (await waitsForPerson(ctx.db, task.id))) throw refuse(409, 'task_invalid', `#${task.number} waits for a person's answer first.`);
  await refuseWaiting(ctx.db, task);
  await refuseOpenUnder(ctx.db, task);
  const n: Note = { kind: 'submitted', actor: { agentId }, text: r.summary, data: { evidence: r.evidence, ...(task.merging ? { merged: true } : {}) }, returned: true };
  const unstuck = stuckGoes(ctx, task);
  /* Its gates passed it already: handing the merge in finishes it. Work sent back goes straight to the gate that sent it. */
  if (task.gates.length && !task.merging) {
    const back = await sentBack(ctx.db, task);
    const gate = await atGate(ctx.db, task, back?.stage ?? 1, back?.findings);
    const row = await move(ctx, task, gate.set, n, unstuck.also, gate.wakes);
    unstuck.tell();
    return { task: row, wakes: gate.wakes };
  }
  /* Without gates it is past them as it is handed in: work in a repository still goes back to be merged. */
  const past = task.merging ? { set: closing(), wakes: doneFor(task, agentId) } : await passedGates(ctx.db, task, doneFor(task, agentId));
  const row = await move(ctx, task, past.set, n, unstuck.also, past.wakes);
  unstuck.tell();
  return { task: row, wakes: past.wakes };
}

/* An API key runs the models of the maker whose plans it stands beside. */
const MAKER: Partial<Record<string, string>> = { anthropic_api: 'claude', openai_api: 'codex' };

/* Who checks the work at a gate. Reviewers of different models find different things, so one of each maker's models
   checks the same work at once: among the live employees of the gate's role in its department that are on, for the
   task's product or for none, never the executor, the one with the fewest tasks at a gate, the oldest on a tie. The
   reviewer the gate names is one of them like any other. A reviewer without a role checks alone. again: those who sent
   the work back from this gate, who check the fixes alone while any of them is still there. idle: those without a
   subscription to run on. */
async function panelFor(db: Db | Tx, task: Task, stage: number, again: string[] = []): Promise<{ panel: string[]; idle: { id: string; name: string }[] }> {
  const named = task.gates[stage - 1];
  if (!named) return { panel: [], idle: [] };
  const [lead] = await db.select().from(agents).where(eq(agents.id, named));
  if (!lead || lead.removedAt) return { panel: [], idle: [] };
  const same = lead.roleKey && lead.departmentId ? and(eq(agents.departmentId, lead.departmentId), eq(agents.roleKey, lead.roleKey)) : eq(agents.id, lead.id);
  const rows = await db
    .select({ id: agents.id, name: agents.name, productId: agents.productId, sub: subscriptions.id, provider: subscriptions.provider })
    .from(agents)
    .leftJoin(subscriptions, and(eq(subscriptions.id, agents.subscriptionId), isNull(subscriptions.removedAt)))
    .where(and(same, isNull(agents.removedAt), isNull(agents.switchedOffAt)))
    .orderBy(asc(agents.createdAt));
  const product = task.productId ?? lead.productId;
  const fit = rows.filter(a => a.id !== task.executorAgentId && (!a.productId || a.productId === product));
  const idle = fit.filter(a => !a.sub).map(a => ({ id: a.id, name: a.name }));
  const able = fit.filter(a => a.sub);
  const back = able.filter(a => again.includes(a.id));
  if (back.length) return { panel: back.map(a => a.id), idle };
  const checking = able.length
    ? await db
        .select({ panel: tasks.panel })
        .from(tasks)
        .where(and(eq(tasks.companyId, task.companyId), inArray(tasks.status, ['review', 'waiting']), ne(tasks.id, task.id)))
    : [];
  const busy = (id: string) => checking.filter(t => t.panel.includes(id)).length;
  const picked = new Map<string, string>();
  for (const a of able) {
    const maker = MAKER[a.provider!] ?? a.provider!;
    const best = picked.get(maker);
    if (best === undefined || busy(a.id) < busy(best)) picked.set(maker, a.id);
  }
  const chosen = new Set(picked.values());
  return { panel: able.filter(a => chosen.has(a.id)).map(a => a.id), idle };
}

/* Where the work was sent back from in the last round, with the findings of each reviewer who sent it back. Nothing once
   the task's gates were given again since: it starts at the first of them. */
async function sentBack(db: Db, task: Task): Promise<{ stage: number; findings: Map<string, string> } | null> {
  if (!task.bounces) return null;
  const failed = await db
    .select({ id: taskEvents.id, agentId: taskEvents.agentId, text: taskEvents.text, data: taskEvents.data })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'verdict'), sql`${taskEvents.data}->>'round' = ${String(task.bounces - 1)}`, sql`${taskEvents.data}->>'pass' = 'false'`))
    .orderBy(asc(taskEvents.id));
  const last = failed[failed.length - 1];
  if (!last) return null;
  const [regated] = await db
    .select({ id: taskEvents.id })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'updated'), gt(taskEvents.id, last.id), sql`${taskEvents.data}->'fields' @> '["gates"]'::jsonb`))
    .limit(1);
  if (regated) return null;
  return { stage: Number(last.data.stage), findings: new Map(failed.map(f => [f.agentId!, f.text])) };
}

/* Whether anyone of the role behind a gate is switched on. A reviewer without a role stands for itself. */
async function roleOn(db: Db | Tx, named: string): Promise<boolean> {
  const [lead] = await db.select().from(agents).where(eq(agents.id, named));
  if (!lead) return false;
  const same = lead.roleKey && lead.departmentId ? and(eq(agents.departmentId, lead.departmentId), eq(agents.roleKey, lead.roleKey)) : eq(agents.id, lead.id);
  const [on] = await db.select({ id: agents.id }).from(agents).where(and(same, isNull(agents.removedAt), isNull(agents.switchedOffAt))).limit(1);
  return Boolean(on);
}

/* The role behind a gate: its role in its department, or the reviewer itself when it has none. */
async function gateRole(db: Db | Tx, named: string): Promise<string> {
  const [lead] = await db.select({ departmentId: agents.departmentId, roleKey: agents.roleKey }).from(agents).where(eq(agents.id, named));
  return lead?.roleKey && lead.departmentId ? `${lead.departmentId}:${lead.roleKey}` : named;
}

/* Whether a gate before this one stands for the same role: the role's whole panel checked the work there. */
async function checkedBefore(db: Db | Tx, task: Task, stage: number): Promise<boolean> {
  const role = await gateRole(db, task.gates[stage - 1]!);
  for (const named of task.gates.slice(0, stage - 1)) if ((await gateRole(db, named)) === role) return true;
  return false;
}

/* The task reaches a gate: its whole panel checks it at once. A gate whose role has nobody switched on takes no part,
   nor one whose role a gate before it has, so the task goes on to the next one, and past the last it is done. While nobody of the role who is on can check it, it
   waits with whoever gave it out. findings: what each reviewer sent the work back from this gate for, in the last round;
   those reviewers check their own fixes. */
async function atGate(db: Db | Tx, task: Task, from: number, findings = new Map<string, string>()): Promise<{ set: Partial<Task>; wakes: Wake[] }> {
  let stage = from;
  /* Work sent back from a gate goes back to it, to those who sent it back. */
  const skip = async (at: number) => !(await roleOn(db, task.gates[at - 1]!)) || (!(at === from && findings.size) && (await checkedBefore(db, task, at)));
  while (task.gates[stage - 1] && (await skip(stage))) stage++;
  if (!task.gates[stage - 1]) {
    const passed = await passedGates(db, task, doneFor(task));
    return { set: { stage: task.gates.length, ...passed.set }, wakes: passed.wakes };
  }
  const again = stage === from ? [...findings.keys()] : [];
  const { panel, idle } = await panelFor(db, task, stage, again);
  if (panel.length) {
    const wakes = panel.map(agentId => ({ agentId, taskId: task.id, why: 'review' as const, ...(again.includes(agentId) ? { text: findings.get(agentId)! } : {}) }));
    return { set: { status: 'review', stage, panel, silent: 0, assigneeAgentId: panel[0]! }, wakes };
  }
  const [lead] = await db.select({ name: agents.name, roleKey: agents.roleKey }).from(agents).where(eq(agents.id, task.gates[stage - 1]!));
  const who = lead?.roleKey ?? lead?.name ?? 'its reviewer';
  const text = idle.length
    ? `${idle.map(a => a.name).join(', ')} ${idle.length === 1 ? 'has' : 'have'} no subscription to run on, so gate ${stage} (${who}) cannot check it. Give them one on their card and then give the task its gates again with update_task, switch them off, or give it other gates.`
    : `Nobody who can check it at gate ${stage} (${who}) is on. Give it other gates with update_task, or tell the CEO it waits for one of them.`;
  return { set: { status: 'review', stage, panel: [], silent: 0, assigneeAgentId: task.createdByAgentId }, wakes: giver(task, 'switched', undefined, text) };
}

type Given = { agentId: string; name: string; pass: boolean; comment: string };

/* The verdicts given at the task's gate in this round, oldest first. */
export async function gateVerdicts(db: Db | Tx, task: Task): Promise<Given[]> {
  const rows = await db
    .select({ agentId: taskEvents.agentId, name: agents.name, text: taskEvents.text, data: taskEvents.data })
    .from(taskEvents)
    .innerJoin(agents, eq(agents.id, taskEvents.agentId))
    .where(
      and(
        eq(taskEvents.taskId, task.id),
        eq(taskEvents.kind, 'verdict'),
        sql`${taskEvents.data}->>'stage' = ${String(task.stage)}`,
        sql`${taskEvents.data}->>'round' = ${String(task.bounces)}`,
      ),
    )
    .orderBy(asc(taskEvents.id));
  return rows.map(r => ({ agentId: r.agentId!, name: r.name, pass: r.data.pass === true, comment: r.text }));
}

/* Repeated returns at one gate call in whoever gave the work out. */
export async function stuckAtGate(db: Db | Tx, task: Task, stage: number, actorId?: string): Promise<Wake[]> {
  const [sent] = await db
    .select({ n: sql<number>`count(distinct coalesce(${taskEvents.data}->>'round', ${taskEvents.id}::text))` })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'verdict'), sql`${taskEvents.data}->>'pass' = 'false'`, sql`${taskEvents.data}->>'stage' = ${String(stage)}`));
  return Number(sent?.n ?? 0) >= GATE_ROUNDS ? giver(task, 'stuck_at_gate', actorId) : [];
}

/* The agent asked a person on the task and waits for the answer. */
async function asked(db: Db, task: Task, agentId: string): Promise<boolean> {
  const [mine] = await db
    .select({ id: requests.id })
    .from(requests)
    .where(and(eq(requests.taskId, task.id), eq(requests.agentId, agentId), eq(requests.status, 'open')))
    .limit(1);
  return !!mine;
}

/* A reviewer at the task's gate gives its verdict. The gate decides once its whole panel has. */
export async function verdict(ctx: Live, agentId: string, taskId: string, v: { pass: boolean; comment: string; findings?: number }): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  if (!['review', 'waiting'].includes(task.status) || task.stage < 1 || !task.panel.includes(agentId) || task.executorAgentId === agentId) throw notYours(task, 'is not at your gate');
  if (!v.comment.trim()) throw refuse(400, 'task_invalid', 'A verdict needs its reasons.');
  /* The others at the gate go on while one of them waits for a person; that one decides once the answer is in. */
  if (task.status === 'waiting' && (await asked(ctx.db, task, agentId))) throw refuse(409, 'task_invalid', `#${task.number} waits for the answer to your question first.`);
  const data = { pass: v.pass, stage: task.stage, round: task.bounces, ...(v.findings !== undefined ? { findings: v.findings } : {}) };
  const n: Note = { kind: 'verdict', actor: { agentId }, text: v.comment.trim(), data, returned: true };
  const panel = task.panel.filter(id => id !== agentId);
  if (panel.length) return { task: await move(ctx, task, { panel, assigneeAgentId: panel[0]!, silent: 0 }, n), wakes: [] };
  const [me] = await ctx.db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId));
  return closeGate(ctx, task, n, [...(await gateVerdicts(ctx.db, task)), { agentId, name: me?.name ?? '', pass: v.pass, comment: v.comment.trim() }]);
}

/* Everyone at the gate has given a verdict: it passes the task on (or finishes it) when all of them passed, else the work
   goes back to its executor with every reason in one list. n is the move that closes the gate. */
async function closeGate(ctx: Live, task: Task, n: Note, given: Given[]): Promise<Moved> {
  if (await isTurnReview(ctx.db, task.id)) return closeTurnReview(ctx, task, n, given);
  const actorId = n.actor.agentId;
  if (given.every(g => g.pass)) {
    if (task.gates[task.stage]) {
      const gate = await atGate(ctx.db, task, task.stage + 1);
      return { task: await move(ctx, task, gate.set, n, undefined, gate.wakes), wakes: gate.wakes };
    }
    const passed = await passedGates(ctx.db, task, doneFor(task, actorId));
    return { task: await move(ctx, task, passed.set, n, undefined, passed.wakes), wakes: passed.wakes };
  }
  const failed = given.filter(g => !g.pass);
  const reasons = given.length === 1 ? failed[0]!.comment : failed.map(g => `${g.name}: ${g.comment}`).join('\n\n');
  /* An executor switched off meanwhile would not take the changes up, so whoever gave the work out decides who does. */
  const [executor] = await ctx.db.select({ name: agents.name, off: agents.switchedOffAt }).from(agents).where(eq(agents.id, task.executorAgentId!));
  const away = executor?.off && task.createdByAgentId && task.createdByAgentId !== task.executorAgentId ? task.createdByAgentId : null;
  const name = executor?.name ?? 'Its executor';
  const wakes: Wake[] = away
    ? [{ agentId: away, taskId: task.id, why: 'switched', text: `${name} does it and is switched off, and gate ${task.stage} sent it back with changes to make: ${reasons}\n\nGive it to someone who is on with update_task, or tell the CEO it waits for ${name}.` }]
    : [{ agentId: task.executorAgentId!, taskId: task.id, why: 'changes', text: reasons }];
  const row = await move(ctx, task, { status: 'open', stage: 0, panel: [], assigneeAgentId: away ?? task.executorAgentId, bounces: task.bounces + 1, silent: 0 }, n, async tx => {
    wakes.push(...(await stuckAtGate(tx, task, task.stage, actorId)));
    await keepWakes(tx, task.companyId, wakes);
  });
  return { task: row, wakes };
}

/* Everyone has spoken on the review of a turn, or left it: it is over either way, without a second round, and the head
   gets every verdict in one list, what blocks first, then who did not check it. */
async function closeTurnReview(ctx: Live, task: Task, n: Note, given: Given[]): Promise<Moved> {
  const said = (gs: Given[]) => gs.map(g => `${g.name}: ${g.comment}`).join('\n\n');
  const blocking = given.filter(g => !g.pass);
  const notes = given.filter(g => g.pass);
  const made = await createdData(ctx.db, task.id);
  const spoke = new Set(given.map(g => g.agentId));
  const left = ((made.panel as string[] | undefined) ?? []).filter(id => !spoke.has(id));
  const unable = (made.unable as string[] | undefined) ?? [];
  const staff = left.length + unable.length ? await ctx.db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, [...left, ...unable])) : [];
  const name = (id: string) => staff.find(a => a.id === id)?.name ?? id;
  const missed = [...left.map(id => `${name(id)} (left without a verdict)`), ...unable.map(id => `${name(id)} (no subscription to run on)`)];
  const text = [
    ...(blocking.length ? [`Blocking:\n\n${said(blocking)}`, ...(notes.length ? [`Passed, with their notes:\n\n${said(notes)}`] : [])] : notes.length ? [said(notes)] : []),
    ...(missed.length ? [`Did not check: ${missed.join(', ')}.`] : []),
  ].join('\n\n');
  const [parent] = blocking.length && task.parentId ? await ctx.db.select({ number: tasks.number, title: tasks.title }).from(tasks).where(eq(tasks.id, task.parentId)) : [];
  const where = parent ? { note: `Put the fixes under #${parent.number} "${parent.title}": create_task with parent ${parent.number}.` } : {};
  const wakes: Wake[] = [{ agentId: task.executorAgentId!, taskId: task.id, why: blocking.length ? 'reviewed' : 'review_passed', text, ...where }];
  return { task: await move(ctx, task, { ...closing(), panel: [] }, n, undefined, wakes), wakes };
}

/* The owner of a task without an executor (a department's, the orchestrator's) closes it or says it cannot go on. */
export async function report(ctx: Live, agentId: string, taskId: string, r: { done: boolean; summary: string }): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  if (task.executorAgentId) throw refuse(400, 'task_invalid', `#${task.number} is a member task: submit it, or say it is blocked.`);
  if (task.assigneeAgentId !== agentId) throw notYours(task, 'is not yours to report');
  await refuseWaiting(ctx.db, task);
  const n: Note = { kind: 'report', actor: { agentId }, text: r.summary, data: { done: r.done }, returned: true };
  const unstuck = stuckGoes(ctx, task);
  if (r.done || task.createdByAgentId) {
    const wakes = giver(task, r.done ? 'reported' : 'blocked', agentId, r.summary);
    const row = await move(ctx, task, r.done ? closing() : { status: 'blocked' }, n, unstuck.also, wakes);
    unstuck.tell();
    return { task: row, wakes };
  }
  /* A person gave it, so a person has to unblock it. */
  let wakes: Wake[] = [];
  const row = await move(ctx, task, { status: 'waiting' }, n, async tx => {
    await letStuckGo(tx, task.id);
    const [note] = await tx.insert(requests).values({ companyId: task.companyId, taskId, agentId, kind: 'stuck', text: r.summary, decisionTopic: 'task' }).returning();
    wakes = await explaining(tx, task, agentId, note!.id);
    await keepWakes(tx, task.companyId, wakes);
  });
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  return { task: row, wakes };
}

/* The executor cannot go on without its head. */
export async function blocked(ctx: Live, agentId: string, taskId: string, why: string): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  if (task.executorAgentId !== agentId || task.stage !== 0) throw notYours(task, 'is not waiting for your work');
  await refuseWaiting(ctx.db, task);
  const wakes = giver(task, 'blocked', agentId, why);
  const row = await move(ctx, task, { status: 'blocked' }, { kind: 'blocked', actor: { agentId }, text: why, returned: true }, undefined, wakes);
  return { task: row, wakes };
}

/* Open tasks that come after any of the cancelled ones keep waiting, and whoever made each hears so: its agent, or the
   orchestrator for a person's. waiting: those whose maker cancelled, who hears it in the answer instead. */
async function afterCancelled(tx: Tx, actor: Actor, cancelled: Task[]): Promise<{ wakes: Wake[]; waiting: Task[] }> {
  const ids = cancelled.map(t => t.id);
  const left = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.companyId, cancelled[0]!.companyId), sql`${tasks.after} ?| array[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::text[]`, notInArray(tasks.status, [...CLOSED])))
    .orderBy(asc(tasks.number));
  const [orchestrator] = left.some(t => !t.createdByAgentId)
    ? await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, cancelled[0]!.companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt)))
    : [];
  const wakes: Wake[] = [];
  const waiting: Task[] = [];
  for (const t of left) {
    const maker = t.createdByAgentId ?? orchestrator?.id;
    if (!maker) continue;
    if (maker === actor.agentId) waiting.push(t);
    else wakes.push({ agentId: maker, taskId: t.id, why: 'after_cancelled', text: listed(cancelled.filter(c => t.after.includes(c.id))) });
  }
  return { wakes, waiting };
}

/* Ends the task and every open task under it; questions waiting on them are withdrawn. Whoever gave it out hears why.
   closed names every task that ended, for their turns to stop; waiting the open tasks that came after them, which the
   one who cancelled made. */
export async function cancel(ctx: Live, actor: Actor, taskId: string, why: string): Promise<Moved & { closed: string[]; waiting: Task[] }> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  const ended: Task[] = [];
  let waiting: Task[] = [];
  const wakes = giver(task, 'cancelled', actor.agentId, why.trim());
  const row = await move(ctx, task, { status: 'cancelled', closedAt: new Date(), assigneeAgentId: null }, { kind: 'cancelled', actor, text: why }, async (tx, row) => {
    let level = [taskId];
    while (level.length) {
      const below = await tx
        .update(tasks)
        .set({ status: 'cancelled', closedAt: new Date(), assigneeAgentId: null, updatedAt: new Date(), version: sql`${tasks.version} + 1` })
        .where(and(inArray(tasks.parentId, level), notInArray(tasks.status, [...CLOSED])))
        .returning();
      for (const t of below) {
        await note(tx, t, { kind: 'cancelled', actor, text: `#${task.number} was cancelled.` });
        /* Work cancelled with the task above it needs none of the turns kept for it. */
        await dropEarlierWakes(tx, t.id);
      }
      ended.push(...below);
      level = below.map(t => t.id);
    }
    await tx
      .update(requests)
      .set({ status: 'withdrawn', answeredAt: new Date() })
      .where(and(inArray(requests.taskId, [taskId, ...ended.map(t => t.id)]), eq(requests.status, 'open')));
    const after = await afterCancelled(tx, actor, [row, ...ended]);
    wakes.push(...after.wakes);
    waiting = after.waiting;
  }, wakes);
  for (const t of ended) published(ctx, t);
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  return { task: row, wakes, closed: [taskId, ...ended.map(t => t.id)], waiting };
}

/* An employee leaves: it comes off the gates of a task it has not reached yet; gates it passed stay as the task's history. */
export async function dropGate(ctx: Live, actor: Actor, task: Task, agentId: string): Promise<Task> {
  const gates = task.gates.filter((id, i) => id !== agentId || i < task.stage);
  return move(ctx, task, { gates }, { kind: 'updated', actor, data: { fields: ['gates'] } });
}

export type TaskChange = { title?: string; brief?: string; body?: string; executor?: string; gates?: string[]; after?: string[] };

/* Runs fn on the task, and again on a fresh read of it when someone moved it meanwhile; null when it kept moving. */
async function onFresh<T>(ctx: Live, task: Task, fn: (task: Task) => Promise<T>): Promise<T | null> {
  for (let tries = 0; tries < 3; tries++) {
    try {
      return await fn(task);
    } catch (err) {
      /* A task that cannot move this way, such as one with work under it still open, stays where it is. */
      if (err instanceof ApiError && err.reason === 'task_invalid') return null;
      if (!(err instanceof ApiError) || err.reason !== 'task_changed') throw err;
      task = await loadTask(ctx.db, task.id);
    }
  }
  return null;
}

type Leaver = { id: string; name: string; companyId: string };

/* An agent switched off once its running turn is over: work it does and has not handed in goes to whoever gave it out,
   and it leaves the gates it has not given its verdict at, which decide with the rest or wait with the giver. Work that
   waits for its own question to a person stays until the answer comes. handed: the tasks it no longer holds, closed: the
   ones that finished as it left. */
export async function leaveWork(ctx: Live, actor: Actor, agent: Leaver): Promise<{ wakes: Wake[]; handed: string[]; closed: Task[] }> {
  const open = await ctx.db.select().from(tasks).where(and(eq(tasks.companyId, agent.companyId), notInArray(tasks.status, [...CLOSED, 'planned']))).orderBy(asc(tasks.number));
  const n: Note = { kind: 'updated', actor, text: `${agent.name} was switched off.`, data: { fields: ['assignee'] } };
  const wakes: Wake[] = [];
  const handed: string[] = [];
  const closed: Task[] = [];
  for (const found of open) {
    const left = await onFresh(ctx, found, task => leaveTask(ctx, n, agent, task));
    if (!left) continue;
    handed.push(found.id);
    wakes.push(...left.wakes);
    if (left.closed) closed.push(left.closed);
  }
  return { wakes, handed, closed };
}

/* The agent leaves one task; null when it does not hold it. */
async function leaveTask(ctx: Live, n: Note, agent: Leaver, task: Task): Promise<{ wakes: Wake[]; closed: Task | null } | null> {
  if (CLOSED.includes(task.status) || task.status === 'planned') return null;
  if (task.status === 'waiting' && (!task.panel.includes(agent.id) || (await asked(ctx.db, task, agent.id)))) return null;
  if (task.stage === 0 && task.executorAgentId === agent.id && task.assigneeAgentId === agent.id && task.createdByAgentId && task.createdByAgentId !== agent.id) {
    const wakes = giver(task, 'switched', agent.id, `${agent.name} does it and was switched off. Give it to someone who is on with update_task, or tell the CEO it waits for ${agent.name}.`);
    await move(ctx, task, { assigneeAgentId: task.createdByAgentId, status: task.status === 'working' ? 'open' : task.status }, n, undefined, wakes);
    return { wakes, closed: null };
  }
  if (task.stage < 1 || !task.panel.includes(agent.id)) return null;
  const panel = task.panel.filter(id => id !== agent.id);
  /* Someone else at the gate asked a person, so someone is left to decide it. */
  if (task.status === 'waiting' && !panel.length) return null;
  if (panel.length) {
    await move(ctx, task, { panel, assigneeAgentId: panel[0]! }, n);
    return { wakes: [], closed: null };
  }
  const given = await gateVerdicts(ctx.db, task);
  /* The review of a turn closes as its last reviewer leaves, with whatever verdicts it has. */
  if (given.length || (await isTurnReview(ctx.db, task.id))) {
    const moved = await closeGate(ctx, task, n, given);
    return { wakes: moved.wakes, closed: CLOSED.includes(moved.task.status) ? moved.task : null };
  }
  /* Nobody left at the gate: it goes on without its role when nobody of it is on, else waits with whoever gave the work. */
  const gate = await atGate(ctx.db, task, task.stage);
  const row = await move(ctx, task, gate.set, n, undefined, gate.wakes);
  return { wakes: gate.wakes, closed: CLOSED.includes(row.status) ? row : null };
}

/* Tasks that wait at a gate with nobody able to check them go on once that changes: someone of its role was switched on,
   or the whole role was switched off, which takes the gate out of the way. closed: the ones that finished. */
export async function regateWaiting(ctx: Live, actor: Actor, agent: Leaver, text: string): Promise<{ wakes: Wake[]; closed: Task[] }> {
  const held = await ctx.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.companyId, agent.companyId), eq(tasks.status, 'review'), sql`${tasks.stage} > 0`, sql`${tasks.panel} = '[]'::jsonb`))
    .orderBy(asc(tasks.number));
  const wakes: Wake[] = [];
  const closed: Task[] = [];
  for (const found of held) {
    await onFresh(ctx, found, async task => {
      if (task.status !== 'review' || task.stage < 1 || task.panel.length) return null;
      const gate = await atGate(ctx.db, task, task.stage);
      if (!gate.set.panel?.length && gate.set.stage === task.stage && gate.set.status === 'review') return null;
      const row = await move(ctx, task, gate.set, { kind: 'updated', actor, text, data: { fields: ['assignee'] } }, undefined, gate.wakes);
      wakes.push(...gate.wakes);
      if (CLOSED.includes(row.status)) closed.push(row);
      return row;
    });
  }
  return { wakes, closed };
}

/* A task waits at a gate with nobody on to check it: the gates from there on are the given ones, and the first of them
   starts at once. None left finishes the task. */
async function regate(ctx: Live, agentId: string, task: Task, c: TaskChange): Promise<Moved> {
  const given = c.gates!;
  await checkGates(ctx.db, task.companyId, task.executorAgentId!, given);
  const gates = [...task.gates.slice(0, task.stage - 1), ...given];
  const text = rewrite(task, c);
  const n: Note = { kind: 'updated', actor: { agentId }, data: { fields: [...text.fields, 'gates'] } };
  /* No gates left passes it: merged first in a repository, else done, and whoever gave it hears so unless they did it. */
  if (!given.length) {
    const passed = await passedGates(ctx.db, task, doneFor(task, agentId));
    return { task: await move(ctx, task, { ...text.set, gates, ...passed.set }, n, undefined, passed.wakes), wakes: passed.wakes };
  }
  const gate = await atGate(ctx.db, { ...task, gates }, task.stage);
  return { task: await move(ctx, task, { ...text.set, gates, ...gate.set }, n, undefined, gate.wakes), wakes: gate.wakes };
}

/* The title, brief and body a change rewrites. */
function rewrite(task: Task, c: TaskChange): { set: Partial<Task>; fields: string[] } {
  const set: Partial<Task> = {};
  const fields: string[] = [];
  for (const key of ['title', 'brief', 'body'] as const) {
    if (c[key] !== undefined && c[key] !== task[key]) {
      set[key] = c[key];
      fields.push(key);
    }
  }
  return { set, fields };
}

/* The owner rewrites the task so it reads as the current truth, or hands it to another executor or other gates. */
export async function updateTask(ctx: Live, agentId: string, taskId: string, c: TaskChange): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  if ((c.executor !== undefined || c.gates !== undefined) && !task.executorAgentId) throw refuse(400, 'task_invalid', `#${task.number} has no executor or gates.`);
  if (c.gates !== undefined && c.executor === undefined && task.status === 'review' && task.stage > 0 && !task.panel.length) return regate(ctx, agentId, task, c);
  if ((c.executor !== undefined || c.gates !== undefined) && task.stage !== 0) throw refuse(409, 'task_invalid', `#${task.number} is at a gate; change who works on it after the verdict.`);
  /* The merge hands in what its gates passed: gates given now would never check it. */
  if (c.gates !== undefined && task.merging) throw refuse(409, 'task_invalid', `#${task.number} passed its gates and is being merged, so its gates no longer change. Give more checks as a task of their own.`);
  if (c.after !== undefined && task.stage !== 0) throw refuse(409, 'task_invalid', `#${task.number} is at a gate already, so it waits for nothing any more.`);
  const executor = c.executor ?? task.executorAgentId;
  const gates = c.gates ?? task.gates;
  if (executor && c.executor !== undefined) await workingAgent(ctx.db, task.companyId, executor);
  if (executor && (c.executor !== undefined || c.gates !== undefined)) await checkGates(ctx.db, task.companyId, executor, gates);
  const { set, fields } = rewrite(task, c);
  /* Handing it to its executor again gives it back after it waited with the head. */
  if (executor !== task.executorAgentId || (c.executor !== undefined && task.assigneeAgentId !== executor)) {
    set.executorAgentId = executor;
    set.assigneeAgentId = executor;
    fields.push('executor');
  }
  if (c.gates !== undefined && JSON.stringify(gates) !== JSON.stringify(task.gates)) {
    set.gates = gates;
    fields.push('gates');
  }
  const waited = (await openAfter(ctx.db, task)).length > 0;
  if (c.after !== undefined && JSON.stringify(c.after) !== JSON.stringify(task.after)) {
    await checkAfter(ctx.db, task.companyId, task.turnId, c.after);
    await refuseAbove(ctx.db, task.parentId, c.after);
    await refuseBelow(ctx.db, task, c.after);
    set.after = c.after;
    fields.push('after');
  }
  if (!fields.length) return { task, wakes: [] };
  /* A rewrite answers a blocked executor. A task nobody holds stays blocked until someone can take it. */
  if (task.status === 'blocked' && (set.assigneeAgentId ?? task.assigneeAgentId)) set.status = 'open';
  /* Another one takes it up, so Hornhoof's note that it stood still is over; a person's word asked for still waits. */
  const handedOn = !!set.assigneeAgentId && set.assigneeAgentId !== task.assigneeAgentId;
  if (handedOn) {
    set.silent = 0;
    if (task.status === 'waiting' && !(await waitsForPerson(ctx.db, task.id))) set.status = 'open';
  }
  const unstuck = stuckGoes(ctx, task);
  const before = task.assigneeAgentId;
  const handOver = async (tx: Tx) => {
    await unstuck.also(tx);
    /* The one who held it would only start on work it no longer holds. */
    if (before) await tx.update(jobs).set({ status: 'failed', error: 'handed_on', finishedAt: new Date() }).where(and(eq(jobs.agentId, before), eq(jobs.taskId, task.id), eq(jobs.status, 'queued')));
  };
  const holder = set.assigneeAgentId ?? task.assigneeAgentId;
  /* A turn its holder has waiting on it would set to work on it anyway; the holder is woken again once it can start. */
  const holdBack = async (tx: Tx) => {
    if (holder) await tx.update(jobs).set({ status: 'failed', error: 'waiting', finishedAt: new Date() }).where(and(eq(jobs.agentId, holder), eq(jobs.taskId, task.id), eq(jobs.status, 'queued')));
  };
  const wakes: Wake[] = [];
  const also = async (tx: Tx) => {
    if (handedOn) await handOver(tx);
    /* It waits now for what it comes after, so nobody sets to work on it yet; one that waited and waits no more starts.
       Seen inside the move, where what it comes after is held. */
    if ((await openAfter(tx, { after: set.after ?? task.after })).length) return holdBack(tx);
    if (set.assigneeAgentId || (waited && holder)) wakes.push({ agentId: (set.assigneeAgentId ?? holder)!, taskId, why: 'assigned' });
    else if (holder && holder !== agentId) wakes.push({ agentId: holder, taskId, why: 'updated' });
  };
  const row = await move(ctx, task, set, { kind: 'updated', actor: { agentId }, data: { fields } }, also, wakes);
  unstuck.tell();
  return { task: row, wakes };
}

/* A comment goes into the log. A person's comment reaches whoever holds the task; an agent's wakes nobody, but for one
   that answers a blocked member task it gave out: the task opens again and its executor goes on with the answer. */
export async function comment(ctx: Live, actor: Actor, taskId: string, text: string): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  if (!text.trim()) throw refuse(400, 'task_invalid', 'A comment needs text.');
  if (actor.agentId && task.status === 'blocked' && task.executorAgentId && task.assigneeAgentId === task.executorAgentId && (await gaveOut(ctx.db, task, actor.agentId))) {
    const wakes: Wake[] = [{ agentId: task.executorAgentId, taskId, why: 'unblocked', text: text.trim() }];
    const row = await move(ctx, task, { status: 'open', silent: 0 }, { kind: 'comment', actor, text: text.trim() }, undefined, wakes);
    return { task: row, wakes };
  }
  const wake = actor.personId && task.assigneeAgentId && !CLOSED.includes(task.status);
  const wakes: Wake[] = wake ? [{ agentId: task.assigneeAgentId!, taskId, why: 'comment', text: text.trim() }] : [];
  await ctx.db.transaction(async tx => {
    await note(tx, task, { kind: 'comment', actor, text: text.trim() });
    await keepWakes(tx, task.companyId, wakes);
  });
  published(ctx, task);
  return { task, wakes };
}

/* Whoever gave the task out: the agent that made it, or the orchestrator, who runs every task. */
async function gaveOut(db: Db, task: Task, agentId: string): Promise<boolean> {
  if (task.createdByAgentId === agentId) return true;
  const [agent] = await db.select({ kind: agents.kind }).from(agents).where(eq(agents.id, agentId));
  return agent?.kind === 'orchestrator';
}

/* What an agent asks: words, an approval of an exact commit, or a pick of one of 2 to 4 ways. images: pictures it sent
   with hh-attach, link: where to see the work, topic: what it is about, which says whose decision it is. */
export type Ask = { kind: 'question' | 'approval' | 'choice'; text: string; commit?: string; images?: string[]; options?: RequestOption[]; link?: string | null; topic?: DecisionTopic };

/* An approval lets a commit into the release, whatever the agent says it is about. */
const topicOf = (q: Ask): DecisionTopic | null => (q.kind === 'approval' ? 'release' : (q.topic ?? null));

/* The agent that holds the task, or any reviewer at its gate, asks a person and the task waits for the answer. */
export async function ask(ctx: Live, agentId: string, taskId: string, q: Ask): Promise<Moved & { request: Request }> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  if (task.assigneeAgentId !== agentId && !(task.stage > 0 && task.panel.includes(agentId))) throw notYours(task, 'is not with you');
  if (!q.text.trim()) throw refuse(400, 'task_invalid', 'Say what you need.');
  if (q.kind === 'approval' && !COMMIT.test(q.commit ?? '')) throw refuse(400, 'task_invalid', 'An approval names the full 40-character commit.');
  if (q.kind !== 'approval' && q.commit) throw refuse(400, 'task_invalid', 'Only an approval names a commit; ask for an approval instead.');
  const options = q.kind === 'choice' ? (q.options ?? []) : [];
  if (q.kind === 'choice' && (options.length < 2 || options.length > 4)) throw refuse(400, 'task_invalid', 'A choice offers 2 to 4 ways.');
  if (q.kind !== 'choice' && q.options?.length) throw refuse(400, 'task_invalid', 'Ways to pick from make a choice; a choice names no commit.');
  const pictures = [...(q.images ?? []), ...options.flatMap(o => (o.image ? [o.image] : []))];
  await checkPictures(ctx.db, task.companyId, agentId, pictures);
  let request: Request | undefined;
  let wakes: Wake[] = [];
  const row = await move(ctx, task, { status: 'waiting', silent: 0 }, { kind: 'asked', actor: { agentId }, text: q.text.trim(), data: { kind: q.kind, commit: q.commit ?? null } }, async tx => {
    [request] = await tx
      .insert(requests)
      .values({ companyId: task.companyId, taskId, agentId, kind: q.kind, text: q.text.trim(), commit: q.commit ?? null, options, link: q.link ?? null, decisionTopic: topicOf(q) })
      .returning();
    wakes = await explaining(tx, task, agentId, request!.id);
    await keepWakes(tx, task.companyId, wakes);
    if (!pictures.length) return;
    const shown = await tx
      .update(attachments)
      .set({ requestId: request!.id })
      .where(and(inArray(attachments.id, pictures), eq(attachments.agentId, agentId), isNull(attachments.requestId)))
      .returning({ id: attachments.id });
    if (shown.length !== pictures.length) throw refuse(409, 'task_changed', 'A picture was shown meanwhile. Send it again with hh-attach.');
  });
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  return { task: row, request: request!, wakes };
}

/* What an employee asks people reaches the orchestrator first, to put into plain words for them; not what it asks itself. */
async function explaining(db: Db | Tx, task: Task, agentId: string, requestId: string): Promise<Wake[]> {
  const [orchestrator] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, task.companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt)));
  return orchestrator && orchestrator.id !== agentId ? [{ agentId: orchestrator.id, taskId: task.id, why: 'explain', text: requestId }] : [];
}

/* The agent holding the task ended a turn without moving it: a reminder, and from SILENT_TURNS on a person is asked. */
export async function silentTurn(ctx: Live, agentId: string, task: Task): Promise<Moved> {
  const silent = task.silent + 1;
  if (silent < SILENT_TURNS) {
    const wakes: Wake[] = [{ agentId, taskId: task.id, why: 'reminder' }];
    const row = await move(ctx, task, { silent }, { kind: 'reminded', actor: { agentId }, data: { silent } }, undefined, wakes);
    return { task: row, wakes };
  }
  return askAboutStill(ctx, agentId, task, silent, `Ended ${silent} turns in a row on #${task.number} without moving it. Tell it how to go on, or cancel the task.`);
}

/* Hornhoof gives member work its executor has not handed in to another executor, as when the executor's plan is at its
   limit: one note in the task says why, and the turns that waited for the one who did it are over. */
export async function handOver(ctx: Live, task: Task, to: string, text: string): Promise<Moved> {
  const from = task.executorAgentId!;
  const wakes: Wake[] = [{ agentId: to, taskId: task.id, why: 'assigned' }];
  const row = await move(
    ctx,
    task,
    { executorAgentId: to, assigneeAgentId: to, status: 'open', silent: 0 },
    { kind: 'assigned', actor: { agentId: from }, text, data: { assignee: to } },
    async tx => {
      await tx.update(jobs).set({ status: 'failed', error: 'handed_on', finishedAt: new Date() }).where(and(eq(jobs.agentId, from), eq(jobs.taskId, task.id), eq(jobs.status, 'queued')));
    },
    wakes,
  );
  return { task: row, wakes };
}

/* The agent's turns on the task keep breaking as soon as they start: Hornhoof stops waking it there, and whoever gave the
   task out hears why, or a person when nobody did or a gate's reviewer broke. */
export async function brokeDown(ctx: Live, agentId: string, task: Task, text: string): Promise<Moved> {
  if (task.stage === 0 && task.createdByAgentId && task.createdByAgentId !== agentId) {
    const wakes = giver(task, 'blocked', agentId, text);
    return { task: await move(ctx, task, { status: 'blocked', silent: 0 }, { kind: 'blocked', actor: { agentId }, text }, undefined, wakes), wakes };
  }
  return askAboutStill(ctx, agentId, task, task.silent, text);
}

/* Hornhoof stops waking the agent on the task and asks a person how it should go on. */
async function askAboutStill(ctx: Live, agentId: string, task: Task, silent: number, text: string): Promise<Moved> {
  let wakes: Wake[] = [];
  const row = await move(ctx, task, { silent, status: 'waiting' }, { kind: 'stuck', actor: { agentId }, text }, async tx => {
    const [note] = await tx.insert(requests).values({ companyId: task.companyId, taskId: task.id, agentId, kind: 'stuck', text, decisionTopic: 'task' }).returning();
    wakes = await explaining(tx, task, agentId, note!.id);
    await keepWakes(tx, task.companyId, wakes);
  });
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  return { task: row, wakes };
}

/* Events that do not move a task: what an agent says in it and Hornhoof's own notes about its turns. */
export const NOT_A_MOVE = ['comment', 'reminded', 'continued', 'stuck', 'interrupted'] as const;

/* Comments and notes about a turn ending do not begin a new piece of work. */
export async function lastMove(db: Db | Tx, taskId: string) {
  const [last] = await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, taskId), notInArray(taskEvents.kind, [...NOT_A_MOVE]))).orderBy(desc(taskEvents.createdAt), desc(taskEvents.id)).limit(1);
  return last;
}

/* The agent holding the task worked through a turn without handing anything in, but said in the task how far it got or
   worked until its time ran out: it goes on in another turn, from GOING_ON_TURNS such turns in a row a person is asked. */
export async function wentOn(ctx: Live, agentId: string, task: Task): Promise<Moved> {
  const last = await lastMove(ctx.db, task.id);
  const [before] = await ctx.db
    .select({ n: count() })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.agentId, agentId), eq(taskEvents.kind, 'continued'), last ? gt(taskEvents.createdAt, last.createdAt) : undefined));
  const turns = Number(before?.n ?? 0) + 1;
  if (turns >= GOING_ON_TURNS) return askAboutStill(ctx, agentId, task, 0, `Went on for ${turns} turns in a row on #${task.number} without handing anything in. Tell it how to go on, or cancel the task.`);
  const wakes: Wake[] = [{ agentId, taskId: task.id, why: 'go_on' }];
  const row = await move(ctx, task, { silent: 0 }, { kind: 'continued', actor: { agentId }, data: { turns } }, undefined, wakes);
  return { task: row, wakes };
}

/* pick: the way a person took, from 0, in a choice. */
export type Answer = { answer?: string; approve?: boolean; retry?: boolean; pick?: number };

/* Pictures are the agent's own, from hh-attach, each shown once. A file put on a task is no picture, whatever it holds. */
async function checkPictures(db: Db, companyId: string, agentId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  if (new Set(ids).size !== ids.length) throw refuse(400, 'task_invalid', 'A picture is listed twice.');
  const rows = await db
    .select({ id: attachments.id, companyId: attachments.companyId, agentId: attachments.agentId, requestId: attachments.requestId, taskId: attachments.taskId })
    .from(attachments)
    .where(inArray(attachments.id, ids));
  for (const id of ids) {
    const found = rows.find(r => r.id === id);
    if (!found || found.companyId !== companyId || found.agentId !== agentId) throw refuse(400, 'task_invalid', `${id} is not a picture you sent. Send it with hh-attach and use the id it prints.`);
    if (found.taskId) throw refuse(400, 'task_invalid', `${id} is a file on a task, not a picture. Send the picture with hh-attach FILE, without --task.`);
    if (found.requestId) throw refuse(400, 'task_invalid', `${id} is shown in another request already. Send it again with hh-attach.`);
  }
}

/* A person answers: the request closes, the task goes on where it stood, and the agent that asked wakes with the answer. */
export async function answer(ctx: Live, actor: Actor, requestId: string, a: Answer): Promise<{ request: Request; task: Task; wakes: Wake[] }> {
  const [found] = await ctx.db.select().from(requests).where(eq(requests.id, requestId));
  if (!found) throw refuse(404, 'request_unknown', 'There is no such request.');
  if (found.status !== 'open') throw refuse(409, 'request_closed', 'This request is answered already.');
  const text = a.answer?.trim() ?? '';
  let status: Request['status'];
  const option = found.kind === 'choice' && a.pick !== undefined ? found.options[a.pick] : undefined;
  if (found.kind !== 'choice' && a.pick !== undefined) throw refuse(400, 'task_invalid', 'Only a choice is answered with a pick.');
  if (found.kind === 'approval') {
    if (a.approve === undefined) throw refuse(400, 'task_invalid', 'Approve or decline this commit.');
    status = a.approve ? 'approved' : 'declined';
  } else if (found.kind === 'choice') {
    if (!option) throw refuse(400, 'task_invalid', `Pick one of the ${found.options.length} ways.`);
    status = 'answered';
  } else {
    if (a.approve !== undefined) throw refuse(400, 'task_invalid', 'Only a commit is approved; answer in words.');
    if (!text && !(found.kind === 'stuck' && a.retry)) throw refuse(400, 'task_invalid', 'Write an answer.');
    status = 'answered';
  }
  const said =
    found.kind === 'approval'
      ? `${a.approve ? 'Approved' : 'Declined'} ${found.commit}.${text ? ` ${text}` : ''}`
      : option
        ? `Picked ${a.pick! + 1}: ${option.label}.${text ? ` ${text}` : ''}`
        : text || 'Try again.';
  const task = await loadTask(ctx.db, found.taskId);
  let wakes: Wake[] = [];
  const row = await ctx.db.transaction(async tx => {
    /* The task first and then its request, in the order a cancel takes them, so the two never wait on each other. As the task
       is now, not as it was read before: one closed meanwhile stays closed. */
    const [current] = await tx.select({ status: tasks.status, stage: tasks.stage }).from(tasks).where(eq(tasks.id, task.id)).for('update');
    const [request] = await tx
      .update(requests)
      .set({ status, answer: text || null, picked: option ? a.pick! : null, answeredBy: actor.personId ?? null, answeredAt: new Date() })
      .where(and(eq(requests.id, requestId), eq(requests.status, 'open')))
      .returning();
    if (!request) throw refuse(409, 'request_closed', 'This request is answered already.');
    await note(tx, task, { kind: 'answered', actor, text: said, data: { requestId, kind: found.kind, status } });
    const [left] = await tx.select({ n: count() }).from(requests).where(and(eq(requests.taskId, task.id), eq(requests.status, 'open')));
    if (current?.status === 'waiting' && !Number(left?.n ?? 0)) {
      await tx
        .update(tasks)
        .set({ status: current.stage > 0 ? 'review' : 'working', silent: 0, version: sql`${tasks.version} + 1`, updatedAt: new Date() })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, 'waiting')));
    }
    const [after] = await tx.select().from(tasks).where(eq(tasks.id, task.id));
    /* A task that stood still goes on with whoever holds it now. */
    const goesOn = found.kind === 'stuck' && after!.stage === 0 && after!.assigneeAgentId ? after!.assigneeAgentId : found.agentId;
    wakes = CLOSED.includes(after!.status) ? [] : [{ agentId: goesOn, taskId: task.id, why: 'answered', text: said }];
    /* The last answer at a gate: everyone else still to give a verdict there goes on too, also after a turn spent waiting. */
    if (current?.status === 'waiting' && after!.status === 'review') {
      const back = await reviewWake(tx, after!);
      wakes.push(...after!.panel.filter(id => id !== found.agentId).map(agentId => ({ agentId, taskId: task.id, ...back })));
    }
    await keepWakes(tx, task.companyId, wakes);
    return request;
  });
  const now = await loadTask(ctx.db, task.id);
  published(ctx, now);
  await handOff(ctx, actor, now);
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  return { request: row, task: now, wakes };
}

/* As long as an answer given in the task may be. */
const ANSWER_MAX = 4000;

/* A person spoke to the agent directly, in its window or its terminal: what they said answers the questions it asked people
   and tells it how to go on where it was stuck, on the tasks that person reaches. A commit to approve and a choice wait for
   their own answer. The task's own turn still follows, which watches that the task moves. */
export async function answerDirectly(ctx: Live, personId: string, agentId: string, text: string): Promise<Wake[]> {
  const said = text.trim().slice(0, ANSWER_MAX);
  if (!said) return [];
  const [person] = await ctx.db.select({ id: people.id, scopeKind: people.scopeKind }).from(people).where(eq(people.id, personId));
  if (!person) return [];
  const access = await accessOf(ctx.db, person);
  const open = await ctx.db
    .select({ id: requests.id, departmentId: tasks.departmentId, productId: tasks.productId })
    .from(requests)
    .innerJoin(tasks, eq(tasks.id, requests.taskId))
    .where(and(eq(requests.agentId, agentId), eq(requests.status, 'open'), inArray(requests.kind, ['question', 'stuck'])))
    .orderBy(asc(requests.createdAt));
  const wakes: Wake[] = [];
  for (const r of open) {
    if (!canReach(access, taskSpot(r))) continue;
    try {
      wakes.push(...(await answer(ctx, { personId }, r.id, { answer: said })).wakes);
    } catch (err) {
      /* Someone answered it in the task meanwhile. */
      if (!(err instanceof ApiError && err.reason === 'request_closed')) throw err;
    }
  }
  return wakes;
}

/* A turn on a task went out: an open task is being worked on now. */
export async function startWork(ctx: Live, jobId: string): Promise<void> {
  const [job] = await ctx.db.select({ taskId: jobs.taskId, agentId: jobs.agentId }).from(jobs).where(eq(jobs.id, jobId));
  if (!job?.taskId || !job.agentId) return;
  /* One that still waits for what it comes after is not at work, whatever turn went out on it. */
  const [task] = await ctx.db.select({ after: tasks.after }).from(tasks).where(eq(tasks.id, job.taskId));
  if (!task || (await openAfter(ctx.db, task)).length) return;
  const [row] = await ctx.db
    .update(tasks)
    .set({ status: 'working', version: sql`${tasks.version} + 1`, updatedAt: new Date() })
    .where(and(eq(tasks.id, job.taskId), eq(tasks.status, 'open'), eq(tasks.assigneeAgentId, job.agentId)))
    .returning();
  if (row) published(ctx, row);
}
