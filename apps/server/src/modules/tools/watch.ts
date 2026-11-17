import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Text } from '../tasks/long-text.js';
import type { Ctx } from '../../app.js';
import { offlineMachine } from '../nodes/offline.js';
import { worksIn } from '../departments/inside.js';
import { ApiError } from '../../errors.js';
import { agentEvents, agents, departments, jobs, requests, taskEvents, tasks } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { answerBy, wrote } from '../conversation/prompt.js';
import { agentState, carrierOf, enqueueTurn, GONE_ALONG, orchestratorOf, reconnecting, STOPPED_ON_PURPOSE } from '../conversation/queue.js';
import { keepUndelivered, NOT_DELIVERED, UndeliveredRecord, undeliveredLine } from '../conversation/undelivered.js';
import { deptName } from '../departments/templates.js';
import type { WithEvent } from '../events/store.js';
import { returnAlongLine } from '../org/map-state.js';
import { carriesFile, encodedHint } from '../tasks/attachments.js';
import { programRestartStatus, restartProgram } from '../tasks/program-restarts.js';
import { queueTaskMessage, MESSAGE_TASK_HINT, TaskReference } from '../tasks/external-wait.js';
import type { Grant } from '../templates/load.js';
import { PROGRAM_OPERATOR_ROLE } from '@hornhoof/protocol/program-operator';
import { cleanDiagnostic } from '@hornhoof/protocol/redaction';
import { agentSeesTask } from '../tasks/views.js';
import { authorizeAccess, OPERATIONS_ROLES } from '../program-operator/access.js';
import { registerOperatorTools, registerProgramAccessTools, registerStopTool } from '../program-operator/tools.js';
import { registerReleaseTool } from '../program-operator/release.js';
import { nextSection } from './next-section.js';
import { INSTALL_HINT, installsIn, MISSING_HINT, missingIn, type Missing } from './stumbles.js';
import { watchedTasks } from './watch-tasks.js';

type Reader = Parameters<typeof agentSeesTask>[0];
type TaskSight = Parameters<typeof agentSeesTask>[1];
type Failure = { kind: string; text: string } | null;
/* What of a task decides whether a reader may open it, read beside its work. */
const SIGHT = { status: tasks.status, departmentId: tasks.departmentId, assigneeAgentId: tasks.assigneeAgentId, executorAgentId: tasks.executorAgentId };

/* Who reads failures, to know whose work it may open. */
const readerOf = async (ctx: Ctx, agentId: string): Promise<Reader | undefined> =>
  (await ctx.db.select({ id: agents.id, kind: agents.kind, departmentId: agents.departmentId }).from(agents).where(eq(agents.id, agentId)))[0];

/* Whether a reader may open a task as task shows it. */
const opensTask = (reader: Reader | undefined, task: TaskSight): boolean => reader !== undefined && agentSeesTask(reader, task);

/* Whether a reader may open the work a turn's words come from: its task, or for a turn on no task its agent's department. */
function opensTurn(reader: Reader | undefined, task: TaskSight | null, agent: { id: string | null; departmentId: string | null }): boolean {
  if (task) return opensTask(reader, task);
  return reader !== undefined && (reader.kind === 'orchestrator' || reader.id === agent.id || (reader.departmentId !== null && reader.departmentId === agent.departmentId));
}

/* Words as a reader gets them: as they are where it may open their work, else with no credential and no private path, cleaned
   before any cut so that no part of either is left at its edge. */
const shown = (text: string, open: boolean): string => (open ? text : cleanDiagnostic(text));

/* Every word of a line as a reader who may not open its work gets it, down into what a node reported, its long words
   already cleaned before their cut. */
function cleanedAll<T>(value: T): T {
  if (typeof value === 'string') return cleanDiagnostic(value) as T;
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, cleanedAll(inner)])) as T;
  return value;
}
const shownAll = <T>(value: T, open: boolean): T => (open ? value : cleanedAll(value));

/* Why a turn failed as Hornhoof recorded it, beside the end of its output, which a program that never wrote leaves empty. */
function failureReason(failure: Failure, result: string | null, open: boolean): string | null {
  const reason = failure?.text ? `${failure.kind}: ${shown(failure.text, open)}` : shown(result?.trim() ?? '', open);
  return reason ? reason.slice(0, TAIL) : null;
}

type FailedRow = { agentId: string | null; departmentId: string | null; tail: string; failure: Failure; result: string | null; sight: TaskSight | null; error: string | null; task: number | null };

/* A turn Hornhoof failed for a message before it kept why still names its recipient and its task. */
const undeliveredBefore = (row: FailedRow): string | null =>
  row.error === NOT_DELIVERED && row.agentId ? undeliveredLine({ reason: 'reason_not_recorded', recipient: row.agentId, task: row.task }) : null;

