import { and, asc, count, eq, gt, inArray, isNull, max, ne, notInArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { accessOf, canReach, type Spot } from '../../auth/access.js';
import type { Db } from '../../db/client.js';
import { agents, attachments, companies, jobs, people, requests, subscriptions, taskEvents, tasks, turns, type RequestOption, type TaskEventKind } from '../../db/schema.js';
import { ApiError, type ErrorReason } from '../../errors.js';
import { dropEarlierWakes, keepWakes } from './outbox.js';
import { handOff } from './pulses.js';

export type Task = typeof tasks.$inferSelect;
export type Request = typeof requests.$inferSelect;
/* Who moves a task: a person from the web app, or an agent from its tools. */
export type Actor = { personId: string; agentId?: undefined } | { agentId: string; personId?: undefined };
export type WakeWhy = 'assigned' | 'review' | 'changes' | 'stuck_at_gate' | 'done' | 'reported' | 'blocked' | 'cancelled' | 'answered' | 'comment' | 'updated' | 'reminder' | 'go_on' | 'turn' | 'switched' | 'explain' | 'subtasks' | 'after_cancelled';
/* An agent that has to act on a task now; Hornhoof queues a turn for it. note: what else it should know, after the rest. */
export type Wake = { agentId: string; taskId: string; why: WakeWhy; text?: string; note?: string };
export type Moved = { task: Task; wakes: Wake[] };

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Live = Pick<Ctx, 'db' | 'bus'>;

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

/* The last work under a task closed: whoever holds the task hears it can go on, unless it gave that work out and hears
   so already, or closed it itself. */
async function workUnderDone(tx: Tx, closed: Task, actorId?: string): Promise<Wake[]> {
  const [parent] = await tx.select().from(tasks).where(eq(tasks.id, closed.parentId!));
  const holder = parent?.assigneeAgentId;
  if (!parent || CLOSED.includes(parent.status) || !holder || holder === closed.createdByAgentId || holder === actorId) return [];
  const [open] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.parentId, parent.id), notInArray(tasks.status, [...CLOSED]))).limit(1);
  return open ? [] : [{ agentId: holder, taskId: parent.id, why: 'subtasks' }];
}

/* Task numbers as a reader says them: "#2", "#2 and #3", "#2, #3 and #4". */
export function listed(rows: Pick<Task, 'number'>[]): string {
  const names = rows.map(t => `#${t.number}`);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
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

/* What a task comes after: tasks of the company in its own turn, each once and none cancelled. */
async function checkAfter(db: Db | Tx, companyId: string, turnId: string | null, ids: string[]): Promise<Task[]> {
  if (new Set(ids).size !== ids.length) throw refuse(400, 'task_invalid', 'A task it comes after is listed twice.');
  const rows = ids.length ? await db.select().from(tasks).where(inArray(tasks.id, ids)) : [];
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

/* A task is done: each task that came after it and waits for nothing else any more goes on with whoever holds it, and
   its log says why. rows: the tasks that started. */
async function startAfter(tx: Tx, done: Task): Promise<{ wakes: Wake[]; rows: Task[] }> {
  const waiting = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.companyId, done.companyId), sql`${tasks.after} @> ${JSON.stringify([done.id])}::jsonb`, notInArray(tasks.status, [...CLOSED])))
    .orderBy(asc(tasks.number));
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

type Note = { kind: TaskEventKind; actor: Actor; text?: string; data?: Record<string, unknown> };

export async function note(tx: Tx | Db, task: Pick<Task, 'id' | 'companyId'>, n: Note): Promise<void> {
  await tx.insert(taskEvents).values({ companyId: task.companyId, taskId: task.id, kind: n.kind, ...actorColumns(n.actor), text: n.text ?? '', data: n.data ?? {} });
}

