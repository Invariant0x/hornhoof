import { eq, max } from 'drizzle-orm';
import { companies, tasks, turns } from '../../db/schema.js';
import type { Tx } from './state.js';

/* The last task number a company gave: the highest of its tasks, or of the numbers it gave before their rows were
   removed. The next task goes on after it. */
export async function lastTaskNumber(tx: Pick<Tx, 'select'>, companyId: string): Promise<number> {
  const [row] = await tx.select({ n: max(tasks.number) }).from(tasks).where(eq(tasks.companyId, companyId));
  const [company] = await tx.select({ used: companies.taskNumbersUsed }).from(companies).where(eq(companies.id, companyId));
  return Math.max(row?.n ?? 0, company?.used ?? 0);
}

/* The last turn number a company gave, the same way, so a branch turn-N never names two turns. A version is its repository's
   own and goes on from that repository's last tag; a turn's number goes into it only where that repository's scheme says so. */
export async function lastTurnNumber(tx: Tx, companyId: string): Promise<number> {
  const [row] = await tx.select({ n: max(turns.number) }).from(turns).where(eq(turns.companyId, companyId));
  const [company] = await tx.select({ used: companies.turnNumbersUsed }).from(companies).where(eq(companies.id, companyId));
  return Math.max(row?.n ?? 0, company?.used ?? 0);
}