/* A failed turn as a reader gets it: its department by name, the end of its output and why it failed. */
function failedLine<T extends FailedRow>(row: T, reader: Reader | undefined, names: Map<string, string>) {
  /* What decides the reader's view stays out of what it reads. */
  const { agentId, departmentId, tail, failure, result, sight, ...line } = row;
  const open = opensTurn(reader, sight, { id: agentId, departmentId });
  const reason = failureReason(failure, result, open) ?? undeliveredBefore(row);
  return shownAll({ ...line, department: (departmentId && names.get(departmentId)) || null, tail: shown(tail, open).slice(-TAIL), reason }, open);
}

type SeenRow = { agentId: string; departmentId: string | null; sight: TaskSight | null; agent: string; text: string; at: Date; task: number | null };

/* Tool calls and results as a reader gets them, cleaned before anything is read out of them or cut, so that what was
   missing, the line that said so and what was installed come from cleaned words. */
const seenBy = (rows: SeenRow[], reader: Reader | undefined) =>
  rows.map(({ agentId, departmentId, sight, ...row }) => ({ ...row, text: shown(row.text, opensTurn(reader, sight, { id: agentId, departmentId })) }));

/* How the turn a holder stopped from ended, the end of its output, cleaned before its cut. */
const turnEnd = (last: { result: string | null; tail: string } | undefined, open: boolean): string | null =>
  last ? shown(last.result?.trim() || last.tail, open).slice(-TAIL) : null;

type ToolJob = { id: string; companyId: string; agentId: string; agentKind: string; roleKey?: string | null };
type Agent = typeof agents.$inferSelect;

/* What one turn may send to others, so a round that goes wrong cannot flood the company. */

/* Why an employee cannot take a message now. A machine that is off stops none of the work it pushed: someone else goes on
   from its branch, or it moves to a plan of the department that is online. */
async function cannotRun(ctx: Pick<Ctx, 'db' | 'hub'>, me: Agent, target: Agent, reason: string | null): Promise<string> {
  const offline = reason === 'machine_offline' ? await offlineMachine(ctx, target.subscriptionId) : null;
  if (!offline) return `${target.name} cannot run now. Tell your head: a person who runs the department gives ${target.name} a plan of the department that serves it, or the plan's owner signs it in.`;
  /* Which machine it is stays inside the department, as on the cards. */
  const machine = (await worksIn(ctx.db, me, target.departmentId)) ? `${offline.hostname}, the machine of its plan, is offline` : 'the machine of its plan is offline';
  return `${target.name} cannot run now: ${machine}. The work it pushed stays in the repository: an employee who is on can go on from its branch, and a person who runs the department can move ${target.name} to a plan of the department that is online.`;
}

export const TURN_NUDGES = 10;
const TAIL = 400;
/* The end of what a holder said when it stopped: a long report ends with its concerns and its next step. */
const WHY_TAIL = 500;
/* Queued turns Hornhoof ended unsent on purpose, as their task went to another holder or waits for the tasks before it: no
   program ran, so there is nothing to find. */
const ENDED_UNSENT = ['handed_on', 'waiting'];
/* The start of what a holder said when it stopped, and its end when it says more than the start holds, as the reader gets it,
   with what it said comes next, cleaned for every reader. */
function heldWords(said: { text: string } | undefined, open: boolean) {
  const text = said ? shown(said.text, open) : null;
  return {
    why: text === null ? null : text.slice(0, TAIL),
    whyTail: text !== null && text.length > TAIL ? text.slice(-WHY_TAIL) : null,
    next: said ? nextSection(said.text) : null,
  };
}
const FAILED_MAX = 50;
/* Tool calls and results read for where agents stumbled, the newest first. */
const STUMBLES_MAX = 1000;
const STOPS_MAX = 50;
const UNDELIVERED_MAX = 50;
const GROUPS_MAX = 30;

/* Messages each running turn sent, counted before the next one goes out so two at once cannot both pass; the oldest turns
   are forgotten. */
const sent = new WeakMap<Ctx, Map<string, number>>();
const SENT_KEPT = 500;

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

function taskMessageFailure(error: unknown): ReturnType<typeof say> {
  if (error instanceof ApiError) return say(error.message, true);
  throw error;
}
const json = (value: unknown) => say(JSON.stringify(value));
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

/* The same thing found many times, with how often and by whom, the most frequent first and the rest left out. Items come
   newest first, so each keeps its newest example, with when and on which task it was. */
