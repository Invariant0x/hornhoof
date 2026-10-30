import { and, asc, count, eq, inArray, isNull, max, notInArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Spot } from '../../auth/access.js';
import type { Db } from '../../db/client.js';
import { agents, attachments, companies, requests, subscriptions, taskEvents, tasks, turns, type RequestOption, type TaskEventKind } from '../../db/schema.js';
import { ApiError, type ErrorReason } from '../../errors.js';
import { handOff } from './pulses.js';

export type Task = typeof tasks.$inferSelect;
export type Request = typeof requests.$inferSelect;
/* Who moves a task: a person from the web app, or an agent from its tools. */
export type Actor = { personId: string; agentId?: undefined } | { agentId: string; personId?: undefined };
export type WakeWhy = 'assigned' | 'review' | 'changes' | 'stuck_at_gate' | 'done' | 'reported' | 'blocked' | 'cancelled' | 'answered' | 'comment' | 'updated' | 'reminder' | 'turn' | 'switched';
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

export async function note(tx: Tx | Db, task: Pick<Task, 'id' | 'companyId'>, n: Note): Promise<void> {
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
  await handOff(ctx, actor, task);
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
  if (task.gates.length) {
    const gate = await atGate(ctx.db, task, 1);
    return { task: await move(ctx, task, gate.set, n), wakes: gate.wakes };
  }
  const row = await move(ctx, task, closing(), n);
  return { task: row, wakes: giver(task, 'done', agentId) };
}

/* Everyone who checks the work at a gate: each live employee of the named reviewer's role in its department, for the
   task's product or for none, that is on and has a subscription, the named one first, never the executor. A reviewer
   without a role checks alone. */
async function panelFor(db: Db | Tx, task: Task, stage: number): Promise<string[]> {
  const named = task.gates[stage - 1];
  if (!named) return [];
  const [lead] = await db.select().from(agents).where(eq(agents.id, named));
  if (!lead || lead.removedAt) return [];
  const same = lead.roleKey && lead.departmentId ? and(eq(agents.departmentId, lead.departmentId), eq(agents.roleKey, lead.roleKey)) : eq(agents.id, lead.id);
  const rows = await db
    .select({ id: agents.id, productId: agents.productId })
    .from(agents)
    .innerJoin(subscriptions, and(eq(subscriptions.id, agents.subscriptionId), isNull(subscriptions.removedAt)))
    .where(and(same, isNull(agents.removedAt), isNull(agents.switchedOffAt)))
    .orderBy(asc(agents.createdAt));
  const product = task.productId ?? lead.productId;
  const ids = rows.filter(a => a.id !== task.executorAgentId && (!a.productId || a.productId === product)).map(a => a.id);
  return [...ids.filter(id => id === named), ...ids.filter(id => id !== named)];
}

/* The task reaches a gate: its whole panel checks it at once. With nobody on to check it, it waits with whoever gave it out. */
async function atGate(db: Db | Tx, task: Task, stage: number): Promise<{ set: Partial<Task>; wakes: Wake[] }> {
  const panel = await panelFor(db, task, stage);
  const at = { status: 'review' as const, stage, panel, silent: 0 };
  if (panel.length) return { set: { ...at, assigneeAgentId: panel[0]! }, wakes: panel.map(agentId => ({ agentId, taskId: task.id, why: 'review' as const })) };
  const [lead] = await db.select({ name: agents.name, roleKey: agents.roleKey }).from(agents).where(eq(agents.id, task.gates[stage - 1]!));
  const who = lead?.roleKey ?? lead?.name ?? 'its reviewer';
  const text = `Nobody who can check it at gate ${stage} (${who}) is on. Give it other gates with update_task, or tell the CEO it waits for one of them.`;
  return { set: { ...at, assigneeAgentId: task.createdByAgentId }, wakes: giver(task, 'switched', undefined, text) };
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

/* A reviewer at the task's gate gives its verdict. The gate decides once its whole panel has. */
export async function verdict(ctx: Live, agentId: string, taskId: string, v: { pass: boolean; comment: string }): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  stillOpen(task);
  if (!['review', 'waiting'].includes(task.status) || task.stage < 1 || !task.panel.includes(agentId) || task.executorAgentId === agentId) throw notYours(task, 'is not at your gate');
  if (!v.comment.trim()) throw refuse(400, 'task_invalid', 'A verdict needs its reasons.');
  /* The others at the gate go on while one of them waits for a person; that one decides once the answer is in. */
  if (task.status === 'waiting') {
    const [mine] = await ctx.db
      .select({ id: requests.id })
      .from(requests)
      .where(and(eq(requests.taskId, task.id), eq(requests.agentId, agentId), eq(requests.status, 'open')))
      .limit(1);
    if (mine) throw refuse(409, 'task_invalid', `#${task.number} waits for the answer to your question first.`);
  }
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
      return { task: await move(ctx, task, gate.set, n), wakes: gate.wakes };
    }
    return { task: await move(ctx, task, { ...closing(), panel: [] }, n), wakes: giver(task, 'done', actorId) };
  }
  const failed = given.filter(g => !g.pass);
  const reasons = given.length === 1 ? failed[0]!.comment : failed.map(g => `${g.name}: ${g.comment}`).join('\n\n');
  /* An executor switched off meanwhile would not take the changes up, so whoever gave the work out decides who does. */
  const [executor] = await ctx.db.select({ name: agents.name, off: agents.switchedOffAt }).from(agents).where(eq(agents.id, task.executorAgentId!));
  const away = executor?.off && task.createdByAgentId && task.createdByAgentId !== task.executorAgentId ? task.createdByAgentId : null;
  let rounds = 0;
  const row = await move(ctx, task, { status: 'open', stage: 0, panel: [], assigneeAgentId: away ?? task.executorAgentId, bounces: task.bounces + 1, silent: 0 }, n, async tx => {
    const [sent] = await tx
      .select({ n: sql<number>`count(distinct coalesce(${taskEvents.data}->>'round', ${taskEvents.id}::text))` })
      .from(taskEvents)
      .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'verdict'), sql`${taskEvents.data}->>'pass' = 'false'`, sql`${taskEvents.data}->>'stage' = ${String(task.stage)}`));
    rounds = Number(sent?.n ?? 0);
  });
  const name = executor?.name ?? 'Its executor';
  const wakes: Wake[] = away
    ? [{ agentId: away, taskId: task.id, why: 'switched', text: `${name} does it and is switched off, and gate ${task.stage} sent it back with changes to make: ${reasons}\n\nGive it to someone who is on with update_task, or tell the CEO it waits for ${name}.` }]
    : [{ agentId: task.executorAgentId!, taskId: task.id, why: 'changes', text: reasons }];
  if (rounds >= GATE_ROUNDS) wakes.push(...giver(task, 'stuck_at_gate', actorId));
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

