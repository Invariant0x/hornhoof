import { REVIEW_SKIP_ENABLED, requestAuthorCheck } from './author-check.js';
import { idOnly } from '../../db/selections.js';
import { earlierWork } from '../departments/branches.js';
import { agentTaskDetail } from './agent-sight.js';
import { Verification } from './echelons-tests.js';
import { AcceptanceInput } from './echelons-accept.js';
import { isTexts, RISK_CLASSES, WORK_KINDS } from '@hornhoof/protocol';
import { cleanDiagnostic } from '@hornhoof/protocol/redaction';
import { ECHELON_STAGES } from '@hornhoof/protocol/echelons';
import { WaitOwnerBinding, WaitPlan } from '@hornhoof/protocol/waits';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, DECISION_TOPICS, departments, people, SUBTASK_REASONS, tasks, type AgentKind, type DecisionTopic } from '../../db/schema.js';
import { repoAt } from '../departments/repository.js';
import { ApiError } from '../../errors.js';
import { commitApprovalRequired } from './commit-approval.js';
import { ask, blocked, cancel, closeTask, createTask, recordAnswer, report, submit, updateTask, verdict } from './engine.js';
import { comment } from './comments.js';
import { CLOSED, listed, mayAsk, openAfter, refuse, taskSpot, type Moved, type Task } from './state.js';
import { replanWait } from './wait-state.js';
import { carriesFile, encodedHint } from './attachments.js';
import { tryAutonomousCommitApproval } from './autonomous-release.js';
import { Text } from './long-text.js';
import { Recorded } from './recorded.js';
import { agentSeesTask as sees, taskLines, type TaskDetail } from './views.js';
import { checksTask } from './look-checker.js';
import { taskByRef } from './lookup.js';
import { editTurn, giveTasks, turnName, turnRows, type Scope } from './turns.js';
import { recordRelease, uncheckedInRelease } from './releases.js';
import type { UncheckedItem } from './unchecked.js';
import { topDepartment } from './turn-department.js';
import { setUrgent } from './urgency.js';
import { ceoPrincipal, departmentPrincipal, standingPrincipal } from '../conversation/decision-context.js';
import { ONLY_CEO_ASKED, ONLY_DEPARTMENT_OWNER } from '../tools/control.js';
import { stopTurns, wakeAll } from './wake.js';
import { requireTreeRules, underText } from './tree-rules.js';
import { refusePaused, setPaused } from './pause.js';
import { resolveStuckComment } from './stuck.js';
import { appendOutgoing } from '../events/store.js';
import { personParty } from '../events/parties.js';
import { decisionPerson } from './decision-people.js';
import { TaskReference as Ref, trackWork } from './external-wait.js';
import { pipelineReport } from './pipeline-report.js';
import { proofSaid } from './release-ci.js';
import { ReviewSha, ReviewSubmission } from './review-context.js';
import { pipelineFindings, reviewDetails } from './review-details.js';
import { ConfirmationInput, confirmFinding, IssueInput } from './review-findings.js';
import { CHECKED_COMMIT, echelonsFor, START_COMMIT } from './turnkey.js';
import { listBacklog } from '../backlog/store.js';
import { deptName } from '../departments/templates.js';
import { requireTaskHead } from './echelons-update.js';
import { editTask, seenOf, trackerSet } from '../tracker/edit.js';
import { hasTrackerFields, TrackerFields, trackerInputOf } from '../tracker/tools.js';

export type ToolJob = { id: string; companyId: string; agentId: string; agentKind: AgentKind; departmentId: string | null };
type Agent = typeof agents.$inferSelect;
type ToolMoveResult = { text: string; moved?: Pick<Moved, 'wakes'> & { task?: Task } };

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
/* Agents read role names in English, the language of their instructions. */
const english = (_k: string, v: unknown) => (isTexts(v) ? v.en : v);
const json = (value: unknown) => say(JSON.stringify(value, english));

/* A task of another department a company watchdog inspects, every word of it with no credential and no private path, as
   failures and agents give that work to whoever may not open it, and cleaned before its log is cut. */
const cleaned = <T>(detail: T): T => JSON.parse(JSON.stringify(detail, (key, value: unknown) => {
  const shown = english(key, value);
  return typeof shown === 'string' ? cleanDiagnostic(shown) : shown;
})) as T;

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

const Title = z.string().trim().min(1).max(120);
const Brief = z.string().max(600).describe('One to three sentences people read on the map and in the tracker.');
/* A department may keep several repositories: its own, and one on each product. */
const Product = z.uuid().describe("The product whose repository the change goes to, as taskRepositories in your briefing lists them; without one the task works in the department's own repository.");
const Body = z.string().max(20000).describe('What every agent on the task reads: requirements, acceptance criteria (what the checking stages check), product, constraints. Rewrite it as the current truth.');
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
const Backlog = z
  .array(z.uuid())
  .describe("Items of departments' lists, by id from backlog, that become tasks in their own department and leave the list.");

type Question = { kind: 'question' | 'approval' | 'choice'; text: string; topic?: DecisionTopic; recipient?: string };
const HumanRecipient = z.uuid().describe('The person who can supply the missing answer, by id. For a missing sign-in, ask them to add it to the vault and give only the entry name.');

/* What people read of a question, and what its asker hears besides: an approval says what test runs say of its commit as it
   is asked, which the answer says again as it comes. What the release of that commit brings that no check covers goes on the
   card apart from these words, and its asker hears how much. */
async function questionWords(ctx: Ctx, task: Task, question: string, commit?: string, unchecked?: UncheckedItem[] | null): Promise<{ text: string; told: string }> {
  if (!commit) return { text: question, told: '' };
  const said = await proofSaid(ctx, task, commit);
  const told = unchecked?.length ? ` Hornhoof names next to Approve what the release brings that no check covers: ${unchecked.length}.` : '';
  return { text: `${question}\n\nHornhoof checked as this was asked. ${said}`, told: ` ${said}${told}` };
}

/* Keep the outgoing question with the person responsible for its decision card. */
async function recordQuestion(ctx: Ctx, job: ToolJob, task: Task, { kind, text, topic, recipient }: Question): Promise<void> {
  const personId = recipient ?? await decisionPerson(ctx, job.companyId, { source: 'request', kind, topic: topic ?? null, spot: taskSpot(task) });
  await appendOutgoing(ctx, { ...job, jobId: job.id, text, to: await personParty(ctx, job.companyId, personId) });
}

/* What the card keeps apart from its words: what the release of its commit brings that no check covers, where it brings any. */
const uncheckedCard = (unchecked?: UncheckedItem[] | null): { unchecked?: UncheckedItem[] } => (unchecked?.length ? { unchecked } : {});

/* What the release of the commit an approval is asked of brings that no check covers; a choice names no commit. */
const uncheckedAsked = (ctx: Ctx, task: Task, commit?: string, options?: unknown[]): Promise<UncheckedItem[] | null> =>
  commit && !options?.length ? uncheckedInRelease(ctx, task, commit) : Promise.resolve(null);

