import type { NodeMessage } from '@hornhoof/protocol';
import { and, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { nodes } from '../../db/schema.js';
import { nodeReported } from './connections.js';
import type { NodeIdentity } from './hub.js';
import { handleNodeMessage } from './messages.js';
import { hasCurrentKey, liveNode } from './nodes.js';
import { rememberBuiltinStop } from './restarts.js';

async function stopping(ctx: Ctx, id: NodeIdentity, msg: Extract<NodeMessage, { type: 'node.stopping' }>): Promise<void> {
  if (msg.exit.kind !== 'planned' || msg.exit.startedAt !== msg.startedAt) return;
  if (!(await hasCurrentKey(ctx, id))) return;
  if (id.kind === 'builtin') return rememberBuiltinStop(ctx, msg.startedAt, msg.exit);
  await ctx.db.update(nodes).set({ boot: sql`${nodes.boot} || jsonb_build_object('stopped', ${JSON.stringify(msg.exit)}::jsonb)` })
    .where(and(eq(nodes.id, id.nodeId), liveNode, sql`${nodes.boot}->>'startedAt' = ${msg.startedAt}`, sql`${nodes.boot}->'stopped' is null`));
}

export async function receiveNodeMessage(ctx: Ctx, id: NodeIdentity, msg: NodeMessage): Promise<void> {
  if (msg.type === 'node.stopping') return stopping(ctx, id, msg);
  if (msg.type === 'node.reconnect') return nodeReported(ctx, id, msg);
  return handleNodeMessage(ctx, id, msg);
}
