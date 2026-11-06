import type { AgentViewer } from '../../auth/agent-view.js';
import type { Db } from '../../db/client.js';
import type { turns } from '../../db/schema.js';

type CountedTurn = Pick<typeof turns.$inferSelect, 'id' | 'companyId'>;
export async function turnCounts(_db: Db, _turn: CountedTurn, _viewer: AgentViewer, _departmentId?: string): Promise<{ total: number; done: number }> {
  throw new Error('Shared visible turn counts are not implemented.');
}
