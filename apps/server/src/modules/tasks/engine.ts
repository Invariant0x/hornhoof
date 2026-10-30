import { and, count, eq, inArray, isNull, max, notInArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Spot } from '../../auth/access.js';
import type { Db } from '../../db/client.js';
import { agents, companies, requests, taskEvents, tasks, turns, type TaskEventKind } from '../../db/schema.js';
import { ApiError, type ErrorReason } from '../../errors.js';

export type Task = typeof tasks.$inferSelect;
export type Request = typeof requests.$inferSelect;
/* Who moves a task: a person from the web app, or an agent from its tools. */
export type Actor = { personId: string; agentId?: undefined } | { agentId: string; personId?: undefined };
export type WakeWhy = 'assigned' | 'review' | 'changes' | 'stuck_at_gate' | 'done' | 'reported' | 'blocked' | 'answered' | 'comment' | 'updated' | 'reminder';
/* An agent that has to act on a task now; Hornhoof queues a turn for it. */
export type Wake = { agentId: string; taskId: string; why: WakeWhy; text?: string };
export type Moved = { task: Task; wakes: Wake[] };

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Live = Pick<Ctx, 'db' | 'bus'>;

export const CLOSED: readonly Task['status'][] = ['done', 'cancelled'];
/* The send-back at one gate that also calls the head in. */
export const GATE_ROUNDS = 3;
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

/* Where a task sits, for the stream: its product inside its department, or the department; none for the orchestrator's. */
export const taskSpot = (t: Pick<Task, 'departmentId' | 'productId'>): Spot =>
  t.productId ? { departmentId: t.productId, parentId: t.departmentId } : { departmentId: t.departmentId, parentId: null };

const actorColumns = (a: Actor) => ({ personId: a.personId ?? null, agentId: a.agentId ?? null });

type Note = { kind: TaskEventKind; actor: Actor; text?: string; data?: Record<string, unknown> };

async function note(tx: Tx | Db, task: Pick<Task, 'id' | 'companyId'>, n: Note): Promise<void> {
  await tx.insert(taskEvents).values({ companyId: task.companyId, taskId: task.id, kind: n.kind, ...actorColumns(n.actor), text: n.text ?? '', data: n.data ?? {} });
}

/* One move: the task changes only if nobody moved it since it was read, and the move is written to its log. */
async function move(ctx: Live, task: Task, set: Partial<Task>, n: Note, also?: (tx: Tx, row: Task) => Promise<void>): Promise<Task> {
  const row = await ctx.db.transaction(async tx => {
    const [row] = await tx
      .update(tasks)
      .set({ ...set, version: task.version + 1, updatedAt: new Date() })
      .where(and(eq(tasks.id, task.id), eq(tasks.version, task.version)))
      .returning();
    if (!row) throw refuse(409, 'task_changed', `#${task.number} changed meanwhile. Read it again.`);
    await note(tx, row, n);
    await also?.(tx, row);
    return row;
  });
  published(ctx, row);
  return row;
}

export function published(ctx: Pick<Ctx, 'bus'>, task: Task): void {
  ctx.bus.publish(task.companyId, { type: 'task', id: task.id, spot: taskSpot(task) });
}

/* Whoever gave the task, when that was an agent other than the one acting. */
const giver = (task: Task, why: WakeWhy, actorId?: string, text?: string): Wake[] =>
  task.createdByAgentId && task.createdByAgentId !== actorId ? [{ agentId: task.createdByAgentId, taskId: task.id, why, ...(text ? { text } : {}) }] : [];

const closing = () => ({ status: 'done' as const, closedAt: new Date(), assigneeAgentId: null, silent: 0 });

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
};

/* A live employee or orchestrator of the company. */
async function liveAgent(db: Db | Tx, companyId: string | null, id: string) {
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, id), isNull(agents.removedAt)));
  if (!agent || (companyId && agent.companyId !== companyId)) throw refuse(400, 'task_invalid', `There is no employee ${id}.`);
  return agent;
}

async function checkGates(db: Db, companyId: string, executor: string, gates: string[]): Promise<void> {
  if (new Set(gates).size !== gates.length) throw refuse(400, 'task_invalid', 'A gate is listed twice.');
  if (gates.includes(executor)) throw refuse(400, 'task_invalid', 'Whoever does the work never passes its gate. Pick another reviewer.');
  for (const id of gates) await liveAgent(db, companyId, id);
}

