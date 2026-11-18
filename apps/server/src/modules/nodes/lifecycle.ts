import type { NodeMessage } from '@hornhoof/protocol';
import type { OperatorNodeMessage, ProgramNodeMessage } from '@hornhoof/protocol/program-operator';
import { and, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { nodes } from '../../db/schema.js';
import { nodeReported } from './connections.js';
import { isOperatorReply, type NodeIdentity, type NodeTransport } from './hub.js';
import { handleNodeMessage } from './messages.js';
import { hasCurrentKey, liveNode } from './nodes.js';
import { rememberBuiltinStop } from './restarts.js';
import { nodeDrainHello } from '../updates/node-drain.js';
import { acceptOperatorEvidence } from '../program-operator/evidence.js';
import { receiveOperatorReply } from '../program-operator/rpc.js';
import { restoreOperatorNode } from '../program-operator/health.js';
import { phoneNodeMessage } from '../phones/rpc.js';
import { checkConnectedPhones } from '../phones/readiness.js';
import { nodeLogArrived } from '../tools/logs.js';
import { recordPhoneFrame } from '../phones/recording.js';

async function stopping(ctx: Ctx, id: NodeIdentity, msg: Extract<NodeMessage, { type: 'node.stopping' }>): Promise<void> {
  if (msg.exit.kind !== 'planned' || msg.exit.startedAt !== msg.startedAt) return;
  if (!(await hasCurrentKey(ctx, id))) return;
  if (id.kind === 'builtin') return rememberBuiltinStop(ctx, id.machine, msg.startedAt, msg.exit);
  await ctx.db.update(nodes).set({ boot: sql`${nodes.boot} || jsonb_build_object('stopped', ${JSON.stringify(msg.exit)}::jsonb)` })
    .where(and(eq(nodes.id, id.nodeId), liveNode, sql`${nodes.boot}->>'startedAt' = ${msg.startedAt}`, sql`${nodes.boot}->'stopped' is null`));
}

const isOperatorFrame = (frame: ProgramNodeMessage): frame is OperatorNodeMessage => frame.type.startsWith('program.');

async function receiveOperatorFrame(ctx: Ctx, id: NodeIdentity, msg: OperatorNodeMessage): Promise<void> {
  if (!isOperatorReply(msg)) {
    await acceptOperatorEvidence(ctx, id, msg);
    return;
  }
  if (await hasCurrentKey(ctx, id)) receiveOperatorReply(ctx, id, msg);
}

async function receiveBaseFrame(ctx: Ctx, id: NodeIdentity, msg: Exclude<ProgramNodeMessage, OperatorNodeMessage>): Promise<void> {
  if ((msg.type === 'hello' || msg.type === 'phone.reply') && await hasCurrentKey(ctx, id) && phoneNodeMessage(ctx, id, msg)) return;
  if (nodeLogArrived(id, msg)) return;
  if (msg.type === 'phone.frame') {
    if (await hasCurrentKey(ctx, id)) await recordPhoneFrame(ctx, id, msg);
    return;
  }
  if (msg.type === 'hello') nodeDrainHello(ctx, id, msg.boot?.startedAt);
  if (msg.type === 'node.stopping') return stopping(ctx, id, msg);
  if (msg.type === 'node.reconnect') return nodeReported(ctx, id, msg);
  await handleNodeMessage(ctx, id, msg);
  if (msg.type === 'hello') {
    void checkConnectedPhones(ctx, id);
    await restoreOperatorNode(ctx, id);
  }
}

export async function receiveNodeMessage(ctx: Ctx, id: NodeIdentity, msg: ProgramNodeMessage, transport?: NodeTransport): Promise<void> {
  if (transport && !ctx.hub.isCurrentLink(id, transport.linkId)) return;
  return isOperatorFrame(msg) ? receiveOperatorFrame(ctx, id, msg) : receiveBaseFrame(ctx, id, msg);
}
