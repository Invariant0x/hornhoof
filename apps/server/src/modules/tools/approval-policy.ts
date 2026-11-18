import { WAIT_SOURCE_KINDS, WaitPlan } from '@hornhoof/protocol/waits';
import { APPROVAL_MODES, ApprovalAmount, ApprovalChannel, approvalNeeded, kindKey } from '@hornhoof/protocol';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { orchestratorHeaders, orchestratorJobHeaders } from '../../auth/internal.js';
import { isUniqueViolation } from '../../db/errors.js';
import { agents, departments } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { decisionPrincipal, withInputLock } from '../conversation/decision-context.js';
import { approvalRuleFor, departmentOwner, departmentRules, kindKnown } from '../departments/approval-policy.js';
import { departmentWaitPolicies } from '../departments/wait-policy-routes.js';
import { personParty } from '../events/parties.js';
import { appendOutgoing } from '../events/store.js';
import { carriesFile, encodedHint } from '../tasks/attachments.js';
import { isAutonomousReleaseEnabled, tryAutonomousCommitApproval } from '../tasks/autonomous-release.js';
import { commitApprovalRequired } from '../tasks/commit-approval.js';
import { decisionPerson } from '../tasks/decision-people.js';
import { ask, type Ask } from '../tasks/engine.js';
import { comment } from '../tasks/comments.js';
import { mayAsk, refuse, taskSpot, type Task } from '../tasks/state.js';
import { refusePaused } from '../tasks/pause.js';
import { openTurnOf } from '../tasks/turn-department.js';
import { taskByRef } from '../tasks/lookup.js';
import { openGoal, resolveGoal, reviseGoal, type GoalImpact, type GoalRef } from '../tasks/wait-goals.js';
import { wakeAll } from '../tasks/wake.js';
import { commitProof, proofLine } from '../testruns/commit-proof.js';
import type { ToolJob } from './job.js';

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
const Ref = z.union([z.number().int().positive(), z.string().max(40)]).describe('The task number, like 12 or "#12", or its id.');
const Department = z.uuid().describe("The department's id, from company. A product goes by the department that holds it.");

/* A refused move comes back as a readable error. */
const readable = async (fn: () => Promise<ReturnType<typeof say>>) => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) return say(err.message, true);
    throw err;
  }
};

const GoalOn = z.enum(['task', 'turn']).default('task');

/* The goal a report is about, by what it stands on rather than by its words: the task, or the release it goes into, the
   turn it joined or else its department's open turn. */
async function goalRefOf(ctx: Pick<Ctx, 'db'>, task: Task, on: 'task' | 'turn'): Promise<GoalRef> {
  if (on === 'task') return { kind: 'task', id: task.id };
  const turnId = task.turnId ?? (await openTurnOf(ctx.db, task.companyId, task.departmentId))?.id;
  if (!turnId) throw refuse(400, 'task_invalid', `#${task.number} is in no turn, and its department has no open turn.`);
  return { kind: 'turn', id: turnId };
}

type Asked = {
  channel: ApprovalChannel;
  kind: string;
  amount?: number | undefined;
  commit?: string | undefined;
  text: string;
  link?: string | undefined;
  plan?: WaitPlan | undefined;
};

const limitWords = (rule: { limit: number; unit?: string | undefined }) => `${rule.limit}${rule.unit ? ` ${rule.unit}` : ''}`;

/* The task, when this agent is the one who asks on it. */
async function heldTask(ctx: Pick<Ctx, 'db'>, job: ToolJob, ref: number | string): Promise<Task> {
  const task = await taskByRef(ctx, job.companyId, ref);
  if (!task) throw refuse(404, 'task_unknown', `There is no task ${ref}. Call tasks for yours.`);
  mayAsk(task, job.agentId);
  return task;
}