/* An approval of a commit that the department's rule or autonomous release lets go, where it does. A release that brings
   what no check covers always goes to a person, who sees that on the card. */
async function commitReply(ctx: Ctx, task: Task, agentId: string, question: string, commit?: string, options?: unknown[], unchecked?: UncheckedItem[] | null) {
  if (!commit || options?.length || unchecked?.length) return null;
  if (!(await commitApprovalRequired(ctx.db, task.companyId, task.departmentId))) {
    mayAsk(task, agentId);
    refusePaused(task);
    const moved = await comment(ctx, { agentId }, task.id, `Went without approval for commit ${commit}. ${question}`);
    return { text: 'No approval needed under the department\'s commit policy. Continue with the required checks.', moved };
  }
  const auto = await tryAutonomousCommitApproval(ctx, task, agentId, commit, question);
  return auto ? { text: auto.text, moved: auto.moved } : null;
}

/* What the holder of turnkey work checked: the commit it took into the turn branch, and where its branch started. */
const TurnkeyInput = z.strictObject({
  commit: z.string().regex(/^[0-9a-f]{40}$/).describe(`The ${CHECKED_COMMIT}.`),
  baseCommit: z.string().regex(/^[0-9a-f]{40}$/).describe(`The ${START_COMMIT}. It holds where the turn branch was as your work started.`),
});

const TurnItem = z.object({ department: z.uuid().optional().describe('Its department; a head may leave it out.'), product: z.uuid().optional(), title: Title, brief: Brief, body: Body, workKind: WorkKind.optional(), riskClass: RiskClass.optional(), urgent: z.boolean().optional().describe('Marks this work and its child tasks urgent. Urgent work takes no slot and waits for none: it goes past the queue, to the department\'s hotfix lane.'), small: z.boolean().optional().describe('One place, a clear result: a small addition of the same product may join a running slot of the department\'s turn instead of waiting in the queue.'), askedBy: z.uuid().optional().describe('Orchestrator only: the person whose request this work carries out, as company lists people. It is shown as who asked, goes down the whole tree, and puts the work in that person\'s own list. Name it only for a person\'s request; leave it out for work you started yourself.'), ...TrackerFields });
const Turn = z.number().int().positive().describe('The turn number, like 2.');
/* The tools an agent gets for tasks, by its kind. Each one checks that the task is the agent's to move. */
export function registerTaskTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  new TaskTools(server, ctx, job).register();
}

export function registerHolderTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  new TaskTools(server, ctx, job).registerHolderTools();
}

export function registerDepartmentTaskTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  new TaskTools(server, ctx, job).registerCreateTask();
}

/* What a close did beyond the task: the open work cancelled under it, and the tasks its closer made that wait for that work,
   which nobody else is told of. */
