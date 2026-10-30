import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, asc, count, desc, eq, gte, inArray, isNull, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, departments, jobs, requests, tasks, turns } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { ask, blocked, cancel, CLOSED, comment, createTask, refuse, report, submit, updateTask, verdict, type Moved, type Task } from './engine.js';
import { taskByRef, taskDetail, taskLines } from './views.js';
import { wakeAll } from './wake.js';

export type ToolJob = { id: string; companyId: string; agentId: string; agentKind: 'orchestrator' | 'head' | 'worker' };
type Agent = typeof agents.$inferSelect;

/* What one turn may do to others' work: tasks it creates and questions it puts to people. */
export const TURN_TASKS = 10;
export const TURN_QUESTIONS = 3;

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
/* Agents read role names in English, the language of their instructions. */
const english = (_k: string, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) && 'en' in v && 'ru' in v && Object.keys(v).length === 2 ? (v as { en: string }).en : v);
const json = (value: unknown) => say(JSON.stringify(value, english));

const Ref = z.union([z.number().int().positive(), z.string().max(40)]).describe('The task number, like 12 or "#12", or its id.');
const Title = z.string().trim().min(1).max(120);
const Brief = z.string().max(600).describe('One to three sentences people read on the map and in the tracker.');
const Body = z.string().max(20000).describe('What every agent on the task reads: requirements, acceptance criteria (what the gates check), product, constraints. Rewrite it as the current truth.');

