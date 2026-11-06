import { RISK_CLASSES, WORK_KINDS } from '@hornhoof/protocol';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, asc, count, desc, eq, gte, inArray, isNull, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, DECISION_TOPICS, departments, jobs, requests, tasks, type DecisionTopic } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { ask, blocked, cancel, CLOSED, comment, createTask, gateLeads, inRepository, listed, openAfter, refuse, report, submit, taskSpot, updateTask, verdict, type Moved, type Task } from './engine.js';
import { requireBlockingGate } from './gate-triggers.js';
import { carriesFile, encodedHint } from './attachments.js';
import { Text } from './long-text.js';
import { agentSeesTask as sees, taskByRef, taskDetail, taskLines, type TaskDetail } from './views.js';
import { addTasks, editTurn, mergeTurn, planTurn, settle, tell, TURN_MESSAGES, turnName, turnRows } from './turns.js';
import { stopTurns, wakeAll } from './wake.js';
import { orchestratorOf } from '../conversation/queue.js';
import { appendOutgoing } from '../events/store.js';
import { personParty } from '../events/parties.js';
import { decisionPerson } from './decisions.js';
import { WaitInput, waitFor } from './external-wait.js';
import { pipelineReport } from './pipeline-report.js';
import { commitProof, proofLine } from '../testruns/commit-proof.js';
import { keptEvidence, noProofNote, taskEvidence } from '../testruns/evidence.js';
import { reviewContext, ReviewSha, ReviewSubmission } from './review-context.js';
import { pipelineFindings, reviewDetails } from './review-details.js';
import { ConfirmationInput, confirmFinding, IssueInput } from './review-findings.js';
import { bindReviewEvidence } from './review-verdict.js';

export type ToolJob = { id: string; companyId: string; agentId: string; agentKind: 'orchestrator' | 'head' | 'worker' };
type Agent = typeof agents.$inferSelect;

/* What one turn may do to others' work: tasks it creates and questions it puts to people. */
export const TURN_TASKS = 10;
export const TURN_QUESTIONS = 3;

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
/* Agents read role names in English, the language of their instructions. */
const english = (_k: string, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) && 'en' in v && 'ru' in v && Object.keys(v).length === 2 ? (v as { en: string }).en : v);
const json = (value: unknown) => say(JSON.stringify(value, english));

/* One task's answer stays within this, so a long log does not fill the agent's context. */
export const TASK_ANSWER = 40_000;

/* A task as an agent reads it: when it is too long, its oldest log lines are left out and counted. */
function fitted<T extends TaskDetail>(detail: T): string {
  const whole = JSON.stringify(detail, english);
  if (whole.length <= TASK_ANSWER) return whole;
  const sizes = detail.log.map(l => JSON.stringify(l, english).length + 1);
  let size = whole.length + ',"logLeftOut":000'.length;
  let drop = 0;
  while (drop < sizes.length && size > TASK_ANSWER) size -= sizes[drop++]!;
  return JSON.stringify({ ...detail, log: detail.log.slice(drop), logLeftOut: drop }, english);
}

const Ref = z.union([z.number().int().positive(), z.string().max(40)]).describe('The task number, like 12 or "#12", or its id.');
const Title = z.string().trim().min(1).max(120);
const Brief = z.string().max(600).describe('One to three sentences people read on the map and in the tracker.');
const Body = z.string().max(20000).describe('What every agent on the task reads: requirements, acceptance criteria (what the gates check), product, constraints. Rewrite it as the current truth.');
const After = z
  .array(Ref)
  .max(10)
  .describe('Tasks of this turn that must be done first, by number. The task waits, and its executor is woken by itself once the last of them is done.');
