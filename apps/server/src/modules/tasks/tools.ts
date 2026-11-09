import { Verification } from './echelons-tests.js';
import { AcceptanceInput } from './echelons-accept.js';
import { RISK_CLASSES, WORK_KINDS } from '@hornhoof/protocol';
import { WaitOwnerBinding, WaitPlan } from '@hornhoof/protocol/waits';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, asc, count, desc, eq, gte, inArray, isNull, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, DECISION_TOPICS, departments, jobs, requests, tasks, type DecisionTopic } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { ask, blocked, cancel, CLOSED, comment, createTask, listed, openAfter, refuse, report, submit, taskSpot, updateTask, verdict, type Moved, type Task } from './engine.js';
import { replanWait } from './wait-state.js';
import { carriesFile, encodedHint } from './attachments.js';
import { Text } from './long-text.js';
import { agentSeesTask as sees, taskByRef, taskDetail, taskLines, type TaskDetail } from './views.js';
import { addTasks, editTurn, mergeTurn, planTurn, settle, tell, TURN_MESSAGES, turnName, turnRows } from './turns.js';
import { setUrgent } from './urgency.js';
import { answersCeoOrDelegate } from '../conversation/decision-context.js';
import { ONLY_CEO } from '../tools/control.js';
import { stopTurns, wakeAll } from './wake.js';
import { resolveStuckComment } from './stuck.js';
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
type ToolMoveResult = { text: string; moved?: Pick<Moved, 'wakes'> & { task?: Task } };

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
const AfterPlans = z.array(z.strictObject({ task: Ref, plan: WaitPlan })).max(10).describe('Who answers by when for a task in after, where someone promised dates. Without one the department\'s dates stand; a department that sets dates and has none for this refuses the task.');
const AskPlan = WaitPlan.optional().describe('Who answers by when, where someone promised dates. Without one the department\'s dates stand, and with none set the question waits with no dates.');
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

const TurnItem = z.object({ department: z.uuid(), product: z.uuid().optional(), title: Title, brief: Brief, body: Body, workKind: WorkKind.optional(), riskClass: RiskClass.optional(), urgent: z.boolean().optional().describe('The CEO says this work is urgent, in the turn that answers them. Work under it is too. Never from its title or an employee.') });
const Turn = z.number().int().positive().describe('The turn number, like 2.');
const TurnWords = z
  .number()
  .int()
  .min(1)
  .max(TURN_MESSAGES)
  .optional()
  .describe("How many of people's messages to you this comes from, counting back from the one you are answering, when the ask took several messages. 1 by default. They are kept with the turn word for word.");

/* The tools an agent gets for tasks, by its kind. Each one checks that the task is the agent's to move. */
export function registerTaskTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  new TaskTools(server, ctx, job).register();
}

class TaskTools {
  private readonly db: Ctx['db'];
  private readonly boss: boolean;

  constructor(private readonly server: McpServer, private readonly ctx: Ctx, private readonly job: ToolJob) {
    this.db = ctx.db;
    this.boss = job.agentKind === 'orchestrator';
  }

  register(): void {
    this.registerTasks();
    this.registerTask();
    this.registerWaitFor();
    this.registerComment();
    this.registerReplanWait();
    this.registerAskPerson();
    this.registerReport();
    if (this.job.agentKind === 'orchestrator') this.registerTurnTools();
    if (this.job.agentKind === 'head') this.registerCreateTask();
    if (this.job.agentKind !== 'worker') this.registerManagementTools();
    if (this.job.agentKind !== 'orchestrator') this.registerExecutionTools();
  }

  private registerTurnTools(): void {
    this.registerTurns();
    this.registerPipelineReport();
    this.registerPlanTurn();
    this.registerAddTasks();
    this.registerSetUrgent();
    this.registerMergeTurn();
    this.registerEditTurn();
  }

  private registerManagementTools(): void {
    this.registerUpdateTask();
    this.registerCancelTask();
  }