/* A question to people, kept with the person it goes to. */
async function askPerson(ctx: Ctx, job: ToolJob, task: Task, q: Ask & { kind: 'question' | 'approval' }): Promise<void> {
  if (carriesFile(q.text)) throw refuse(400, 'task_invalid', encodedHint(task.number));
  const moved = await ask(ctx, job.agentId, task.id, q);
  const personId = await decisionPerson(ctx, job.companyId, { source: 'request', kind: q.kind, topic: moved.request.decisionTopic, spot: taskSpot(task) });
  await appendOutgoing(ctx, { companyId: job.companyId, agentId: job.agentId, jobId: job.id, text: q.text, to: await personParty(ctx, job.companyId, personId) });
  await wakeAll(ctx, moved.wakes);
}

/* Why the policy lets this work go without a person, when it does. */
async function letGoBecause(ctx: Pick<Ctx, 'db'>, job: ToolJob, task: Task, asked: Asked): Promise<string | null> {
  const rule = await approvalRuleFor(ctx.db, task.departmentId, asked.channel);
  const known = task.departmentId !== null && rule.mode === 'new_kinds' && (await kindKnown(ctx.db, job.companyId, task.departmentId, asked.channel, asked.kind));
  if (approvalNeeded(rule, { amount: asked.amount ?? null, known })) return null;
  if (rule.mode === 'none') return `the department asks no approval for ${asked.channel}`;
  return rule.mode === 'within_limits' ? `${asked.amount} is within the limit of ${limitWords(rule)}` : 'this kind was approved before';
}

function approvalCard(asked: Asked, kind: string, topic: 'task' | 'release', text: string, commit?: string): Ask & { kind: 'approval' } {
  return {
    kind: 'approval',
    text,
    ...(commit ? { commit } : {}),
    approval: { channel: commit ? 'commit' : asked.channel, kind, amount: asked.amount ?? null },
    link: asked.link ?? null,
    topic,
    ...(asked.plan ? { plan: asked.plan } : {}),
  };
}

async function requestCommitApproval(ctx: Ctx, job: ToolJob, task: Task, commit: string, asked: Asked) {
  if (carriesFile(asked.text)) throw refuse(400, 'task_invalid', encodedHint(task.number));
  if (!(await commitApprovalRequired(ctx.db, job.companyId, task.departmentId))) {
    refusePaused(task);
    return proceedWithoutApproval(ctx, job, task, asked, 'commit', 'the department asks no approval for commit');
  }
  const auto = await tryAutonomousCommitApproval(ctx, task, job.agentId, commit, asked.text);
  if (auto) {
    await wakeAll(ctx, auto.moved.wakes);
    return say(auto.text);
  }
  const said = proofLine(await commitProof(ctx.db, task, commit));
  await askPerson(ctx, job, task, approvalCard({ ...asked, amount: undefined }, 'commit', 'release', `${asked.text}\n\nHornhoof checked as this was asked. ${said}`, commit));
  return say(`Asked. #${task.number} waits for a person's answer; you will be woken with it. ${said}`);
}

/* Work the policy lets go leaves a line in the task's log. */
async function proceedWithoutApproval(ctx: Ctx, job: ToolJob, task: Task, asked: Asked, kind: string, why: string) {
  await wakeAll(ctx, (await comment(ctx, { agentId: job.agentId }, task.id, `Went without approval (${asked.channel}, ${kind}): ${why}. ${asked.commit ? `${asked.commit}. ` : ''}${asked.text}`)).wakes);
  return say(`No approval needed: ${why}. Go on with the work.`);
}


async function requestApproval(ctx: Ctx, job: ToolJob, ref: number | string, asked: Asked) {
  if (asked.commit && asked.channel !== 'commit') throw refuse(400, 'task_invalid', 'Only channel commit names a commit SHA.');
  const task = await heldTask(ctx, job, ref);
  const kind = kindKey(asked.kind);
  if (asked.commit) return requestCommitApproval(ctx, job, task, asked.commit, asked);
  const why = await letGoBecause(ctx, job, task, asked);
  if (why) return proceedWithoutApproval(ctx, job, task, asked, kind, why);
  if (asked.channel === 'commit') throw refuse(400, 'task_invalid', 'Commit approval needs the full 40-character commit.');
  await askPerson(ctx, job, task, approvalCard(asked, kind, 'task', asked.text));
  return say(`Asked. #${task.number} waits for a person's answer; you will be woken with it.`);
}

