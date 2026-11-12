import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireAssistant } from '../../auth/assistant.js';
import type { Person } from '../../auth/session.js';
import { refusal } from '../../errors.js';
import { lastSeqOf } from './events.js';
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

/* The assistant API as tools, for this assistant's owner as they are now. gone: the asker went, so a long poll ends. */
function toolsFor(ctx: Ctx, me: Person, gone: AbortSignal): McpServer {
  const server = new McpServer({ name: 'hornhoof', version: ctx.config.version }, { instructions: INSTRUCTIONS });
  server.registerTool(
    'who_am_i',
    { description: "Who you are in Hornhoof, the person you act for (your owner), what your owner is in the company, and the company's name." },
    () => answer(() => whoAmI(ctx, me)),
  );
  server.registerTool(
    'list_agents',
    { description: "The company's agents you may write to now, with their ids, roles and departments: the same agents your owner may write to." },
    () => answer(() => agentsFor(ctx, me)),
  );
  server.registerTool(
    'send_message',
    {
      description:
        "Writes to an agent for your owner, as your owner would in the agent's window; the agent takes your words as your owner's. " +
        'The answer comes later: read it with read_events, after the number `next` this gives.',
      inputSchema: {
        agentId: MessageBody.shape.agentId.describe("The agent's id, from list_agents."),
        text: MessageBody.shape.text.describe("What you write, as your owner's words: 1 to 20000 characters."),
      },
    },
    args =>
      answer(async () => {
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
    (args, extra) => answer(() => eventsFor(ctx, me, args, AbortSignal.any([gone, extra.signal]))),
  );
  server.registerTool(
    'list_requests',
    { description: 'The requests that wait for your owner now, oldest first: questions, choices, approvals and stuck work. Ask your owner, then give their answer with answer_request.' },
    () => answer(() => requestsFor(ctx, me)),
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
    ({ requestId, ...body }) => answer(() => answerFor(ctx, me, { id: requestId }, body)),
  );
  return server;
}

/* The assistant API over MCP, for a program that is an MCP client: Streamable HTTP without sessions, every POST with the
   assistant's key, its own server and transport. */
export function assistantMcpRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.post('/api/assistant/mcp', async (req, reply) => {
    const me = await requireAssistant(req, ctx.db);
    const gone = new AbortController();
    const server = toolsFor(ctx, me, gone.signal);
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