const IndependentPart = z.strictObject({ title: Title, brief: Brief, body: Body, executor: z.uuid() }).describe('The part that can start before the tasks in after finish, and who does it.');
const IndependentNone = z.string().trim().min(1).max(2000).describe('Why no independent part exists: one file author, a genuine dependency, or a release boundary.');
const WorkKind = z.enum(WORK_KINDS).describe('What kind of work it is: a bug, known behavior to build, an unknown path, or old code. The pipeline report counts by it.');
const RiskClass = z.enum(RISK_CLASSES).describe('What a mistake in it would cost: money, access, security, data, or none.');
const Improvement = z.uuid().describe("The improvement these tasks take into work after a person's instruction, from improvements.");

type Question = { kind: 'question' | 'approval' | 'choice'; text: string; topic?: DecisionTopic };

/* What people read of a question, and what its asker hears besides: an approval says what test runs say of its commit as it
   is asked, which the answer says again as it comes. */
async function questionWords(db: Ctx['db'], task: Task, question: string, commit?: string): Promise<{ text: string; told: string }> {
  if (!commit) return { text: question, told: '' };
  const said = proofLine(await commitProof(db, task, commit));
  return { text: `${question}\n\nHornhoof checked as this was asked. ${said}`, told: ` ${said}` };
}

/* Keep the outgoing question with the person responsible for its decision card. */
async function recordQuestion(ctx: Ctx, job: ToolJob, task: Task, { kind, text, topic }: Question): Promise<void> {
  const personId = await decisionPerson(ctx, job.companyId, { source: 'request', kind, topic: topic ?? null, spot: taskSpot(task) });
  await appendOutgoing(ctx, { ...job, jobId: job.id, text, to: await personParty(ctx, job.companyId, personId) });
}

const isDepartmentTurnParent = (parent: Task | null, departmentId: string | null): parent is Task =>
  !!parent && !parent.executorAgentId && !!parent.turnId && parent.departmentId === departmentId;

/* Whether a member task without explicit gates is checked by the review of the department's turn. */
async function turnReviewed(
  db: Ctx['db'],
  head: Agent,
  executor: Agent,
  parent: Task | null,
  input: { gates?: string[]; product?: string },
): Promise<boolean> {
  if (executor.teamId || input.gates !== undefined || !isDepartmentTurnParent(parent, head.departmentId)) return false;
  return inRepository(db, { departmentId: head.departmentId, productId: input.product ?? null });
}

