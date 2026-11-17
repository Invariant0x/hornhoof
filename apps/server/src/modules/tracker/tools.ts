import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { goals, GOAL_STATUSES } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { refuse, taskSpot, type Task } from '../tasks/engine.js';
import { taskByRef } from '../tasks/views.js';
import type { Grant } from '../templates/load.js';
import type { ToolJob } from '../tools/job.js';
import { editTask, seenOf, type TaskEdit } from './edit.js';
import { createGoal, editGoal, goalViews, setGoalStatus, type GoalGuard } from './goals.js';
import { createPipeline, editPipeline, MAX_STAGES, pipelineViews, type PipelineGuard } from './pipelines.js';
import { placeOwner, spotOf } from './responsible.js';
import { goalServed } from './task-view.js';

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

/* What the tracker keeps of a task, as the task tools take it. */
const GoalRef = z.number().int().positive().describe('The number of the goal this work serves, as goals lists them. Work under a task serves the goal of the task above it and names none.');
export const TrackerFields = {
  goal: GoalRef.optional(),
  responsible: z.uuid().optional().describe("The person who answers for the result, as company lists people. Without one: the parent's, else the goal's, else the person who decides for the department."),
  why: z.string().trim().max(300).optional().describe('Why the work matters, in a short sentence people read.'),
  due: z.iso.datetime({ offset: true }).optional().describe('When it is due, if anyone set a date.'),
  pipeline: z.uuid().optional().describe("The department's pipeline it goes along, from goals. Its stage follows whoever holds it."),
  stage: z.uuid().optional().describe('The stage of that pipeline it stands in, when not where its holder stands.'),
};
type TrackerArgs = { goal?: number; responsible?: string; why?: string; due?: string; pipeline?: string; stage?: string };
/* The same in the engine's names; it fits both a new task and an edit. */
type TrackerGiven = { goalId?: string; responsiblePersonId?: string; why?: string; dueAt?: Date; pipelineId?: string; pipelineStageId?: string };

/* The goal of the company with this number. */
async function goalIdOf(ctx: Pick<Ctx, 'db'>, companyId: string, number: number): Promise<string> {
  const [goal] = await ctx.db.select({ id: goals.id }).from(goals).where(and(eq(goals.companyId, companyId), eq(goals.number, number)));
  if (!goal) throw refuse(404, 'goal_unknown', `There is no goal ${number}. Call goals for their numbers.`);
  return goal.id;
}

/* The tracker's part of what a task tool was given, in the engine's names. */
export async function trackerInputOf(ctx: Pick<Ctx, 'db'>, companyId: string, args: TrackerArgs): Promise<TrackerGiven> {
  return {
    ...(args.goal !== undefined ? { goalId: await goalIdOf(ctx, companyId, args.goal) } : {}),
    ...(args.responsible !== undefined ? { responsiblePersonId: args.responsible } : {}),
    ...(args.why !== undefined ? { why: args.why } : {}),
    ...(args.due !== undefined ? { dueAt: new Date(args.due) } : {}),
    ...(args.pipeline !== undefined ? { pipelineId: args.pipeline } : {}),
    ...(args.stage !== undefined ? { pipelineStageId: args.stage } : {}),
  };
}

export const hasTrackerFields = (args: TrackerArgs) => Object.values(pick(args)).some(v => v !== undefined);
const pick = ({ goal, responsible, why, due, pipeline, stage }: TrackerArgs): TrackerArgs => ({ goal, responsible, why, due, pipeline, stage });

/* An agent keeps goals and pipelines of its own department; the orchestrator, of any and of the company. */
const agentGuard = (job: ToolJob): GoalGuard & PipelineGuard => async spot => {
  if (job.agentKind === 'orchestrator') return;
  if (!spot.departmentId) throw new ApiError(403, 'forbidden', "Only the orchestrator sets the company's goals. Ask it, with the goal you propose.", 'company_scope_only');
  if (spot.departmentId !== job.departmentId && spot.parentId !== job.departmentId) throw refuse(403, 'not_your_department', 'This department is not yours. Ask its head.');
};

/* Readable refusals; anything else is a fault of Hornhoof's. */
async function told(fn: () => Promise<string>) {
  try {
    return say(await fn());
  } catch (err) {
    if (err instanceof ApiError) return say(err.message, true);
    throw err;
  }
}

const Stage = z.strictObject({
  key: z.string().trim().min(1).max(64).describe("A name for the stage within this call; an existing stage's id keeps it."),
  id: z.uuid().optional().describe('The id of an existing stage this one keeps.'),
  parent: z.string().trim().min(1).max(64).nullable().describe("The key of the stage it comes after, null for the first; forks are fine, joins are not."),
  name: z.string().trim().min(1).max(60),
  ownerRole: z.string().trim().min(1).max(40).optional().describe("The role that owns it, as company lists roles, like a role key of the department's roster."),
  ownerAgentId: z.uuid().optional().describe('Or one employee of the department who owns it.'),
});

