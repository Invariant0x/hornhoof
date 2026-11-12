import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/* What an agent's tools do on a machine that only reads the company's data. The agent sees the same tools in every
   mode, so its program's list never changes under it. The tools that only read answer as ever. A tool that changes
   something answers one fixed text on a machine that is cut off, so the agent finishes its step and ends its turn
   itself; on a machine that still has the internet, and so only waits for the leader or for the CEO, the call is
   turned away before any tool runs and tried again by the front door. */

/* The tools whose handlers only read. `computer_result` is not among them: it gives up a command whose keeper never
   came for it, which is a write. */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  'company', 'staffing_options', 'tasks', 'task', 'turns', 'agents', 'failures', 'test_run', 'work_run', 'notebook', 'improvements', 'database', 'view', 'pool',
]);

export const CUT_OFF = 'This machine is cut off and does not take changes now. Finish your current step, commit your work on your task branch, push if you can, and end your turn.';

type Answer = { content: { type: 'text'; text: string }[]; isError?: boolean };

/* From here on, every tool registered on this server that is not kept answers the text as a tool's own error, under
   its own name, description and input. keep: the tools that answer as ever; the read tools when left out. */
export function cutOff(server: McpServer, o: { text?: string; keep?: ReadonlySet<string> } = {}): McpServer {
  const keep = o.keep ?? READ_TOOLS;
  const text = o.text ?? CUT_OFF;
  const register = server.registerTool.bind(server) as (name: string, config: unknown, handler: (...given: unknown[]) => unknown) => unknown;
  server.registerTool = ((name: string, config: unknown, handler: (...given: unknown[]) => unknown) =>
    register(name, config, keep.has(name) ? handler : async (): Promise<Answer> => ({ content: [{ type: 'text', text }], isError: true }))) as McpServer['registerTool'];
  return server;
}

/* The name of the tool a request calls: the params.name of a JSON-RPC body whose method is tools/call, else none. */
export function callName(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const { method, params } = body as { method?: unknown; params?: { name?: unknown } | null };
  return method === 'tools/call' && typeof params?.name === 'string' ? params.name : null;
}
