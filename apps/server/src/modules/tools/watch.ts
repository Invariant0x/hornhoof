import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agentEvents, agents, departments, jobs, requests, taskEvents, tasks } from '../../db/schema.js';
import { wrote } from '../conversation/prompt.js';
import { agentState, carrierOf, enqueueTurn, GONE_ALONG, orchestratorOf, STOPPED_ON_PURPOSE } from '../conversation/queue.js';
import { deptName } from '../departments/templates.js';
import { carriesFile, encodedHint } from '../tasks/attachments.js';
import { CLOSED } from '../tasks/engine.js';
import type { Grant } from '../templates/load.js';
import { INSTALL_HINT, installsIn, MISSING_HINT, missingIn, type Missing } from './stumbles.js';

type ToolJob = { id: string; companyId: string; agentId: string; agentKind: string };

/* What one turn may send to others, so a round that goes wrong cannot flood the company. */
export const TURN_NUDGES = 10;
const TAIL = 400;
const FAILED_MAX = 50;
/* Tool calls and results read for where agents stumbled, the newest first. */
const STUMBLES_MAX = 1000;
const STOPS_MAX = 50;
const GROUPS_MAX = 30;

/* Messages each running turn sent, counted before the next one goes out so two at once cannot both pass; the oldest turns
   are forgotten. */
const sent = new WeakMap<Ctx, Map<string, number>>();
const SENT_KEPT = 500;

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
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

/* The tools a skill grants an employee, for watching the company on a timer round: every agent's state, what failed, and
   writing to another employee as itself; and a head's way to tell the orchestrator. */