/* One move: the task changes only if nobody moved it since it was read, and the move is written to its log. */
/* wakes: the turns the move needs, kept with it until they are queued. */
async function move(ctx: Live, task: Task, set: Partial<Task>, n: Note, also?: (tx: Tx, row: Task) => Promise<void>, wakes: Wake[] = []): Promise<Task> {
  let started: Task[] = [];
  const row = await ctx.db.transaction(async tx => {
    const [row] = await tx
      .update(tasks)
      .set({ ...set, version: task.version + 1, updatedAt: new Date() })
      .where(and(eq(tasks.id, task.id), eq(tasks.version, task.version)))
      .returning();
    if (!row) throw refuse(409, 'task_changed', `#${task.number} changed meanwhile. Read it again.`);
    /* Done means all of it: work under it still open would go on under a finished task, and the turn with it. */
    if (set.status === 'done') await refuseOpenUnder(tx, task);
    await dropEarlierWakes(tx, task.id);
    await note(tx, row, n);
    await also?.(tx, row);
    if (CLOSED.includes(row.status) && row.parentId) wakes.push(...(await workUnderDone(tx, row, n.actor.agentId)));
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
  for (const t of started) published(ctx, t);
  await handOff(ctx, n.actor, row);
  return row;
}

export function published(ctx: Pick<Ctx, 'bus'>, task: Task): void {
  ctx.bus.publish(task.companyId, { type: 'task', id: task.id, spot: taskSpot(task) });
}

/* Whoever gave the task, when that was an agent other than the one acting. */
const giver = (task: Task, why: WakeWhy, actorId?: string, text?: string): Wake[] =>
  task.createdByAgentId && task.createdByAgentId !== actorId ? [{ agentId: task.createdByAgentId, taskId: task.id, why, ...(text ? { text } : {}) }] : [];

const closing = () => ({ status: 'done' as const, closedAt: new Date(), assigneeAgentId: null, silent: 0 });

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
    }
    const [last] = await tx.select({ n: max(tasks.number) }).from(tasks).where(eq(tasks.companyId, assignee.companyId));
    const [turn] = parent ? [] : await tx.select({ id: turns.id }).from(turns).where(and(eq(turns.companyId, assignee.companyId), eq(turns.status, 'open')));
    const turnId = parent ? parent.turnId : (turn?.id ?? null);
    const after = await checkAfter(tx, assignee.companyId, turnId, input.after ?? []);
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
    await note(tx, row!, { kind: 'created', actor, text: row!.brief, data: { assignee: assignee.id, gates, after: row!.after } });
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
  const n: Note = { kind: 'submitted', actor: { agentId }, text: r.summary, data: { evidence: r.evidence } };
  const unstuck = stuckGoes(ctx, task);
  if (task.gates.length) {
    const gate = await atGate(ctx.db, task, 1);
    const row = await move(ctx, task, gate.set, n, unstuck.also, gate.wakes);
    unstuck.tell();
    return { task: row, wakes: gate.wakes };
  }
  const wakes = giver(task, 'done', agentId);
  const row = await move(ctx, task, closing(), n, unstuck.also, wakes);
  unstuck.tell();
  return { task: row, wakes };
}

/* Everyone who checks the work at a gate: each live employee of the named reviewer's role in its department, for the
   task's product or for none, that is on, the named one first, never the executor. A reviewer without a role checks
   alone. idle: the names of those among them without a subscription to run on. */
async function panelFor(db: Db | Tx, task: Task, stage: number): Promise<{ panel: string[]; idle: string[] }> {
  const named = task.gates[stage - 1];
  if (!named) return { panel: [], idle: [] };
  const [lead] = await db.select().from(agents).where(eq(agents.id, named));
  if (!lead || lead.removedAt) return { panel: [], idle: [] };
  const same = lead.roleKey && lead.departmentId ? and(eq(agents.departmentId, lead.departmentId), eq(agents.roleKey, lead.roleKey)) : eq(agents.id, lead.id);
  const rows = await db
    .select({ id: agents.id, name: agents.name, productId: agents.productId, sub: subscriptions.id })
    .from(agents)
    .leftJoin(subscriptions, and(eq(subscriptions.id, agents.subscriptionId), isNull(subscriptions.removedAt)))
    .where(and(same, isNull(agents.removedAt), isNull(agents.switchedOffAt)))
    .orderBy(asc(agents.createdAt));
  const product = task.productId ?? lead.productId;
  const fit = rows.filter(a => a.id !== task.executorAgentId && (!a.productId || a.productId === product));
  const ids = fit.filter(a => a.sub).map(a => a.id);
  return { panel: [...ids.filter(id => id === named), ...ids.filter(id => id !== named)], idle: fit.filter(a => !a.sub).map(a => a.name) };
}