/* The tools an agent gets for tasks, by its kind. Each one checks that the task is the agent's to move. */
export function registerTaskTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  const { db } = ctx;
  const me = async (): Promise<Agent> => (await db.select().from(agents).where(eq(agents.id, job.agentId)))[0]!;
  const startedAt = async () => (await db.select({ at: jobs.startedAt }).from(jobs).where(eq(jobs.id, job.id)))[0]?.at ?? new Date(0);

  /* The orchestrator sees every task; an employee its department's, and any it holds or reviews. */
  const sees = (agent: Agent, t: Task) =>
    agent.kind === 'orchestrator' || (agent.departmentId !== null && t.departmentId === agent.departmentId) || t.assigneeAgentId === agent.id || t.executorAgentId === agent.id || t.gates.includes(agent.id);

  async function find(ref: number | string): Promise<{ agent: Agent; task: Task }> {
    const agent = await me();
    const task = await taskByRef(ctx, job.companyId, ref);
    if (!task || !sees(agent, task)) throw refuse(404, 'task_unknown', `There is no task ${ref} you can see. Call tasks for yours.`);
    return { agent, task };
  }

  /* Runs a move, wakes whoever it needs and answers in a line; a refused move comes back as a readable error. */
  const run = (fn: () => Promise<{ text: string; moved?: Pick<Moved, 'wakes'> }>) =>
    fn().then(
      async ({ text, moved }) => {
        if (moved) await wakeAll(ctx, moved.wakes);
        return say(text);
      },
      (err: unknown) => {
        if (err instanceof ApiError) return say(err.message, true);
        throw err;
      },
    );

  async function where(t: Task): Promise<string> {
    const [line] = await taskLines(ctx, [t]);
    const holder = line?.assignee ? `, with ${line.assignee.name}` : '';
    return `#${t.number} is ${t.status}${holder}.`;
  }

  async function underCap(agent: Agent): Promise<void> {
    const [made] = await db
      .select({ n: count() })
      .from(tasks)
      .where(and(eq(tasks.createdByAgentId, agent.id), gte(tasks.createdAt, await startedAt())));
    if (Number(made?.n ?? 0) >= TURN_TASKS) throw refuse(409, 'task_invalid', `One turn creates at most ${TURN_TASKS} tasks. Finish this turn and go on in the next.`);
  }

  server.registerTool(
    'tasks',
    { description: 'Your open tasks first, then the other open tasks you can see: number, title, brief, state, who holds it.', inputSchema: {} },
    async () => {
      const agent = await me();
      const open = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.companyId, job.companyId), notInArray(tasks.status, [...CLOSED])))
        .orderBy(desc(tasks.number))
        .limit(200);
      const mine = open.filter(t => sees(agent, t)).sort((a, b) => Number(b.assigneeAgentId === agent.id) - Number(a.assigneeAgentId === agent.id));
      return json(await taskLines(ctx, mine.slice(0, 40)));
    },
  );

  server.registerTool(
    'task',
    { description: 'One task in full: its body (the current truth), gates and where it stands, subtasks, open questions and its log.', inputSchema: { task: Ref } },
    async ({ task: ref }) =>
      find(ref).then(
        async ({ task }) => json(await taskDetail(ctx, task)),
        (err: unknown) => (err instanceof ApiError ? say(err.message, true) : Promise.reject(err)),
      ),
  );

  server.registerTool(
    'comment',
    { description: 'Adds a note to a task\'s log for everyone on it. It wakes nobody; to hand work on, use the task\'s own moves.', inputSchema: { task: Ref, text: z.string().trim().min(1).max(4000) } },
    async ({ task: ref, text }) =>
      run(async () => {
        const { task } = await find(ref);
        return { text: `Noted on #${task.number}.`, moved: await comment(ctx, { agentId: job.agentId }, task.id, text) };
      }),
  );

  server.registerTool(
    'ask_person',
    {
      description:
        'Asks the people responsible for the task a question, or (with commit) for approval of that exact commit before a release. The task waits; you are woken with the answer. ' +
        `At most ${TURN_QUESTIONS} per turn; ask only what you cannot decide or find out yourself.`,
      inputSchema: { task: Ref, question: z.string().trim().min(1).max(2000), commit: z.string().regex(/^[0-9a-f]{40}$/).optional() },
    },
    async ({ task: ref, question, commit }) =>
      run(async () => {
        const { task } = await find(ref);
        const [asked] = await db
          .select({ n: count() })
          .from(requests)
          .where(and(eq(requests.agentId, job.agentId), inArray(requests.kind, ['question', 'approval']), gte(requests.createdAt, await startedAt())));
        if (Number(asked?.n ?? 0) >= TURN_QUESTIONS) throw refuse(409, 'task_invalid', `One turn asks people at most ${TURN_QUESTIONS} times.`);
        const moved = await ask(ctx, job.agentId, task.id, commit ? { kind: 'approval', text: question, commit } : { kind: 'question', text: question });
        return { text: `Asked. #${task.number} waits for a person's answer; you will be woken with it.`, moved };
      }),
  );

  if (job.agentKind === 'orchestrator') {
    server.registerTool(
      'create_task',
      {
        description:
          "Gives a department a task: it goes to the department's head, who splits it among the department and reports back to you when it is done. " +
          'department and product ids from company. parent: the task this one serves (by default the open turn\'s task).',
        inputSchema: { department: z.uuid(), product: z.uuid().optional(), title: Title, brief: Brief, body: Body, parent: Ref.optional() },
      },
      async input =>
        run(async () => {
          const agent = await me();
          await underCap(agent);
          const [dept] = await db.select().from(departments).where(and(eq(departments.id, input.department), eq(departments.companyId, job.companyId), isNull(departments.parentId)));
          if (!dept) throw refuse(404, 'department_unknown', `There is no department ${input.department}. Call company for the ids.`);
          if (input.product) {
            const [product] = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.id, input.product), eq(departments.parentId, dept.id)));
            if (!product) throw refuse(404, 'department_unknown', `${input.product} is not a product of this department.`);
          }
          const [head] = await db.select().from(agents).where(and(eq(agents.departmentId, dept.id), eq(agents.kind, 'head'), isNull(agents.removedAt))).orderBy(asc(agents.createdAt));
          if (!head) throw refuse(409, 'no_head', 'This department has no head yet. Propose staff for it first.');
          const parent = await parentFor(agent, input.parent);
          const moved = await createTask(ctx, { agentId: agent.id }, { title: input.title, brief: input.brief, body: input.body, departmentId: dept.id, productId: input.product ?? null, parentId: parent, assigneeAgentId: head.id });
          return { text: `Created #${moved.task.number} for ${head.name}, the head. You will hear back when it is done.`, moved };
        }),
    );
  }

  if (job.agentKind === 'head') {
    server.registerTool(
      'create_task',
      {
        description:
          'Gives work to someone in your department (or yourself): executor is an employee id from company. gates are the reviewers it passes in order, as role ids (DEV-REV) or employee ids; ' +
          'left out, the department\'s usual gates that are hired; [] for none. The executor never reviews its own work. parent: the department task it serves.',
        inputSchema: { title: Title, brief: Brief, body: Body, executor: z.uuid(), gates: z.array(z.string().max(40)).max(8).optional(), parent: Ref.optional(), product: z.uuid().optional() },
      },
      async input =>
        run(async () => {
          const agent = await me();
          await underCap(agent);
          const executor = await member(agent, input.executor);
          const gates = await gatesFor(agent, executor.id, input.gates);
          if (input.product) {
            const [product] = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.id, input.product), eq(departments.parentId, agent.departmentId!)));
            if (!product) throw refuse(404, 'department_unknown', `${input.product} is not a product of your department.`);
          }
          const parent = input.parent !== undefined ? (await find(input.parent)).task.id : null;
          const moved = await createTask(ctx, { agentId: agent.id }, { title: input.title, brief: input.brief, body: input.body, departmentId: agent.departmentId, productId: input.product ?? null, parentId: parent, assigneeAgentId: executor.id, executor: true, gates });
          return { text: `Created #${moved.task.number} for ${executor.name}${gates.length ? ` with ${gates.length} gate${gates.length > 1 ? 's' : ''}` : ''}.`, moved };
        }),
    );
    server.registerTool(
      'update_task',
      {
        description: "Rewrites one of your department's member tasks so it reads as the current truth, or hands it to another executor or gates (only while it is with its executor). A blocked task opens again.",
        inputSchema: { task: Ref, title: Title.optional(), brief: Brief.optional(), body: Body.optional(), executor: z.uuid().optional(), gates: z.array(z.string().max(40)).max(8).optional() },
      },
      async ({ task: ref, executor, gates, ...text }) =>
        run(async () => {
          const { agent, task } = await find(ref);
          if (task.departmentId !== agent.departmentId || !task.executorAgentId) throw refuse(403, 'task_not_yours', `#${task.number} is not a member task of your department.`);
          const next = executor !== undefined ? (await member(agent, executor)).id : undefined;
          const gateIds = gates !== undefined ? await gatesFor(agent, next ?? task.executorAgentId, gates) : undefined;
          const moved = await updateTask(ctx, agent.id, task.id, { ...text, executor: next, gates: gateIds });
          return { text: `Updated. ${await where(moved.task)}`, moved };
        }),
    );
  }

  if (job.agentKind !== 'worker') {
    server.registerTool(
      'report',
      {
        description: 'Closes a task you own that has no executor (a department task, a turn, a person\'s task): done with what came of it, or not done with what blocks it. Whoever gave it is told.',
        inputSchema: { task: Ref, done: z.boolean(), summary: z.string().trim().min(1).max(4000) },
      },
      async ({ task: ref, done, summary }) =>
        run(async () => {
          const { task } = await find(ref);
          const moved = await report(ctx, job.agentId, task.id, { done, summary });
          return { text: `Reported. ${await where(moved.task)}`, moved };
        }),
    );
    server.registerTool(
      'cancel_task',
      { description: 'Cancels a task you created, with every open task under it.', inputSchema: { task: Ref, why: z.string().trim().min(1).max(1000) } },
      async ({ task: ref, why }) =>
        run(async () => {
          const { task } = await find(ref);
          if (task.createdByAgentId !== job.agentId) throw refuse(403, 'task_not_yours', `#${task.number} was not created by you.`);
          return { text: `Cancelled #${task.number}.`, moved: await cancel(ctx, { agentId: job.agentId }, task.id, why) };
        }),
    );
  }

  if (job.agentKind !== 'orchestrator') {
    server.registerTool(
      'submit',
      {
        description: 'Hands your finished work on a task to its first gate (or closes it when it has none). summary: what you did; evidence: the command you ran and what it printed, the link, the check.',
        inputSchema: { task: Ref, summary: z.string().trim().min(1).max(4000), evidence: z.string().trim().min(1).max(4000) },
      },
      async ({ task: ref, summary, evidence }) =>
        run(async () => {
          const { task } = await find(ref);
          const moved = await submit(ctx, job.agentId, task.id, { summary, evidence });
          return { text: `Submitted. ${await where(moved.task)}`, moved };
        }),
    );
    server.registerTool(
      'blocked',
      { description: 'Tells your head you cannot go on with a task, and why. Your head answers by rewriting the task.', inputSchema: { task: Ref, why: z.string().trim().min(1).max(2000) } },
      async ({ task: ref, why }) =>
        run(async () => {
          const { task } = await find(ref);
          return { text: `Your head is told. ${task.title} waits.`, moved: await blocked(ctx, job.agentId, task.id, why) };
        }),
    );
    server.registerTool(
      'verdict',
      {
        description: 'Your verdict as the gate a task stands at: pass sends it to the next gate (or finishes it), changes sends it back to its executor. comment: your reasons, always.',
        inputSchema: { task: Ref, pass: z.boolean(), comment: z.string().trim().min(1).max(4000) },
      },
      async ({ task: ref, pass, comment: why }) =>
        run(async () => {
          const { task } = await find(ref);
          const moved = await verdict(ctx, job.agentId, task.id, { pass, comment: why });
          return { text: `Recorded. ${await where(moved.task)}`, moved };
        }),
    );
  }

  /* An employee of the head's department, or the head. */
  async function member(head: Agent, id: string): Promise<Agent> {
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, id), isNull(agents.removedAt)));
    if (!agent || agent.departmentId !== head.departmentId) throw refuse(403, 'task_not_yours', `${id} does not work in your department. Call company for its employees.`);
    return agent;
  }

  /* Gates by role id or employee id; left out, the department's gate roles that are hired, in their order. */
  async function gatesFor(head: Agent, executor: string, given: string[] | undefined): Promise<string[]> {
    const staff = await db.select().from(agents).where(and(eq(agents.departmentId, head.departmentId!), isNull(agents.removedAt))).orderBy(asc(agents.createdAt));
    const gate = (a: Agent) => (a.roleKey ? ctx.templates.roles.get(a.roleKey)?.gate : null) ?? null;
    if (given === undefined) {
      const seen = new Set<string>();
      return staff
        .filter(a => a.id !== executor && gate(a) !== null)
        .sort((a, b) => gate(a)! - gate(b)!)
        .filter(a => !seen.has(a.roleKey!) && seen.add(a.roleKey!))
        .map(a => a.id);
    }
    return given.map(g => {
      const found = /^[A-Z]{3}-[A-Z0-9]+$/.test(g) ? staff.find(a => a.roleKey === g && a.id !== executor) : staff.find(a => a.id === g);
      if (!found) throw refuse(400, 'task_invalid', `No one in your department can be the gate ${g}.`);
      return found.id;
    });
  }

  /* The parent the orchestrator names, or the open turn's task when he holds it. */
  async function parentFor(agent: Agent, ref: number | string | undefined): Promise<string | null> {
    if (ref !== undefined) return (await find(ref)).task.id;
    const [turn] = await db
      .select({ taskId: turns.taskId })
      .from(turns)
      .innerJoin(tasks, eq(tasks.id, turns.taskId))
      .where(and(eq(turns.companyId, job.companyId), eq(turns.status, 'open'), eq(tasks.assigneeAgentId, agent.id), notInArray(tasks.status, [...CLOSED])));
    return turn?.taskId ?? null;
  }

}
