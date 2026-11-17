import { createHmac, timingSafeEqual } from 'node:crypto';
import { ACKS_HEADER, TOOLS_HEADER } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx } from '../../app.js';
import { hashToken } from '../../crypto/tokens.js';
import { nodes } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { builtinOf, ownBuiltin, type NodeIdentity } from './hub.js';

/* Results can be long, and a phone's screen with its elements is the longest; anything bigger than this closes the socket. */
const MAX_FRAME = 20 * 1024 * 1024;

function sameKey(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* The built-in node's key of its machine: builtin.<machine id>.<HMAC-SHA256 of the node key over the words below and the
   id>. The node key itself never travels in it. */
const MACHINE_KEY = /^builtin\.([0-9a-f]{32}|[0-9a-f]{64})\.([0-9a-f]{64})$/;

/* The machine a built-in node's key was made for; '' for the bare node key, as a node of a build before sends it; null
   for any other key. */
function builtinMachine(key: string, nodeKey: string): string | null {
  if (sameKey(key, nodeKey)) return '';
  const [, machineId, mac] = MACHINE_KEY.exec(key) ?? [];
  return machineId !== undefined && sameKey(mac!, createHmac('sha256', nodeKey).update(`hornhoof builtin node ${machineId}`).digest('hex')) ? machineId : null;
}

/* The built-in node's key, bare as a node from before sends it or made for its machine, or the key a node got at join.
   Nodes of removed subscriptions still match so they can be told to clean up. */
export async function identify(ctx: Ctx, req: FastifyRequest): Promise<NodeIdentity | null> {
  const header = req.headers.authorization ?? '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!key) return null;
  const machine = ctx.config.nodeKey ? builtinMachine(key, ctx.config.nodeKey) : null;
  /* Each machine's built-in node is its own, wherever the server runs: after a switch the old leader's node, reaching the
     new one, is still that machine's. */
  if (machine !== null) return machine ? builtinOf(machine) : ownBuiltin(ctx.config);
  const keyHash = hashToken(key);
  const [node] = await ctx.db.select(idOnly(nodes)).from(nodes).where(eq(nodes.keyHash, keyHash));
  return node ? { kind: 'node', nodeId: node.id, keyHash } : null;
}

const SOCKET_PATH = '/api/nodes/socket';

export function nodeSocket(app: FastifyInstance, ctx: Ctx): void {
  const identities = new WeakMap<FastifyRequest, NodeIdentity>();
  /* A node keeps each numbered message until it is confirmed only when the server says here that it confirms, and hands
     on what an agent's program sends to its tools with no turn running only when it says it answers that. */
  app.websocketServer.on('headers', (headers: string[], req: { url?: string }) => {
    if (req.url?.split('?')[0] === SOCKET_PATH) headers.push(`${ACKS_HEADER}: 1`, `${TOOLS_HEADER}: 1`);
  });
  app.get(
    SOCKET_PATH,
    {
      websocket: true,
      preValidation: async (req, reply) => {
        const id = await identify(ctx, req);
        if (!id) return reply.code(401).send({ error: { code: 'unauthorized', message: 'Unknown node key.' } });
        identities.set(req, id);
      },
    },
    (socket, req) => ctx.hub.attach(identities.get(req)!, socket),
  );
}

export const SOCKET_OPTIONS = { options: { maxPayload: MAX_FRAME } };
