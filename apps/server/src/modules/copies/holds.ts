import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { people } from '../../db/schema.js';
import { seesAll } from './qualify.js';

/* Whether a person may have machines that hold the company's data: active, and the CEO or someone who sees it whole. */
export async function holdsData(db: Db, personId: string): Promise<boolean> {
  const [person] = await db.select({ isOwner: people.isOwner, scopeKind: people.scopeKind, status: people.status }).from(people).where(eq(people.id, personId));
  return Boolean(person) && seesAll({ isOwner: person!.isOwner, company: person!.scopeKind === 'company', active: person!.status === 'active', name: '' });
}