/* Whether anyone of the role behind a gate is switched on. A reviewer without a role stands for itself. */
async function roleOn(db: Db | Tx, named: string): Promise<boolean> {
  const [lead] = await db.select().from(agents).where(eq(agents.id, named));
  if (!lead) return false;
  const same = lead.roleKey && lead.departmentId ? and(eq(agents.departmentId, lead.departmentId), eq(agents.roleKey, lead.roleKey)) : eq(agents.id, lead.id);
  const [on] = await db.select({ id: agents.id }).from(agents).where(and(same, isNull(agents.removedAt), isNull(agents.switchedOffAt))).limit(1);
  return Boolean(on);
}

/* The task reaches a gate: its whole panel checks it at once. A gate whose role has nobody switched on takes no part,
   so the task goes on to the next one, and past the last it is done. While anyone of the role who is on cannot check it,
   it waits with whoever gave it out, as the gate passes only when all of them pass. */
async function atGate(db: Db | Tx, task: Task, from: number): Promise<{ set: Partial<Task>; wakes: Wake[] }> {
  let stage = from;
  while (task.gates[stage - 1] && !(await roleOn(db, task.gates[stage - 1]!))) stage++;
  if (!task.gates[stage - 1]) return { set: { ...closing(), stage: task.gates.length, panel: [] }, wakes: giver(task, 'done') };
  const { panel, idle } = await panelFor(db, task, stage);
  if (panel.length && !idle.length) return { set: { status: 'review', stage, panel, silent: 0, assigneeAgentId: panel[0]! }, wakes: panel.map(agentId => ({ agentId, taskId: task.id, why: 'review' as const })) };
  const [lead] = await db.select({ name: agents.name, roleKey: agents.roleKey }).from(agents).where(eq(agents.id, task.gates[stage - 1]!));
  const who = lead?.roleKey ?? lead?.name ?? 'its reviewer';
  const text = idle.length
    ? `${idle.join(', ')} ${idle.length === 1 ? 'has' : 'have'} no subscription to run on, so gate ${stage} (${who}) cannot check it. Give them one on their card and then give the task its gates again with update_task, switch them off, or give it other gates.`
    : `Nobody who can check it at gate ${stage} (${who}) is on. Give it other gates with update_task, or tell the CEO it waits for one of them.`;
  return { set: { status: 'review', stage, panel: [], silent: 0, assigneeAgentId: task.createdByAgentId }, wakes: giver(task, 'switched', undefined, text) };
}

type Given = { agentId: string; name: string; pass: boolean; comment: string };

/* The verdicts given at the task's gate in this round, oldest first. */
async function gateVerdicts(db: Db, task: Task): Promise<Given[]> {
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
export async function verdict(ctx: Live, agentId: string, taskId: string, v: { pass: boolean; comment: string }): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  if (!['review', 'waiting'].includes(task.status) || task.stage < 1 || !task.panel.includes(agentId) || task.executorAgentId === agentId) throw notYours(task, 'is not at your gate');
  if (!v.comment.trim()) throw refuse(400, 'task_invalid', 'A verdict needs its reasons.');
  /* The others at the gate go on while one of them waits for a person; that one decides once the answer is in. */
  if (task.status === 'waiting' && (await asked(ctx.db, task, agentId))) throw refuse(409, 'task_invalid', `#${task.number} waits for the answer to your question first.`);
  const n: Note = { kind: 'verdict', actor: { agentId }, text: v.comment.trim(), data: { pass: v.pass, stage: task.stage, round: task.bounces } };
  const panel = task.panel.filter(id => id !== agentId);
  if (panel.length) return { task: await move(ctx, task, { panel, assigneeAgentId: panel[0]!, silent: 0 }, n), wakes: [] };
  const [me] = await ctx.db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId));
  return closeGate(ctx, task, n, [...(await gateVerdicts(ctx.db, task)), { agentId, name: me?.name ?? '', pass: v.pass, comment: v.comment.trim() }]);
}