/* The tools an agent gets for tasks, by its kind. Each one checks that the task is the agent's to move. */
export function registerTaskTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  const { db } = ctx;
  /* The orchestrator runs the company: it cancels and rewrites any task. */
  const boss = job.agentKind === 'orchestrator';
  const me = async (): Promise<Agent> => (await db.select().from(agents).where(eq(agents.id, job.agentId)))[0]!;
  const startedAt = async () => (await db.select({ at: jobs.startedAt }).from(jobs).where(eq(jobs.id, job.id)))[0]?.at ?? new Date(0);

  async function find(ref: number | string): Promise<{ agent: Agent; task: Task }> {
    const agent = await me();
    const task = await taskByRef(ctx, job.companyId, ref);
    if (!task || !sees(agent, task)) throw refuse(404, 'task_unknown', `There is no task ${ref} you can see. Call tasks for yours.`);
    return { agent, task };
  }

  /* What an agent writes on a task is words: a file goes on the task itself. */
  const plain = (task: Task, ...texts: string[]) => {
    if (texts.some(carriesFile)) throw refuse(400, 'task_invalid', encodedHint(task.number));
  };

  /* Runs a move, wakes whoever it needs and answers in a line; a refused move comes back as a readable error. A move that
     closed the last task of the open turn moves the company on to the next turn. */
  const run = (fn: () => Promise<{ text: string; moved?: Pick<Moved, 'wakes'> & { task?: Task } }>) =>
    fn().then(
      async ({ text, moved }) => {
        if (!moved) return say(text);
        const settled = moved.task ? await settle(ctx, moved.task) : null;
        const orchestrator = settled ? await orchestratorOf(ctx, job.companyId) : null;
        await wakeAll(ctx, tell(moved.wakes, settled, orchestrator?.id ?? null, moved.task?.id ?? '', job.agentId));
        return say(settled && orchestrator?.id === job.agentId ? `${text} ${settled.note}` : text);
      },
      (err: unknown) => {
        if (err instanceof ApiError) return say(err.message, true);
        throw err;
      },
    );

  async function where(t: Task): Promise<string> {
    const agent = await me();
    const [line] = await taskLines(ctx, [t], x => sees(agent, x));
    const holder = line?.assignee ? `, with ${line.assignee.name}` : '';
    return `#${t.number} is ${t.status}${holder}.${await waiting(t)}`;
  }

  /* Tasks another one comes after, named by number or id among the tasks the agent sees: the engine keeps them to its turn. */
  async function afterIds(refs: (number | string)[] | undefined): Promise<string[]> {
    const ids: string[] = [];
    const agent = refs?.length ? await me() : null;
    for (const ref of refs ?? []) {
      const t = await taskByRef(ctx, job.companyId, ref);
      if (!t || !sees(agent!, t)) throw refuse(404, 'task_unknown', `There is no task ${ref} to come after. Call turns or tasks for the numbers.`);
      ids.push(t.id);
    }
    return ids;
  }

  /* What a task still waits for, as a sentence for the tool's answer. */
  async function waiting(t: Task): Promise<string> {
    const open = await openAfter(db, t);
    return open.length ? ` It starts once ${listed(open)} ${open.length === 1 ? 'is' : 'are'} done.` : '';
  }

  async function underCap(agent: Agent, adding = 1): Promise<void> {
    const [made] = await db
      .select({ n: count() })
      .from(tasks)
      .where(and(eq(tasks.createdByAgentId, agent.id), gte(tasks.createdAt, await startedAt())));
    if (Number(made?.n ?? 0) + adding > TURN_TASKS) throw refuse(409, 'task_invalid', `One turn creates at most ${TURN_TASKS} tasks. Finish this turn and go on in the next.`);
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
      const holds = (t: Task) => t.assigneeAgentId === agent.id || t.panel.includes(agent.id);
      const mine = open.filter(t => sees(agent, t)).sort((a, b) => Number(holds(b)) - Number(holds(a)));
      return json(await taskLines(ctx, mine.slice(0, 40), t => sees(agent, t)));
    },
  );

  server.registerTool(
    'task',
    {
      description:
        'One task in full: its body (the current truth), gates and where it stands, subtasks, open questions and its log. A long log comes with its newest lines, and logLeftOut counts the older ones left out. ' +
        "testEvidence: its newest test runs, and in a review of a turn or a department's task of a turn those on the turn's branch, each with the exact commit it pinned and whether its branch still stands there. Only a run with proves true counts as evidence. review pins an immutable candidate and author receipts; review.quality is structured producer evidence or unavailable; gateCounts is labeled review-lifecycle. reviewPlan assigns task areas/common contracts and an integration reviewer. fixReview limits a repeat to its own original finding IDs and exact range. reviewFindings contains explicit confirmations and vendor provenance.",
      inputSchema: { task: Ref },
    },
    async ({ task: ref }) =>
      find(ref).then(
        async ({ agent, task }) => say(fitted({ ...await taskDetail(ctx, task, t => sees(agent, t)), ...await reviewDetails(db, task.id, agent.id) })),
        (err: unknown) => (err instanceof ApiError ? say(err.message, true) : Promise.reject(err)),
      ),
  );

  server.registerTool(
    'wait_for',
    {
      description: 'Waits on a task you hold for an employee or an external event. Name what you need in one line and give an ISO deadline at most two hours away. End your turn after this: no reminder or stuck request is sent while it waits. A comment, a message naming this task, or the deadline wakes you once.',
      inputSchema: { task: Ref, ...WaitInput.shape },
    },
    async ({ task: ref, ...input }) => run(async () => {
      const { task } = await find(ref);
      plain(task, input.reason);
      const moved = await waitFor(ctx, job.agentId, task.id, input);
      return { text: `#${task.number} waits for "${moved.task.externalWait!.reason}" until ${moved.task.externalWait!.until}. End this turn; you will be woken.`, moved };
    }),
  );

  server.registerTool(
    'comment',
    {
      description:
        "Adds a note to a task's log for everyone on it. Whoever gave out a member task that is blocked can answer it with a comment, " +
        'which opens it again and wakes its executor with your words. A comment from a person or another agent also ends an external wait and wakes its holder. To hand work on, use the task\'s own moves.',
      inputSchema: { task: Ref, text: Text.trim().min(1) },
    },
    async ({ task: ref, text }) =>
      run(async () => {
        const { task } = await find(ref);
        plain(task, text);
        const moved = await comment(ctx, { agentId: job.agentId }, task.id, text);
        return { text: moved.wakes.length ? `Noted on #${task.number}. It is open again, and its executor goes on with your answer.` : `Noted on #${task.number}.`, moved };
      }),
  );

  server.registerTool(
    'ask_person',
    {
      description:
        'Asks the people responsible for the task a question, (with commit) for approval of that exact commit before a release, or (with options) to pick one of 2 to 4 ways. The task waits; you are woken with the answer. ' +
        'Show what people judge instead of describing it: take screenshots, send each with the shell command `hh-attach FILE` and pass the ids it prints as images, or as an option\'s image. ' +
        'link: an https page where the work can be seen, like a branch comparison; an approval links its commit by itself. ' +
        'An approval tells you and the person which passed test run checked that very commit, or that none did. ' +
        `At most ${TURN_QUESTIONS} per turn; ask only what you cannot decide or find out yourself.`,
      inputSchema: {
        task: Ref,
        question: z.string().trim().min(1).max(2000),
        commit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
        images: z.array(z.uuid()).max(6).optional(),
        options: z.array(z.object({ label: z.string().trim().min(1).max(200), image: z.uuid().optional() })).max(4).optional(),
        link: z.url({ protocol: /^https$/ }).max(500).optional(),
        topic: z
          .enum(DECISION_TOPICS)
          .optional()
          .describe(
            'What it is about, which says who decides: task or employee for work of your department, which its own person answers; people, access, subscriptions, machines, repositories, public_link, updates or release for what only the CEO decides. Name it on every question; without it the CEO answers.',
          ),
      },
    },
    async ({ task: ref, question, commit, images, options, link, topic }) =>
      run(async () => {
        const { task } = await find(ref);
        plain(task, question);
        const [asked] = await db
          .select({ n: count() })
          .from(requests)
          .where(and(eq(requests.agentId, job.agentId), inArray(requests.kind, ['question', 'approval', 'choice']), gte(requests.createdAt, await startedAt())));
        if (Number(asked?.n ?? 0) >= TURN_QUESTIONS) throw refuse(409, 'task_invalid', `One turn asks people at most ${TURN_QUESTIONS} times.`);
        const kind = commit ? 'approval' : options?.length ? 'choice' : 'question';
        const ways = options?.map(o => ({ label: o.label, image: o.image ?? null }));
        const { text, told } = await questionWords(db, task, question, commit);
        const moved = await ask(ctx, job.agentId, task.id, { kind, text, ...(commit ? { commit } : {}), images, options: ways, link: link ?? null, topic });
        await recordQuestion(ctx, job, task, { kind, text, topic });
        return { text: `Asked. #${task.number} waits for a person's answer; you will be woken with it.${told}`, moved };
      }),
  );

  if (job.agentKind === 'orchestrator') {
    const Item = z.object({ department: z.uuid(), product: z.uuid().optional(), title: Title, brief: Brief, body: Body, workKind: WorkKind.optional(), riskClass: RiskClass.optional() });
    const Turn = z.number().int().positive().describe('The turn number, like 2.');
    const Words = z
      .number()
      .int()
      .min(1)
      .max(TURN_MESSAGES)
      .optional()
      .describe("How many of people's messages to you this comes from, counting back from the one you are answering, when the ask took several messages. 1 by default. They are kept with the turn word for word.");
    server.registerTool(
      'turns',
      { description: 'The last closed turn, the running turn and the planned ones in order, each with its title, main point and tasks, and where each task stands.', inputSchema: {} },
      async () => {
        const rows = (await turnRows(ctx, job.companyId)).filter((t, i, all) => t.status !== 'closed' || all[i + 1]?.status !== 'closed');
        const top = rows.length ? await db.select().from(tasks).where(and(inArray(tasks.turnId, rows.map(t => t.id)), isNull(tasks.parentId))).orderBy(asc(tasks.number)) : [];
        const agent = await me();
        const lines = await taskLines(ctx, top, t => sees(agent, t));
        return json(rows.map(t => ({ number: t.number, title: t.title || t.goal, goal: t.goal, status: t.status, tasks: lines.filter((_, i) => top[i]!.turnId === t.id) })));
      },
    );
    server.registerTool(
      'pipeline_report',
      {
        description:
          'How the pipeline went in a turn, for the company and by department: time from giving a task out to accepting it, the critical path apart from agent time, stages, waits by reason, returns, failures, interrupted turns, numbers by kind of task and test times. ' +
          'Each number comes with the previous turn and the baseline turn and its change in percent. By default the running turn, else the last that ran. A department with described false has no description to take its own numbers from.',
        inputSchema: { turn: Turn.optional() },
      },
      async ({ turn }) => run(async () => {
        const report = await pipelineReport(db, job.companyId, turn);
        const reviewFindings = await pipelineFindings(db, job.companyId, report);
        return { text: JSON.stringify({ ...report, reviewFindings }, english) };
      }),
    );
    server.registerTool(
      'plan_turn',
      {
        description:
          "Lays out a new turn: a short title, the main point in one or two sentences, and its tasks: one for each of the CEO's goals, for the one department that owns it end to end, " +
          "going to that department's head; no separate tasks for plans, contracts or proofs. " +
          'When no turn runs it starts at once; otherwise it waits after the planned turns and starts by itself when the turn before it is done. department and product ids from company.',
        inputSchema: { title: z.string().trim().min(1).max(80), goal: z.string().trim().min(1).max(600), tasks: z.array(Item), words: Words, improvement: Improvement.optional() },
      },
      async input =>
        run(async () => {
          await underCap(await me(), input.tasks.length);
          const moved = await planTurn(ctx, { companyId: job.companyId, agentId: job.agentId, jobId: job.id }, input);
          return { text: moved.text, moved };
        }),
    );
    server.registerTool(
      'add_tasks',
      {
        description:
          'Adds tasks to a turn that is not over. A new ask goes into the next planned turn, into the running turn only when the CEO says now. ' +
          'In the running turn they go to the heads at once, in a planned turn they wait for it to start. Work that does not belong to any planned turn goes into a new one with plan_turn.',
        inputSchema: { turn: Turn, tasks: z.array(Item), words: Words, improvement: Improvement.optional() },
      },
      async input =>
        run(async () => {
          await underCap(await me(), input.tasks.length);
          const moved = await addTasks(ctx, { companyId: job.companyId, agentId: job.agentId, jobId: job.id }, input.turn, input.tasks, input.words, input.improvement);
          return { text: moved.text, moved };
        }),
    );
    server.registerTool(
      'merge_turn',
      {
        description:
          'Merges a planned source turn into an existing open or planned target turn. Unfinished tasks keep their ids, trees, assignees, gates, results and history; they start once when the target is open. ' +
          'The source closes and its closed tasks stay there as history. Repeating the same merge is safe.',
        inputSchema: { source: Turn, target: Turn },
      },
      async input =>
        run(async () => {
          const moved = await mergeTurn(ctx, { companyId: job.companyId, agentId: job.agentId }, input.source, input.target);
          return { text: moved.text, moved };
        }),
    );
    server.registerTool(
      'edit_turn',
      { description: 'Gives a turn that is not over a new title or main point.', inputSchema: { turn: Turn, title: z.string().max(80).optional(), goal: z.string().max(600).optional() } },
      async input =>
        run(async () => {
          const turn = await editTurn(ctx, job.companyId, input.turn, input);
          return { text: `${turnName(turn)} now reads: ${turn.goal}` };
        }),
    );
  }

  if (job.agentKind === 'head') {
    server.registerTool(
      'create_task',
      {
        description:
          'Gives work to a member of your department: executor is an employee id from company. Name yourself only when no member can do it. gates are the reviewers it passes in order, as role ids (DEV-REV) or employee ids: ' +
          "leave them out for code in a repository under your department's task of the turn, which the review of the turn checks all at once; [] for research, reports, plans and docs; name one only where a change must not reach the turn's branch unchecked. Name a role once: one reviewer of each model of it checks the work at once there. Left out anywhere else, the department's first review stage. The executor never reviews its own work. parent: the department task it serves. after needs independentPart or independentNone.",
        inputSchema: { title: Title, brief: Brief, body: Body, executor: z.uuid(), gates: z.array(z.string().max(40)).max(8).optional(), parent: Ref.optional(), product: z.uuid().optional(), after: After.optional(), independentPart: IndependentPart.optional(), independentNone: IndependentNone.optional(), workKind: WorkKind.optional(), riskClass: RiskClass.optional() },
      },
      async input =>
        run(async () => {
          const agent = await me();
          await underCap(agent);
          const executor = await member(agent, input.executor);
          if (input.independentPart) await member(agent, input.independentPart.executor);
          if (input.product) {
            const [product] = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.id, input.product), eq(departments.parentId, agent.departmentId!)));
            if (!product) throw refuse(404, 'department_unknown', `${input.product} is not a product of your department.`);
          }
          const parent = input.parent !== undefined ? (await find(input.parent)).task : null;
          /* Code left without gates under the department's task of a turn waits for the review of the turn; other work left
             without them gets the department's first review stage. Sub-unit employees work outside the pipeline. */
          const inTurnReview = await turnReviewed(db, agent, executor, parent, input);
          const gates = inTurnReview || (executor.teamId && input.gates === undefined) ? [] : await gatesFor(agent, executor.id, input.gates);
          const after = await afterIds(input.after);
          const moved = await createTask(ctx, { agentId: agent.id }, { title: input.title, brief: input.brief, body: input.body, departmentId: agent.departmentId, productId: input.product ?? null, parentId: parent?.id ?? null, assigneeAgentId: executor.id, executor: true, gates, after, independentPart: input.independentPart, independentNone: input.independentNone, inTurnReview, workKind: input.workKind, riskClass: input.riskClass });
          return { text: `Created #${moved.task.number} for ${executor.name}${gates.length ? ` with ${gates.length} gate${gates.length > 1 ? 's' : ''}` : ''}.${await waiting(moved.task)}`, moved };
        }),
    );
  }

  if (job.agentKind !== 'worker') {
    server.registerTool(
      'update_task',
      {
        description: boss
          ? 'Rewrites any task that is not closed so it reads as the current truth, or hands a member task to another executor or gates of its department (only while it is with its executor). ' +
            'Whoever holds it is woken with the change. A blocked task opens again. after: the tasks of its turn it waits for from now on, [] to start it now.'
          : "Rewrites one of your department's member tasks so it reads as the current truth, or hands it to another executor or gates (only while it is with its executor). " +
            'A task waiting at a gate with nobody on to check it takes new gates from that gate on. A blocked task opens again. after: the tasks of its turn it waits for from now on, [] to start it now.',
        inputSchema: { task: Ref, title: Title.optional(), brief: Brief.optional(), body: Body.optional(), executor: z.uuid().optional(), gates: z.array(z.string().max(40)).max(8).optional(), after: After.optional(), independentPart: IndependentPart.optional(), independentNone: IndependentNone.optional(), workKind: WorkKind.optional(), riskClass: RiskClass.optional() },
      },
      async ({ task: ref, executor, gates, after, ...text }) =>
        run(async () => {
          const { agent, task } = await find(ref);
          if (!boss && (task.departmentId !== agent.departmentId || !task.executorAgentId)) throw refuse(403, 'task_not_yours', `#${task.number} is not a member task of your department.`);
          /* The orchestrator hands a task on within the task's own department, as its head would. */
          const head = boss ? { ...agent, departmentId: task.departmentId } : agent;
          if (head.departmentId === null && (executor !== undefined || gates !== undefined)) throw refuse(400, 'task_invalid', `#${task.number} has no executor or gates.`);
          const next = executor !== undefined ? (await member(head, executor)).id : undefined;
          if (text.independentPart) await member(head, text.independentPart.executor);
          const gateIds = gates !== undefined ? await gatesFor(head, next ?? task.executorAgentId!, gates) : undefined;
          const moved = await updateTask(ctx, agent.id, task.id, { ...text, executor: next, gates: gateIds, ...(after !== undefined ? { after: await afterIds(after) } : {}) });
          return { text: `Updated. ${await where(moved.task)}`, moved };
        }),
    );
    server.registerTool(
      'report',
      {
        description: 'Closes a task you own that has no executor (a department task, a turn, a person\'s task): done with what came of it, or not done with what blocks it. Whoever gave it is told.',
        inputSchema: { task: Ref, done: z.boolean(), summary: Text.trim().min(1) },
      },
      async ({ task: ref, done, summary }) =>
        run(async () => {
          const { task } = await find(ref);
          plain(task, summary);
          const moved = await report(ctx, job.agentId, task.id, { done, summary });
          return { text: `Reported. ${await where(moved.task)}`, moved };
        }),
    );
    server.registerTool(
      'cancel_task',
      { description: boss ? 'Cancels any task, with every open task under it.' : 'Cancels a task you created, with every open task under it.', inputSchema: { task: Ref, why: z.string().trim().min(1).max(1000) } },
      async ({ task: ref, why }) =>
        run(async () => {
          const { task } = await find(ref);
          if (!boss && task.createdByAgentId !== job.agentId) throw refuse(403, 'task_not_yours', `#${task.number} was not created by you.`);
          const moved = await cancel(ctx, { agentId: job.agentId }, task.id, why);
          await stopTurns(ctx, moved.closed, job.agentId);
          const left = moved.waiting.length
            ? ` ${listed(moved.waiting)} ${moved.waiting.length === 1 ? 'comes after it and still waits' : 'come after it and still wait'}: give ${moved.waiting.length === 1 ? 'it' : 'them'} what to wait for with update_task (after, [] to start now), or cancel ${moved.waiting.length === 1 ? 'it' : 'them'}.`
            : '';
          return { text: `Cancelled #${task.number}.${left}`, moved };
        }),
    );
  }

  if (job.agentKind !== 'orchestrator') {
    server.registerTool(
      'submit',
      {
        description: 'Hands your finished work on a task to its first gate (or closes it when it has none). summary: what you did; evidence: the command you ran and what it printed, the link, the check. Optional review.baseCommit pins the source range for your vertical task area; the server reads its head commit.',
        inputSchema: { task: Ref, summary: Text.trim().min(1), evidence: Text.trim().min(1), review: ReviewSubmission.optional() },
      },
      async ({ task: ref, summary, evidence, review }) =>
        run(async () => {
          const { task } = await find(ref);
          plain(task, summary, evidence);
          const moved = await submit(ctx, job.agentId, task.id, { summary, evidence, review });
          return { text: `Submitted. ${await where(moved.task)}`, moved };
        }),
    );
    server.registerTool(
      'blocked',
      { description: 'Tells your head you cannot go on with a task, and why. Your head answers by rewriting the task.', inputSchema: { task: Ref, why: z.string().trim().min(1).max(2000) } },
      async ({ task: ref, why }) =>
        run(async () => {
          const { task } = await find(ref);
          plain(task, why);
          return { text: `Your head is told. ${task.title} waits.`, moved: await blocked(ctx, job.agentId, task.id, why) };
        }),
    );
    server.registerTool(
      'verdict',
      {
        description:
          'Your verdict as the gate a task stands at: pass sends it to the next gate (or finishes it), changes sends it back to its executor. comment: your reasons, always. findings: how many separate problems your comment names, 0 when there are none. reviewedCommit names the pinned candidate. issues records category/blocking/path/line/harm and taskId for a vertical area. Only original blocking security/data/spec findings get a same-reviewer fix look; repeats add no new issues. Legacy findings is not a confirmed count. Its log retains run/commit provenance.',
        inputSchema: { task: Ref, pass: z.boolean(), comment: Text.trim().min(1), findings: z.number().int().min(0).max(99).optional(), reviewedCommit: ReviewSha.optional(), issues: z.array(IssueInput).max(99).optional() },
      },
      async ({ task: ref, pass, comment: why, findings, reviewedCommit, issues }) =>
        run(async () => {
          const { task } = await find(ref);
          plain(task, why);
          const review = await reviewContext(ctx.db, task.id);
          const evidence = bindReviewEvidence(await taskEvidence(ctx, task), review?.commit ?? null);
          const moved = await verdict(ctx, job.agentId, task.id, { pass, comment: why, findings, reviewedCommit, issues, evidence: keptEvidence(evidence) });
          return { text: `Recorded. ${await where(moved.task)}${noProofNote(evidence, pass)}`, moved };
        }),
    );
    server.registerTool(
      'confirm_finding',
      { description: 'The actual area author or its head explicitly confirms or rejects a structured finding. Read its findingId and revision from task.reviewFindings. An author must name its current exact fixCommit; a head may confirm existence before a fix. This records existence only; it never passes a gate or removes a blocking finding. History and vendor counts retain provenance.', inputSchema: { task: Ref, ...ConfirmationInput.shape } },
      async ({ task: ref, ...input }) => run(async () => {
        const { task } = await find(ref);
        await confirmFinding(ctx, job.agentId, task, input);
        return { text: 'The finding confirmation is recorded; its gate and fix status are unchanged.' };
      }),
    );
  }

  /* An employee of the head's department, or the head. */
  async function member(head: Agent, id: string): Promise<Agent> {
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, id), isNull(agents.removedAt)));
    if (!agent || agent.departmentId !== head.departmentId) throw refuse(403, 'task_not_yours', `${id} does not work in your department. Call company for its employees.`);
    return agent;
  }

  /* Gates by role id or employee id. Left out, the department's first gate role that is hired. */
  async function gatesFor(head: Agent, executor: string, given: string[] | undefined): Promise<string[]> {
    if (given === undefined) return (await gateLeads(db, ctx.templates, head.departmentId!, executor)).slice(0, 1);
    const staff = await db.select().from(agents).where(and(eq(agents.departmentId, head.departmentId!), isNull(agents.removedAt), isNull(agents.teamId))).orderBy(asc(agents.createdAt));
    return given.map(g => {
      const role = (a: Agent) => a.roleKey === g && a.id !== executor;
      const found = /^[A-Z]{3}-[A-Z0-9]+$/.test(g) ? (staff.find(a => role(a) && !a.switchedOffAt) ?? staff.find(role)) : staff.find(a => a.id === g);
      if (!found) throw refuse(400, 'task_invalid', `No one in your department can be the gate ${g}.`);
      requireBlockingGate(ctx.templates, found.roleKey);
      return found.id;
    });
  }
}
