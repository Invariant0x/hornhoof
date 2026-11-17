import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NodeMessage } from '@hornhoof/protocol';
import { cleanDiagnostic } from '@hornhoof/protocol/redaction';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { machines, nodes } from '../../db/schema.js';
import { keyOf, nodeIdentity, type NodeIdentity } from '../nodes/hub.js';

const KEPT_LINES = 400;
const MAX_ANSWER = 30_000;
const NODE_WAIT_MS = 10_000;

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

/* The server's log as it goes out to the container's, with its last lines kept for the orchestrator to read. */
const kept: string[] = [];
export const serverLog = new Writable({
  write(chunk: Buffer, _encoding, done) {
    process.stdout.write(chunk);
    for (const line of chunk.toString('utf8').split('\n')) if (line) kept.push(line);
    kept.splice(0, Math.max(0, kept.length - KEPT_LINES));
    done();
  },
});

/* The asks for a node's log that wait for its answer, by their id. */
const asked = new Map<string, { node: string; done(log: string | null): void }>();

/* A node's log as it asked for it; true when the message was this one. */
export function nodeLogArrived(id: NodeIdentity, msg: NodeMessage): boolean {
  if (msg.type !== 'node.log') return false;
  const ask = asked.get(msg.requestId);
  if (ask?.node === keyOf(id)) ask.done(msg.log);
  return true;
}

function nodeLog(ctx: Ctx, nodeId: string): Promise<string | null> {
  const requestId = randomUUID();
  return new Promise(resolve => {
    const done = (log: string | null) => {
      clearTimeout(timer);
      asked.delete(requestId);
      resolve(log);
    };
    const timer = setTimeout(() => done(null), NODE_WAIT_MS);
    asked.set(requestId, { node: nodeId, done });
    if (!ctx.hub.send(nodeIdentity(nodeId), { type: 'node.log.read', requestId })) done(null);
  });
}

/* The orchestrator sees how Hornhoof runs right now, as it reads in source how it is made. */
export function registerLogsTool(server: McpServer, ctx: Ctx, job: { companyId: string }): void {
  server.registerTool(
    'logs',
    {
      description:
        "The last lines of Hornhoof's own log: the server's, or with node, that node's, asked of it now. Use it with source and database to see how something runs right now and why it went wrong. " +
        'Which machines and nodes there are, their versions and when each was last seen: api /api/machines and /api/updates, or database (machines, nodes, node_connections).',
      inputSchema: { node: z.uuid().optional().describe("A node's id, from api /api/machines or the nodes table.") },
    },
    async ({ node }) => {
      if (!node) return say(cleanDiagnostic(`Server ${ctx.config.version} (${ctx.config.commit}):\n${kept.join('\n')}`).slice(-MAX_ANSWER));
      const [found] = await ctx.db
        .select({ hostname: machines.hostname })
        .from(nodes)
        .innerJoin(machines, eq(machines.id, nodes.machineId))
        .where(and(eq(nodes.id, node), eq(nodes.companyId, job.companyId)));
      if (!found) return say(`This company has no node ${node}. api /api/machines lists its machines and their nodes.`, true);
      const log = await nodeLog(ctx, node);
      if (log === null) return say(`The node on ${found.hostname} did not answer: it is not connected now, or it runs a build older than the server's.`, true);
      return say(`Node on ${found.hostname}:\n${log}`);
    },
  );
}