  private registerExecutionTools(): void {
    this.registerSubmit();
    this.registerBlocked();
    this.registerVerdict();
    this.registerConfirmFinding();
  }

  private async me(): Promise<Agent> { return (await this.db.select().from(agents).where(eq(agents.id, this.job.agentId)))[0]!; }

  private async startedAt(): Promise<Date> { return (await this.db.select({ at: jobs.startedAt }).from(jobs).where(eq(jobs.id, this.job.id)))[0]?.at ?? new Date(0); }

  /* Find only a task the agent can see. */
  private async find(ref: number | string): Promise<{ agent: Agent; task: Task }> {
    const agent = await this.me();
    const task = await taskByRef(this.ctx, this.job.companyId, ref);
    if (!task || !sees(agent, task)) throw refuse(404, 'task_unknown', `There is no task ${ref} you can see. Call tasks for yours.`);
    return { agent, task };
  }

  private async where(t: Task): Promise<string> {
    const agent = await this.me();
    const [line] = await taskLines(this.ctx, [t], x => sees(agent, x));
    const holder = line?.assignee ? `, with ${line.assignee.name}` : '';
    return `#${t.number} is ${t.status}${holder}.${await this.waiting(t)}`;
  }

  /* Resolve dependencies among the tasks the agent sees; the engine keeps them to its turn. */
  private async afterIds(refs: (number | string)[] | undefined): Promise<string[]> {
    const ids: string[] = [];
    const agent = refs?.length ? await this.me() : null;
    for (const ref of refs ?? []) {
      const t = await taskByRef(this.ctx, this.job.companyId, ref);
      if (!t || !sees(agent!, t)) throw refuse(404, 'task_unknown', `There is no task ${ref} to come after. Call turns or tasks for the numbers.`);
      ids.push(t.id);
    }
    return ids;
  }

  /* Keep promised dates keyed by the dependency id the engine knows. */
  private async afterPlansOf(given: { task: number | string; plan: WaitPlan }[] | undefined): Promise<Record<string, WaitPlan> | undefined> {
    if (!given) return undefined;
    const ids = await this.afterIds(given.map(g => g.task));
    return Object.fromEntries(given.map((g, i) => [ids[i]!, g.plan]));
  }

  /* What a task still waits for, as a sentence for the tool's answer. */
  private async waiting(t: Task): Promise<string> {
    const open = await openAfter(this.db, t);
    return open.length ? ` It starts once ${listed(open)} ${open.length === 1 ? 'is' : 'are'} done.` : '';
  }

  private async underCap(agent: Agent, adding = 1): Promise<void> {
    const [made] = await this.db
      .select({ n: count() })
      .from(tasks)
      .where(and(eq(tasks.createdByAgentId, agent.id), gte(tasks.createdAt, await this.startedAt())));
    if (Number(made?.n ?? 0) + adding > TURN_TASKS) throw refuse(409, 'task_invalid', `One turn creates at most ${TURN_TASKS} tasks. Finish this turn and go on in the next.`);
  }

  /* An employee of the head's department, or the head. */
  private async member(head: Agent, id: string): Promise<Agent> {
    const [agent] = await this.db.select().from(agents).where(and(eq(agents.id, id), isNull(agents.removedAt)));
    if (!agent || agent.departmentId !== head.departmentId) throw refuse(403, 'task_not_yours', `${id} does not work in your department. Call company for its employees.`);
    return agent;
  }

  /* A file goes on the task itself; tool text stays plain. */
  private plain(task: Task, ...texts: string[]): void {
    if (texts.some(carriesFile)) throw refuse(400, 'task_invalid', encodedHint(task.number));
  }

  /* Apply a move, settle its turn and wake its next owners; return readable refusals. */
  private run(fn: () => Promise<ToolMoveResult>): Promise<ReturnType<typeof say>> {
    return fn().then(
      result => this.movedReply(result),
      (err: unknown) => {
        if (err instanceof ApiError) return say(err.message, true);
        throw err;
      },
    );
  }

