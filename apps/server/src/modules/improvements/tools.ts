import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, count, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { improvements, jobs } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { improvementsChanged, listImprovements, moveImprovement } from './store.js';

type ToolJob = { id: string; companyId: string; agentId: string };

/* What one turn may put under Improvements, so a round that goes wrong cannot flood the CEO. */
export const TURN_IMPROVEMENTS = 10;
/* What each running turn put, counted before the next one goes in so parallel calls cannot both pass; the oldest turns
   are forgotten. */
const put = new WeakMap<Ctx, Map<string, number>>();
const PUT_KEPT = 500;

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
const json = (value: unknown) => say(JSON.stringify(value));
const Id = z.uuid().describe("The improvement's id, from improvements.");
/* A refusal comes back to the agent as its reason. */
const refused = async (fn: () => Promise<ReturnType<typeof say>>) => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) return say(err.message, true);
    throw err;
  }
};
const brief = (list: Awaited<ReturnType<typeof listImprovements>>) =>
  list.map(({ id, title, seen, status, result, agent, department }) => ({ id, title, seen, status, result, foundBy: agent.name, department: department?.name ?? null }));

/* For heads and the employees a skill lets: what is under Improvements now, and putting a new one there or finding one
   again. */
export function registerImprovementTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  const { db } = ctx;
  /* Whether this turn may put one more, counted at once. A turn's first one reads what it put before, which a restart of
     Hornhoof would otherwise forget. */
  async function room(): Promise<boolean> {
    const counts = put.get(ctx) ?? new Map<string, number>();
    put.set(ctx, counts);
    if (!counts.has(job.id)) {
      const [run] = await db.select({ startedAt: jobs.startedAt, createdAt: jobs.createdAt }).from(jobs).where(eq(jobs.id, job.id));
      const [before] = await db
        .select({ n: count() })
        .from(improvements)
        .where(and(eq(improvements.agentId, job.agentId), gte(improvements.updatedAt, run?.startedAt ?? run?.createdAt ?? new Date(0))));
      if (!counts.has(job.id)) counts.set(job.id, before?.n ?? 0);
    }
    const n = counts.get(job.id)!;
    if (n >= TURN_IMPROVEMENTS) return false;
    counts.delete(job.id);
    counts.set(job.id, n + 1);
    if (counts.size > PUT_KEPT) counts.delete(counts.keys().next().value!);
    return true;
  }
  server.registerTool(
    'improvements',
    { description: 'What waits under Improvements for the CEO or is in work now, the latest first, with how many rounds found each. Read it before you put one there, so you find one again instead of twice.' },
    async () => json(brief(await listImprovements(ctx, job.companyId, ['open', 'taken']))),
  );
  server.registerTool(
    'propose_improvement',
    {
      description:
        'Puts something you found to improve in how the company works under Improvements, where the CEO takes it into work and the orchestrator does it: a program to install on the nodes ahead, words to add to an instruction, ' +
        'something to write down, a role to move to another subscription. title: the change, in a few words. text: what happened, how often, which agents, the evidence and the exact change. ' +
        `With improvement, the id of one still waiting, you found it again: it is rewritten with your text and counted once more. One turn puts at most ${TURN_IMPROVEMENTS}.`,
      inputSchema: { title: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(4000), improvement: Id.optional() },
    },
    async ({ title, text, improvement }) =>
      refused(async () => {
        if (!(await room())) return say(`One turn puts at most ${TURN_IMPROVEMENTS} improvements. Go on in your next round.`, true);
        if (improvement) {
          await moveImprovement(ctx, job.companyId, improvement, 'open', { title, text, seen: sql`${improvements.seen} + 1` });
          return json({ improvement });
        }
        const [row] = await db.insert(improvements).values({ companyId: job.companyId, agentId: job.agentId, title, text }).returning({ id: improvements.id });
        improvementsChanged(ctx, job.companyId);
        return json({ improvement: row!.id });
      }),
  );
}

/* For the orchestrator: every improvement, and saying what came of one the CEO gave it. */
export function registerOrchestratorImprovementTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  server.registerTool(
    'improvements',
    { description: 'What employees found to improve, the latest first: waiting for the CEO (open), given to you (taken), done, or set aside. When the CEO asks what to improve, read it.' },
    async () => json(brief(await listImprovements(ctx, job.companyId))),
  );
  server.registerTool(
    'close_improvement',
    {
      description:
        'Says what came of an improvement the CEO gave you: done, with what was done, or not done, with why, and it waits for the CEO again. text: one or two lines in the language the CEO writes in.',
      inputSchema: { improvement: Id, done: z.boolean(), text: z.string().trim().min(1).max(2000) },
    },
    async ({ improvement, done, text }) =>
      refused(async () => {
        await moveImprovement(ctx, job.companyId, improvement, 'taken', { status: done ? 'done' : 'open', result: text });
        return say(done ? 'Closed as done.' : 'Back with the CEO.');
      }),
  );
}