/* A department's owner and rules as an agent reads them. */
async function readPolicy(ctx: Pick<Ctx, 'db'>, job: ToolJob, department: string) {
  const [dept] = await ctx.db.select().from(departments).where(and(eq(departments.id, department), eq(departments.companyId, job.companyId)));
  if (!dept) return say(`There is no department with id ${department}. Call company to see the current ids.`, true);
  const top = dept.parentId ?? dept.id;
  return say(
    JSON.stringify({
      department: top,
      owner: await departmentOwner(ctx, job.companyId, top),
      autonomousRelease: await isAutonomousReleaseEnabled(ctx.db, top),
      rules: await departmentRules(ctx.db, top),
      waitDates: await departmentWaitPolicies(ctx, top),
    }),
  );
}

/* A goal in danger, as a head or the orchestrator says it: a new episode, or what this adds to the one that is open. */
async function escalateGoal(ctx: Ctx, job: ToolJob, ref: number | string, said: { goal: string; why: string; impact: GoalImpact; on: 'task' | 'turn' }) {
  const task = await heldTask(ctx, job, ref);
  const goalRef = await goalRefOf(ctx, task, said.on);
  const open = await openGoal(ctx.db, task.companyId, goalRef);
  if (open) return say(await reviseGoal(ctx, { agentId: job.agentId }, open, said.impact) ? 'The CEO is told it is now missed.' : `The CEO has this already, on the question in #${task.number}. Nothing changed.`);
  try {
    await askPerson(ctx, job, task, { kind: 'question', text: `${said.impact === 'missed' ? 'Missed goal' : 'Goal at risk'}: ${said.goal}. ${said.why}`, goal: { ref: goalRef, impact: said.impact } });
  } catch (err) {
    /* Another said it first: this one joins that episode. */
    const first = isUniqueViolation(err) ? await openGoal(ctx.db, task.companyId, goalRef) : null;
    if (!first) throw err;
    await reviseGoal(ctx, { agentId: job.agentId }, first, said.impact);
  }
  return say(`Told the CEO. #${task.number} waits for the answer; you will be woken with it.`);
}

/* The head of the department or the orchestrator says the goal is out of danger. */
async function endGoalRisk(ctx: Ctx, job: ToolJob, ref: number | string, why: string, on: 'task' | 'turn') {
  const task = await taskByRef(ctx, job.companyId, ref);
  if (!task) return say(`There is no task ${ref}. Call tasks for yours.`, true);
  const [me] = await ctx.db.select({ kind: agents.kind, departmentId: agents.departmentId }).from(agents).where(eq(agents.id, job.agentId));
  if (me?.kind !== 'orchestrator' && me?.departmentId !== task.departmentId) return say(`#${task.number} is not of your department.`, true);
  await resolveGoal(ctx, { agentId: job.agentId }, job.companyId, await goalRefOf(ctx, task, on), why);
  return say('Recorded: the goal is out of danger.');
}