export function closedBeyond(moved: { closed: string[]; waiting: Pick<Task, 'number'>[] }): string {
  const cancelled = moved.closed.length > 1 ? ` Open tasks cancelled under it: ${moved.closed.length - 1}.` : '';
  const waiting = moved.waiting.length ? ` Still waiting for work cancelled under it: ${listed(moved.waiting)}. Give each what to wait for with update_task, or cancel it.` : '';
  return cancelled + waiting;
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
    this.registerRecordAnswer();
    this.registerReport();
    if (this.job.agentKind !== 'worker') this.registerTurnTools();
    if (this.job.agentKind === 'head') this.registerCreateTask();
    if (this.job.agentKind !== 'worker') this.registerManagementTools();
    if (this.job.agentKind !== 'orchestrator') this.registerHolderTools();
  }

  /* What the holder of a task hands in and records; the orchestrator keeps them on its shelf. */
  registerHolderTools(): void {
    this.registerExecutionTools();
    this.registerReleaseTurn();
  }

  /* The orchestrator gives the work of every department and reads their turns; a head those of its own. */
  private registerTurnTools(): void {
    this.registerTurns();
    this.registerBacklog();
    if (this.boss) this.registerPipelineReport();
    this.registerAddTasks();
    if (this.boss) this.registerSetUrgent();
    this.registerEditTurn();
  }

  /* The department whose turns this agent lays out and changes: any for the orchestrator, its own top-level one for a head. */
  private async turnScope(): Promise<Scope> {
    if (this.boss) return null;
    const top = await topDepartment(this.db, (await this.me()).departmentId);
    if (!top) throw refuse(403, 'task_not_yours', 'You head no department, so you lay out no turn.');
    return top.id;
  }

  private registerManagementTools(): void {
    this.registerUpdateTask();
    this.registerCancelTask();
    if (this.boss) this.registerCloseTask();
    this.registerPause();
  }

  private registerPause(): void {
    this.server.registerTool('pause_task', {
      description: 'Pauses a task of your department (any task, for the orchestrator) with every open task under it. A paused task wakes nobody: no reminders, wait deadlines, comments, messages or run ends reach its holder, its holder\'s turn on it stops and its own work is refused. Test runs already running finish. It stays paused until resume_task, which wakes its holder once.',
      inputSchema: { task: Ref, why: z.string().trim().min(1).max(1000) },
    }, async ({ task: ref, why }) => this.run(async () => {
      const { task } = await this.find(ref);
      const moved = await setPaused(this.ctx, { agentId: this.job.agentId }, task.id, true, why);
      await stopTurns(this.ctx, moved.tree, this.job.agentId);
      return { text: `Paused #${task.number}${moved.tree.length > 1 ? ` and ${moved.tree.length - 1} open task${moved.tree.length > 2 ? 's' : ''} under it` : ''}.`, moved };
    }));
    this.server.registerTool('resume_task', {
      description: 'Resumes a task you or someone else paused, with the work paused with it. Its holder is woken once to go on.',
      inputSchema: { task: Ref },
    }, async ({ task: ref }) => this.run(async () => {
      const { task } = await this.find(ref);
      const moved = await setPaused(this.ctx, { agentId: this.job.agentId }, task.id, false, '');
      return { text: `Resumed #${task.number}. ${await this.where(moved.task)}`, moved };
    }));
  }

  private registerExecutionTools(): void {
    this.registerAuthorCheck();
    this.registerSubmit();
    this.registerBlocked();
    this.registerVerdict();
    this.registerConfirmFinding();
  }

  private async me(): Promise<Agent> { return (await this.db.select().from(agents).where(eq(agents.id, this.job.agentId)))[0]!; }

  /* A company watchdog can inspect tasks across departments, and the head of Design its holder named on its open wait
     reads it and comments on it. Task moves keep the normal scope. */
  private async find(ref: number | string, sight: 'move' | 'read' | 'comment' = 'move'): Promise<{ agent: Agent; task: Task }> {
    const agent = await this.me();
    const task = await taskByRef(this.ctx, this.job.companyId, ref);
    if (!task || !(sees(agent, task) || await this.seesFor(sight, agent, task))) throw refuse(404, 'task_unknown', `There is no task ${ref} you can see. Call tasks for yours.`);
    return { agent, task };
  }

  private async seesFor(sight: 'move' | 'read' | 'comment', agent: Agent, task: Task): Promise<boolean> {
    if (sight === 'move') return false;
    return (sight === 'read' && await this.canInspect(agent, task)) || checksTask(this.db, agent, task);
  }

  private async canInspect(agent: Agent, task: Task): Promise<boolean> {
    if (!agent.skills.some(id => this.ctx.templates.skills.get(id)?.grants.includes('agents'))) return false;
    const holders = [task.assigneeAgentId, task.executorAgentId].filter(id => id !== null);
    const privateHolder = holders.length && (await this.db.select(idOnly(agents)).from(agents).where(and(inArray(agents.id, holders), eq(agents.kind, 'assistant')))).length;
    return !privateHolder;
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

  /* An employee of the head's department, or the head. */
  private async member(head: Agent, id: string): Promise<Agent> {
    const [agent] = await this.db.select().from(agents).where(and(eq(agents.id, id), eq(agents.companyId, head.companyId), isNull(agents.removedAt)));
    if (!agent || agent.departmentId !== head.departmentId) throw refuse(403, 'task_not_yours', `${id} does not work in your department. Call company for its employees.`);
    return agent;
  }

  /* A file goes on the task itself; tool text stays plain. */
  private plain(task: Task, ...texts: string[]): void {
    if (texts.some(carriesFile)) throw refuse(400, 'task_invalid', encodedHint(task.number));
  }

  /* Apply a move and wake its next owners; return readable refusals. */
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
    await wakeAll(this.ctx, moved.wakes);
    return say(text);
  }

  /* A head can mark its department work urgent. The orchestrator can mark work urgent anywhere. */
  private async urgentBy(departmentId: string | null): Promise<void> {
    if (this.job.agentKind === 'orchestrator') return;
    if (!departmentId && !(await ceoPrincipal(this.db, this.job.id, standingPrincipal))) throw refuse(403, 'urgent_not_allowed', ONLY_CEO_ASKED);
    if (departmentId && !(await departmentPrincipal(this.db, this.job.id, departmentId, standingPrincipal))) throw refuse(403, 'urgent_not_allowed', ONLY_DEPARTMENT_OWNER);
  }

  private async urgentFromCeo(items: { department: string; urgent?: boolean | undefined }[]): Promise<void> {
    for (const department of new Set(items.filter(item => item.urgent).map(item => item.department))) await this.urgentBy(department);
  }

  private async checkProduct(agent: Agent, id: string | undefined): Promise<void> {
    if (!id) return;
    const [product] = await this.db.select(idOnly(departments)).from(departments).where(and(eq(departments.id, id), eq(departments.parentId, agent.departmentId!)));
    if (!product) throw refuse(404, 'department_unknown', `${id} is not a product of your department.`);
  }

  /* A code task names the paths its change may touch: without them every submit of it is refused as outside the scope. Where
     only the department's products keep code, it names its product: without one it has no repository and closes by a report. */
  private async checkCodeScope(agent: Agent, input: { product?: string; resultKind?: 'code' | 'document' | 'coordination'; paths?: string[] }): Promise<void> {
    if (input.resultKind === 'coordination') return;
    if (await repoAt(this.ctx, [input.product ?? null, agent.departmentId])) {
      if (!input.paths?.length) throw refuse(400, 'task_invalid', 'A code task needs the paths its change may touch, like ["apps/server/**"]: without them every submit of it is refused as outside the scope.');
      return;
    }
    if (input.product) return;
    const products = await this.db.select({ id: departments.id, name: departments.name, url: departments.repoUrl }).from(departments).where(and(eq(departments.parentId, agent.departmentId!), isNotNull(departments.repoUrl)));
    if (products.length) throw refuse(400, 'task_invalid', `Name the product whose repository the change goes to: the code of your department lives in the repositories of its products (${products.map(product => `${product.name ?? 'unnamed'} (${product.id}): ${product.url}`).join('; ')}). Without one the task has no repository and closes by a report.`);
  }

  private async optionalMember(head: Agent, id: string | undefined): Promise<Agent | null> {
    return id ? this.member(head, id) : null;
  }

  private async checkCreatedScope(agent: Agent, executor: Agent, input: { product?: string; resultKind?: 'code' | 'document' | 'coordination'; paths?: string[] }): Promise<void> {
    if (input.resultKind === 'document' && input.paths?.length) {
      throw refuse(400, 'task_invalid', 'A document has no paths: its holder attaches files to the task. Leave paths out, or make it a code task.');
    }
    if (input.resultKind !== 'coordination' && input.resultKind !== 'document' && await echelonsFor(this.db, { companyId: agent.companyId, holderId: executor.id })) {
      await this.checkCodeScope(agent, input);
    }
  }

  private async createdTaskText(task: Task, executor: Agent, architect: Agent | null = null): Promise<string> {
    const holder = architect && task.assigneeAgentId === architect.id ? architect : executor;
    const [parent] = task.parentId ? await this.db.select({ number: tasks.number, title: tasks.title }).from(tasks).where(eq(tasks.id, task.parentId)) : [];
    return `Created #${task.number} for ${holder.name}.${parent ? ` ${underText(parent, task)} If that title is narrower than the whole result it serves, fix the parent's title with update_task.` : ''}${await this.waiting(task)}`;
  }

  private registerTasks(): void {
    this.server.registerTool(
      'tasks',
      { description: 'Your open tasks first, then other open tasks you can see, 40 per page. Use offset to skip rows already read.', inputSchema: { offset: z.number().int().nonnegative().default(0) } },
      async ({ offset }) => {
        const agent = await this.me();
        const visible = this.boss ? undefined : or(agent.departmentId ? eq(tasks.departmentId, agent.departmentId) : undefined, eq(tasks.assigneeAgentId, agent.id), eq(tasks.executorAgentId, agent.id));
        const open = await this.db
          .select()
          .from(tasks)
          .where(and(eq(tasks.companyId, this.job.companyId), notInArray(tasks.status, [...CLOSED]), visible))
          .orderBy(desc(sql`${tasks.assigneeAgentId} is not distinct from ${agent.id}`), desc(tasks.number))
          .limit(40)
          .offset(offset);
        return json(await taskLines(this.ctx, open, t => sees(agent, t)));
      },
    );
  }

  private registerTask(): void {
    this.server.registerTool(
      'task',
      {
        description:
          'One task in full: its body (the current truth), stages and where it stands, subtasks, open questions and its log. A long log comes with its newest lines, and logLeftOut counts the older ones left out. ' +
          "task.echelons is the required ordered route and current owner. Candidates and producing identities are immutable. Review and Security own their repairs in the same branch; optional Cleanup follows Review only when the head enabled it. review names the pinned commit and its change; testEvidence proves only its exact current commit. echelonFindings contains deduplicated stage findings and independent confirmations.",
        inputSchema: { task: Ref },
      },
      async ({ task: ref }) =>
        this.find(ref, 'read').then(
          async ({ agent, task }) => {
            const detail = { ...await agentTaskDetail(this.ctx, agent, task, t => sees(agent, t)), ...await reviewDetails(this.db, task.id), ...await earlierWork(this.ctx, agent, task) };
            return say(fitted(sees(agent, task) ? detail : cleaned(detail)));
          },
          (err: unknown) => (err instanceof ApiError ? say(err.message, true) : Promise.reject(err)),
        ),
    );
  }

  private registerWaitFor(): void {
    this.server.registerTool(
      'wait_for',
      {
        description: 'Asks a named person for the missing judgment or information on a task you hold. The task waits for their answer, then you are woken. Use track_work for an operation in progress. Diagnose and repair failed work. For a missing sign-in, ask for a vault entry by name.',
        inputSchema: { task: Ref, person: HumanRecipient, reason: z.string().trim().min(1), plan: AskPlan },
      },
      async ({ task: ref, person, reason, plan }) => this.run(async () => {
        const { task } = await this.find(ref);
        this.plain(task, reason);
        const recipient = await this.questionRecipient(person);
        const moved = await ask(this.ctx, this.job.agentId, task.id, { kind: 'question', text: reason, recipientPersonId: recipient, ...(plan ? { plan } : {}) });
        await recordQuestion(this.ctx, this.job, task, { kind: 'question', text: reason, recipient });
        return { text: `Asked. #${task.number} waits for the person's answer.`, moved };
      }),
    );
    this.server.registerTool(
      'track_work',
      {
        description: 'Records an operation already in progress on a task you hold, such as tests or delegated work. Name the operation and the next time to check it. Name the employee doing the work so they get a notice. The head of Design named so, to check the final look of a screen, reads this task and comments on it until the wait ends, and you can write to that head about it with message_employee naming the task; its comment ends the wait and wakes you. You will be woken to check progress or if that employee becomes unavailable. Diagnose and repair a failed operation.',
        inputSchema: { task: Ref, work: z.string().trim().min(1), nextCheck: z.iso.datetime({ offset: true }), employee: z.uuid().optional() },
      },
      async ({ task: ref, work, nextCheck, employee }) => this.run(async () => {
        const { task } = await this.find(ref);
        this.plain(task, work);
        const moved = await trackWork(this.ctx, this.job.agentId, task.id, work, nextCheck, employee);
        return { text: `Work is in progress on #${task.number}. Next check at ${moved.task.externalWait!.until}.`, moved };
      }),
    );
  }

  private registerComment(): void {
    this.server.registerTool(
      'comment',
      {
        description:
          "Adds a note to a task's log for everyone on it. Whoever gave out a member task that is blocked can answer it with a comment, " +
          'which opens it again and wakes its executor with your words, once in a piece of work: blocked again after that, it opens with the answer written into it by update_task. ' +
          'A comment from a person or another agent also ends an external wait and wakes its holder. A note that should leave the wait standing goes to its holder with message_employee naming no task. ' +
          'The current head or orchestrator resolves its internal stuck request with a comment. To hand work on, use the task\'s own moves.',
        inputSchema: { task: Ref, text: Text.trim().min(1) },
      },
      async ({ task: ref, text }) =>
        this.run(async () => {
          const { task } = await this.find(ref, 'comment');
          this.plain(task, text);
          const moved = (await resolveStuckComment(this.ctx, this.job, task.id, text)) ?? (await comment(this.ctx, { agentId: this.job.agentId }, task.id, text));
          if ('held' in moved && moved.held) return { text: `Noted on #${task.number}. It stays blocked: its executor blocked it again after a comment opened it. Write the answer into the task with update_task, which opens it again, give it to someone else, or cancel it.`, moved };
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

  private async questionRecipient(person: string): Promise<string> {
    const [recipient] = await this.db.select({ id: people.id }).from(people).where(and(eq(people.id, person), eq(people.companyId, this.job.companyId), eq(people.status, 'active'), eq(people.isAgent, false)));
    if (!recipient) throw refuse(400, 'task_invalid', 'Name an active person in this company.');
    return recipient.id;
  }

  private registerAskPerson(): void {
    this.server.registerTool(
      'ask_person',
      {
        description:
          'Asks the people responsible for the task a question, (with commit) for approval of that exact commit under the department\'s rule, or (with options) to pick one of 2 to 4 ways. The task waits; you are woken with the answer. A person\'s message to you that answers one of several open questions without naming it closes none: record which with record_answer. ' +
          "Ask only once every instruction and material the question promises is ready, attached to it instead of a pointer to a task's log, and let one sender ask it once. " +
          'Show what people judge instead of describing it: take screenshots, send each with the shell command `hh-attach FILE` and pass the ids it prints as images, or as an option\'s image. ' +
          'link: an https page where the work can be seen, like a branch comparison; an approval links its commit by itself. ' +
          'With commit, an unset rule needs no approval, except for a release that brings what no check covers: a person approves it on a card where Hornhoof names exactly that next to Approve, apart from your words. An approval card shows what the repository\'s CI says of that commit, and which test run checked it where one did. If its department enabled autonomousRelease and the repository\'s CI is green on that commit, or the repository has none, with an independent non-author PASS verdict and a fast-forward path from main, Hornhoof records the automatic approval without opening a card. ' +
          'Ask a person when their own judgment or information is indispensable. Resolve ordinary work through the responsible department or the orchestrator. Only irreversible deletion needs the CEO\'s yes. Keep credentials out of the question and answer; ask the person to save a missing sign-in in the vault and name the entry.',
        inputSchema: {
          task: Ref,
          question: z.string().trim().min(1).max(2000),
          commit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
          images: z.array(z.uuid()).max(6).optional(),
          options: z.array(z.object({ label: z.string().trim().min(1).max(200), image: z.uuid().optional() })).max(4).optional(),
          link: z.url({ protocol: /^https$/ }).max(500).optional(),
          plan: AskPlan,
          person: HumanRecipient.optional(),
          topic: z
            .enum(DECISION_TOPICS)
            .optional()
            .describe(
              'What the question is about. For people, access, subscriptions, machines, public_link or updates, name the person who can supply the answer. For department work, use task or employee. For its repository or release, use repositories or release.',
            ),
        },
      },
      async ({ task: ref, question, commit, images, options, link, topic, plan, person }) =>
        this.run(async () => {
          const { task } = await this.find(ref);
          this.plain(task, question);
          const unchecked = await uncheckedAsked(this.ctx, task, commit, options);
          const reply = await commitReply(this.ctx, task, this.job.agentId, question, commit, options, unchecked);
          if (reply) return reply;
          if (commit && person) throw refuse(400, 'task_invalid', 'The department\'s commit rule determines who approves it.');
          const recipient = person ? await this.questionRecipient(person) : undefined;
          if (!recipient && !commit && topic && !['task', 'employee', 'repositories', 'release'].includes(topic)) {
            throw refuse(400, 'task_invalid', 'Resolve the request through the department or the orchestrator. If only a person can answer, name them.');
          }
          const kind = commit ? 'approval' : options?.length ? 'choice' : 'question';
          const ways = options?.map(o => ({ label: o.label, image: o.image ?? null }));
          const { text, told } = await questionWords(this.ctx, task, question, commit, unchecked);
          const moved = await ask(this.ctx, this.job.agentId, task.id, { kind, text, ...(commit ? { commit, approval: { channel: 'commit', kind: 'commit', amount: null } } : {}), ...uncheckedCard(unchecked), images, options: ways, link: link ?? null, topic, ...(recipient ? { recipientPersonId: recipient } : {}), ...(plan ? { plan } : {}) });
          await recordQuestion(this.ctx, this.job, task, { kind, text, topic: commit ? 'release' : topic, ...(recipient ? { recipient } : {}) });
          return { text: `Asked. #${task.number} waits for a person's answer; you will be woken with it.${told}`, moved };
        }),
    );
  }

  /* A person's words to the agent closed none of its questions by themselves: the agent says which they answer, citing them. */
  private registerRecordAnswer(): void {
    this.server.registerTool(
      'record_answer',
      {
        description:
          "Records which of your open questions to people, or which work you are stuck on for them, a person's message to you answers. Their words close one by themselves only when it is clear which: the only one they may answer, or the one they name by its task, a link or a quoted line. With more open, read their message, and record here each question it answers. " +
          'request: the id of that question, as task shows it. words: a part of their message, exactly as they wrote it, enough to find that one message, from your window, Telegram, their assistant or your terminal. Hornhoof finds the message, written to you since you asked, and records the whole message as their answer on that card alone, with a link to it. It refuses words no person wrote to you, words more than one message holds, and a person who may not answer it. A choice and an approval keep their own card.',
        inputSchema: { request: z.uuid(), words: z.string().trim().min(1).max(12_000) },
      },
      async ({ request, words }) =>
        this.run(async () => {
          const { task, wakes } = await recordAnswer(this.ctx, this.job.agentId, request, words);
          return { text: `Recorded as their answer on #${task.number}. Your other questions stay open.`, moved: { wakes: wakes.filter(w => w.agentId !== this.job.agentId) } };
        }),
    );
  }

  private registerTurns(): void {
    this.server.registerTool(
      'turns',
      {
        description: this.boss
          ? "Each department's turns, which are its releases: its last released turn with its version and commit, and its open one, getting the next release ready, each with its department, title, main point and the results accepted into it, and for a turn closed with no version, why."
          : "Your department's turns, which are its releases: the last released one with its version and commit, and the open one, getting the next release ready, each with its title, main point and the results accepted into it, and for a turn closed with no version, why.",
        inputSchema: {},
      },
      async () => {
        const scope = await this.turnScope();
        const all = await turnRows(this.ctx, this.job.companyId, scope ?? undefined);
        const rows = all.filter((t, i) => t.status !== 'closed' || !all.slice(i + 1).some(later => later.status === 'closed' && later.departmentId === t.departmentId));
        /* Each result accepted into a turn, but a subtask that goes with its parent in the same turn: a member of a coordination
           task is accepted alone while its parent joins no turn. */
        const held = rows.length ? await this.db.select().from(tasks).where(inArray(tasks.turnId, rows.map(t => t.id))).orderBy(asc(tasks.number)) : [];
        const top = held.filter(t => !held.some(parent => parent.id === t.parentId && parent.turnId === t.turnId));
        const agent = await this.me();
        const lines = await taskLines(this.ctx, top, t => sees(agent, t));
        const ids = [...new Set(rows.flatMap(t => t.departmentId ?? []))];
        const places = ids.length ? await this.db.select().from(departments).where(inArray(departments.id, ids)) : [];
        const department = (id: string | null) => {
          const place = places.find(d => d.id === id);
          return place ? { id: place.id, name: deptName(place) } : null;
        };
        return json(rows.map(t => ({ number: t.number, department: department(t.departmentId), title: t.title || t.goal, goal: t.goal, status: t.status, version: t.version, commit: t.commit, baseVersion: t.baseVersion, startCommit: t.startCommit, ...(t.closedBecause ? { closedBecause: t.closedBecause } : {}), tasks: lines.filter((_, i) => top[i]!.turnId === t.id) })));
      },
    );
  }

  private registerBacklog(): void {
    this.server.registerTool(
      'backlog',
      {
        description: this.boss
          ? "What people of each department keep in its list for later, the first to go first: proposals nobody holds yet. Give items to work with backlog in add_tasks."
          : "What people of your department keep in its list for later, the first to go first: proposals nobody holds yet. Give items to work with backlog in add_tasks.",
        inputSchema: {},
      },
      async () => {
        const all = await listBacklog(this.db, this.job.companyId, (await this.turnScope()) ?? undefined);
        const places = all.length ? await this.db.select().from(departments).where(inArray(departments.id, [...new Set(all.map(i => i.departmentId))])) : [];
        return json(places.sort((a, b) => a.position - b.position).map(d => ({
          department: { id: d.id, name: deptName(d) },
          items: all.filter(i => i.departmentId === d.id).map(i => ({ id: i.id, title: i.title, text: i.text, by: i.by.name, at: i.at })),
        })));
      },
    );
  }

  private registerPipelineReport(): void {
    this.server.registerTool(
      'pipeline_report',
      {
        description:
          'How the pipeline went in a turn, for the company and by department: time from giving a task out to accepting it, the critical path apart from agent time, stages, agent turns with how many a task took and the share of the orchestrator, heads and Operations, waits by reason, returns, failures, interrupted turns, numbers by kind of task and test times, naming the files over 30 s and the tests over 1 s, the time budget of the testing policy. ' +
          "Each number comes with the previous turn and the baseline turn of the same department and its change in percent. By default the running turn of the department named, else its last that ran. A department with described false has no description to take its own numbers from.",
        inputSchema: { turn: Turn.optional(), department: z.uuid().optional().describe('The department whose turn to read when no turn is named.') },
      },
      async ({ turn, department }) => this.run(async () => {
        const report = await pipelineReport(this.db, this.job.companyId, turn, department, this.ctx.files);
        const reviewFindings = await pipelineFindings(this.db, this.job.companyId, report);
        return { text: JSON.stringify({ ...report, reviewFindings }, english) };
      }),
    );
  }

  private registerAddTasks(): void {
    this.server.registerTool(
      'add_tasks',
      {
        description:
          (this.boss ? 'Gives tasks to the heads of their departments, each task naming its department, ' : 'Gives tasks of your own department to you as its head, ') +
          'who take them on at once, unless every slot of the department\'s turn is busy: then the task waits in the department\'s queue for the next turn, with no one woken, and the answer says which. Work flows, nothing else waits for a turn. No turn holds a task: it joins its department\'s open turn, the next release, as its result is accepted into the turn branch. Follow the shared admission rule in hh-lead-tasks. ' +
          'A member of a turnkey team does a task end to end alone; everybody else\'s goes through the route of its department.',
        inputSchema: { tasks: z.array(TurnItem), improvement: Improvement.optional(), backlog: Backlog.optional() },
      },
      async input =>
        this.run(async () => {
          const scope = await this.turnScope();
          await this.urgentFromCeo(input.tasks.map(t => ({ ...t, department: t.department ?? scope ?? '' })));
          const items = await Promise.all(input.tasks.map(async ({ goal, responsible, why, due, pipeline, stage, priority, askedBy, ...item }) => ({ ...item, askedByPersonId: askedBy, ...(await trackerInputOf(this.ctx, this.job.companyId, { goal, responsible, why, due, pipeline, stage, priority })) })));
          const given = await giveTasks(this.ctx, { companyId: this.job.companyId, agentId: this.job.agentId, jobId: this.job.id }, items, input.improvement, input.backlog, scope);
          return { text: given.text, moved: { wakes: given.wakes } };
        }),
    );
  }

  private registerSetUrgent(): void {
    this.server.registerTool(
      'set_urgent',
      {
        description:
          'Says whether a task with nothing above it is urgent, with all the work under it: as the company owner in any turn. Nobody is woken and nothing else of the work changes.',
        inputSchema: { task: Ref, urgent: z.boolean() },
      },
      async ({ task: ref, urgent }) =>
        this.run(async () => {
          const { agent, task } = await this.find(ref);
          await this.urgentBy(task.departmentId);
          const moved = await setUrgent(this.ctx, { agentId: agent.id }, task.id, urgent);
          return { text: `#${moved.task.number} is ${urgent ? 'urgent' : 'not urgent'} now, with all the work under it.`, moved };
        }),
    );
  }

  private registerEditTurn(): void {
    this.server.registerTool(
      'edit_turn',
      { description: (this.boss ? "Gives a department's open turn" : "Gives your department's open turn") + ' a new title or main point: what its release brings, in words people read.', inputSchema: { turn: Turn, title: z.string().max(80).optional(), goal: z.string().max(600).optional() } },
      async input =>
        this.run(async () => {
          const turn = await editTurn(this.ctx, this.job.companyId, input.turn, input, await this.turnScope());
          return { text: `${turnName(turn)} now reads: ${turn.goal}` };
        }),
    );
  }

  /* The holder of a release task records the release of its department's open turn before main moves. */
  private registerReleaseTurn(): void {
    this.server.registerTool(
      'release_turn',
      {
        description:
          "Records the release of your department's open turn before main moves, on the release task you hold: commit is a commit of the turn branch turn-<number>, its head or one the branch went past while it was checked. The release relies on the repository's CI for that exact commit: the GitHub Actions runs of it, which Hornhoof reads from github.com, never from your word; commit statuses and the checks of other apps prove nothing. Green CI, every job of every full run of the release workflow finished with success and no test job skipped, records it with no run, while a run of any other workflow, and a run of the release workflow that was not started by hand with its input full, counts for nothing; red CI, CI still under way and CI that ran nothing that succeeded refuse, naming the check and its link, so push the fix or let CI finish and record it again; a repository with no CI at all records with no run; a host that cannot be read now, or whose request limit is used up, records nothing and says so, and a repository on another host than github.com is refused as unreadable. Where no full run of the release workflow is on the commit yet, it starts that workflow with the input full set on the turn branch itself, once for each commit, which must be the head of the branch, and answers 'CI started, run N; the release records when it\'s green' with recorded false: the minute round then records the release when CI is green on that exact commit and tells you, or tells you why it did not, so start no run yourself and record nothing by hand. A token that cannot start workflows, or a repository whose settings name no release workflow (a person names it there, by the path of its file; Hornhoof never works it out, and says: name the release workflow in the repository settings), refuses and says why. The department's commit rule says whether the task needs approval of that exact commit. An unset rule needs no approval, but a release that brings what no check covers is recorded only once a person approved a card naming exactly that, whatever the rule, and autonomous release never approves it. When required, ask_person with commit asks the person responsible, or the orchestrator can answer for the owner. With autonomous release on, proof of each change can satisfy the approval rule and is recorded in its log. It uses an independent checker or, for turnkey work, the holder's own review, security check and tests, which cover only the first-parent line from the commit its holder named down to where its branch started. " +
          'It says what the release brings, whether each of its commits was checked, and which results of the turn it leaves out because they joined the branch after the commit. The turn branch never stops for a release: keep taking finished work into it. Then fast-forward main to the commit and tag it vX.Y.Z, the next version of your department\'s repository after its own last version tag, which the answer names, or its first version tag where it has none: the tag closes the turn, and what the release left out goes into the next turn, whose branch you create from the head of this one.',
        inputSchema: { task: Ref, commit: z.string().regex(/^[a-f0-9]{40}$/).describe("The exact commit of the turn branch: its head, where CI is to start on it, or one the repository's CI checked.") },
      },
      async input =>
        this.run(async () => {
          const ref = typeof input.task === 'number' ? input.task : Number(String(input.task).replace(/^#/, ''));
          const recorded = await recordRelease(this.ctx, this.job.agentId, this.job.companyId, { task: ref, commit: input.commit });
          return { text: JSON.stringify(recorded) };
        }),
    );
  }

  registerCreateTask(): void {
    this.server.registerTool(
      'create_task',
      {
        description: 'Assigns one whole result in your department. Code follows Architecture (unless small or shared with its Development owner), Development, Review, risk-based Security, then Tests on the final candidate. Coordination has only a checked report over accepted child results. Optional Cleanup is enabled only by the head and runs after Review. A code task needs its repository paths (paths), and the product whose repository it changes when that is not the department\'s own; one task changes one repository, so a change across repositories is a task per repository. checker ids are optional, otherwise eligible skill owners are selected. Without an explicit result kind, a repository means code; work without a repository finishes with a checked report and no invented Git candidate. A document is files, not code, even where the department keeps a repository: no paths and no commit, its holder attaches the files and hands them in with submit, and the head closes it with report. A task given to a member of a turnkey team goes through no echelons, whatever its text says: its holder does it end to end alone and closes it with report, with no checker, Cleanup or paths; everybody else\'s goes through the route of its department. No task is in a turn until its result is accepted into the open turn\'s branch. Never write the echelons into a task\'s text: the route is the server\'s.',
        inputSchema: { title: Title, brief: Brief, body: Body, executor: z.uuid(), architectAgentId: z.uuid().optional().describe('Optional distinct Architecture owner; when omitted or equal to executor, Architecture collapses into Development.'), resultKind: z.enum(['code', 'document', 'coordination']).optional(), reviewerAgentId: z.uuid().optional(), securityAgentId: z.uuid().optional(), testsAgentId: z.uuid().optional(), cleanup: z.boolean().optional(), paths: z.array(z.string().min(1).max(500)).max(100).optional(), parent: Ref.optional(), product: Product.optional(), after: After.optional(), afterPlans: AfterPlans.optional(), independentPart: IndependentPart.optional(), independentNone: IndependentNone.optional(), workKind: WorkKind.optional(), riskClass: RiskClass.optional(), small: z.boolean().optional(), subtaskReason: z.enum(SUBTASK_REASONS).optional().describe('Required with parent, and only then: why this is a task of its own and not a step in its parent\'s body. independent_result: a result a person can check on its own. other_owner: other skills, another department or an independent checker. parallel_block: work that runs at the same time as its siblings and shortens the whole. At most 3 sub-tasks per task without the head, 5 under any parent, 3 levels deep; no coordination task holds one sub-task only: assign that task directly.'), ...TrackerFields },
      },
      async input =>
        this.run(async () => {
          const me = await this.me();
          const agent = this.boss ? { ...me, departmentId: this.job.departmentId } : me;
          const executor = await this.member(agent, input.executor);
          const architect = await this.optionalMember(agent, input.architectAgentId);
          if (input.independentPart) await this.member(agent, input.independentPart.executor);
          await this.checkProduct(agent, input.product);
          const parent = input.parent !== undefined ? (await this.find(input.parent)).task : null;
          const after = await this.afterIds(input.after);
          await this.checkCreatedScope(agent, executor, input);
          await requireTreeRules(this.ctx, { id: agent.id, kind: agent.kind, departmentId: agent.departmentId }, parent, input.subtaskReason);
          const moved = await createTask(this.ctx, { agentId: agent.id }, { subtaskReason: input.subtaskReason, title: input.title, brief: input.brief, body: input.body, departmentId: agent.departmentId, productId: input.product ?? null, parentId: parent?.id ?? null, assigneeAgentId: executor.id, architectAgentId: architect?.id, executor: input.resultKind !== 'coordination', resultKind: input.resultKind, reviewerAgentId: input.reviewerAgentId, securityAgentId: input.securityAgentId, testsAgentId: input.testsAgentId, cleanup: input.cleanup, paths: input.paths, after, afterPlans: await this.afterPlansOf(input.afterPlans), independentPart: input.independentPart, independentNone: input.independentNone, workKind: input.workKind, riskClass: input.riskClass, small: input.small, ...(await trackerInputOf(this.ctx, this.job.companyId, input)) });
          return { text: await this.createdTaskText(moved.task, executor, architect), moved };
        }),
    );
  }

  private registerUpdateTask(): void {
    this.server.registerTool('update_task', {
      description: 'The department head revises the current task or checking owner without returning it to the author. With echelonStage and ownerAgentId, assigns an eligible owner to a future pending stage or refreshes the active checking assignment for its current owner after a fallback. An assignment on its own wakes nobody. Producer, model capability, ability and scope rules still apply. stage is the stage of the tracker pipeline, not an echelon stage. An eligible owner resumes a waiting stage on its current candidate. Optional Cleanup is decided before Review hands forward; cleanupForTurn applies the same explicit choice to this department in the turn, including new tasks.',
      inputSchema: { task: Ref, title: Title.optional(), brief: Brief.optional(), body: Body.optional(), executor: z.uuid().optional(), echelonStage: z.enum(ECHELON_STAGES).optional().describe('A future pending stage to assign, or the active checking stage to refresh for its current owner.'), ownerAgentId: z.uuid().optional(), paths: z.array(z.string().min(1).max(500)).max(100).optional(), cleanup: z.boolean().optional(), cleanupForTurn: z.boolean().optional(), after: After.optional(), afterPlans: AfterPlans.optional(), independentPart: IndependentPart.optional(), independentNone: IndependentNone.optional(), workKind: WorkKind.optional(), riskClass: RiskClass.optional(), small: z.boolean().optional(), ...TrackerFields },
    }, async ({ task: ref, after, afterPlans, goal, responsible, why, due, pipeline, stage, priority, ...changes }) => this.run(async () => {
      const { agent, task } = await this.find(ref);
      const tracker = { goal, responsible, why, due, pipeline, stage, priority };
      /* What the tracker keeps changes on its own, waking nobody; the work changes as before. Both are checked before
         either is written, so a refused part leaves the other as it was. With a change of the work, what the tracker
         keeps is written in the same move, checked again there: both are in, or neither. */
      const works = after !== undefined || Object.values(changes).some(v => v !== undefined);
      const edit = hasTrackerFields(tracker) ? await trackerInputOf(this.ctx, this.job.companyId, tracker) : null;
      if (!works) await requireTaskHead(this.ctx, task, agent.id);
      if (edit) await trackerSet(this.ctx, task, edit);
      const moved = works ? await updateTask(this.ctx, agent.id, task.id, { ...changes, ...(after !== undefined ? { after: await this.afterIds(after), afterPlans: await this.afterPlansOf(afterPlans) } : {}) }, edit ?? undefined) : undefined;
      let row = moved?.task ?? task;
      if (edit && !works) row = await editTask(this.ctx, { agentId: agent.id }, row, edit, seenOf(row));
      return { text: `Updated. ${await this.where(row)}`, moved };
    }));
  }

  private registerReport(): void {
    this.server.registerTool(
      'report',
      {
        description: 'Reports the current assigned stage: Architecture hands its plan to Development; Tests names the exact candidate/revision it checked with local tests, and done false returns a source defect to Development when verification.delta describes the repair, or otherwise gives the failure to the head; the accepting head names the ready candidate/revision and observed integration commit, or nothing but the summary where the result is a document. Main requires the normal human approval of that exact commit. Coordination aggregates accepted child results. Code never bypasses Review through a report. ' +
          `If you hold turnkey work with a branch of its own, close it with done true and turnkey: commit, the ${CHECKED_COMMIT}, and baseCommit, the ${START_COMMIT}. A release counts as checked only the first-parent line from that commit down to that start, and nothing the turn branch held as the work started: anything else it brings is named for a person to approve. ` +
          `A report that closes work that is not code (a group, or turnkey work that joined no turn) names where its result is recorded with recorded: path, a path in the department's repository, or file, the name of a file attached to the task. Without it the report is refused.`,
        inputSchema: { task: Ref, done: z.boolean(), summary: Text.trim().min(1), verification: Verification.optional(), acceptance: AcceptanceInput.optional(), turnkey: TurnkeyInput.optional(), recorded: Recorded.optional() },
      },
      async ({ task: ref, done, summary, verification, acceptance, turnkey, recorded }) =>
        this.run(async () => {
          const { task } = await this.find(ref);
          this.plain(task, summary, ...(verification?.delta ? [verification.delta] : []));
          const moved = await report(this.ctx, this.job.agentId, task.id, { done, summary, verification, acceptance, turnkey, recorded });
          return { text: `Reported. ${await this.where(moved.task)}`, moved };
        }),
    );
  }

  private registerCancelTask(): void {
    this.server.registerTool(
      'cancel_task',
      { description: this.boss ? 'Cancels any task, with every open task under it.' : this.job.agentKind === 'head' ? 'Cancels a task of your department or one you created, with every open task under it.' : 'Cancels a task you created, with every open task under it.', inputSchema: { task: Ref, why: z.string().trim().min(1).max(1000) } },
      async ({ task: ref, why }) =>
        this.run(async () => {
          const { task } = await this.find(ref);
          /* A head runs its department's work, whoever gave it: the orchestrator or a person's schedule too. */
          const headsIt = this.job.agentKind === 'head' && this.job.departmentId !== null && task.departmentId === this.job.departmentId;
          if (!this.boss && !headsIt && task.createdByAgentId !== this.job.agentId) throw refuse(403, 'task_not_yours', `#${task.number} is neither of your department nor created by you.`);
          const moved = await cancel(this.ctx, { agentId: this.job.agentId }, task.id, why);
          await stopTurns(this.ctx, moved.closed, this.job.agentId);
          const left = moved.waiting.length
            ? ` ${listed(moved.waiting)} ${moved.waiting.length === 1 ? 'comes after it and still waits' : 'come after it and still wait'}: give ${moved.waiting.length === 1 ? 'it' : 'them'} what to wait for with update_task (after, [] to start now), or cancel ${moved.waiting.length === 1 ? 'it' : 'them'}.`
            : '';
          return { text: `Cancelled #${task.number}.${left}`, moved };
        }),
    );
  }

  /* The orchestrator closes a task its route cannot close, in whatever state it stands. */
  private registerCloseTask(): void {
    this.server.registerTool(
      'close_task',
      {
        description: 'Closes any task in any state, past its route: status done or cancelled, why goes into its log as your act. Open work under it is cancelled with it. Done closes only the record: it accepts no result and puts nothing into a turn, a release or main. Use it when a task cannot close through its own moves, such as one whose work was closed outside Hornhoof.',
        inputSchema: { task: Ref, status: z.enum(['done', 'cancelled']), why: z.string().trim().min(1).max(1000) },
      },
      async ({ task: ref, status, why }) =>
        this.run(async () => {
          const { task } = await this.find(ref);
          const moved = await closeTask(this.ctx, { agentId: this.job.agentId }, task.id, { status, why });
          await stopTurns(this.ctx, moved.closed, this.job.agentId);
          return { text: `Closed #${task.number} as ${status}.${closedBeyond(moved)}`, moved };
        }),
    );
  }

  private registerAuthorCheck(): void {
    this.server.registerTool('check_author', {
      description: REVIEW_SKIP_ENABLED
        ? 'Requests check:author on the pushed Development candidate. The server pins the candidate and the current turn or main base. The node records the result on the task. Use the returned baseCommit for submit after this check finishes.'
        : 'Disabled. Submit the candidate for Review.',
      inputSchema: z.strictObject({ task: Ref }),
    }, async ({ task: ref }) => this.run(async () => {
      const { task } = await this.find(ref);
      const result = await requestAuthorCheck(this.ctx, this.job.agentId, this.job.id, task.id);
      return { text: JSON.stringify(result) };
    }));
  }

  private registerSubmit(): void {
    this.server.registerTool(
      'submit',
      {
        description: 'Hands the current Development or checking-stage candidate forward. Where task.echelons says document: attach the files to the task, give summary and evidence, and name no review. Review and Security fix findings themselves on the same branch, without returning to the author. At Tests, submit a new test-only repair on the same branch and base: the delta from the current candidate may change only test, tests or e2e directories, or *.test.* and *.spec.* files. Source repairs use report with done false and verification.delta, preserving the task and candidate history. When the candidate\'s own change passed and it only needs the main line, or the open turn branch of its department that went on (the turn takes a candidate only by fast-forward), its owner merges that line into the candidate branch and submits the merge with review.baseCommit naming the commit taken in: the candidate stays at Tests to be checked again, unless its previous Review was skipped on an author receipt. A new commit then needs Review. summary: what you did; evidence: the command you ran and what it printed, the link, the check. review.baseCommit is the commit the change starts from. The server reads the head of the branch named after the task (task-<number> or the only task-<number>-...), or of review.branch when the work is on another branch; a repair stays on the branch of the candidate it repairs. review.commit, when given, must be that head. Without a readable commit the submission is refused with the reason. Check the change before handing it forward. Where task.echelons says document, recorded names where the result is recorded (a path in the department\'s repository, or the name of a file attached to the task), and the hand-in is refused without it. Submitting starts no test run.',
        inputSchema: { task: Ref, summary: Text.trim().min(1), evidence: Text.trim().min(1), review: ReviewSubmission.optional(), recorded: Recorded.optional(), operationId: z.uuid().optional() },
      },
      async ({ task: ref, summary, evidence, review, recorded, operationId }) =>
        this.run(async () => {
          const { task } = await this.find(ref);
          this.plain(task, summary, evidence);
          const moved = await submit(this.ctx, this.job.agentId, task.id, { summary, evidence, review, recorded, operationId });
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
          'Records the current checker decision on an exact candidate: reviewedCommit names the commit checked, or candidateId from task.echelons where the result is a document. PASS hands it forward; a defect remains with this checker to fix. Wrong-goal escalate asks the head, without an author return. Review can add Security by naming a concrete risk. Structured issues record provenance of a commit, and the findings of a document go in the comment; numeric counts are derived, never supplied.',
        inputSchema: { task: Ref, pass: z.boolean(), comment: Text.trim().min(1), reviewedCommit: ReviewSha.optional(), candidateId: z.uuid().optional(), issues: z.array(IssueInput).max(99).optional(), security: z.string().trim().min(1).max(2000).optional(), escalate: z.boolean().optional() },
      },
      async ({ task: ref, pass, comment: why, reviewedCommit, candidateId, issues, security, escalate }) =>
        this.run(async () => {
          const { task } = await this.find(ref);
          this.plain(task, why);
          const moved = await verdict(this.ctx, this.job.agentId, task.id, { pass, comment: why, reviewedCommit, candidateId, issues, security, escalate });
          return { text: `Recorded. ${await this.where(moved.task)}`, moved };
        }),
    );
  }

  private registerConfirmFinding(): void {
    this.server.registerTool(
      'confirm_finding',
      { description: 'The actual area author or its head explicitly confirms or rejects a structured finding. Read its findingId and revision from task.reviewFindings. An author must name its current exact fixCommit; a head may confirm existence before a fix. This records existence only; it never passes a stage or removes a blocking finding. History and vendor counts retain provenance.', inputSchema: { task: Ref, ...ConfirmationInput.shape } },
      async ({ task: ref, ...input }) => this.run(async () => {
        const { task } = await this.find(ref);
        await confirmFinding(this.ctx, this.job.agentId, task, input);
        return { text: 'The finding confirmation is recorded; its stage and fix status are unchanged.' };
      }),
    );
  }
}