  private async movedReply({ text, moved }: ToolMoveResult): Promise<ReturnType<typeof say>> {
    if (!moved) return say(text);
    const settled = moved.task ? await settle(this.ctx, moved.task) : null;
    const orchestrator = settled ? await orchestratorOf(this.ctx, this.job.companyId) : null;
    await wakeAll(this.ctx, tell(moved.wakes, settled, orchestrator?.id ?? null, moved.task?.id ?? '', this.job.agentId));
    return say(this.settledReply(text, settled, orchestrator?.id));
  }

  private settledReply(text: string, settled: Awaited<ReturnType<typeof settle>>, orchestratorId: string | undefined): string {
    return settled && orchestratorId === this.job.agentId ? `${text} ${settled.note}` : text;
  }

  /* Only the CEO or delegate answered in this turn can make work urgent. */
  private async forCeoAlone(): Promise<void> {
    if (!(await answersCeoOrDelegate(this.db, this.job.id))) throw refuse(403, 'urgent_not_allowed', ONLY_CEO);
  }

  private async urgentFromCeo(items: { urgent?: boolean | undefined }[]): Promise<void> {
    if (items.some(item => item.urgent)) await this.forCeoAlone();
  }

  private async underQuestionCap(): Promise<void> {
    const [asked] = await this.db
      .select({ n: count() })
      .from(requests)
      .where(and(eq(requests.agentId, this.job.agentId), inArray(requests.kind, ['question', 'approval', 'choice']), gte(requests.createdAt, await this.startedAt())));
    if (Number(asked?.n ?? 0) >= TURN_QUESTIONS) throw refuse(409, 'task_invalid', `One turn asks people at most ${TURN_QUESTIONS} times.`);
  }

  private async checkProduct(agent: Agent, id: string | undefined): Promise<void> {
    if (!id) return;
    const [product] = await this.db.select({ id: departments.id }).from(departments).where(and(eq(departments.id, id), eq(departments.parentId, agent.departmentId!)));
    if (!product) throw refuse(404, 'department_unknown', `${id} is not a product of your department.`);
  }

  private async createdTaskText(task: Task, executor: Agent): Promise<string> {
    return `Created #${task.number} for ${executor.name}.${await this.waiting(task)}`;
  }

  private registerTasks(): void {
    this.server.registerTool(
      'tasks',
      { description: 'Your open tasks first, then the other open tasks you can see: number, title, brief, state, who holds it.', inputSchema: {} },
      async () => {
        const agent = await this.me();
        const open = await this.db
          .select()
          .from(tasks)
          .where(and(eq(tasks.companyId, this.job.companyId), notInArray(tasks.status, [...CLOSED])))
          .orderBy(desc(tasks.number))
          .limit(200);
        const holds = (t: Task) => t.assigneeAgentId === agent.id;
        const mine = open.filter(t => sees(agent, t)).sort((a, b) => Number(holds(b)) - Number(holds(a)));
        return json(await taskLines(this.ctx, mine.slice(0, 40), t => sees(agent, t)));
      },
    );
  }

  private registerTask(): void {
    this.server.registerTool(
      'task',
      {
        description:
          'One task in full: its body (the current truth), gates and where it stands, subtasks, open questions and its log. A long log comes with its newest lines, and logLeftOut counts the older ones left out. ' +
          "task.echelons is the required ordered route and current owner. Candidates and producing identities are immutable. Review and Security own their repairs in the same branch; optional Cleanup follows Review only when the head enabled it. review contains exact author receipts and quality evidence or unavailable; testEvidence proves only its exact current commit. echelonFindings contains deduplicated stage findings and independent confirmations.",
        inputSchema: { task: Ref },
      },
      async ({ task: ref }) =>
        this.find(ref).then(
          async ({ agent, task }) => say(fitted({ ...await taskDetail(this.ctx, task, t => sees(agent, t)), ...await reviewDetails(this.db, task.id) })),
          (err: unknown) => (err instanceof ApiError ? say(err.message, true) : Promise.reject(err)),
        ),
    );
  }

