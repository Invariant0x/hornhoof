import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, departments } from '../../db/schema.js';
import type { Tx } from './state.js';

type Agent = typeof agents.$inferSelect;
type Place = Pick<Agent, 'companyId' | 'departmentId'>;

async function departmentHead(db: Db | Tx, place: Place, exceptId?: string): Promise<Agent | null> {
  if (!place.departmentId) return null;
  const [dept] = await db.select().from(departments).where(eq(departments.id, place.departmentId));
  if (!dept) return null;
  const [head] = await db.select().from(agents).where(and(eq(agents.departmentId, dept.parentId ?? dept.id), eq(agents.kind, 'head'), isNull(agents.removedAt), isNull(agents.switchedOffAt))).orderBy(asc(agents.createdAt)).limit(1);
  return head && head.id !== exceptId ? head : null;
}

async function orchestrator(db: Db | Tx, companyId: string, exceptId: string): Promise<Agent | null> {
  const [found] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt))).orderBy(asc(agents.createdAt)).limit(1);
  return found && found.id !== exceptId ? found : null;
}

async function anyHead(db: Db | Tx, companyId: string): Promise<Agent | null> {
  const [head] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.kind, 'head'), isNull(agents.removedAt), isNull(agents.switchedOffAt))).orderBy(asc(agents.createdAt)).limit(1);
  return head ?? null;
}

/* Routes a stuck task to its department's active head first, then to the orchestrator or another active head. */
export async function stuckRecipient(db: Db | Tx, agent: Agent, task: { departmentId: string | null }): Promise<Agent | null> {
  if (agent.kind === 'orchestrator') return (await departmentHead(db, { companyId: agent.companyId, departmentId: task.departmentId })) ?? anyHead(db, agent.companyId);
  return (await departmentHead(db, agent, agent.id)) ?? orchestrator(db, agent.companyId, agent.id);
}