function tally<T>(items: { key: string; value: T; agent: string; example?: string; at: Date; task: number | null }[]) {
  const all = new Map<string, { value: T; times: number; agents: Set<string>; example?: string; at: Date; task: number | null }>();
  for (const { key, value, agent, example, at, task } of items) {
    const seen = all.get(key) ?? { value, times: 0, agents: new Set<string>(), example, at, task };
    seen.times++;
    seen.agents.add(agent);
    all.set(key, seen);
  }
  return [...all.values()]
    .sort((a, b) => b.times - a.times)
    .slice(0, GROUPS_MAX)
    .map(({ value, times, agents, example, at, task }) => ({ value, times, agents: [...agents].sort(), example, at, task }));
}
/* The line of a tool result that says what was missing. */
const lineOf = (text: string, what: string) => text.split('\n').find(l => l.includes(what))?.trim().slice(0, TAIL) ?? '';

/* A message to the one above the sender on the map gives a result back along their line, kept with the message; one to
   anybody else, a peer or an employee below, gives nothing back. It hands no task in, not even the one it is about: the
   sender's turn may go on with that task, and a task is handed in by its own move. told lets the map know once the
   message is in. */
function givingBack(ctx: Ctx, companyId: string, me: string, to: string) {
  const gave = { back: false };
  const withMessage: WithEvent = async (tx, stored) => {
    gave.back = await returnAlongLine(tx, { agentId: me, to, sourceKey: `message:${stored.seq}`, sourceTaskId: null, returnedAt: stored.createdAt });
  };
  const told = () => gave.back && ctx.bus.publish(companyId, { type: 'org' });
  return { withMessage, told };
}

const seesPrograms = (job: ToolJob) => Boolean(job.roleKey) && OPERATIONS_ROLES[job.roleKey!] === job.agentKind;

/* The watchdog restarts by its skill; Operations by their role, checked again as for the screen and named in the turn's log. */
async function restartAsked(ctx: Ctx, job: ToolJob, grants: ReadonlySet<Grant>, employee: string): Promise<{ ok: boolean; text: string }> {
  try {
    const by = grants.has('restart_program') ? undefined : (await authorizeAccess(ctx, job)).name;
    return await restartProgram(ctx, job.companyId, employee, by);
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, text: error.message };
    throw error;
  }
}

/* Operations see and type into any employee's program, stop its turn and release its recovery hold, along with what their
   skills grant; the program operator also reports the case it was given. Each call checks the role again. */
function registerRoleTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  if (seesPrograms(job)) {
    registerProgramAccessTools(server, ctx, job);
    registerStopTool(server, ctx, job);
    registerReleaseTool(server, ctx, job);
  }
  if (job.roleKey === PROGRAM_OPERATOR_ROLE) registerOperatorTools(server, ctx, job);
}

/* What a message that waits for a turn waits for: the update its machine gets ready for, its machine getting back on the
   line, or a turn of its own after the one that runs or waits. */
const WAITS = {
  update: 'Its machine waits for an update, so the turn starts after it.',
  reconnect: 'Its machine is getting back on the line, so the turn starts once it is back.',
  line: 'It gets this with its next turn, not at once.',
};
type Waits = keyof typeof WAITS;
const waitsOf = (state: { ready: boolean; machineDrain: unknown }): Waits => (state.machineDrain ? 'update' : state.ready ? 'line' : 'reconnect');

/* What the sender of a message hears: it went in or started a turn, or it waits for a turn to come. */
async function sentLine(ctx: Ctx, name: string, jobId: string, waits: Waits): Promise<string> {
  const [turn] = await ctx.db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, jobId));
  if (turn?.status !== 'queued') return `Sent to ${name}.`;
  return `Sent to ${name}. ${WAITS[waits]}`;
}

/* Why a message does not go, as a code a failure collector groups by and as words its sender reads. */
type Refusal = { reason: string; text: string };

const nobody = (employee: string): Refusal => ({ reason: 'recipient_unknown', text: `There is no employee with id ${employee}. Call agents to see the current ids.` });

/* The sender and the employee it writes to, or why it may not: the employee is not there, is the sender itself, is out of
   its reach, or is switched off. */
async function partiesOf(ctx: Pick<Ctx, 'db'>, job: ToolJob, employee: string, reachable: (me: Agent, target: Agent) => Promise<boolean>): Promise<{ me: Agent; target: Agent } | Refusal> {
  const [me] = await ctx.db.select().from(agents).where(eq(agents.id, job.agentId));
  const [target] = await ctx.db.select().from(agents).where(and(eq(agents.id, employee), eq(agents.companyId, job.companyId), isNull(agents.removedAt)));
  if (!me || !target) return nobody(employee);
  if (target.id === me.id) return { reason: 'recipient_is_sender', text: 'That is you. Write to another employee.' };
  if (!(await reachable(me, target)))
    return target.kind === 'orchestrator' ? nobody(employee) : { reason: 'other_department', text: `${target.name} works in another department. Ask your head, who has the orchestrator pass it on.` };
  if (target.switchedOffAt) return { reason: 'switched_off', text: `${target.name} is switched off and takes no work until a person switches it on.` };
  return { me, target };
}

