import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { assistantOfAgent, requireAssistant } from '../../auth/assistant.js';
import type { Person } from '../../auth/session.js';
import { agents } from '../../db/schema.js';
import { ApiError, refusal } from '../../errors.js';
import { lastSeqOf } from './events.js';
import { tellOwner } from './replies.js';
import { callSkill, hasSkills } from './skills.js';
import { registerPhoneTools } from '../phones/tools.js';
import { agentsFor, answerFor, EventsQuery, eventsFor, MessageBody, requestsFor, whoAmI, writeFor } from './routes.js';

/* What the program's model reads first: what Hornhoof is to it, and how the tools go together. */
const INSTRUCTIONS =
  "Hornhoof is where your owner's company works with its AI agents. Here you act for your owner, with your owner's rights. " +
  'Write to an agent with send_message, read the answers and the requests that wait for your owner with read_events, ' +
  "and answer a request with answer_request once your owner tells you what to answer.";

const said = (value: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], ...(isError ? { isError } : {}) });

/* A call's answer as JSON, or the refusal the API would give, as an error the model reads. */
async function answer(call: () => Promise<unknown>) {
  try {
    return said(await call());
  } catch (err) {
    const refused = refusal(err);
    if (refused) return said(refused.body, true);
    throw err;
  }
}

/* The assistant API as tools, for this assistant's owner as they are now. gone: the asker went, so a long poll ends.
   self: the assistant's own agent when it is the one asking, which never writes to itself. */
function registerTools(server: McpServer, ctx: Ctx, actor: () => Promise<Person>, gone: AbortSignal, self?: string): McpServer {
  server.registerTool(
    'who_am_i',
    { description: "Who you are in Hornhoof, the person you act for (your owner), what your owner is in the company, and the company's name." },
    () => answer(async () => whoAmI(ctx, await actor())),
  );
  server.registerTool(
    'list_agents',
    { description: "The company's agents you may write to now, with their ids, roles and departments: the same agents your owner may write to." },
    () => answer(async () => agentsFor(ctx, await actor())),
  );
  server.registerTool(
    'send_message',
    {
      description:
        "Writes to an agent for your owner, as your owner would in the agent's window; the agent takes your words as your owner's. " +
        'The answer comes later: read it with read_events, after the number `next` this gives.',
      inputSchema: {
        agentId: MessageBody.shape.agentId.describe("The agent's id, from list_agents."),
        text: MessageBody.shape.text.describe("What you write, as your owner's words: 1 to 50000 characters."),
        freshText: MessageBody.shape.freshText.describe(
          "Optional, for the assistant's own agent: your whole conversation with your owner, up to 200000 characters, which it reads in place of text when its turn starts a new session.",
        ),
      },
    },
    args =>
      answer(async () => {
        if (self && (!args.agentId || args.agentId === self)) throw new ApiError(400, 'validation', 'This is your own conversation: name an agent from list_agents.');
        const me = await actor();
        const next = await lastSeqOf(ctx.db, me.assistant!.id);
        return { ...(await writeFor(ctx, me, args)), next };
      }),
  );
  server.registerTool(
    'read_events',
    {
      description:
        "What happened for you after a number, oldest first, at most 100 at a time: an agent's answer to your message (reply, then reply_end once it is over), " +
        'a request that now waits for your owner (request), and one that waits no more (request_closed). Each answer gives `next`: pass it as `after` the next time.',
      inputSchema: {
        after: EventsQuery.shape.after.describe('Read what came after this number: the `next` you got last. 0 reads from the oldest kept event.'),
        wait: EventsQuery.shape.wait.describe('When nothing is new yet, wait up to this many seconds for something, 0 to 50. 0 answers at once.'),
      },
    },
    (args, extra) => answer(async () => eventsFor(ctx, await actor(), args, AbortSignal.any([gone, extra.signal]))),
  );
  server.registerTool(
    'list_requests',
    { description: 'The requests that wait for your owner now, oldest first: questions, choices, approvals and stuck work. Ask your owner, then give their answer with answer_request.' },
    () => answer(async () => requestsFor(ctx, await actor())),
  );
  server.registerTool(
    'answer_request',
    {
      description:
        'Answers a request for your owner, the same way they answer it in Hornhoof. Give `answer` (words, for a question, a choice or stuck work), ' +
        '`pick` (the number of an option from 0, for a choice, with `answer` if wanted), `approve` true or false (for an approval, with `answer` if wanted), ' +
        'or `retry` true (for stuck work, to try again).',
      inputSchema: {
        requestId: z.uuid().describe("The request's id, from list_requests or read_events."),
        answer: z.string().optional().describe('The answer in words.'),
        pick: z.number().int().optional().describe('For a choice: the number of the option, from 0.'),
        approve: z.boolean().optional().describe('For an approval: true to approve, false to decline.'),
        retry: z.boolean().optional().describe('For stuck work: true to try again.'),
      },
    },
    ({ requestId, ...body }) => answer(async () => answerFor(ctx, await actor(), { id: requestId }, body)),
  );
  return server;
}