/* Everyone at the gate has given a verdict: it passes the task on (or finishes it) when all of them passed, else the work
   goes back to its executor with every reason in one list. n is the move that closes the gate. */
async function closeGate(ctx: Live, task: Task, n: Note, given: Given[]): Promise<Moved> {
  const actorId = n.actor.agentId;
  if (given.every(g => g.pass)) {
    if (task.gates[task.stage]) {
      const gate = await atGate(ctx.db, task, task.stage + 1);
      return { task: await move(ctx, task, gate.set, n, undefined, gate.wakes), wakes: gate.wakes };
    }
    const wakes = giver(task, 'done', actorId);
    return { task: await move(ctx, task, { ...closing(), panel: [] }, n, undefined, wakes), wakes };
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
    const [sent] = await tx
      .select({ n: sql<number>`count(distinct coalesce(${taskEvents.data}->>'round', ${taskEvents.id}::text))` })
      .from(taskEvents)
      .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'verdict'), sql`${taskEvents.data}->>'pass' = 'false'`, sql`${taskEvents.data}->>'stage' = ${String(task.stage)}`));
    if (Number(sent?.n ?? 0) >= GATE_ROUNDS) wakes.push(...giver(task, 'stuck_at_gate', actorId));
    await keepWakes(tx, task.companyId, wakes);
  });
  return { task: row, wakes };
}

/* The owner of a task without an executor (a department's, the orchestrator's) closes it or says it cannot go on. */
export async function report(ctx: Live, agentId: string, taskId: string, r: { done: boolean; summary: string }): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  if (task.executorAgentId) throw refuse(400, 'task_invalid', `#${task.number} is a member task: submit it, or say it is blocked.`);
  if (task.assigneeAgentId !== agentId) throw notYours(task, 'is not yours to report');
  await refuseWaiting(ctx.db, task);
  const n: Note = { kind: 'report', actor: { agentId }, text: r.summary, data: { done: r.done } };
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
    const [note] = await tx.insert(requests).values({ companyId: task.companyId, taskId, agentId, kind: 'stuck', text: r.summary }).returning();
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
  const row = await move(ctx, task, { status: 'blocked' }, { kind: 'blocked', actor: { agentId }, text: why }, undefined, wakes);
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
  if (given.length) {
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
  /* No gates left finishes it: whoever gave it hears so, unless they did it. */
  if (!given.length) {
    const wakes = giver(task, 'done', agentId);
    return { task: await move(ctx, task, { ...text.set, gates, ...closing(), panel: [] }, n, undefined, wakes), wakes };
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
    await refuseCircle(ctx.db, task, c.after);
    set.after = c.after;
    fields.push('after');
  }
  if (!fields.length) return { task, wakes: [] };
  /* It waits now for what it comes after, so nobody sets to work on it yet; one that waited and waits no more starts. */
  const waits = (await openAfter(ctx.db, { after: set.after ?? task.after })).length > 0;
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
  const wakes: Wake[] = waits
    ? []
    : set.assigneeAgentId || (waited && holder)
      ? [{ agentId: (set.assigneeAgentId ?? holder)!, taskId, why: 'assigned' }]
      : holder && holder !== agentId
        ? [{ agentId: holder, taskId, why: 'updated' }]
        : [];
  const row = await move(ctx, task, set, { kind: 'updated', actor: { agentId }, data: { fields } }, handedOn ? handOver : undefined, wakes);
  unstuck.tell();
  return { task: row, wakes };
}

/* A comment goes into the log. A person's comment reaches whoever holds the task; an agent's wakes nobody. */
export async function comment(ctx: Live, actor: Actor, taskId: string, text: string): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  if (!text.trim()) throw refuse(400, 'task_invalid', 'A comment needs text.');
  const wake = actor.personId && task.assigneeAgentId && !CLOSED.includes(task.status);
  const wakes: Wake[] = wake ? [{ agentId: task.assigneeAgentId!, taskId, why: 'comment', text: text.trim() }] : [];
  await ctx.db.transaction(async tx => {
    await note(tx, task, { kind: 'comment', actor, text: text.trim() });
    await keepWakes(tx, task.companyId, wakes);
  });
  published(ctx, task);
  return { task, wakes };
}

