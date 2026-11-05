import { APPROVAL_MODES, ApprovalAmount, ApprovalChannel, approvalNeeded, kindKey, ruleOf } from '@hornhoof/protocol';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, count, eq, gte, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { orchestratorHeaders } from '../../auth/internal.js';
import { approvalPolicies, departments, jobs, requests } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { ceoPrincipal, decisionPrincipal, withInputLock } from '../conversation/decision-context.js';
import { departmentOwner, departmentRules, kindKnown } from '../departments/approval-policy.js';
import { personParty } from '../events/parties.js';
import { appendOutgoing } from '../events/store.js';
import { carriesFile, encodedHint } from '../tasks/attachments.js';
import { decisionPerson } from '../tasks/decisions.js';
import { ask, comment, mayAsk, refuse, taskSpot, type Task } from '../tasks/engine.js';
import { TURN_QUESTIONS } from '../tasks/tools.js';
import { taskByRef } from '../tasks/views.js';
import { wakeAll } from '../tasks/wake.js';
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

type Asked = { channel: ApprovalChannel; kind: string; amount?: number | undefined; text: string; link?: string | undefined };

/* The rule of a channel of the task's department; a task of no department asks every time. */
async function ruleFor(ctx: Pick<Ctx, 'db'>, task: Task, channel: ApprovalChannel) {
  if (!task.departmentId) return ruleOf(undefined);
  const [stored] = await ctx.db.select().from(approvalPolicies).where(and(eq(approvalPolicies.departmentId, task.departmentId), eq(approvalPolicies.channel, channel)));
  return ruleOf(stored);
}

const limitWords = (rule: { limit: number; unit?: string | undefined }) => `${rule.limit}${rule.unit ? ` ${rule.unit}` : ''}`;

/* The tools every agent has for approvals: it reads how a department's go, and asks under them. Work the policy lets go
   leaves a line in the task's log, so people can see what went without them. */
export function registerApprovalTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  const { db } = ctx;

  const held = async (ref: number | string): Promise<Task> => {
    const task = await taskByRef(ctx, job.companyId, ref);
    if (!task) throw refuse(404, 'task_unknown', `There is no task ${ref}. Call tasks for yours.`);
    mayAsk(task, job.agentId);
    return task;
  };

  /* A question to people, kept with the person it goes to, within what one turn may ask. */
  const askPerson = async (task: Task, q: { kind: 'question' | 'approval'; text: string; approval?: { channel: ApprovalChannel; kind: string; amount: number | null }; link?: string | null }) => {
    if (carriesFile(q.text)) throw refuse(400, 'task_invalid', encodedHint(task.number));
    const [{ at } = { at: null }] = await db.select({ at: jobs.startedAt }).from(jobs).where(eq(jobs.id, job.id));
    const [asked] = await db
      .select({ n: count() })
      .from(requests)
      .where(and(eq(requests.agentId, job.agentId), inArray(requests.kind, ['question', 'approval', 'choice']), gte(requests.createdAt, at ?? new Date(0))));
    if (Number(asked?.n ?? 0) >= TURN_QUESTIONS) throw refuse(409, 'task_invalid', `One turn asks people at most ${TURN_QUESTIONS} times.`);
    const moved = await ask(ctx, job.agentId, task.id, q);
    const personId = await decisionPerson(ctx, job.companyId, { source: 'request', kind: q.kind, topic: moved.request.decisionTopic, spot: taskSpot(task) });
    await appendOutgoing(ctx, { companyId: job.companyId, agentId: job.agentId, jobId: job.id, text: q.text, to: await personParty(ctx, job.companyId, personId) });
    await wakeAll(ctx, moved.wakes);
    return moved;
  };

  server.registerTool(
    'approval_policy',
    {
      description: "A department's approvals: who owns them (none means the CEO) and the rule of each channel: every, new_kinds, or within_limits with its limit. Each channel with no rule of its own asks every time.",
      inputSchema: { department: Department },
    },
    ({ department }) =>
      readable(async () => {
        const [dept] = await db.select().from(departments).where(and(eq(departments.id, department), eq(departments.companyId, job.companyId)));
        if (!dept) return say(`There is no department with id ${department}. Call company to see the current ids.`, true);
        const top = dept.parentId ?? dept.id;
        return say(JSON.stringify({ department: top, owner: await departmentOwner(ctx, job.companyId, top), rules: await departmentRules(db, top) }));
      }),
  );

  server.registerTool(
    'request_approval',
    {
      description:
        'Before work that may need a person\'s approval (a message out, a price, a publication, a spend and so on), ask here. It follows the policy of the task\'s department. ' +
        'When the policy lets the work go, no person is asked: the answer says so and a line goes in the task\'s log, so go on with the work. Otherwise the task waits, the department\'s owner (with none, the CEO) is asked, and you are woken with the answer. ' +
        'channel: message, price, publication, commit, spend, or other for anything else. kind: a short name of this kind of work, the same each time, like "welcome email". ' +
        'amount: how much this one is, in what the channel\'s limit counts. Without it, a limit never lets the work go. text: what you want to do, in plain words. link: an https page where it can be seen.' +
        ` Counts among the ${TURN_QUESTIONS} questions a turn may ask. To approve an exact commit for a release, use ask_person with commit, which always asks.`,
      inputSchema: {
        task: Ref,
        channel: ApprovalChannel,
        kind: z.string().trim().min(1).max(80),
        amount: ApprovalAmount.optional(),
        text: z.string().trim().min(1).max(2000),
        link: z.url({ protocol: /^https$/ }).max(500).optional(),
      },
    },
    ({ task: ref, ...asked }: Asked & { task: number | string }) =>
      readable(async () => {
        const task = await held(ref);
        const rule = await ruleFor(ctx, task, asked.channel);
        const known = task.departmentId !== null && rule.mode === 'new_kinds' && (await kindKnown(db, job.companyId, task.departmentId, asked.channel, asked.kind));
        if (!approvalNeeded(rule, { amount: asked.amount ?? null, known })) {
          const why = rule.mode === 'within_limits' ? `${asked.amount} is within the limit of ${limitWords(rule)}` : 'this kind was approved before';
          await wakeAll(ctx, (await comment(ctx, { agentId: job.agentId }, task.id, `Went without approval (${asked.channel}, ${kindKey(asked.kind)}): ${why}. ${asked.text}`)).wakes);
          return say(`No approval needed: ${why}. Go on with the work.`);
        }
        await askPerson(task, { kind: 'approval', text: asked.text, approval: { channel: asked.channel, kind: kindKey(asked.kind), amount: asked.amount ?? null }, link: asked.link ?? null });
        return say(`Asked. #${task.number} waits for a person's answer; you will be woken with it.`);
      }),
  );

  if (job.agentKind === 'worker') return;
  server.registerTool(
    'escalate_missed_goal',
    {
      description: 'Puts before the CEO that the department is missing a goal or its plan (no customers, no deals, a release running late). The CEO comes for this, not for each approval, which go to the department\'s owner. The task waits for the answer. goal: the goal that is missed. why: what happened, with the numbers.',
      inputSchema: { task: Ref, goal: z.string().trim().min(1).max(300), why: z.string().trim().min(1).max(1500) },
    },
    ({ task: ref, goal, why }) =>
      readable(async () => {
        const task = await held(ref);
        await askPerson(task, { kind: 'question', text: `Missed goal: ${goal}. ${why}` });
        return say(`Told the CEO. #${task.number} waits for the answer; you will be woken with it.`);
      }),
  );
}