export function registerWatchTools(server: McpServer, ctx: Ctx, job: ToolJob, grants: ReadonlySet<Grant>): void {
  const { db } = ctx;
  const deptNames = async () => new Map((await db.select().from(departments).where(eq(departments.companyId, job.companyId))).map(d => [d.id, deptName(d)]));
  const roleTitle = (roleKey: string | null) => (roleKey && ctx.templates.roles.get(roleKey)?.title.en) || null;

  if (grants.has('agents')) {
    server.registerTool(
      'agents',
      {
        description:
          'Every agent of the company as it is now: department, role, whether it is on and ready (and why not), until when its plan is at its limit, whether a turn runs and since when, ' +
          'turns waiting, the open tasks it holds with when each last moved, its last activity and how its last turn ended.',
      },
      async () => {
        const staff = await db.select().from(agents).where(and(eq(agents.companyId, job.companyId), isNull(agents.removedAt)));
        const ids = staff.map(a => a.id);
        if (!ids.length) return json([]);
        const names = await deptNames();
        const held = await db
          .select({ number: tasks.number, title: tasks.title, status: tasks.status, updatedAt: tasks.updatedAt, holder: tasks.assigneeAgentId })
          .from(tasks)
          .where(and(eq(tasks.companyId, job.companyId), inArray(tasks.assigneeAgentId, ids), notInArray(tasks.status, [...CLOSED, 'planned'])));
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
          out.push({
            id: a.id,
            name: a.name,
            kind: a.kind,
            department: (a.departmentId && names.get(a.departmentId)) || null,
            role: roleTitle(a.roleKey),
            on: !a.switchedOffAt,
            ready: state.ready,
            reason: state.reason,
            limitUntil: state.limitUntil,
            busy: state.busy,
            runningSince: running?.at ?? null,
            queued: state.queued,
            tasks: held.filter(t => t.holder === a.id).map(({ holder: _, ...t }) => t),
            lastActivityAt: active?.at ?? null,
            lastTurn: last ? { status: last.status, at: last.at, error: last.error } : null,
          });
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
          'What went wrong in the last hours: the turns that failed, newest first, with the agent, the error, the end of its output and the task, and the tasks blocked now, ' +
          'with what their holder said when it stopped and how its last turn on the task ended. ' +
          'Turns people or Hornhoof stopped on purpose are left out. Also where agents stumbled, each with when and on which task it was seen last: commands and modules ' +
          'a shell or a program said were not installed (the same words read in a file count for nothing), the tools they installed by hand, ' +
          'and the questions and stuck tasks they stopped on for people, with the answer and how their last turn on the task ended.',
        inputSchema: { hours: z.number().int().min(1).max(72).default(6).describe('How many hours back to read, 1 to 72.') },
      },
      async ({ hours }) => {
        const names = await deptNames();
        const failed = await db
          .select({ agent: agents.name, departmentId: agents.departmentId, at: jobs.finishedAt, error: jobs.error, tail: jobs.tail, task: tasks.number })
          .from(jobs)
          .innerJoin(agents, eq(agents.id, jobs.agentId))
          .leftJoin(tasks, eq(tasks.id, jobs.taskId))
          .where(and(eq(jobs.companyId, job.companyId), eq(jobs.status, 'failed'), or(isNull(jobs.error), notInArray(jobs.error, STOPPED_ON_PURPOSE)), gte(jobs.finishedAt, hoursAgo(hours))))
          .orderBy(desc(jobs.finishedAt))
          .limit(FAILED_MAX);
        const stuck = await db
          .select({ id: tasks.id, holderId: tasks.assigneeAgentId, number: tasks.number, title: tasks.title, holder: agents.name, since: tasks.updatedAt })
          .from(tasks)
          .leftJoin(agents, eq(agents.id, tasks.assigneeAgentId))
          .where(and(eq(tasks.companyId, job.companyId), eq(tasks.status, 'blocked')))
          .orderBy(tasks.updatedAt);
        const blocked = [];
        for (const { id, holderId, ...task } of stuck) {
          /* What its holder said when it stopped, and how its last turn on it ended: enough to group causes without the task itself. */
          const [said] = await db
            .select({ text: taskEvents.text })
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
          blocked.push({ ...task, why: said ? said.text.slice(0, TAIL) : null, lastTurn: lastTurn ?? null });
        }
        const since = hoursAgo(hours);
        const seen = (kind: 'tool' | 'tool_result', field: string, hint: string) =>
          db
            .select({ agent: agents.name, text: sql<string>`${agentEvents.data}->>${field}`, at: agentEvents.createdAt, task: tasks.number })
            .from(agentEvents)
            .innerJoin(agents, eq(agents.id, agentEvents.agentId))
            .leftJoin(jobs, eq(jobs.id, agentEvents.jobId))
            .leftJoin(tasks, eq(tasks.id, jobs.taskId))
            .where(and(eq(agentEvents.companyId, job.companyId), eq(agentEvents.kind, kind), gte(agentEvents.createdAt, since), sql`${agentEvents.data}->>${field} ~* ${hint}`))
            .orderBy(desc(agentEvents.seq))
            .limit(STUMBLES_MAX);
        const missing = tally<Missing>((await seen('tool_result', 'summary', MISSING_HINT)).flatMap(r => missingIn(r.text).map(m => ({ ...r, key: `${m.kind} ${m.what}`, value: m, example: lineOf(r.text, m.what) }))));
        const installed = tally<string>((await seen('tool', 'input', INSTALL_HINT)).flatMap(r => installsIn(r.text).map(command => ({ ...r, key: command, value: command }))));
        const stopped = await db
          .select({ kind: requests.kind, agentId: requests.agentId, taskId: requests.taskId, agent: agents.name, task: tasks.number, text: requests.text, status: requests.status, answer: requests.answer, at: requests.createdAt })
          .from(requests)
          .innerJoin(agents, eq(agents.id, requests.agentId))
          .innerJoin(tasks, eq(tasks.id, requests.taskId))
          .where(and(eq(requests.companyId, job.companyId), inArray(requests.kind, ['question', 'stuck']), gte(requests.createdAt, since)))
          .orderBy(desc(requests.createdAt))
          .limit(STOPS_MAX);
        const stops = [];
        for (const { agentId, taskId, at, ...stop } of stopped) {
          /* The turn it asked from, or the last one it ended without moving the task. */
          const [last] = await db
            .select({ result: jobs.result, tail: jobs.tail })
            .from(jobs)
            .where(and(eq(jobs.agentId, agentId), eq(jobs.taskId, taskId), inArray(jobs.status, ['done', 'failed']), sql`coalesce(${jobs.startedAt}, ${jobs.createdAt}) <= ${at}`))
            .orderBy(desc(sql`coalesce(${jobs.startedAt}, ${jobs.createdAt})`))
            .limit(1);
          stops.push({ ...stop, lastTurn: last ? (last.result?.trim() || last.tail).slice(-TAIL) : null });
        }
        return json({
          failed: failed.map(({ departmentId, tail, ...f }) => ({ ...f, department: (departmentId && names.get(departmentId)) || null, tail: tail.slice(-TAIL) })),
          blocked,
          missing: missing.map(({ value, ...m }) => ({ ...value, ...m })),
          installed: installed.map(({ value, example: _, ...i }) => ({ command: value, ...i })),
          stops,
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
          'Writes to the orchestrator, as you, into its window, which the CEO reads: what came of your work outside the tasks it gave you, such as a timer round, what you need decided, what blocks your department. ' +
          `It decides with the CEO or the employee concerned. One turn sends at most ${TURN_NUDGES} messages.`,
        inputSchema: { text: z.string().trim().min(1).max(4000) },
      },
      async ({ text }) => {
        if (carriesFile(text)) return say(encodedHint(), true);
        const [me] = await db.select().from(agents).where(eq(agents.id, job.agentId));
        const orchestrator = await orchestratorOf(ctx, job.companyId);
        if (!me || !orchestrator) return say('This company has no orchestrator.', true);
        if (!(await counted(me.id))) return say(`One turn sends at most ${TURN_NUDGES} messages. Go on in your next round.`, true);
        await enqueueTurn(ctx, {
          companyId: job.companyId,
          agentId: orchestrator.id,
          prompt: wrote({ name: me.name, title: roleTitle(me.roleKey) ?? '' }, text),
          createdBy: null,
          message: { personId: null, text, from: 'agent', name: me.name, by: me.id },
        });
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
  server.registerTool(
    'message_employee',
    {
      description: anywhere
        ? `Writes to another employee, as you, into its window: one at work gets it at once in the turn it runs, one that is not in its next turn. Use it to nudge a stuck agent or to tell a head. One turn sends at most ${TURN_NUDGES}.`
        : `Writes to another employee of your department, as you, into its window: one at work gets it at once in the turn it runs, one that is not in its next turn. Ask the one whose work yours builds on, or the one whose findings you do not understand, instead of waiting for your head. One turn sends at most ${TURN_NUDGES}.`,
      inputSchema: { employee: z.uuid().describe("The employee's id, from agents or company."), text: z.string().trim().min(1).max(4000) },
    },
    async ({ employee, text }) => {
      if (carriesFile(text)) return say(encodedHint(), true);
      const [me] = await db.select().from(agents).where(eq(agents.id, job.agentId));
      const [target] = await db.select().from(agents).where(and(eq(agents.id, employee), eq(agents.companyId, job.companyId), isNull(agents.removedAt)));
      if (!me || !target || target.kind === 'orchestrator') return say(`There is no employee with id ${employee}. Call agents to see the current ids.`, true);
      if (target.id === me.id) return say('That is you. Write to another employee.', true);
      if (!anywhere && (await topOf(target.departmentId)) !== (await topOf(me.departmentId)))
        return say(`${target.name} works in another department. Ask your head, who has the orchestrator pass it on.`, true);
      if (target.switchedOffAt) return say(`${target.name} is switched off and takes no work until a person switches it on.`, true);
      if (!(await agentState(ctx, target.id)).ready) return say(`${target.name} cannot run now. Tell your head, who tells the CEO.`, true);
      if (!(await counted(me.id))) return say(`One turn sends at most ${TURN_NUDGES} messages. Go on in your next round.`, true);
      await enqueueTurn(ctx, {
        companyId: job.companyId,
        agentId: target.id,
        prompt: wrote({ name: me.name, title: roleTitle(me.roleKey) ?? '' }, text),
        createdBy: null,
        message: { personId: null, text, from: 'agent', name: me.name, by: me.id },
      });
      /* The map runs it between the two departments, or the card between the two agents of one. */
      if (me.departmentId && target.departmentId) {
        const same = me.departmentId === target.departmentId;
        ctx.bus.publish(job.companyId, {
          type: 'pulse',
          from: same ? { kind: 'agent', id: me.id, departmentId: me.departmentId } : { kind: 'department', id: me.departmentId },
          to: same ? { kind: 'agent', id: target.id, departmentId: target.departmentId } : { kind: 'department', id: target.departmentId },
        });
      }
      return say(`Sent to ${target.name}.`);
    },
  );
}