/* What an agent asks: words, an approval of an exact commit, or a pick of one of 2 to 4 ways. images: pictures it sent
   with hh-attach, link: where to see the work. */
export type Ask = { kind: 'question' | 'approval' | 'choice'; text: string; commit?: string; images?: string[]; options?: RequestOption[]; link?: string | null };

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
      .values({ companyId: task.companyId, taskId, agentId, kind: q.kind, text: q.text.trim(), commit: q.commit ?? null, options, link: q.link ?? null })
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

/* Hornhoof stops waking the agent on the task and asks a person how it should go on. */
async function askAboutStill(ctx: Live, agentId: string, task: Task, silent: number, text: string): Promise<Moved> {
  let wakes: Wake[] = [];
  const row = await move(ctx, task, { silent, status: 'waiting' }, { kind: 'stuck', actor: { agentId }, text }, async tx => {
    const [note] = await tx.insert(requests).values({ companyId: task.companyId, taskId: task.id, agentId, kind: 'stuck', text }).returning();
    wakes = await explaining(tx, task, agentId, note!.id);
    await keepWakes(tx, task.companyId, wakes);
  });
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  return { task: row, wakes };
}

/* Events that do not move a task: what an agent says in it and Hornhoof's own notes about its turns. */
export const NOT_A_MOVE = ['comment', 'reminded', 'continued', 'stuck'] as const;

/* The agent holding the task worked through a turn without handing anything in, but said in the task how far it got or
   worked until its time ran out: it goes on in another turn, from GOING_ON_TURNS such turns in a row a person is asked. */
export async function wentOn(ctx: Live, agentId: string, task: Task): Promise<Moved> {
  const [last] = await ctx.db
    .select({ at: max(taskEvents.createdAt) })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), notInArray(taskEvents.kind, [...NOT_A_MOVE])));
  const [before] = await ctx.db
    .select({ n: count() })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.agentId, agentId), eq(taskEvents.kind, 'continued'), ...(last?.at ? [gt(taskEvents.createdAt, last.at)] : [])));
  const turns = Number(before?.n ?? 0) + 1;
  if (turns >= GOING_ON_TURNS) return askAboutStill(ctx, agentId, task, 0, `Went on for ${turns} turns in a row on #${task.number} without handing anything in. Tell it how to go on, or cancel the task.`);
  const wakes: Wake[] = [{ agentId, taskId: task.id, why: 'go_on' }];
  const row = await move(ctx, task, { silent: 0 }, { kind: 'continued', actor: { agentId }, data: { turns } }, undefined, wakes);
  return { task: row, wakes };
}

/* pick: the way a person took, from 0, in a choice. */
export type Answer = { answer?: string; approve?: boolean; retry?: boolean; pick?: number };

/* Pictures are the agent's own, from hh-attach, each shown once. */
async function checkPictures(db: Db, companyId: string, agentId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  if (new Set(ids).size !== ids.length) throw refuse(400, 'task_invalid', 'A picture is listed twice.');
  const rows = await db.select({ id: attachments.id, companyId: attachments.companyId, agentId: attachments.agentId, requestId: attachments.requestId }).from(attachments).where(inArray(attachments.id, ids));
  for (const id of ids) {
    const found = rows.find(r => r.id === id);
    if (!found || found.companyId !== companyId || found.agentId !== agentId) throw refuse(400, 'task_invalid', `${id} is not a picture you sent. Send it with hh-attach and use the id it prints.`);
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
    if (current?.status === 'waiting' && after!.status === 'review') wakes.push(...after!.panel.filter(id => id !== found.agentId).map(agentId => ({ agentId, taskId: task.id, why: 'review' as const })));
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
  const [row] = await ctx.db
    .update(tasks)
    .set({ status: 'working', version: sql`${tasks.version} + 1`, updatedAt: new Date() })
    .where(and(eq(tasks.id, job.taskId), eq(tasks.status, 'open'), eq(tasks.assigneeAgentId, job.agentId)))
    .returning();
  if (row) published(ctx, row);
}