export async function createTask(ctx: Live, actor: Actor, input: NewTask): Promise<Moved> {
  const assignee = await liveAgent(ctx.db, null, input.assigneeAgentId);
  const gates = input.executor ? (input.gates ?? []) : [];
  if (!input.executor && input.gates?.length) throw refuse(400, 'task_invalid', 'Only a task with an executor has gates.');
  if (input.executor) await checkGates(ctx.db, assignee.companyId, assignee.id, gates);
  if (!input.title.trim()) throw refuse(400, 'task_invalid', 'A task needs a title.');
  const parent = input.parentId ? await loadTask(ctx.db, input.parentId) : null;
  if (parent) stillOpen(parent);
  const task = await ctx.db.transaction(async tx => {
    /* Numbers go up one by one per company, so creating tasks waits on the company row. */
    await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, assignee.companyId)).for('update');
    const [last] = await tx.select({ n: max(tasks.number) }).from(tasks).where(eq(tasks.companyId, assignee.companyId));
    const [turn] = parent ? [] : await tx.select({ id: turns.id }).from(turns).where(and(eq(turns.companyId, assignee.companyId), eq(turns.status, 'open')));
    const [row] = await tx
      .insert(tasks)
      .values({
        companyId: assignee.companyId,
        number: (last?.n ?? 0) + 1,
        turnId: parent ? parent.turnId : (turn?.id ?? null),
        parentId: parent?.id ?? null,
        departmentId: input.departmentId,
        productId: input.productId ?? null,
        title: input.title.trim(),
        brief: input.brief.trim(),
        body: input.body,
        assigneeAgentId: assignee.id,
        executorAgentId: input.executor ? assignee.id : null,
        gates,
        createdByPersonId: actor.personId ?? null,
        createdByAgentId: actor.agentId ?? null,
        updatedAt: new Date(),
      })
      .returning();
    await note(tx, row!, { kind: 'created', actor, text: row!.brief, data: { assignee: assignee.id, gates } });
    return row!;
  });
  published(ctx, task);
  return { task, wakes: [{ agentId: assignee.id, taskId: task.id, why: 'assigned' }] };
}

/* The executor hands its work to the first gate, or finishes a task without gates. */
export async function submit(ctx: Live, agentId: string, taskId: string, r: { summary: string; evidence: string }): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  if (!task.executorAgentId) throw refuse(400, 'task_invalid', `#${task.number} has no executor; its owner closes it with report.`);
  if (task.executorAgentId !== agentId || task.stage !== 0) throw notYours(task, 'is not waiting for your work');
  if (task.status === 'waiting') throw refuse(409, 'task_invalid', `#${task.number} waits for a person's answer first.`);
  const n: Note = { kind: 'submitted', actor: { agentId }, text: r.summary, data: { evidence: r.evidence } };
  const [first] = task.gates;
  if (first) {
    const row = await move(ctx, task, { status: 'review', stage: 1, assigneeAgentId: first, silent: 0 }, n);
    return { task: row, wakes: [{ agentId: first, taskId, why: 'review' }] };
  }
  const row = await move(ctx, task, closing(), n);
  return { task: row, wakes: giver(task, 'done', agentId) };
}

/* The gate at the task's stage passes it on, or sends it back with its reasons. */
export async function verdict(ctx: Live, agentId: string, taskId: string, v: { pass: boolean; comment: string }): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  if (task.status !== 'review' || task.stage < 1 || task.gates[task.stage - 1] !== agentId || task.executorAgentId === agentId) throw notYours(task, 'is not at your gate');
  if (!v.comment.trim()) throw refuse(400, 'task_invalid', 'A verdict needs its reasons.');
  const n: Note = { kind: 'verdict', actor: { agentId }, text: v.comment.trim(), data: { pass: v.pass, stage: task.stage } };
  if (v.pass) {
    const next = task.gates[task.stage];
    if (next) {
      const row = await move(ctx, task, { stage: task.stage + 1, assigneeAgentId: next, silent: 0 }, n);
      return { task: row, wakes: [{ agentId: next, taskId, why: 'review' }] };
    }
    const row = await move(ctx, task, closing(), n);
    return { task: row, wakes: giver(task, 'done', agentId) };
  }
  let rounds = 0;
  const row = await move(ctx, task, { status: 'open', stage: 0, assigneeAgentId: task.executorAgentId, bounces: task.bounces + 1, silent: 0 }, n, async tx => {
    const [sent] = await tx
      .select({ n: count() })
      .from(taskEvents)
      .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.kind, 'verdict'), sql`${taskEvents.data}->>'pass' = 'false'`, sql`${taskEvents.data}->>'stage' = ${String(task.stage)}`));
    rounds = Number(sent?.n ?? 0);
  });
  const wakes: Wake[] = [{ agentId: task.executorAgentId!, taskId, why: 'changes', text: v.comment.trim() }];
  if (rounds >= GATE_ROUNDS) wakes.push(...giver(task, 'stuck_at_gate', agentId));
  return { task: row, wakes };
}

