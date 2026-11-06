import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, departments } from '../../db/schema.js';
import type { Tx } from './engine.js';

type Agent = typeof agents.$inferSelect;

/* The one stuck-specific route until the general internal-question lifecycle lands. */
export async function stuckRecipient(db: Db | Tx, agent: Agent): Promise<Agent | null> {
  const [dept] = agent.departmentId ? await db.select().from(departments).where(eq(departments.id, agent.departmentId)) : [];
  const [head] = dept ? await db.select().from(agents).where(and(eq(agents.departmentId, dept.parentId ?? dept.id), eq(agents.kind, 'head'), isNull(agents.removedAt), isNull(agents.switchedOffAt))).orderBy(asc(agents.createdAt)).limit(1) : [];
  if (head && head.id !== agent.id) return head;
  const [orchestrator] = await db.select().from(agents).where(and(eq(agents.companyId, agent.companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt))).orderBy(asc(agents.createdAt)).limit(1);
  return orchestrator && orchestrator.id !== agent.id ? orchestrator : null;
}