/* Why the employee's turn cannot go out now nor wait for it, or null: a machine getting back on the line takes it once it is back. */
async function cannotTake(ctx: Ctx, me: Agent, target: Agent, state: Awaited<ReturnType<typeof agentState>>): Promise<Refusal | null> {
  if (state.ready || (state.reason === 'machine_offline' && (await reconnecting(ctx, target.id)))) return null;
  return { reason: state.reason ?? 'cannot_run', text: await cannotRun(ctx, me, target, state.reason) };
}

/* A refusal its sender hears with its code, the employee and the task, as it is kept for failures. */
async function refused(ctx: Ctx, job: ToolJob, refusal: Refusal, employee: string, task: number | string | undefined) {
  const line = await keepUndelivered(ctx, { companyId: job.companyId, agentId: job.agentId, jobId: job.id }, { reason: refusal.reason, recipient: employee, task: task ?? null });
  return say(cleanDiagnostic(`${refusal.text}\n${line}`), true);
}

/* The messages employees could not deliver since then, as their senders' turns kept them, newest first. Their words were
   cleaned when they were kept, and are again for a reader who may not open the sender's work. */
async function undeliveredSince(ctx: Pick<Ctx, 'db'>, companyId: string, since: Date, reader: Reader | undefined) {
  const rows = await ctx.db
    .select({ agentId: agents.id, departmentId: agents.departmentId, agent: agents.name, data: agentEvents.data, at: agentEvents.createdAt, sight: SIGHT })
    .from(agentEvents)
    .innerJoin(agents, eq(agents.id, agentEvents.agentId))
    .leftJoin(jobs, eq(jobs.id, agentEvents.jobId))
    .leftJoin(tasks, eq(tasks.id, jobs.taskId))
    .where(and(eq(agentEvents.companyId, companyId), eq(agentEvents.kind, 'tool_result'), sql`${agentEvents.data}->'undelivered' is not null`, gte(agentEvents.createdAt, since)))
    .orderBy(desc(agentEvents.seq))
    .limit(UNDELIVERED_MAX);
  const staff = new Map((await ctx.db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.companyId, companyId))).map(a => [a.id, a.name]));
  return rows.flatMap(({ agentId, departmentId, sight, data, ...row }) => {
    const kept = UndeliveredRecord.safeParse(data);
    if (!kept.success) return [];
    const { recipient, task, reason } = kept.data.undelivered;
    return [shownAll({ ...row, recipient, to: staff.get(recipient) ?? null, task, reason, text: kept.data.summary }, opensTurn(reader, sight, { id: agentId, departmentId }))];
  });
}

/* The tools a skill grants an employee, for watching the company on a timer round: every agent's state, what failed, and
   restarting a program. Every employee has message_employee, which a grant only widens to other departments, and a head
   has tell_orchestrator. */