/* The tracker's tools. Everyone reads goals; heads, the orchestrator and whoever keeps the tracker set goals and pipelines;
   only a keeper of the tracker tidies tasks, of its own department, and never touches who does the work or how it goes. */
export function registerTrackerTools(server: McpServer, ctx: Ctx, job: ToolJob, grants: ReadonlySet<Grant>): void {
  const keeper = grants.has('tracker');
  const actor = { agentId: job.agentId };
  server.registerTool(
    'goals',
    { description: "The company's goals with their progress, and the pipelines of your department (every department's for the orchestrator), each with its stages." },
    async () => told(async () => JSON.stringify({ goals: await goalViews(ctx, job.companyId), pipelines: await pipelineViews(ctx, job.companyId, job.agentKind === 'orchestrator' ? undefined : (job.departmentId ?? undefined)) })),
  );
  if (job.agentKind !== 'head' && job.agentKind !== 'orchestrator' && !keeper) return;
  const guard = agentGuard(job);
  /* A head and the orchestrator name anyone who reaches the goal's place; a keeper of the tracker only the person who
     decides for it or the one already on the goal, as on a task. */
  const namesOnGoal = async (departmentId: string | null, personId: string, current: string | null) => {
    if (job.agentKind === 'head' || job.agentKind === 'orchestrator' || personId === current) return;
    if (personId === (await placeOwner(ctx, job.companyId, await spotOf(ctx.db, job.companyId, departmentId)))) return;
    throw refuse(403, 'responsible_invalid', 'You may make responsible for a goal only the person who decides for its department or the one already on it. Ask the head to propose anyone else.');
  };

  server.registerTool(
    'set_goal',
    {
      description:
        "Creates a goal, or with goal changes one: a goal of your department, or with company a goal of the whole company (only the orchestrator). Set targets only as people agreed them; mark a goal reached or dropped only when its reports or its responsible person say so.",
      inputSchema: {
        goal: GoalRef.optional().describe('The goal to change, by number; without it a new goal is made.'),
        company: z.boolean().optional().describe("A goal of the whole company, not of a department."),
        department: z.uuid().optional().describe('The department of a new goal, for the orchestrator; others set goals of their own department.'),
        title: z.string().trim().min(1).max(120).optional(),
        why: z.string().trim().max(300).optional(),
        parent: GoalRef.nullable().optional().describe('The bigger goal this one is part of, by number, or null for none.'),
        responsible: z.uuid().optional().describe('The person who answers for it; without one, the person who decides for its place. A product manager names only that person or the one already on the goal.'),
        target: z.number().positive().nullable().optional().describe('A number to reach, like 500.'),
        current: z.number().min(0).nullable().optional().describe('Where it stands now, from the reports.'),
        unit: z.string().trim().max(40).optional().describe('What the number counts, like subscribers.'),
        due: z.iso.datetime({ offset: true }).nullable().optional(),
        status: z.enum(GOAL_STATUSES).optional(),
      },
    },
    async input =>
      told(async () => {
        const parentGoalId = input.parent === undefined ? undefined : input.parent === null ? null : await goalIdOf(ctx, job.companyId, input.parent);
        const change = { title: input.title, why: input.why, parentGoalId, responsiblePersonId: input.responsible, targetValue: input.target, currentValue: input.current, unit: input.unit, dueAt: input.due === undefined ? undefined : input.due === null ? null : new Date(input.due) };
        let id: string;
        if (input.goal === undefined) {
          if (!input.title) throw refuse(400, 'goal_invalid', 'A new goal needs a title.');
          const departmentId = input.company ? null : job.agentKind === 'orchestrator' ? (input.department ?? null) : job.departmentId;
          if (job.agentKind === 'orchestrator' && !input.company && !input.department) throw refuse(400, 'goal_invalid', 'Name the department of the goal, or say it is a goal of the company.');
          if (input.responsible) await namesOnGoal(departmentId, input.responsible, null);
          id = (await createGoal(ctx, job.companyId, actor, guard, { ...change, title: input.title, departmentId })).id;
          if (input.status && input.status !== 'active') await setGoalStatus(ctx, job.companyId, actor, guard, id, input.status, 0);
        } else {
          id = await goalIdOf(ctx, job.companyId, input.goal);
          const [now] = await ctx.db.select({ version: goals.version, departmentId: goals.departmentId, responsible: goals.responsiblePersonId }).from(goals).where(eq(goals.id, id));
          if (input.responsible) await namesOnGoal(now!.departmentId, input.responsible, now!.responsible);
          const edited = await editGoal(ctx, job.companyId, actor, guard, id, change, now!.version);
          if (input.status) await setGoalStatus(ctx, job.companyId, actor, guard, id, input.status, edited.version);
        }
        return JSON.stringify((await goalViews(ctx, job.companyId)).find(g => g.id === id));
      }),
  );

  server.registerTool(
    'set_pipeline',
    {
      description:
        "Creates a pipeline of your department, or with pipeline changes or archives one. A pipeline maps who hands work to whom: stages in a tree from the first, forks allowed, no joins, each owned by a role of the department or one of its employees. It creates and moves no work. Stages given replace the old ones: keep a stage by its id, and tasks on a stage left out go back to not started.",
      inputSchema: {
        pipeline: z.uuid().optional().describe('The pipeline to change, from goals; without it a new one is made.'),
        department: z.uuid().optional().describe('Its department, for the orchestrator; others keep pipelines of their own department.'),
        name: z.string().trim().min(1).max(80).optional(),
        why: z.string().trim().max(300).optional(),
        stages: z.array(Stage).max(MAX_STAGES).optional(),
        archived: z.literal(true).optional().describe('true archives it: it stays readable and takes no new work.'),
      },
    },
    async input =>
      told(async () => {
        let id: string;
        if (input.pipeline === undefined) {
          if (!input.name || !input.stages) throw refuse(400, 'pipeline_invalid', 'A new pipeline needs a name and its stages.');
          const departmentId = job.agentKind === 'orchestrator' ? input.department : (input.department ?? job.departmentId);
          if (!departmentId) throw refuse(400, 'pipeline_invalid', 'Name the department of the pipeline.');
          id = (await createPipeline(ctx, job.companyId, actor, guard, departmentId, { name: input.name, why: input.why ?? '', stages: input.stages })).id;
        } else {
          id = input.pipeline;
          await editPipeline(ctx, job.companyId, guard, id, { name: input.name, why: input.why, stages: input.stages, archived: input.archived || undefined });
        }
        return JSON.stringify((await pipelineViews(ctx, job.companyId)).find(p => p.id === id));
      }),
  );

  if (!keeper) return;
  server.registerTool(
    'tidy_task',
    {
      description:
        "Makes a task of your department clear for people: its title, brief, why, goal, pipeline and stage, and who answers for it, only the person who decides for the department or the one already responsible for its goal. Who does the work, its status, urgency, pause, waits and route stay with the head: ask the head when they look wrong. Nobody is woken.",
      inputSchema: {
        task: z.union([z.number().int().positive(), z.string().regex(/^#?\d+$/)]).describe('The task, by number, like 12.'),
        title: z.string().trim().min(1).max(120).optional(),
        brief: z.string().max(600).optional(),
        why: z.string().trim().max(300).optional(),
        goal: GoalRef.nullable().optional(),
        pipeline: z.uuid().nullable().optional(),
        stage: z.uuid().nullable().optional(),
        responsible: z.uuid().optional(),
      },
    },
    async input =>
      told(async () => {
        const task = await taskByRef(ctx, job.companyId, input.task);
        if (!task) throw refuse(404, 'task_unknown', `There is no task ${input.task}. Call tasks for yours.`);
        if (!job.departmentId || task.departmentId !== job.departmentId) throw refuse(403, 'not_your_department', `#${task.number} is not of your department. Its own product manager or head keeps it.`);
        const goalId = input.goal === undefined ? undefined : input.goal === null ? null : await goalIdOf(ctx, job.companyId, input.goal);
        if (input.responsible !== undefined) await requireNamable(ctx, task, input.responsible, goalId);
        const edit: TaskEdit = { title: input.title, brief: input.brief, why: input.why, goalId, responsiblePersonId: input.responsible, pipelineId: input.pipeline, pipelineStageId: input.stage };
        const row = await editTask(ctx, actor, task, edit, seenOf(task));
        return `#${row.number} reads "${row.title}" now.`;
      }),
  );
}

/* Whom a keeper of the tracker may make responsible for a task: the person who decides for its department, or the one
   already responsible for the goal it serves. */
async function requireNamable(ctx: Ctx, task: Task, personId: string, goalId: string | null | undefined): Promise<void> {
  if (personId === task.responsiblePersonId) return;
  if (personId === (await placeOwner(ctx, task.companyId, taskSpot(task)))) return;
  const served = goalId !== undefined ? goalId : await goalServed(ctx.db, task);
  if (served) {
    const [goal] = await ctx.db.select({ responsible: goals.responsiblePersonId }).from(goals).where(eq(goals.id, served));
    if (goal?.responsible === personId) return;
  }
  throw refuse(403, 'responsible_invalid', `You may make responsible for #${task.number} only the person who decides for its department or the one responsible for its goal. Ask the head to propose anyone else.`);
}