  private registerWaitFor(): void {
    this.server.registerTool(
      'wait_for',
      {
        description: 'Waits on a task you hold for an employee or an external event. Name what you need in one line and give an ISO deadline at most two hours away. End your turn after this: no reminder or stuck request is sent while it waits. A comment, a message naming this task, or the deadline wakes you once.',
        inputSchema: { task: Ref, ...WaitInput.shape },
      },
      async ({ task: ref, ...input }) => this.run(async () => {
        const { task } = await this.find(ref);
        this.plain(task, input.reason);
        const moved = await waitFor(this.ctx, this.job.agentId, task.id, input);
        return { text: `#${task.number} waits for "${moved.task.externalWait!.reason}" until ${moved.task.externalWait!.until}. End this turn; you will be woken.`, moved };
      }),
    );
  }

  private registerComment(): void {
    this.server.registerTool(
      'comment',
      {
        description:
          "Adds a note to a task's log for everyone on it. Whoever gave out a member task that is blocked can answer it with a comment, " +
          'which opens it again and wakes its executor with your words. A comment from a person or another agent also ends an external wait and wakes its holder. ' +
          'The current head or orchestrator resolves its internal stuck request with a comment. To hand work on, use the task\'s own moves.',
        inputSchema: { task: Ref, text: Text.trim().min(1) },
      },
      async ({ task: ref, text }) =>
        this.run(async () => {
          const { task } = await this.find(ref);
          this.plain(task, text);
          const moved = (await resolveStuckComment(this.ctx, this.job, task.id, text)) ?? (await comment(this.ctx, { agentId: this.job.agentId }, task.id, text));
          return { text: moved.wakes.length ? `Noted on #${task.number}. It is open again, and its executor goes on with your answer.` : `Noted on #${task.number}.`, moved };
        }),
    );
  }

  private registerReplanWait(): void {
    this.server.registerTool(
      'replan_wait',
      {
        description:
          'Gives a wait on a task (its id in waits, from task) a new owner or new dates, for someone who answers for it: its owner, its head or the orchestrator. Also the way to give a wait with no plan its first dates. Dates moved stay on record. Say whose promise they are in plan.provenance, and only dates someone really promised.',
        inputSchema: { wait: z.uuid(), expectedGeneration: z.number().int().positive(), owner: WaitOwnerBinding.optional(), plan: WaitPlan.optional(), reason: z.string().trim().min(1).max(600) },
      },
      async ({ wait, expectedGeneration, owner, plan, reason }) =>
        this.run(async () => {
          const kept = await this.db.transaction(tx => replanWait(tx, { waitId: wait, expectedGeneration, ...(owner ? { ownerBinding: owner } : {}), ...(plan ? { plan } : {}), reason, actor: { agentId: this.job.agentId } }));
          const { task } = await this.find(kept.taskId);
          return { text: `The wait on #${task.number} is at generation ${kept.generation}, due ${kept.nextActionAt?.toISOString() ?? 'with no date'}.`, moved: { task, wakes: [] } };
        }),
    );
  }