/* The tools every agent has for approvals: it reads how a department's go, and asks under them. */
export function registerApprovalTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  server.registerTool(
    'approval_policy',
    {
      description:
        "Reads who owns the department's approvals, whether autonomousRelease is on, and the rule and limit for each channel. An unset channel needs no approval.",
      inputSchema: { department: Department },
    },
    ({ department }) => readable(() => readPolicy(ctx, job, department)),
  );

  server.registerTool(
    'request_approval',
    {
      description:
        'Follows the approval policy of the task\'s department. A channel with no rule needs no approval. When the policy lets the work go, the task log records it. Otherwise the department\'s owner (with none, the CEO) is asked and the task waits for their answer. ' +
        'channel: message, price, publication, commit, spend, or other for anything else. kind: a short name of this kind of work, the same each time, like "welcome email". ' +
        'amount: how much this work is in the limit\'s unit. text: what you want to do. link: an https page where it can be seen. ' +
        'For an exact commit to main, send its full SHA. Exact commits share one kind and have no amount. If autonomous release is on, it can approve a main integration with a whole green run, an independent PASS verdict and a verified fast-forward path. Otherwise the commit rule says whether to ask a person.',
      inputSchema: {
        task: Ref,
        channel: ApprovalChannel,
        kind: z.string().trim().min(1).max(80),
        amount: ApprovalAmount.optional(),
        commit: z.string().regex(/^[0-9a-f]{40}$/).optional().describe('Full 40-character SHA for channel commit.'),
        text: z.string().trim().min(1).max(2000),
        link: z.url({ protocol: /^https$/ }).max(500).optional(),
        plan: WaitPlan.optional().describe('Who answers by when, where someone promised dates. Without one the department\'s dates stand; a department that sets dates and has none for this refuses the request.'),
      },
    },
    ({ task, ...asked }: Asked & { task: number | string }) => readable(() => requestApproval(ctx, job, task, asked)),
  );

  if (job.agentKind === 'worker') return;
  server.registerTool(
    'escalate_missed_goal',
    {
      description: "Puts before the CEO that the department is missing a goal or its plan (no customers, no deals, a release running late), or is about to. The CEO comes for this, not for each approval, which go to the department's owner. The task waits for the answer. goal: the goal in danger. why: what happened, with the numbers. impact: missed, or at_risk while it can still be saved. on: task for a goal of this task, turn for one of its turn. Saying it again changes nothing unless at_risk became missed. An answer does not end it: resolve_goal_risk does.",
      inputSchema: { task: Ref, goal: z.string().trim().min(1).max(300), why: z.string().trim().min(1).max(1500), impact: z.enum(['at_risk', 'missed']).default('missed'), on: GoalOn },
    },
    ({ task, ...said }) => readable(() => escalateGoal(ctx, job, task, said)),
  );

  server.registerTool(
    'resolve_goal_risk',
    {
      description: 'Records that a goal you or someone put before the CEO with escalate_missed_goal is out of danger. Only the head of the department or the orchestrator says so, with what shows it. An answer from the CEO alone does not. A later threat starts anew.',
      inputSchema: { task: Ref, why: z.string().trim().min(1).max(1500), on: GoalOn },
    },
    ({ task, why, on }) => readable(() => endGoalRisk(ctx, job, task, why, on)),
  );
}

const NO_PERSON = 'No active owner is available, or input for this turn is still being recorded. Nothing was changed. Check the department owner or the CEO.';
const NOT_YOURS = 'This department is not yours. Nothing was changed. You set only your own department\'s approvals and wait dates.';

type Change = (url: string, payload: object) => Promise<ReturnType<typeof say>>;

/* A change calls the screen's route under the input lock with the agent's current principal: a head's department owner,
   otherwise the CEO, and the orchestrator's company principal. */
function changeAsPerson(ctx: Ctx, app: FastifyInstance, job: ToolJob): Change {
  const send = async (url: string, payload: object, headers: Record<string, string>) => {
    const res = await app.inject({ method: 'PUT', url, headers, payload });
    if (res.statusCode < 400) return say(res.body);
    return say((JSON.parse(res.body) as { error?: { message?: string } }).error?.message ?? `Hornhoof answered ${res.statusCode}.`, true);
  };
  if (job.agentKind === 'orchestrator') return (url, payload) => send(url, payload, orchestratorJobHeaders(job));
  return (url, payload) =>
    withInputLock(ctx, job.agentId, async () => {
      const personId = (await decisionPrincipal(ctx.db, job.id))?.personId;
      if (!personId) return say(NO_PERSON, true);
      return send(url, payload, orchestratorHeaders(personId, job.agentId));
    });
}

