import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, desc, eq, gte, inArray, isNotNull, isNull, max, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agentEvents, agents, departments, jobs, tasks } from '../../db/schema.js';
import { turnPrompt } from '../conversation/prompt.js';
import { agentState, enqueueTurn } from '../conversation/queue.js';
import { deptName } from '../departments/templates.js';
import { CLOSED } from '../tasks/engine.js';
import type { Grant } from '../templates/load.js';

type ToolJob = { id: string; companyId: string; agentId: string };

/* What one turn may send to others, so a round that goes wrong cannot flood the company. */
export const TURN_NUDGES = 10;
const TAIL = 400;
const FAILED_MAX = 50;
/* How far back an agent's last turn counts for agents. */
const LAST_TURN_HOURS = 24;

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
const json = (value: unknown) => say(JSON.stringify(value));
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

/* The tools a skill grants an employee, for watching the company on a timer round: every agent's state, what failed, and
   writing to another employee as itself. */
export function registerWatchTools(server: McpServer, ctx: Ctx, job: ToolJob, grants: ReadonlySet<Grant>): void {
  const { db } = ctx;
  const deptNames = async () => new Map((await db.select().from(departments).where(eq(departments.companyId, job.companyId))).map(d => [d.id, deptName(d)]));
  const roleTitle = (roleKey: string | null) => (roleKey && ctx.templates.roles.get(roleKey)?.title.en) || null;

  if (grants.has('agents')) {
    server.registerTool(
      'agents',
      {
        description:
          'Every agent of the company as it is now: department, role, whether it is on and ready (and why not), whether a turn runs and since when, ' +
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
        const running = await db
          .select({ agentId: jobs.agentId, startedAt: jobs.startedAt })
          .from(jobs)
          .where(and(eq(jobs.companyId, job.companyId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'running')));
        const active = await db
          .select({ agentId: agentEvents.agentId, at: max(agentEvents.createdAt) })
          .from(agentEvents)
          .where(eq(agentEvents.companyId, job.companyId))
          .groupBy(agentEvents.agentId);
        const finished = await db
          .select({ agentId: jobs.agentId, status: jobs.status, error: jobs.error, at: jobs.finishedAt })
          .from(jobs)
          .where(and(eq(jobs.companyId, job.companyId), eq(jobs.kind, 'conversation'), isNotNull(jobs.finishedAt), gte(jobs.finishedAt, hoursAgo(LAST_TURN_HOURS))))
          .orderBy(desc(jobs.finishedAt));
        const out = [];
        for (const a of staff) {
          const state = await agentState(ctx, a.id);
          const last = finished.find(j => j.agentId === a.id);
          out.push({
            id: a.id,
            name: a.name,
            kind: a.kind,
            department: (a.departmentId && names.get(a.departmentId)) || null,
            role: roleTitle(a.roleKey),
            on: !a.switchedOffAt,
            ready: state.ready,
            reason: state.reason,
            busy: state.busy,
            runningSince: running.find(j => j.agentId === a.id)?.startedAt ?? null,
            queued: state.queued,
            tasks: held.filter(t => t.holder === a.id).map(({ holder: _, ...t }) => t),
            lastActivityAt: active.find(e => e.agentId === a.id)?.at ?? null,
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
        description: 'What went wrong in the last hours: the turns that failed, newest first, with the agent, the error, the end of its output and the task, and the tasks blocked now.',
        inputSchema: { hours: z.number().int().min(1).max(72).default(6).describe('How many hours back to read, 1 to 72.') },
      },
      async ({ hours }) => {
        const names = await deptNames();
        const failed = await db
          .select({ agent: agents.name, departmentId: agents.departmentId, at: jobs.finishedAt, error: jobs.error, tail: jobs.tail, task: tasks.number })
          .from(jobs)
          .innerJoin(agents, eq(agents.id, jobs.agentId))
          .leftJoin(tasks, eq(tasks.id, jobs.taskId))
          .where(and(eq(jobs.companyId, job.companyId), eq(jobs.status, 'failed'), gte(jobs.finishedAt, hoursAgo(hours))))
          .orderBy(desc(jobs.finishedAt))
          .limit(FAILED_MAX);
        const blocked = await db
          .select({ number: tasks.number, title: tasks.title, holder: agents.name, since: tasks.updatedAt })
          .from(tasks)
          .leftJoin(agents, eq(agents.id, tasks.assigneeAgentId))
          .where(and(eq(tasks.companyId, job.companyId), eq(tasks.status, 'blocked')))
          .orderBy(tasks.updatedAt);
        return json({
          failed: failed.map(({ departmentId, tail, ...f }) => ({ ...f, department: (departmentId && names.get(departmentId)) || null, tail: tail.slice(-TAIL) })),
          blocked,
        });
      },
    );
  }

  if (grants.has('message_employee')) {
    server.registerTool(
      'message_employee',
      {
        description: `Writes to another employee, as you, into its window; it reads the message in its next turn. Use it to nudge a stuck agent or to tell a head. One turn sends at most ${TURN_NUDGES}.`,
        inputSchema: { employee: z.uuid().describe("The employee's id, from agents or company."), text: z.string().trim().min(1).max(4000) },
      },
      async ({ employee, text }) => {
        const [me] = await db.select().from(agents).where(eq(agents.id, job.agentId));
        const [target] = await db.select().from(agents).where(and(eq(agents.id, employee), eq(agents.companyId, job.companyId), isNull(agents.removedAt)));
        if (!me || !target || target.kind === 'orchestrator') return say(`There is no employee with id ${employee}. Call agents to see the current ids.`, true);
        if (target.id === me.id) return say('That is you. Write to another employee.', true);
        if (target.switchedOffAt) return say(`${target.name} is switched off and takes no work until a person switches it on.`, true);
        if (!(await agentState(ctx, target.id)).ready) return say(`${target.name} cannot run now. Tell your head, who tells the CEO.`, true);
        const [started] = await db.select({ at: jobs.startedAt }).from(jobs).where(eq(jobs.id, job.id));
        const [sent] = await db
          .select({ n: sql<number>`count(*)` })
          .from(agentEvents)
          .where(and(eq(agentEvents.companyId, job.companyId), eq(agentEvents.kind, 'message'), sql`${agentEvents.data}->>'by' = ${me.id}`, gte(agentEvents.createdAt, started?.at ?? new Date(0))));
        if (Number(sent?.n ?? 0) >= TURN_NUDGES) return say(`One turn sends at most ${TURN_NUDGES} messages. Go on in your next round.`, true);
        await enqueueTurn(ctx, {
          companyId: job.companyId,
          agentId: target.id,
          prompt: turnPrompt({ name: me.name, title: roleTitle(me.roleKey) ?? '' }, text),
          createdBy: null,
          message: { personId: null, text, from: 'agent', name: me.name, by: me.id },
        });
        return say(`Sent to ${target.name}.`);
      },
    );
  }
}
