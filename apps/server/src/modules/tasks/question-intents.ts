import { QuestionClassificationInput } from '@hornhoof/protocol';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, departments, jobs, requestInternal, requests, tasks } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { jobOf, type ToolJob } from '../tools/job.js';
import { picturesOf } from './attachments.js';
import { answerInternal, classifyInternal, ResolveInput, RouteInput, routeInternal, type Settled } from './question-lifecycle.js';
import { wakeAll } from './wake.js';

/* The same questions over tools and HTTP: what whoever has them reads, and the one way each is settled or put before a person. The
   caller is the turn its token belongs to, never anything it says it is. */

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
const PAGE = 50;
const Cursor = z.strictObject({ at: z.iso.datetime(), id: z.uuid() });
type Cursor = z.infer<typeof Cursor>;

const encoded = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');
function decoded(text: string | undefined): Cursor | null {
  if (!text) return null;
  try {
    return Cursor.parse(JSON.parse(Buffer.from(text, 'base64url').toString()));
  } catch {
    throw new ApiError(400, 'validation', 'This cursor is not one this page gave.', 'task_invalid');
  }
}

/* What this turn's agent has to read: the orchestrator every question inside, a head those on its department's work, anyone what was
   handed to it. Nobody else's is even named. */
async function questionsOf(db: Ctx['db'], job: Pick<ToolJob, 'agentId' | 'companyId' | 'agentKind' | 'departmentId'>) {
  const inside = and(eq(requests.companyId, job.companyId), eq(requests.status, 'open'), eq(requests.audience, 'internal'));
  if (job.agentKind === 'orchestrator') return inside;
  const mine = eq(requests.triageAgentId, job.agentId);
  if (job.agentKind !== 'head' || !job.departmentId) return and(inside, mine);
  const products = await db.select({ id: departments.id }).from(departments).where(eq(departments.parentId, job.departmentId));
  return and(inside, or(mine, inArray(tasks.departmentId, [job.departmentId, ...products.map(p => p.id)])));
}

export async function internalQuestions(ctx: Ctx, job: ToolJob, after?: string) {
  const from = decoded(after);
  const rows = await ctx.db
    .select({ request: requests, task: { id: tasks.id, number: tasks.number, title: tasks.title }, asker: { id: agents.id, name: agents.name }, words: requestInternal.technicalText })
    .from(requests)
    .innerJoin(tasks, eq(tasks.id, requests.taskId))
    .innerJoin(agents, eq(agents.id, requests.agentId))
    .leftJoin(requestInternal, eq(requestInternal.requestId, requests.id))
    .where(and(await questionsOf(ctx.db, job), from ? or(gt(requests.createdAt, new Date(from.at)), and(eq(requests.createdAt, new Date(from.at)), gt(requests.id, from.id))) : undefined))
    .orderBy(asc(requests.createdAt), asc(requests.id))
    .limit(PAGE + 1);
  const page = rows.slice(0, PAGE);
  const pictures = await picturesOf(ctx.db, page.map(r => r.request));
  const last = page.at(-1);
  return {
    questions: page.map(({ request: r, task, asker, words }) => ({
      source: { kind: 'task_request' as const, id: r.id }, kind: r.kind, text: words ?? r.text, revision: r.questionRevision, routeRevision: r.routeRevision, triageAgentId: r.triageAgentId,
      task, asker, commit: r.commit, options: r.options, link: r.link, images: pictures.get(r.id) ?? [], topic: r.decisionTopic, approval: r.approvalChannel ? { channel: r.approvalChannel, kind: r.approvalKind, amount: r.approvalAmount } : null, at: r.createdAt.toISOString(),
    })),
    next: rows.length > PAGE && last ? encoded({ at: last.request.createdAt.toISOString(), id: last.request.id }) : null,
  };
}

const call = (job: Pick<ToolJob, 'id' | 'agentId' | 'companyId'>) => ({ jobId: job.id, agentId: job.agentId, companyId: job.companyId });

/* The wakes are kept with the move; a retry that changed nothing has none. */
async function done(ctx: Ctx, settled: Settled) {
  await wakeAll(ctx, settled.wakes);
  return settled.result;
}

const readable = async (fn: () => Promise<unknown>) => {
  try {
    return say(JSON.stringify(await fn()));
  } catch (err) {
    if (err instanceof ApiError) return say(err.message, true);
    if (err instanceof z.ZodError) return say(err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(' '), true);
    throw err;
  }
};

export function registerQuestionTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  server.registerTool(
    'internal_questions',
    { description: 'The questions inside the company that are yours to settle, with their words and the revisions to act on them with. after: the next value of the page before.', inputSchema: { after: z.string().max(400).optional() } },
    ({ after }) => readable(() => internalQuestions(ctx, job, after)),
  );
  server.registerTool(
    'resolve_question',
    {
      description: 'Settles a question inside the company that is yours: resolution is what the one who goes on hears, executorInstruction the technical detail only they get. It approves and grants nothing, and no person is named as answering. Use a new operationId for each decision; the same one again returns what it did.',
      inputSchema: ResolveInput,
    },
    input => readable(async () => done(ctx, await answerInternal(ctx, call(job), ResolveInput.parse(input)))),
  );
  server.registerTool(
    'route_question',
    { description: 'Hands a question inside the company that is yours on to the head, the orchestrator or Operations. Handing it to Operations gives it the work, and no right to put it before a person.', inputSchema: RouteInput },
    input => readable(async () => done(ctx, await routeInternal(ctx, call(job), RouteInput.parse(input)))),
  );
  server.registerTool(
    'classify_human_intent',
    {
      description: 'Puts a question before the person who takes it, the only way one comes to a person. Only the head of its department or the orchestrator may, and only for a ready result (classification kind ready_result, with the exact commit or pictures) or what only a person can do (kind human_only_action). ' +
        'humanEnvelope is all the person reads: situation, requiredAction and options, in plain words with no commands, code or markup. It approves, pays and grants nothing. The person is worked out by Hornhoof.',
      inputSchema: QuestionClassificationInput,
    },
    input => readable(async () => done(ctx, await classifyInternal(ctx, call(job), QuestionClassificationInput.parse(input)))),
  );
}

const refused = async (req: FastifyRequest, ctx: Ctx): Promise<ToolJob> => jobOf(ctx, req);

export function questionRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/internal-intents', async req => {
    const job = await refused(req, ctx);
    const { after } = z.strictObject({ after: z.string().max(400).optional() }).parse(req.query);
    return internalQuestions(ctx, job, after);
  });
  app.post('/api/internal-intents/resolve', async req => {
    const job = await refused(req, ctx);
    return done(ctx, await answerInternal(ctx, call(job), ResolveInput.parse(req.body)));
  });
  app.post('/api/internal-intents/classify', async req => {
    const job = await refused(req, ctx);
    return done(ctx, await classifyInternal(ctx, call(job), QuestionClassificationInput.parse(req.body)));
  });
}
