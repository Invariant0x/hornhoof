import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { improvements, improvementSubmissions, IMPROVEMENT_SCOPES, type ImprovementParts } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import type { Tx } from '../tasks/state.js';
import { currentInvocation } from '../tools/calls.js';
import { caseText, countOnSent, improvementsChanged, listImprovements, moveImprovement, moveImprovementTx } from './store.js';

type ToolJob = { id: string; companyId: string; agentId: string };

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
const json = (value: unknown) => say(JSON.stringify(value));
const Id = z.uuid().describe("The improvement's id, from improvements.");
const Line = (max: number) => z.string().trim().min(1).max(max);
/* An improvement as a short case. Only the title and the change are a must. */
const Case = {
  title: Line(200).describe('The change, in a few words.'),
  problem: Line(1000).optional().describe('What is wrong, in a sentence or two.'),
  facts: z
    .array(z.object({ text: Line(500).describe('One thing that happened, checked.'), source: Line(200).describe('Where it comes from: a task number, a log, a count.') }))
    .max(10)
    .optional()
    .describe('What you checked, each with where it comes from.'),
  guesses: z.array(Line(500)).max(5).optional().describe('What you think but did not check, kept apart from the facts.'),
  why: Line(1000).optional().describe('Why it matters: what it costs or holds up now.'),
  change: Line(2000).describe('What exactly to change: the package to install, the words to add to an instruction, the setting.'),
  gain: Line(1000).optional().describe('What it gives once it is done.'),
  scope: z
    .enum(IMPROVEMENT_SCOPES)
    .optional()
    .describe(
      'company (the default): how this company works, its setup, instructions or work. platform: Hornhoof itself is at fault, such as a system package its node image lacks, or a failure of its terminal, queue or tools.',
    ),
  code: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .optional()
    .describe('For a platform finding, the error code Hornhoof gave, as it gave it, like relay_unreachable.'),
};
/* A refusal comes back to the agent as its reason. */
const refused = async (fn: () => Promise<ReturnType<typeof say>>) => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) return say(err.message, true);
    throw err;
  }
};
/* Whose work a finding is, and for one about Hornhoof itself, the error code Hornhoof gave. */
function kindOf(scope: (typeof IMPROVEMENT_SCOPES)[number] = 'company', code?: string) {
  return { scope, code: scope === 'platform' ? (code ?? null) : null };
}
/* Files a new finding, or counts one about Hornhoof itself on the sent card its developers have it as already. */
async function fileFinding(ctx: Ctx, tx: Tx, job: ToolJob, values: { title: string; text: string; parts: ImprovementParts } & ReturnType<typeof kindOf>) {
  const known = values.scope === 'platform' ? await countOnSent(ctx, tx, job.companyId, { title: values.title, code: values.code }) : null;
  if (known) return { improvement: known.id, sent: { number: known.number }, note: "Hornhoof's developers have this already. It is counted once more on its card." };
  const [row] = await tx.insert(improvements).values({ companyId: job.companyId, agentId: job.agentId, ...values }).returning({ id: improvements.id });
  return { improvement: row!.id };
}

const brief = (list: Awaited<ReturnType<typeof listImprovements>>) =>
  list.map(({ id, title, seen, status, scope, result, agent, department }) => ({ id, title, seen, status, scope, result, foundBy: agent.name, department: department?.name ?? null }));

/* For heads and the employees a skill lets: what is under Improvements now, and putting a new one there or finding one
   again. */
export function registerImprovementTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
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
        'something to write down, a role to move to another subscription. Write it as a short case in the CEO\'s language and plain words, keeping names, commands and packages as they are: ' +
        'the title, what is wrong, the facts with where each comes from, apart from what you only guess, why it matters, the exact change and what it gives. ' +
        'Say with scope whether the company can change it itself, or whether Hornhoof itself is at fault: on an installation of another company a platform finding goes to Hornhoof developers once the CEO sends it, ' +
        'and one they have already is counted once more on its card instead of a new one. ' +
        'With improvement, the id of one still waiting, you found it again: it is rewritten with your case and counted once more.',
      inputSchema: { ...Case, improvement: Id.optional() },
    },
    async ({ title, problem, facts, guesses, why, change, gain, scope, code, improvement }) =>
      refused(async () => {
        const parts = { problem: problem ?? null, facts: facts ?? [], guesses: guesses ?? [], why: why ?? null, change, gain: gain ?? null };
        const text = caseText(parts);
        const kind = kindOf(scope, code);
        const key = createHash('sha256').update(JSON.stringify([job.companyId, job.id, currentInvocation() ?? [improvement, title, parts, kind]])).digest('hex');
        const saved = await ctx.db.transaction(async tx => {
          const [added] = await tx.insert(improvementSubmissions).values({ key }).onConflictDoNothing().returning();
          if (!added) {
            const [before] = await tx.select().from(improvementSubmissions).where(eq(improvementSubmissions.key, key));
            return before!.result!;
          }
          const result = improvement
            ? { improvement: (await moveImprovementTx(tx, job.companyId, improvement, 'open', { title, text, parts, ...kind, seen: sql`${improvements.seen} + 1` })).id }
            : await fileFinding(ctx, tx, job, { title, text, parts, ...kind });
          await tx.update(improvementSubmissions).set({ result }).where(eq(improvementSubmissions.key, key));
          return result;
        });
        improvementsChanged(ctx, job.companyId);
        return json(saved);
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
