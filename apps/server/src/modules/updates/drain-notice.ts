import { eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { machines, nodes, subscriptions } from '../../db/schema.js';
import { enqueueTurn } from '../conversation/queue.js';
import { orchestratorOf } from '../conversation/turn-records.js';
import type { NodeIdentity } from '../nodes/hub.js';
import type { drainWork } from './drain-work.js';

type Work = Awaited<ReturnType<typeof drainWork>>;
/* A node as people know it, the company it is of (none for a built-in node) and its machine's short name. */
type Named = { name: string; companyId: string | null; machine: string };

/* A plan's node by its plan and machine, and its id, which the screens and the logs give too. */
async function planNode(ctx: Ctx, nodeId: string): Promise<Named> {
  const [row] = await ctx.db.select({ companyId: nodes.companyId, machine: machines.hostname, plan: subscriptions.label })
    .from(nodes).innerJoin(machines, eq(machines.id, nodes.machineId)).leftJoin(subscriptions, eq(subscriptions.id, nodes.subscriptionId))
    .where(eq(nodes.id, nodeId));
  if (!row) return { name: `node ${nodeId}`, companyId: null, machine: 'a node' };
  return { name: `the node on ${row.machine}${row.plan ? ` of plan ${row.plan}` : ''} (node ${nodeId})`, companyId: row.companyId, machine: row.machine };
}

const nodeName = (ctx: Ctx, node: NodeIdentity): Promise<Named> | Named =>
  node.kind === 'node' ? planNode(ctx, node.nodeId) : { name: `the built-in node of machine ${node.machine}`, companyId: null, machine: 'built-in node' };

/* A turn by who runs it, its task and its id. */
const turnName = (turn: Work['turns'][number]) => `${turn.agent ?? 'a call of no employee'}${turn.task ? ` on #${turn.task}` : ''} (turn ${turn.id})`;

/* The work of one company that holds the node: its turns, then how many of its test parts. */
function holdingOf(work: Work, companyId: string): string {
  const turns = work.turns.filter(t => t.companyId === companyId).map(turnName);
  const parts = work.parts.filter(p => p.companyId === companyId).length;
  const all = parts ? [...turns, `${parts} test ${parts === 1 ? 'part' : 'parts'}`] : turns;
  return all.length ? all.join(', ') : 'the work of other companies';
}

const longWaitText = (name: string, holding: string, heldAt: number, until: number) =>
  `Hornhoof: ${name} has waited for its update since ${new Date(heldAt).toISOString()}, and takes no new turn meanwhile, so the employees whose turns go there wait too. ` +
  `It waits for ${holding}. ` +
  `At ${new Date(until).toISOString()} Hornhoof updates it anyway: what still runs on it then stops, and each turn it cut runs once more after the restart, as after any restart.`;

/* Half an hour into a node's wait for its update, the orchestrator of each company whose work holds it hears which node,
   since when, the turns of its own company that hold it and when the node updates anyway. A plan's node is its company's;
   the built-in node runs the work of each company that has some on it. */
export async function tellLongWait(ctx: Ctx, node: NodeIdentity, work: Work, heldAt: number, until: number): Promise<void> {
  const { name, companyId, machine } = await nodeName(ctx, node);
  const companies = new Set([companyId, ...work.turns.map(t => t.companyId), ...work.parts.map(p => p.companyId)].filter(id => id !== null));
  const detail = { en: `${machine}: update waits`, ru: `${machine}: обновление ждёт` };
  for (const company of companies) {
    const orchestrator = await orchestratorOf(ctx, company);
    if (!orchestrator) continue;
    const text = longWaitText(name, holdingOf(work, company), heldAt, until);
    await enqueueTurn(ctx, { companyId: company, agentId: orchestrator.id, prompt: text, createdBy: null, message: { personId: null, text, notification: { source: 'machine', tasks: [], detail } } });
  }
}