/* Ends the task and every open task under it; questions waiting on them are withdrawn. Whoever gave it out hears why.
   closed names every task that ended, for their turns to stop. */
export async function cancel(ctx: Live, actor: Actor, taskId: string, why: string): Promise<Moved & { closed: string[] }> {
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
  return { task: row, wakes: giver(task, 'cancelled', actor.agentId, why.trim()), closed: [taskId, ...ended.map(t => t.id)] };
}

/* An employee leaves: it comes off the gates of a task it has not reached yet; gates it passed stay as the task's history. */
export async function dropGate(ctx: Live, actor: Actor, task: Task, agentId: string): Promise<Task> {
  const gates = task.gates.filter((id, i) => id !== agentId || i < task.stage);
  return move(ctx, task, { gates }, { kind: 'updated', actor, data: { fields: ['gates'] } });
}

export type TaskChange = { title?: string; brief?: string; body?: string; executor?: string; gates?: string[] };

/* An agent switched off once its running turn is over: work it does and has not handed in goes to whoever gave it out,
   and it leaves the gates it has not given its verdict at, which decide with the rest or wait with the giver. Work that
   waits for its own question to a person stays until the answer comes. handed: the tasks it no longer holds, closed: the
   ones that finished as it left. */
export async function leaveWork(ctx: Live, actor: Actor, agent: { id: string; name: string; companyId: string }): Promise<{ wakes: Wake[]; handed: string[]; closed: Task[] }> {
  const open = await ctx.db.select().from(tasks).where(and(eq(tasks.companyId, agent.companyId), notInArray(tasks.status, [...CLOSED, 'planned'])));
  const asked = new Set((await ctx.db.select({ taskId: requests.taskId }).from(requests).where(and(eq(requests.agentId, agent.id), eq(requests.status, 'open')))).map(r => r.taskId));
  const n: Note = { kind: 'updated', actor, text: `${agent.name} was switched off.`, data: { fields: ['assignee'] } };
  const wakes: Wake[] = [];
  const handed: string[] = [];
  const closed: Task[] = [];
  for (const task of open) {
    if (task.status === 'waiting' && (asked.has(task.id) || !task.panel.includes(agent.id))) continue;
    if (task.stage === 0 && task.executorAgentId === agent.id && task.assigneeAgentId === agent.id && task.createdByAgentId && task.createdByAgentId !== agent.id) {
      await move(ctx, task, { assigneeAgentId: task.createdByAgentId, status: task.status === 'working' ? 'open' : task.status }, n);
      wakes.push(...giver(task, 'switched', agent.id, `${agent.name} does it and was switched off. Give it to someone who is on with update_task, or tell the CEO it waits for ${agent.name}.`));
      handed.push(task.id);
    } else if (task.stage > 0 && task.panel.includes(agent.id)) {
      const panel = task.panel.filter(id => id !== agent.id);
      /* Someone else at the gate asked a person, so someone is left to decide it. */
      if (task.status === 'waiting' && !panel.length) continue;
      handed.push(task.id);
      if (panel.length) {
        await move(ctx, task, { panel, assigneeAgentId: panel[0]! }, n);
        continue;
      }
      const given = await gateVerdicts(ctx.db, task);
      if (given.length) {
        const moved = await closeGate(ctx, task, n, given);
        wakes.push(...moved.wakes);
        if (CLOSED.includes(moved.task.status)) closed.push(moved.task);
        continue;
      }
      await move(ctx, task, { panel: [], assigneeAgentId: task.createdByAgentId }, n);
      wakes.push(...giver(task, 'switched', agent.id, `Nobody who can check it at gate ${task.stage} is on now that ${agent.name} was switched off. Give it other gates with update_task, or tell the CEO it waits for one of them.`));
    }
  }
  return { wakes, handed, closed };
}

