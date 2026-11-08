import { effortFor, ORCHESTRATOR_EFFORT } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import type { agents } from '../../db/schema.js';

/* Resolve the configured effort when a program starts; messages and repair findings do not lower it. */
export function effortOfTurn(ctx: Pick<Ctx, 'templates'>, agent: Pick<typeof agents.$inferSelect, 'kind' | 'roleKey' | 'effort'>, efforts: string[]): string | null {
  const role = agent.roleKey ? ctx.templates.roles.get(agent.roleKey) : undefined;
  return effortFor(agent.effort, efforts, agent.kind === 'orchestrator' ? ORCHESTRATOR_EFFORT : role?.effort);
}
