import type { NodeMessage } from '@hornhoof/protocol';
import type { OperatorNodeMessage, ProgramNodeMessage } from '@hornhoof/protocol/program-operator';
import { and, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { nodes } from '../../db/schema.js';
import { nodeReported } from './connections.js';
import type { NodeIdentity } from './hub.js';
import { handleNodeMessage } from './messages.js';
import { hasCurrentKey, liveNode } from './nodes.js';
import { rememberBuiltinStop } from './restarts.js';
import { nodeDrainHello } from '../updates/node-drain.js';
import { acceptOperatorEvidence } from '../program-operator/evidence.js';
import { receiveOperatorReply } from '../program-operator/rpc.js';
import { restoreOperatorNode } from '../program-operator/health.js';

async function stopping(ctx: Ctx, id: NodeIdentity, msg: Extract<NodeMessage, { type: 'node.stopping' }>): Promise<void> {
  if (msg.exit.kind !== 'planned' || msg.exit.startedAt !== msg.startedAt) return;
  if (!(await hasCurrentKey(ctx, id))) return;
  if (id.kind === 'builtin') return rememberBuiltinStop(ctx, msg.startedAt, msg.exit);
  await ctx.db.update(nodes).set({ boot: sql`${nodes.boot} || jsonb_build_object('stopped', ${JSON.stringify(msg.exit)}::jsonb)` })
    .where(and(eq(nodes.id, id.nodeId), liveNode, sql`${nodes.boot}->>'startedAt' = ${msg.startedAt}`, sql`${nodes.boot}->'stopped' is null`));
}

const isOperatorFrame = (frame: ProgramNodeMessage): frame is OperatorNodeMessage => frame.type.startsWith('program.');

export async function receiveNodeMessage(ctx: Ctx, id: NodeIdentity, msg: ProgramNodeMessage): Promise<void> {
  if (msg.type === 'hello') nodeDrainHello(ctx, id, msg.boot?.startedAt);
  if (isOperatorFrame(msg)) {
    if (msg.type === 'program.screen' || msg.type === 'program.key_result' || msg.type === 'program.key_prepared') {
      if (await hasCurrentKey(ctx, id)) receiveOperatorReply(ctx, id, msg);
    } else await acceptOperatorEvidence(ctx, id, msg);
    return;
  }
  if (msg.type === 'node.stopping') return stopping(ctx, id, msg);
  if (msg.type === 'node.reconnect') return nodeReported(ctx, id, msg);
  await handleNodeMessage(ctx, id, msg);
  if (msg.type === 'hello') await restoreOperatorNode(ctx, id);
}