/* An agent switched on again: a task that waits at a gate with nobody on to check it starts that gate again once someone
   can. */
export async function rejoin(ctx: Live, actor: Actor, agent: { id: string; name: string; companyId: string }): Promise<Wake[]> {
  const held = await ctx.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.companyId, agent.companyId), eq(tasks.status, 'review'), sql`${tasks.stage} > 0`, sql`${tasks.panel} = '[]'::jsonb`));
  const wakes: Wake[] = [];
  for (const task of held) {
    const gate = await atGate(ctx.db, task, task.stage);
    if (!gate.set.panel?.length) continue;
    await move(ctx, task, gate.set, { kind: 'updated', actor, text: `${agent.name} was switched on.`, data: { fields: ['assignee'] } });
    wakes.push(...gate.wakes);
  }
  return wakes;
}

/* A task waits at a gate with nobody on to check it: the gates from there on are the given ones, and the first of them
   starts at once. None left finishes the task. */
async function regate(ctx: Live, agentId: string, task: Task, c: TaskChange): Promise<Moved> {
  const given = c.gates!;
  await checkGates(ctx.db, task.companyId, task.executorAgentId!, given);
  const gates = [...task.gates.slice(0, task.stage - 1), ...given];
  const text = rewrite(task, c);
  const n: Note = { kind: 'updated', actor: { agentId }, data: { fields: [...text.fields, 'gates'] } };
  if (!given.length) return { task: await move(ctx, task, { ...text.set, gates, ...closing(), panel: [] }, n), wakes: [] };
  const gate = await atGate(ctx.db, { ...task, gates }, task.stage);
  return { task: await move(ctx, task, { ...text.set, gates, ...gate.set }, n), wakes: gate.wakes };
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
  const row = await move(ctx, task, { status: 'waiting', silent: 0 }, { kind: 'asked', actor: { agentId }, text: q.text.trim(), data: { kind: q.kind, commit: q.commit ?? null } }, async tx => {
    [request] = await tx
      .insert(requests)
      .values({ companyId: task.companyId, taskId, agentId, kind: q.kind, text: q.text.trim(), commit: q.commit ?? null, options, link: q.link ?? null })
      .returning();
    if (!pictures.length) return;
    const shown = await tx
      .update(attachments)
      .set({ requestId: request!.id })
      .where(and(inArray(attachments.id, pictures), eq(attachments.agentId, agentId), isNull(attachments.requestId)))
      .returning({ id: attachments.id });
    if (shown.length !== pictures.length) throw refuse(409, 'task_changed', 'A picture was shown meanwhile. Send it again with hh-attach.');
  });
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  return { task: row, request: request!, wakes: [] };
}

/* The agent holding the task ended a turn without moving it: a reminder, and from SILENT_TURNS on a person is asked. */
export async function silentTurn(ctx: Live, agentId: string, task: Task): Promise<Moved> {
  const silent = task.silent + 1;
  if (silent < SILENT_TURNS) {
    const row = await move(ctx, task, { silent }, { kind: 'reminded', actor: { agentId }, data: { silent } });
    return { task: row, wakes: [{ agentId, taskId: task.id, why: 'reminder' }] };
  }
  const text = `Ended ${silent} turns in a row on #${task.number} without moving it. Tell it how to go on, or cancel the task.`;
  const row = await move(ctx, task, { silent, status: 'waiting' }, { kind: 'stuck', actor: { agentId }, text }, async tx => {
    await tx.insert(requests).values({ companyId: task.companyId, taskId: task.id, agentId, kind: 'stuck', text });
  });
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  return { task: row, wakes: [] };
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
export async function answer(ctx: Live, personId: string, requestId: string, a: Answer): Promise<{ request: Request; task: Task; wakes: Wake[] }> {
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
  const row = await ctx.db.transaction(async tx => {
    const [request] = await tx
      .update(requests)
      .set({ status, answer: text || null, picked: option ? a.pick! : null, answeredBy: personId, answeredAt: new Date() })
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
  await handOff(ctx, { personId }, now);
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  const wakes: Wake[] = CLOSED.includes(now.status) ? [] : [{ agentId: found.agentId, taskId: task.id, why: 'answered', text: said }];
  return { request: row, task: now, wakes };
}