/* What an assistant's own agent works with: its owner's assistant tools, the program's skills, and words for its owner's
   chat with the program. called: the tool this request calls, if it calls one. */
export async function assistantAgentTools(ctx: Ctx, job: { id: string; agentId: string }, called: string | null): Promise<McpServer> {
  let actor: Promise<Person> | undefined;
  const owner = () => (actor ??= assistantOfAgent(ctx.db, job.agentId));
  const server = new McpServer({ name: 'hornhoof', version: ctx.config.version });
  registerTools(server, ctx, owner, new AbortController().signal, job.agentId);
  registerPhoneTools(server, ctx, async () => {
    const [me] = await ctx.db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, job.agentId));
    if (!me) throw new ApiError(401, 'unauthorized', 'This tool token is not valid.', 'tool_token_invalid');
    return { id: job.agentId, companyId: me.companyId, jobId: job.id };
  });
  server.registerTool(
    'tell_owner',
    {
      description:
        "Sends your owner words in their chat with the assistant program now. Only for when your owner asks in your window to be written to there: " +
        "your answer to words from your window stays in the window, and your answer to the program's message reaches the chat by itself.",
      inputSchema: { text: MessageBody.shape.text.describe('The words for your owner, as they will read them: 1 to 50000 characters.') },
    },
    args =>
      answer(async () => {
        const me = await owner();
        await tellOwner(ctx, { companyId: me.companyId, assistantId: me.assistant!.id }, job.agentId, args.text, ctx.assistants.told);
        return { passedOn: true };
      }),
  );
  /* The program's skills are among the tools only while the assistant's card has a skills address, as it is at this
     request, so the next list after a change shows it. A call by name from a list read before still gets its refusal in
     words. */
  if (called === 'persona_call' || (await hasSkills(ctx.db, job.agentId))) registerSkills(server, ctx, job);
  return server;
}

function registerSkills(server: McpServer, ctx: Ctx, job: { id: string; agentId: string }): void {
  server.registerTool(
    'persona_call',
    {
      description:
        "Runs one of the assistant program's own skills, such as a reminder, a file or a search, by its name with its arguments, as the message lists them, and gives the program's answer. It may take up to 120 seconds.",
      inputSchema: {
        name: z.string().trim().min(1).max(200).describe("The skill's name, as the message lists it."),
        arguments: z.record(z.string(), z.unknown()).default({}).describe("The skill's arguments, as the message describes them."),
      },
    },
    async (args, extra) => {
      const done = await callSkill(ctx, job, args, extra.signal);
      return { content: [{ type: 'text' as const, text: done.text }], ...(done.ok ? {} : { isError: true }) };
    },
  );
}

/* The assistant API over MCP, for a program that is an MCP client: Streamable HTTP without sessions, every POST with the
   assistant's key, its own server and transport. */
export function assistantMcpRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.post('/api/assistant/mcp', async (req, reply) => {
    const me = await requireAssistant(req, ctx.db);
    const gone = new AbortController();
    const server = registerTools(new McpServer({ name: 'hornhoof', version: ctx.config.version }, { instructions: INSTRUCTIONS }), ctx, async () => me, gone.signal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      gone.abort();
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({ method, url: '/api/assistant/mcp', handler: async (_req, reply) => reply.code(405).header('allow', 'POST').send({ error: { code: 'method_not_allowed', message: 'Use POST.' } }) });
  }
}