const ORCHESTRATOR_WHO = 'In any turn as the company owner.';
const HEAD_WHO = 'Only for your own department, in any turn with its named owner\'s rights, or the CEO\'s when it has none. No fresh human message is needed. Follow its rules and notebook.';

/* The tools that set a department's approvals and wait dates; mine says which department the agent may name. */
function registerPolicyTools(server: McpServer, change: Change, who: string, mine: (department: string) => boolean): void {
  const place = (department: string, url: string, payload: object) => (mine(department) ? change(url, payload) : Promise.resolve(say(NOT_YOURS, true)));
  server.registerTool(
    'set_approval_policy',
    {
      description:
        'Sets how one channel of a department is approved. mode none: nothing asks. every: each one asks. new_kinds: only a kind nobody approved yet asks. within_limits: no approval up to limit, above it the owner is asked; unit says what the limit counts, like USD. ' +
        who,
      inputSchema: { department: Department, channel: ApprovalChannel, mode: z.enum(APPROVAL_MODES), limit: ApprovalAmount.optional(), unit: z.string().trim().min(1).max(16).optional() },
    },
    ({ department, channel, mode, limit, unit }) =>
      place(department, `/api/departments/${department}/approval-policy/${channel}`, { mode, ...(limit === undefined ? {} : { limit }), ...(unit === undefined ? {} : { unit }) }),
  );

  server.registerTool(
    'set_autonomous_release',
    {
      description: 'Turns the department\'s use of proof to satisfy commit approvals on or off. ' + who,
      inputSchema: { department: Department, enabled: z.boolean() },
    },
    ({ department, enabled }) => place(department, `/api/departments/${department}/approval-policy/autonomous-release`, { enabled }),
  );

  server.registerTool(
    'set_wait_policy',
    {
      description:
        'Sets how long a department gives a kind of wait: after, review, person, run or external, at a stage of a run or at all. ownerMs, headMs, decisionMs: when its owner, its head and then the department\'s owner are told, counted from when the wait began. reviewIntervalMs: how often the head looks at it again after that. ' +
        'The first one set makes the department strict: from then on a wait of a kind with no dates set and no promise is refused, so set them all that are needed. A question to a person is never refused: it then waits with no dates. Choose within your department rules and authority; never invent a person\'s promise. There are no standard numbers. ' +
        who,
      inputSchema: { department: Department, kind: z.enum(WAIT_SOURCE_KINDS), stage: z.string().trim().max(40).optional(), ownerMs: z.number().int().positive(), headMs: z.number().int().positive(), decisionMs: z.number().int().positive(), reviewIntervalMs: z.number().int().positive() },
    },
    ({ department, kind, ...policy }) => place(department, `/api/departments/${department}/wait-policy/${kind}`, policy),
  );
}

/* The orchestrator's tools to change them, for any department, as the person its turn answers. */
export function registerApprovalControlTools(server: McpServer, ctx: Ctx, app: FastifyInstance, job: ToolJob): void {
  const change = changeAsPerson(ctx, app, job);
  server.registerTool(
    'set_department_owner',
    {
      description: 'Names who owns a department: they take its approvals and set its policy. person: someone active with access to the department, or null to leave it to the CEO. Access alone never makes anyone an owner, and the rules stay as they are when the owner changes. Available in any turn.',
      inputSchema: { department: Department, person: z.uuid().nullable() },
    },
    ({ department, person }) => change(`/api/departments/${department}/owner`, { personId: person }),
  );
  registerPolicyTools(server, change, ORCHESTRATOR_WHO, () => true);
}

/* A head's own: the same tools for its own department only, with no word of the orchestrator or the CEO. The route still lets
   the people who run the department, the CEO and the CEO delegate change them. */
export function registerHeadPolicyTools(server: McpServer, ctx: Ctx, app: FastifyInstance, job: ToolJob): void {
  registerPolicyTools(server, changeAsPerson(ctx, app, job), HEAD_WHO, department => job.departmentId !== null && department === job.departmentId);
}