export function registerWatchTools(server: McpServer, ctx: Ctx, job: ToolJob, grants: ReadonlySet<Grant>): void {
  registerRoleTools(server, ctx, job);
  const { db } = ctx;
  const deptNames = async () => new Map((await db.select().from(departments).where(eq(departments.companyId, job.companyId))).map(d => [d.id, deptName(d)]));
  const roleTitle = (roleKey: string | null) => (roleKey && ctx.templates.roles.get(roleKey)?.title.en) || null;

  /* The watchdog has it by its skill, and Operations by their role, which each call checks again as it does for the screen. */
  if (grants.has('restart_program') || seesPrograms(job)) {
    server.registerTool('restart_program', {
      description: 'Restart a program that has stopped giving signs of life, in the same session: its role, skills, memory and tasks stay. Hornhoof checks its state, the time without a sign, its node and session, and allows only one restart per turn. Read agents or program_screen first.',
      inputSchema: { employee: z.uuid().describe("The agent's id from agents.") },
    }, async ({ employee }) => {
      const result = await restartAsked(ctx, job, grants, employee);
      return say(result.text, !result.ok);
    });
  }

  if (grants.has('agents')) {
    server.registerTool(
      'agents',
      {
        description:
          'Every agent of the company as it is now: department, role, whether it is on and ready (and why not), until when its plan is at its limit, whether its machine is getting ready for an update (machineDrain: its turns wait, it has not hung), whether its machine is short of free memory for its program to start (memoryWait: its turns wait and start by themselves once memory frees up, it has not hung), whether a turn runs and since when, ' +
          'turns waiting, the open tasks it holds with when each last moved, its last activity, how its last turn ended, program state and signs of life, failures, waiting retries, and whether a safe program restart is allowed with the reason when it is not. ' +
          "Each task's waitsFor lists only open prerequisite numbers in that task's department; externalWait gives its recorded reason and times, and waitingForPerson marks an open person request. Count a task as waiting for department work only when waitsFor is nonempty and neither a live externalWait nor waitingForPerson holds it. " +
          'The words of work you may not open, as task shows it, come with no credential and no private path in them.',
      },
      async () => {
        const staff = await db.select().from(agents).where(and(eq(agents.companyId, job.companyId), ne(agents.kind, 'assistant'), isNull(agents.removedAt)));
        const ids = staff.map(a => a.id);
        if (!ids.length) return json([]);
        const names = await deptNames();
        const held = await watchedTasks(db, job.companyId, ids);
        const reader = await readerOf(ctx, job.agentId);
        const out = [];
        /* Each agent by its own indexes, so a round costs the same however long the company has run. */
        for (const a of staff) {
          const state = await agentState(ctx, a.id);
          const [running] = state.runningJobId ? await db.select({ at: jobs.startedAt }).from(jobs).where(eq(jobs.id, state.runningJobId)) : [];
          /* What the agent did itself: words others sent it are no sign of life. */
          const [active] = await db
            .select({ at: agentEvents.createdAt })
            .from(agentEvents)
            .where(and(eq(agentEvents.agentId, a.id), ne(agentEvents.kind, 'message')))
            .orderBy(desc(agentEvents.seq))
            .limit(1);
          const [last] = await db
            .select({ status: jobs.status, error: jobs.error, at: jobs.finishedAt })
            .from(jobs)
            .where(and(eq(jobs.agentId, a.id), inArray(jobs.status, ['done', 'failed']), isNotNull(jobs.finishedAt)))
            .orderBy(desc(jobs.finishedAt))
            .limit(1);
          const agent = {
            id: a.id,
            name: a.name,
            kind: a.kind,
            department: (a.departmentId && names.get(a.departmentId)) || null,
            role: roleTitle(a.roleKey),
            on: !a.switchedOffAt,
            ready: state.ready,
            reason: state.reason,
            limitUntil: state.limitUntil,
            machineDrain: state.machineDrain,
            memoryWait: state.memoryWait,
            busy: state.busy,
            runningSince: running?.at ?? null,
            queued: state.queued,
            program: state.program,
            alarm: state.alarm,
            failure: state.failure,
            obsolete: state.obsolete,
            retry: state.retry,
            restart: await programRestartStatus(ctx, job.companyId, a.id),
            lastActivityAt: active?.at ?? null,
            lastTurn: last ? { status: last.status, at: last.at, error: last.error } : null,
          };
          /* An agent's own words are its department's to read, the words of each task it holds that task's readers'. */
          // eslint-disable-next-line @typescript-eslint/no-unused-vars -- strip internal grouping field
          const holds = held.filter(t => t.holder === a.id).map(({ holder: _, sight, ...t }) => shownAll(t, opensTask(reader, sight)));
          out.push({ ...shownAll(agent, opensTurn(reader, null, { id: a.id, departmentId: a.departmentId })), tasks: holds });
        }
        return json(out);
      },
    );
  }

  if (grants.has('failures')) {
    server.registerTool(
      'failures',
      {
        description:
          'What went wrong in the last hours: the turns that failed, newest first, with the agent, the error, the reason Hornhoof recorded, the end of its output and the task, and the tasks blocked now, ' +
          'with the start of what their holder said when it stopped, its end in whyTail when it is longer, in next the Next section of that report or else its last 500 characters, and how its last turn on the task ended. Node restart interruptions include the machine, diagnosis and sanitized node log. ' +
          'In undelivered, the messages employees sent with message_employee that neither went in nor wait in line, newest first: who sent them, the reason code, the recipient and the task. ' +
          'The words of work you may not open, as task shows it, come with no credential and no private path in them. ' +
          'Turns people or Hornhoof stopped on purpose are left out. Also where agents stumbled, each with when and on which task it was seen last: commands and modules ' +
          'a shell or a program said were not installed (the same words read in a file count for nothing), the tools they installed by hand, ' +
          'and the questions and stuck tasks they stopped on for people, with the answer and how their last turn on the task ended.',
        inputSchema: { hours: z.number().int().min(1).max(72).default(6).describe('How many hours back to read, 1 to 72.') },
      },
      async ({ hours }) => {
        const names = await deptNames();
        const reader = await readerOf(ctx, job.agentId);
        const failed = await db
          .select({ agent: agents.name, agentId: jobs.agentId, departmentId: agents.departmentId, at: jobs.finishedAt, error: jobs.error, tail: jobs.tail, failure: jobs.failure, result: jobs.result, task: tasks.number, interruption: jobs.interruption, sight: SIGHT })
          .from(jobs)
          .innerJoin(agents, eq(agents.id, jobs.agentId))
          .leftJoin(tasks, eq(tasks.id, jobs.taskId))
          .where(and(eq(jobs.companyId, job.companyId), eq(jobs.status, 'failed'), or(isNull(jobs.error), notInArray(jobs.error, [...STOPPED_ON_PURPOSE, ...ENDED_UNSENT])), gte(jobs.finishedAt, hoursAgo(hours))))
          .orderBy(desc(jobs.finishedAt))
          .limit(FAILED_MAX);
        const stuck = await db
          .select({ id: tasks.id, holderId: tasks.assigneeAgentId, number: tasks.number, title: tasks.title, holder: agents.name, since: tasks.updatedAt, sight: SIGHT })
          .from(tasks)
          .leftJoin(agents, eq(agents.id, tasks.assigneeAgentId))
          .where(and(eq(tasks.companyId, job.companyId), eq(tasks.status, 'blocked')))
          .orderBy(tasks.updatedAt);
        const blocked = [];
        for (const { id, holderId, sight, ...task } of stuck) {
          /* What its holder said when it stopped, and how its last turn on it ended: enough to group causes without the task itself. */
          const [said] = await db
            .select(only(taskEvents, 'text'))
            .from(taskEvents)
            .where(and(eq(taskEvents.taskId, id), inArray(taskEvents.kind, ['blocked', 'report'])))
            .orderBy(desc(taskEvents.id))
            .limit(1);
          const [last] = holderId
            ? await db
                .select({ status: jobs.status, error: jobs.error, at: jobs.finishedAt, result: jobs.result, startedAt: jobs.startedAt })
                .from(jobs)
                .where(and(eq(jobs.agentId, holderId), eq(jobs.taskId, id), inArray(jobs.status, ['done', 'failed'])))
                .orderBy(desc(jobs.finishedAt))
                .limit(1)
            : [];
          /* A turn that went out inside another one ended as that one did. */
          const lastTurn = holderId && last?.result === GONE_ALONG && last.startedAt ? await carrierOf(ctx, { agentId: holderId, startedAt: last.startedAt }) : last && { status: last.status, error: last.error, at: last.at };
          const open = opensTask(reader, sight);
          blocked.push(shownAll({ ...task, ...heldWords(said, open), lastTurn: lastTurn ?? null }, open));
        }
        const since = hoursAgo(hours);
        const seen = (kind: 'tool' | 'tool_result', field: string, hint: string) =>
          db
            .select({ agentId: agents.id, departmentId: agents.departmentId, agent: agents.name, text: sql<string>`${agentEvents.data}->>${field}`, at: agentEvents.createdAt, task: tasks.number, sight: SIGHT })
            .from(agentEvents)
            .innerJoin(agents, eq(agents.id, agentEvents.agentId))
            .leftJoin(jobs, eq(jobs.id, agentEvents.jobId))
            .leftJoin(tasks, eq(tasks.id, jobs.taskId))
            .where(and(eq(agentEvents.companyId, job.companyId), eq(agentEvents.kind, kind), gte(agentEvents.createdAt, since), sql`${agentEvents.data}->>${field} ~* ${hint}`))
            .orderBy(desc(agentEvents.seq))
            .limit(STUMBLES_MAX)
            .then(rows => seenBy(rows, reader));
        const missing = tally<Missing>((await seen('tool_result', 'summary', MISSING_HINT)).flatMap(r => missingIn(r.text).map(m => ({ ...r, key: `${m.kind} ${m.what}`, value: m, example: lineOf(r.text, m.what) }))));
        const installed = tally<string>((await seen('tool', 'input', INSTALL_HINT)).flatMap(r => installsIn(r.text).map(command => ({ ...r, key: command, value: command }))));
        const stopped = await db
          .select({ kind: requests.kind, agentId: requests.agentId, taskId: requests.taskId, agent: agents.name, task: tasks.number, text: requests.text, status: requests.status, answer: requests.answer, at: requests.createdAt, sight: SIGHT })
          .from(requests)
          .innerJoin(agents, eq(agents.id, requests.agentId))
          .innerJoin(tasks, eq(tasks.id, requests.taskId))
          .where(and(eq(requests.companyId, job.companyId), inArray(requests.kind, ['question', 'stuck']), gte(requests.createdAt, since)))
          .orderBy(desc(requests.createdAt))
          .limit(STOPS_MAX);
        const stops = [];
        for (const { agentId, taskId, at, sight, ...stop } of stopped) {
          /* The turn it asked from, or the last one it ended without moving the task. */
          const [last] = await db
            .select({ result: jobs.result, tail: jobs.tail })
            .from(jobs)
            .where(and(eq(jobs.agentId, agentId), eq(jobs.taskId, taskId), inArray(jobs.status, ['done', 'failed']), sql`coalesce(${jobs.startedAt}, ${jobs.createdAt}) <= ${at}`))
            .orderBy(desc(sql`coalesce(${jobs.startedAt}, ${jobs.createdAt})`))
            .limit(1);
          const open = opensTask(reader, sight);
          stops.push(shownAll({ ...stop, lastTurn: turnEnd(last, open) }, open));
        }
        const undelivered = await undeliveredSince(ctx, job.companyId, since, reader);
        return json({
          failed: failed.map(row => failedLine(row, reader, names)),
          blocked,
          missing: missing.map(({ value, ...m }) => ({ ...value, ...m })),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars -- strip unused tally example field
          installed: installed.map(({ value, example: _, ...i }) => ({ command: value, ...i })),
          stops,
          undelivered,
        });
      },
    );
  }

  /* Whether this turn may send one more message, counted at once. */
  async function counted(me: string): Promise<boolean> {
    const counts = sent.get(ctx) ?? new Map<string, number>();
    sent.set(ctx, counts);
    /* A turn's first message reads what it sent before, which a restart of Hornhoof would otherwise forget. */
    if (!counts.has(job.id)) {
      const [run] = await db.select({ startedAt: jobs.startedAt, createdAt: jobs.createdAt }).from(jobs).where(eq(jobs.id, job.id));
      const [before] = await db
        .select({ n: sql<number>`count(*)` })
        .from(agentEvents)
        .where(and(eq(agentEvents.companyId, job.companyId), eq(agentEvents.kind, 'message'), sql`${agentEvents.data}->>'by' = ${me}`, gte(agentEvents.createdAt, run?.startedAt ?? run?.createdAt ?? new Date(0))));
      if (!counts.has(job.id)) counts.set(job.id, Number(before?.n ?? 0));
    }
    /* Counted with no wait between the check and the count, so parallel calls cannot both take the last one. */
    const n = counts.get(job.id)!;
    if (n >= TURN_NUDGES) return false;
    counts.delete(job.id);
    counts.set(job.id, n + 1);
    if (counts.size > SENT_KEPT) counts.delete(counts.keys().next().value!);
    return true;
  }

  if (job.agentKind === 'head') {
    server.registerTool(
      'tell_orchestrator',
      {
        description:
          'Writes to the orchestrator, as you, into its window, which the CEO reads: what came of your work outside the tasks it gave you, such as a timer round, what you need decided beyond your department, what blocks it. ' +
          'Not for your department\'s own staff, units, products, tasks, approval and wait policies: what a person who runs it decides, you do yourself. ' +
          `It decides with the CEO or the employee concerned. One turn sends at most ${TURN_NUDGES} messages.`,
        inputSchema: { text: Text.trim().min(1) },
      },
      async ({ text }) => {
        if (carriesFile(text)) return say(encodedHint(), true);
        const [me] = await db.select().from(agents).where(eq(agents.id, job.agentId));
        const orchestrator = await orchestratorOf(ctx, job.companyId);
        if (!me || !orchestrator) return say('This company has no orchestrator.', true);
        if (!(await counted(me.id))) return say(`One turn sends at most ${TURN_NUDGES} messages. Go on in your next round.`, true);
        const back = givingBack(ctx, job.companyId, me.id, orchestrator.id);
        await enqueueTurn(ctx, {
          companyId: job.companyId,
          agentId: orchestrator.id,
          prompt: `${wrote({ name: me.name, title: roleTitle(me.roleKey) ?? '' }, text)}\n\n${answerBy(me)}`,
          createdBy: null,
          message: { personId: null, text, from: 'agent', name: me.name, by: me.id },
          withMessage: back.withMessage,
        });
        back.told();
        if (me.departmentId) ctx.bus.publish(job.companyId, { type: 'pulse', from: { kind: 'department', id: me.departmentId }, to: { kind: 'orchestrator' } });
        return say('Told the orchestrator.');
      },
    );
  }

  /* Everyone talks to the people of its own department directly; writing across departments is a skill's grant. */
  const anywhere = grants.has('message_employee');
  const topOf = async (departmentId: string | null) => {
    if (!departmentId) return null;
    const [d] = await db.select({ id: departments.id, parentId: departments.parentId }).from(departments).where(eq(departments.id, departmentId));
    return d ? (d.parentId ?? d.id) : null;
  };
  const inReach = async (me: Agent, target: Agent) =>
    target.kind !== 'orchestrator' && target.kind !== 'assistant' && (anywhere || (await topOf(target.departmentId)) === (await topOf(me.departmentId)));
  /* Whoever wrote to me last, the orchestrator too, gets one answer wherever it works: an answer in my window reaches only
     people, so an agent's question is answered with a message or not at all. Notices Hornhoof passes on ask nothing. */
  const owesAnswer = async (me: Agent, target: Agent): Promise<boolean> => {
    const by = target.kind === 'orchestrator'
      ? sql`${agentEvents.data}->>'from' = 'orchestrator'`
      : sql`${agentEvents.data}->>'from' = 'agent' and ${agentEvents.data}->>'by' = ${target.id}`;
    const [asked] = await db.select(only(agentEvents, 'seq')).from(agentEvents)
      .where(and(eq(agentEvents.agentId, me.id), eq(agentEvents.kind, 'message'), by, sql`${agentEvents.data}->'notification' is null`))
      .orderBy(desc(agentEvents.seq)).limit(1);
    if (!asked) return false;
    const [answered] = await db.select(only(agentEvents, 'seq')).from(agentEvents)
      .where(and(eq(agentEvents.agentId, target.id), eq(agentEvents.kind, 'message'), gt(agentEvents.seq, asked.seq), sql`${agentEvents.data}->>'from' = 'agent' and ${agentEvents.data}->>'by' = ${me.id}`))
      .limit(1);
    return !answered;
  };
  /* Who may write to whom: within reach, or answering the one who wrote last. */
  const reachable = async (me: Agent, target: Agent) => (await inReach(me, target)) || (await owesAnswer(me, target));

  server.registerTool(
    'message_employee',
    {
      description: (anywhere
        ? `Writes to another employee, as you, into its window: one at work gets it at once in the turn it runs, one that is not in its next turn. Use it to nudge a stuck agent or to tell a head. One turn sends at most ${TURN_NUDGES}.`
        : `Writes to another employee of your department, as you, into its window: one at work gets it at once in the turn it runs, one that is not in its next turn. Ask the one whose work yours builds on, or the one whose findings you do not understand, instead of waiting for your head. One turn sends at most ${TURN_NUDGES}.`) +
        ' It also answers the one who wrote to you last, in any department or the orchestrator, with one message: an answer in your window reaches only people, never an agent.' +
        MESSAGE_TASK_HINT,
      inputSchema: { employee: z.uuid().describe("The employee's id, from agents or company."), text: Text.trim().min(1), task: TaskReference.optional() },
    },
    async ({ employee, text, task: ref }) => {
      if (carriesFile(text)) return say(encodedHint(), true);
      const parties = await partiesOf(ctx, job, employee, reachable);
      if ('reason' in parties) return refused(ctx, job, parties, employee, ref);
      const { me, target } = parties;
      const state = await agentState(ctx, target.id);
      const unable = await cannotTake(ctx, me, target, state);
      if (unable) return refused(ctx, job, unable, employee, ref);
      if (!(await counted(me.id))) return refused(ctx, job, { reason: 'send_limit', text: `One turn sends at most ${TURN_NUDGES} messages. Go on in your next round.` }, employee, ref);
      const back = givingBack(ctx, job.companyId, me.id, target.id);
      return queueTaskMessage(ctx, { companyId: job.companyId, agentId: target.id, task: ref, actor: { agentId: me.id }, text }, {
          companyId: job.companyId,
          agentId: target.id,
          prompt: `${wrote({ name: me.name, title: roleTitle(me.roleKey) ?? '' }, text)}\n\n${answerBy(me)}`,
          createdBy: null,
          message: { personId: null, text, from: 'agent', name: me.name, by: me.id },
          withMessage: back.withMessage,
        }).then(async id => {
        back.told();
        /* The map runs it between the two departments, or the card between the two agents of one. */
        if (me.departmentId && target.kind === 'orchestrator') ctx.bus.publish(job.companyId, { type: 'pulse', from: { kind: 'department', id: me.departmentId }, to: { kind: 'orchestrator' } });
        else if (me.departmentId && target.departmentId) {
          const same = me.departmentId === target.departmentId;
          ctx.bus.publish(job.companyId, {
            type: 'pulse',
            from: same ? { kind: 'agent', id: me.id, departmentId: me.departmentId } : { kind: 'department', id: me.departmentId },
            to: same ? { kind: 'agent', id: target.id, departmentId: target.departmentId } : { kind: 'department', id: target.departmentId },
          });
        }
        return say(await sentLine(ctx, target.name, id, waitsOf(state)));
      }, taskMessageFailure);
    },
  );
}