/* The owner of a task without an executor (a department's, the orchestrator's) closes it or says it cannot go on. */
export async function report(ctx: Live, agentId: string, taskId: string, r: { done: boolean; summary: string }): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  if (task.executorAgentId) throw refuse(400, 'task_invalid', `#${task.number} is a member task: submit it, or say it is blocked.`);
  if (task.assigneeAgentId !== agentId) throw notYours(task, 'is not yours to report');
  const n: Note = { kind: 'report', actor: { agentId }, text: r.summary, data: { done: r.done } };
  if (r.done) return { task: await move(ctx, task, closing(), n), wakes: giver(task, 'reported', agentId, r.summary) };
  if (task.createdByAgentId) return { task: await move(ctx, task, { status: 'blocked' }, n), wakes: giver(task, 'blocked', agentId, r.summary) };
  /* A person gave it, so a person has to unblock it. */
  const row = await move(ctx, task, { status: 'waiting' }, n, async tx => {
    await tx.insert(requests).values({ companyId: task.companyId, taskId, agentId, kind: 'stuck', text: r.summary });
  });
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  return { task: row, wakes: [] };
}

/* The executor cannot go on without its head. */
export async function blocked(ctx: Live, agentId: string, taskId: string, why: string): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  if (task.executorAgentId !== agentId || task.stage !== 0) throw notYours(task, 'is not waiting for your work');
  const row = await move(ctx, task, { status: 'blocked' }, { kind: 'blocked', actor: { agentId }, text: why });
  return { task: row, wakes: giver(task, 'blocked', agentId, why) };
}

/* Ends the task and every open task under it; questions waiting on them are withdrawn. */
export async function cancel(ctx: Live, actor: Actor, taskId: string, why: string): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  const ended: Task[] = [];
  const row = await move(ctx, task, { status: 'cancelled', closedAt: new Date(), assigneeAgentId: null }, { kind: 'cancelled', actor, text: why }, async tx => {
    let level = [taskId];
    while (level.length) {
      const below = await tx
        .update(tasks)
        .set({ status: 'cancelled', closedAt: new Date(), assigneeAgentId: null, updatedAt: new Date(), version: sql`${tasks.version} + 1` })
        .where(and(inArray(tasks.parentId, level), notInArray(tasks.status, [...CLOSED])))
        .returning();
      for (const t of below) await note(tx, t, { kind: 'cancelled', actor, text: `#${task.number} was cancelled.` });
      ended.push(...below);
      level = below.map(t => t.id);
    }
    await tx
      .update(requests)
      .set({ status: 'withdrawn', answeredAt: new Date() })
      .where(and(inArray(requests.taskId, [taskId, ...ended.map(t => t.id)]), eq(requests.status, 'open')));
  });
  for (const t of ended) published(ctx, t);
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  return { task: row, wakes: [] };
}

export type TaskChange = { title?: string; brief?: string; body?: string; executor?: string; gates?: string[] };

/* The owner rewrites the task so it reads as the current truth, or hands it to another executor or other gates. */
export async function updateTask(ctx: Live, agentId: string, taskId: string, c: TaskChange): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  if ((c.executor !== undefined || c.gates !== undefined) && !task.executorAgentId) throw refuse(400, 'task_invalid', `#${task.number} has no executor or gates.`);
  if ((c.executor !== undefined || c.gates !== undefined) && task.stage !== 0) throw refuse(409, 'task_invalid', `#${task.number} is at a gate; change who works on it after the verdict.`);
  const executor = c.executor ?? task.executorAgentId;
  const gates = c.gates ?? task.gates;
  if (executor) {
    await liveAgent(ctx.db, task.companyId, executor);
    await checkGates(ctx.db, task.companyId, executor, gates);
  }
  const set: Partial<Task> = {};
  const fields: string[] = [];
  for (const key of ['title', 'brief', 'body'] as const) {
    if (c[key] !== undefined && c[key] !== task[key]) {
      set[key] = c[key];
      fields.push(key);
    }
  }
  if (executor !== task.executorAgentId) {
    set.executorAgentId = executor;
    set.assigneeAgentId = executor;
    fields.push('executor');
  }
  if (c.gates !== undefined && JSON.stringify(gates) !== JSON.stringify(task.gates)) {
    set.gates = gates;
    fields.push('gates');
  }
  if (!fields.length) return { task, wakes: [] };
  /* A rewrite answers a blocked executor. */
  if (task.status === 'blocked') set.status = 'open';
  const row = await move(ctx, task, set, { kind: 'updated', actor: { agentId }, data: { fields } });
  const wakes: Wake[] = [];
  if (set.assigneeAgentId) wakes.push({ agentId: set.assigneeAgentId, taskId, why: 'assigned' });
  else if (row.assigneeAgentId && row.assigneeAgentId !== agentId) wakes.push({ agentId: row.assigneeAgentId, taskId, why: 'updated' });
  return { task: row, wakes };
}