  private registerAskPerson(): void {
    this.server.registerTool(
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
          plan: AskPlan,
          topic: z
            .enum(DECISION_TOPICS)
            .optional()
            .describe(
              'What it is about, which says who decides: task or employee for work of your department, which its own person answers; people, access, subscriptions, machines, repositories, public_link, updates or release for what only the CEO decides. Name it on every question; without it the CEO answers.',
            ),
        },
      },
      async ({ task: ref, question, commit, images, options, link, topic, plan }) =>
        this.run(async () => {
          const { task } = await this.find(ref);
          this.plain(task, question);
          await this.underQuestionCap();
          const kind = commit ? 'approval' : options?.length ? 'choice' : 'question';
          const ways = options?.map(o => ({ label: o.label, image: o.image ?? null }));
          const { text, told } = await questionWords(this.db, task, question, commit);
          const moved = await ask(this.ctx, this.job.agentId, task.id, { kind, text, ...(commit ? { commit } : {}), images, options: ways, link: link ?? null, topic, ...(plan ? { plan } : {}) });
          await recordQuestion(this.ctx, this.job, task, { kind, text, topic });
          return { text: `Asked. #${task.number} waits for a person's answer; you will be woken with it.${told}`, moved };
        }),
    );
  }

  private registerTurns(): void {
    this.server.registerTool(
      'turns',
      { description: 'The last closed turn, the running turn and the planned ones in order, each with its title, main point and tasks, and where each task stands.', inputSchema: {} },
      async () => {
        const rows = (await turnRows(this.ctx, this.job.companyId)).filter((t, i, all) => t.status !== 'closed' || all[i + 1]?.status !== 'closed');
        const top = rows.length ? await this.db.select().from(tasks).where(and(inArray(tasks.turnId, rows.map(t => t.id)), isNull(tasks.parentId))).orderBy(asc(tasks.number)) : [];
        const agent = await this.me();
        const lines = await taskLines(this.ctx, top, t => sees(agent, t));
        return json(rows.map(t => ({ number: t.number, title: t.title || t.goal, goal: t.goal, status: t.status, tasks: lines.filter((_, i) => top[i]!.turnId === t.id) })));
      },
    );
  }

  private registerPipelineReport(): void {
    this.server.registerTool(
      'pipeline_report',
      {
        description:
          'How the pipeline went in a turn, for the company and by department: time from giving a task out to accepting it, the critical path apart from agent time, stages, waits by reason, returns, failures, interrupted turns, numbers by kind of task and test times. ' +
          'Each number comes with the previous turn and the baseline turn and its change in percent. By default the running turn, else the last that ran. A department with described false has no description to take its own numbers from.',
        inputSchema: { turn: Turn.optional() },
      },
      async ({ turn }) => this.run(async () => {
        const report = await pipelineReport(this.db, this.job.companyId, turn);
        const reviewFindings = await pipelineFindings(this.db, this.job.companyId, report);
        return { text: JSON.stringify({ ...report, reviewFindings }, english) };
      }),
    );
  }

  private registerPlanTurn(): void {
    this.server.registerTool(
      'plan_turn',
      {
        description:
          "Lays out a new turn: a short title, the main point in one or two sentences, and its tasks: one for each of the CEO's goals, for the one department that owns it end to end, " +
          "going to that department's head; no separate tasks for plans, contracts or proofs. " +
          'When no turn runs it starts at once; otherwise it waits after the planned turns and starts by itself when the turn before it is done. department and product ids from company.',
        inputSchema: { title: z.string().trim().min(1).max(80), goal: z.string().trim().min(1).max(600), tasks: z.array(TurnItem), words: TurnWords, improvement: Improvement.optional() },
      },
      async input =>
        this.run(async () => {
          await this.underCap(await this.me(), input.tasks.length);
          await this.urgentFromCeo(input.tasks);
          const moved = await planTurn(this.ctx, { companyId: this.job.companyId, agentId: this.job.agentId, jobId: this.job.id }, input);
          return { text: moved.text, moved };
        }),
    );
  }

  private registerAddTasks(): void {
    this.server.registerTool(
      'add_tasks',
      {
        description:
          'Adds tasks to a turn that is not over. Follow the shared admission rule in hh-lead-tasks. ' +
          'In the running turn they go to the heads at once, in a planned turn they wait for it to start. Work that does not belong to any planned turn goes into a new one with plan_turn.',
        inputSchema: { turn: Turn, tasks: z.array(TurnItem), words: TurnWords, improvement: Improvement.optional() },
      },
      async input =>
        this.run(async () => {
          await this.underCap(await this.me(), input.tasks.length);
          await this.urgentFromCeo(input.tasks);
          const moved = await addTasks(this.ctx, { companyId: this.job.companyId, agentId: this.job.agentId, jobId: this.job.id }, input.turn, input.tasks, input.words, input.improvement);
          return { text: moved.text, moved };
        }),
    );
  }

  private registerSetUrgent(): void {
    this.server.registerTool(
      'set_urgent',
      {
        description:
          'Says whether a task with nothing above it is urgent, with all the work under it: only when the CEO or the CEO delegate says so, in the turn that answers them, and never from a task\'s title or an employee. Nobody is woken and nothing else of the work changes.',
        inputSchema: { task: Ref, urgent: z.boolean() },
      },
      async ({ task: ref, urgent }) =>
        this.run(async () => {
          await this.forCeoAlone();
          const { agent, task } = await this.find(ref);
          const moved = await setUrgent(this.ctx, { agentId: agent.id }, task.id, urgent);
          return { text: `#${moved.task.number} is ${urgent ? 'urgent' : 'not urgent'} now, with all the work under it.`, moved };
        }),
    );
  }

  private registerMergeTurn(): void {
    this.server.registerTool(
      'merge_turn',
      {
        description:
          'Merges a planned source turn into an existing open or planned target turn. Unfinished tasks keep their ids, trees, assignees, gates, results and history; they start once when the target is open. ' +
          'The source closes and its closed tasks stay there as history. Repeating the same merge is safe.',
        inputSchema: { source: Turn, target: Turn },
      },
      async input =>
        this.run(async () => {
          const moved = await mergeTurn(this.ctx, { companyId: this.job.companyId, agentId: this.job.agentId }, input.source, input.target);
          return { text: moved.text, moved };
        }),
    );
  }

  private registerEditTurn(): void {
    this.server.registerTool(
      'edit_turn',
      { description: 'Gives a turn that is not over a new title or main point.', inputSchema: { turn: Turn, title: z.string().max(80).optional(), goal: z.string().max(600).optional() } },
      async input =>
        this.run(async () => {
          const turn = await editTurn(this.ctx, this.job.companyId, input.turn, input);
          return { text: `${turnName(turn)} now reads: ${turn.goal}` };
        }),
    );
  }

  private registerCreateTask(): void {
    this.server.registerTool(
      'create_task',
      {
        description: 'Assigns one whole result in your department. Code always follows Architecture (unless small), Development, Review, risk-based Security, then Tests on the final candidate. Coordination has only a checked report over accepted child results. Optional Cleanup is enabled only by the head and runs after Review. Scope repository paths explicitly; checker ids are optional, otherwise eligible skill owners are selected. Without an explicit result kind, a repository means code; work without a repository finishes with a checked report and no invented Git candidate.',
        inputSchema: { title: Title, brief: Brief, body: Body, executor: z.uuid(), resultKind: z.enum(['code', 'coordination']).optional(), reviewerAgentId: z.uuid().optional(), securityAgentId: z.uuid().optional(), testsAgentId: z.uuid().optional(), cleanup: z.boolean().optional(), paths: z.array(z.string().min(1).max(500)).max(100).optional(), parent: Ref.optional(), product: z.uuid().optional(), after: After.optional(), afterPlans: AfterPlans.optional(), independentPart: IndependentPart.optional(), independentNone: IndependentNone.optional(), workKind: WorkKind.optional(), riskClass: RiskClass.optional(), small: z.boolean().optional() },
      },
      async input =>
        this.run(async () => {
          const agent = await this.me();
          await this.underCap(agent);
          const executor = await this.member(agent, input.executor);
          if (input.independentPart) await this.member(agent, input.independentPart.executor);
          await this.checkProduct(agent, input.product);
          const parent = input.parent !== undefined ? (await this.find(input.parent)).task : null;
          const after = await this.afterIds(input.after);
          const moved = await createTask(this.ctx, { agentId: agent.id }, { title: input.title, brief: input.brief, body: input.body, departmentId: agent.departmentId, productId: input.product ?? null, parentId: parent?.id ?? null, assigneeAgentId: executor.id, executor: input.resultKind !== 'coordination', resultKind: input.resultKind, reviewerAgentId: input.reviewerAgentId, securityAgentId: input.securityAgentId, testsAgentId: input.testsAgentId, cleanup: input.cleanup, paths: input.paths, after, afterPlans: await this.afterPlansOf(input.afterPlans), independentPart: input.independentPart, independentNone: input.independentNone, workKind: input.workKind, riskClass: input.riskClass, small: input.small });
          return { text: await this.createdTaskText(moved.task, executor), moved };
        }),
    );
  }

  private registerUpdateTask(): void {
    this.server.registerTool('update_task', {
      description: 'The department head revises the current task or checking owner without returning it to the author. An eligible owner resumes a waiting stage on its current candidate. Optional Cleanup is decided before Review hands forward; cleanupForTurn applies the same explicit choice to this department in the turn, including new tasks.',
      inputSchema: { task: Ref, title: Title.optional(), brief: Brief.optional(), body: Body.optional(), executor: z.uuid().optional(), ownerAgentId: z.uuid().optional(), paths: z.array(z.string().min(1).max(500)).max(100).optional(), cleanup: z.boolean().optional(), cleanupForTurn: z.boolean().optional(), after: After.optional(), afterPlans: AfterPlans.optional(), independentPart: IndependentPart.optional(), independentNone: IndependentNone.optional(), workKind: WorkKind.optional(), riskClass: RiskClass.optional(), small: z.boolean().optional() },
    }, async ({ task: ref, after, afterPlans, ...changes }) => this.run(async () => {
      const { agent, task } = await this.find(ref);
      const moved = await updateTask(this.ctx, agent.id, task.id, { ...changes, ...(after !== undefined ? { after: await this.afterIds(after), afterPlans: await this.afterPlansOf(afterPlans) } : {}) });
      return { text: `Updated. ${await this.where(moved.task)}`, moved };
    }));
  }

  private registerReport(): void {
    this.server.registerTool(
      'report',
      {
        description: 'Reports the current assigned stage: Architecture hands its plan to Development; Tests names the exact candidate/revision and completed run ids; the accepting head names the ready candidate/revision and observed integration commit. Main requires the normal human approval of that exact commit. Coordination aggregates accepted child results. Code never bypasses Review through a report.',
        inputSchema: { task: Ref, done: z.boolean(), summary: Text.trim().min(1), verification: Verification.optional(), acceptance: AcceptanceInput.optional() },
      },
      async ({ task: ref, done, summary, verification, acceptance }) =>
        this.run(async () => {
          const { task } = await this.find(ref);
          this.plain(task, summary);
          const moved = await report(this.ctx, this.job.agentId, task.id, { done, summary, verification, acceptance });
          return { text: `Reported. ${await this.where(moved.task)}`, moved };
        }),
    );
  }

  private registerCancelTask(): void {
    this.server.registerTool(
      'cancel_task',
      { description: this.boss ? 'Cancels any task, with every open task under it.' : 'Cancels a task you created, with every open task under it.', inputSchema: { task: Ref, why: z.string().trim().min(1).max(1000) } },
      async ({ task: ref, why }) =>
        this.run(async () => {
          const { task } = await this.find(ref);
          if (!this.boss && task.createdByAgentId !== this.job.agentId) throw refuse(403, 'task_not_yours', `#${task.number} was not created by you.`);
          const moved = await cancel(this.ctx, { agentId: this.job.agentId }, task.id, why);
          await stopTurns(this.ctx, moved.closed, this.job.agentId);
          const left = moved.waiting.length
            ? ` ${listed(moved.waiting)} ${moved.waiting.length === 1 ? 'comes after it and still waits' : 'come after it and still wait'}: give ${moved.waiting.length === 1 ? 'it' : 'them'} what to wait for with update_task (after, [] to start now), or cancel ${moved.waiting.length === 1 ? 'it' : 'them'}.`
            : '';
          return { text: `Cancelled #${task.number}.${left}`, moved };
        }),
    );
  }

  private registerSubmit(): void {
    this.server.registerTool(
      'submit',
      {
        description: 'Hands the current Development or checking-stage candidate forward. Review and Security fix findings themselves on the same branch, without returning to the author. summary: what you did; evidence: the command you ran and what it printed, the link, the check. review.baseCommit is the commit the change starts from. The server reads the head of the branch named after the task (task-<number> or the only task-<number>-...), or of review.branch when the work is on another branch; a repair stays on the branch of the candidate it repairs. review.commit, when given, must be that head. Without a readable commit the submission is refused with the reason. Check the change before handing it forward. Submitting starts no test run.',
        inputSchema: { task: Ref, summary: Text.trim().min(1), evidence: Text.trim().min(1), review: ReviewSubmission.optional(), operationId: z.uuid().optional() },
      },
      async ({ task: ref, summary, evidence, review, operationId }) =>
        this.run(async () => {
          const { task } = await this.find(ref);
          this.plain(task, summary, evidence);
          const moved = await submit(this.ctx, this.job.agentId, task.id, { summary, evidence, review, operationId });
          return { text: `Submitted. ${await this.where(moved.task)}`, moved };
        }),
    );
  }

  private registerBlocked(): void {
    this.server.registerTool(
      'blocked',
      { description: 'Tells your head you cannot go on with a task, and why. Your head answers by rewriting the task.', inputSchema: { task: Ref, why: z.string().trim().min(1).max(2000) } },
      async ({ task: ref, why }) =>
        this.run(async () => {
          const { task } = await this.find(ref);
          this.plain(task, why);
          return { text: `Your head is told. ${task.title} waits.`, moved: await blocked(this.ctx, this.job.agentId, task.id, why) };
        }),
    );
  }

  private registerVerdict(): void {
    this.server.registerTool(
      'verdict',
      {
        description:
          'Records the current checker decision on an exact candidate. PASS hands it forward; a defect remains with this checker to fix. Wrong-goal escalate asks the head, without an author return. Review can add Security by naming a concrete risk. Structured issues record provenance; numeric counts are derived, never supplied.',
        inputSchema: { task: Ref, pass: z.boolean(), comment: Text.trim().min(1), reviewedCommit: ReviewSha, issues: z.array(IssueInput).max(99).optional(), security: z.string().trim().min(1).max(2000).optional(), escalate: z.boolean().optional() },
      },
      async ({ task: ref, pass, comment: why, reviewedCommit, issues, security, escalate }) =>
        this.run(async () => {
          const { task } = await this.find(ref);
          this.plain(task, why);
          const review = await reviewContext(this.ctx.db, task.id);
          const evidence = bindReviewEvidence(await taskEvidence(this.ctx, task), review?.commit ?? null);
          const moved = await verdict(this.ctx, this.job.agentId, task.id, { pass, comment: why, reviewedCommit, issues, security, escalate, evidence: keptEvidence(evidence) });
          return { text: `Recorded. ${await this.where(moved.task)}${noProofNote(evidence, pass)}`, moved };
        }),
    );
  }

  private registerConfirmFinding(): void {
    this.server.registerTool(
      'confirm_finding',
      { description: 'The actual area author or its head explicitly confirms or rejects a structured finding. Read its findingId and revision from task.reviewFindings. An author must name its current exact fixCommit; a head may confirm existence before a fix. This records existence only; it never passes a gate or removes a blocking finding. History and vendor counts retain provenance.', inputSchema: { task: Ref, ...ConfirmationInput.shape } },
      async ({ task: ref, ...input }) => this.run(async () => {
        const { task } = await this.find(ref);
        await confirmFinding(this.ctx, this.job.agentId, task, input);
        return { text: 'The finding confirmation is recorded; its gate and fix status are unchanged.' };
      }),
    );
  }
}