/* The orchestrator's tools to change them. Each calls the route the screen calls, as the person whose words its turn answers
   now, under the input lock, so it may do what that person may and no employee, timer or task can ask it to. */
export function registerApprovalControlTools(server: McpServer, ctx: Ctx, app: FastifyInstance, job: ToolJob): void {
  const asPerson = (find: () => Promise<string | null>, nobody: string, url: string, payload: object) =>
    withInputLock(ctx, job.agentId, async () => {
      const personId = await find();
      if (!personId) return say(nobody, true);
      const res = await app.inject({ method: 'PUT', url, headers: orchestratorHeaders(personId, job.agentId), payload });
      if (res.statusCode < 400) return say(res.body);
      return say((JSON.parse(res.body) as { error?: { message?: string } }).error?.message ?? `Hornhoof answered ${res.statusCode}.`, true);
    });

  server.registerTool(
    'set_department_owner',
    {
      description: 'Names who owns a department: they take its approvals and set its policy. person: someone active with access to the department, or null to leave it to the CEO. Access alone never makes anyone an owner, and the rules stay as they are when the owner changes. Only in a turn that answers the CEO or the CEO delegate.',
      inputSchema: { department: Department, person: z.uuid().nullable() },
    },
    ({ department, person }) =>
      asPerson(
        () => ceoPrincipal(ctx.db, job.id),
        'Only the CEO or the CEO delegate names a department\'s owner, in a turn that answers them: the last person who wrote into it. Nothing was changed. Ask the CEO first.',
        `/api/departments/${department}/owner`,
        { personId: person },
      ),
  );

  server.registerTool(
    'set_approval_policy',
    {
      description:
        'Sets how one channel of a department is approved. mode every: each one asks. new_kinds: only a kind nobody approved yet asks. within_limits: no approval up to limit, above it the owner is asked; unit says what the limit counts, like USD. ' +
        "Only in a turn that answers the department's owner, the CEO or the CEO delegate, as their decision.",
      inputSchema: { department: Department, channel: ApprovalChannel, mode: z.enum(APPROVAL_MODES), limit: ApprovalAmount.optional(), unit: z.string().trim().min(1).max(16).optional() },
    },
    ({ department, channel, mode, limit, unit }) =>
      asPerson(
        async () => (await decisionPrincipal(ctx.db, job.id))?.personId ?? null,
        'This turn answers no person who may change this: the last message in it came from an employee or from Hornhoof. Nothing was changed. Ask the department\'s owner, the CEO or the CEO delegate.',
        `/api/departments/${department}/approval-policy/${channel}`,
        { mode, ...(limit === undefined ? {} : { limit }), ...(unit === undefined ? {} : { unit }) },
      ),
  );
}