/* A comment goes into the log. A person's comment reaches whoever holds the task; an agent's wakes nobody. */
export async function comment(ctx: Live, actor: Actor, taskId: string, text: string): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  if (!text.trim()) throw refuse(400, 'task_invalid', 'A comment needs text.');
  await note(ctx.db, task, { kind: 'comment', actor, text: text.trim() });
  published(ctx, task);
  const wake = actor.personId && task.assigneeAgentId && !CLOSED.includes(task.status);
  return { task, wakes: wake ? [{ agentId: task.assigneeAgentId!, taskId, why: 'comment', text: text.trim() }] : [] };
}

/* The agent that holds the task asks a person and the task waits for the answer. */
export async function ask(ctx: Live, agentId: string, taskId: string, q: { kind: 'question' | 'approval'; text: string; commit?: string }): Promise<Moved & { request: Request }> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  if (task.assigneeAgentId !== agentId) throw notYours(task, 'is not with you');
  if (!q.text.trim()) throw refuse(400, 'task_invalid', 'Say what you need.');
  if (q.kind === 'approval' && !COMMIT.test(q.commit ?? '')) throw refuse(400, 'task_invalid', 'An approval names the full 40-character commit.');
  if (q.kind === 'question' && q.commit) throw refuse(400, 'task_invalid', 'A question has no commit; ask for an approval instead.');
  let request: Request | undefined;
  const row = await move(ctx, task, { status: 'waiting', silent: 0 }, { kind: 'asked', actor: { agentId }, text: q.text.trim(), data: { kind: q.kind, commit: q.commit ?? null } }, async tx => {
    [request] = await tx.insert(requests).values({ companyId: task.companyId, taskId, agentId, kind: q.kind, text: q.text.trim(), commit: q.commit ?? null }).returning();
  });
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  return { task: row, request: request!, wakes: [] };
}

export type Answer = { answer?: string; approve?: boolean; retry?: boolean };

/* A person answers: the request closes, the task goes on where it stood, and the agent that asked wakes with the answer. */
export async function answer(ctx: Live, personId: string, requestId: string, a: Answer): Promise<{ request: Request; task: Task; wakes: Wake[] }> {
  const [found] = await ctx.db.select().from(requests).where(eq(requests.id, requestId));
  if (!found) throw refuse(404, 'request_unknown', 'There is no such request.');
  if (found.status !== 'open') throw refuse(409, 'request_closed', 'This request is answered already.');
  const text = a.answer?.trim() ?? '';
  let status: Request['status'];
  if (found.kind === 'approval') {
    if (a.approve === undefined) throw refuse(400, 'task_invalid', 'Approve or decline this commit.');
    status = a.approve ? 'approved' : 'declined';
  } else {
    if (a.approve !== undefined) throw refuse(400, 'task_invalid', 'Only a commit is approved; answer in words.');
    if (!text && !(found.kind === 'stuck' && a.retry)) throw refuse(400, 'task_invalid', 'Write an answer.');
    status = 'answered';
  }
  const said = found.kind === 'approval' ? `${a.approve ? 'Approved' : 'Declined'} ${found.commit}.${text ? ` ${text}` : ''}` : text || 'Try again.';
  const task = await loadTask(ctx.db, found.taskId);
  const row = await ctx.db.transaction(async tx => {
    const [request] = await tx
      .update(requests)
      .set({ status, answer: text || null, answeredBy: personId, answeredAt: new Date() })
      .where(and(eq(requests.id, requestId), eq(requests.status, 'open')))
      .returning();
    if (!request) throw refuse(409, 'request_closed', 'This request is answered already.');
    await note(tx, task, { kind: 'answered', actor: { personId }, text: said, data: { requestId, kind: found.kind, status } });
    const [left] = await tx.select({ n: count() }).from(requests).where(and(eq(requests.taskId, task.id), eq(requests.status, 'open')));
    if (task.status === 'waiting' && !Number(left?.n ?? 0)) {
      await tx
        .update(tasks)
        .set({ status: task.stage > 0 ? 'review' : 'working', silent: 0, version: sql`${tasks.version} + 1`, updatedAt: new Date() })
        .where(eq(tasks.id, task.id));
    }
    return request;
  });
  const now = await loadTask(ctx.db, task.id);
  published(ctx, now);
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  const wakes: Wake[] = CLOSED.includes(now.status) ? [] : [{ agentId: found.agentId, taskId: task.id, why: 'answered', text: said }];
  return { request: row, task: now, wakes };
}
