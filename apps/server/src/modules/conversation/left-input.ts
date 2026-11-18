import type { NodeMessage } from '@hornhoof/protocol';
import { and, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { appendEvent } from '../events/store.js';
import type { NodeIdentity } from '../nodes/hub.js';
import { onAgent } from './line.js';
import { wordsFrom } from './unheard.js';

type Left = Extract<NodeMessage, { type: 'agent.input_left' }>;

const keptBefore = async (ctx: Ctx, agentId: string, ref: string): Promise<boolean> =>
  (await ctx.db.select(idOnly(agentEvents)).from(agentEvents)
    .where(and(eq(agentEvents.agentId, agentId), eq(agentEvents.kind, 'input_left'), sql`${agentEvents.data}->>'ref' = ${ref}`)).limit(1)).length > 0;

/* Words left unsent in a program's input, which the node clears for the next assignment only once it hears they are kept.
   They stay a line of the agent's conversation: no turn runs them and the author of no turn answers for them. The person
   on the line is who typed in that terminal last, when the node saw keys since Hornhoof last typed there. */
export async function keepLeftInput(ctx: Ctx, node: NodeIdentity, msg: Left): Promise<void> {
  const origin = await wordsFrom(ctx, node, msg);
  if (!origin) return;
  const { agent } = origin;
  await onAgent(ctx, agent.id, async () => {
    if (await keptBefore(ctx, agent.id, msg.ref)) return;
    const personId = msg.typed ? ctx.terminals.lastWriter(node, agent.id) : null;
    await appendEvent(ctx, { companyId: agent.companyId, agentId: agent.id, jobId: msg.jobId, kind: 'input_left', personId, data: { text: msg.text, ref: msg.ref } });
  });
  /* The node clears them now. */
  ctx.terminals.inputLine(agent.id).empty();
  ctx.hub.send(node, { type: 'agent.input_kept', agentKey: agent.id, ref: msg.ref });
}
