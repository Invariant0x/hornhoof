import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/client.js';
import { assistants, people } from '../db/schema.js';
import { hashToken } from '../crypto/tokens.js';
import { ApiError } from '../errors.js';
import { actsAsCeo } from './decisions.js';
import { personColumns, type Person } from './session.js';

/* The key as an assistant sends it: Authorization: Bearer hha_<43 characters>. */
const BEARER = /^Bearer (hha_[A-Za-z0-9_-]{43})$/;

const badKey = () =>
  new ApiError(401, 'unauthorized', "Send the assistant's key as Authorization: Bearer <key>. A key that was replaced or revoked, or of an assistant that is switched off, opens nothing.", 'assistant_key_invalid');

/* The owner of the assistant whose key the request carries, as they are now, marked as acting through it. The key opens only
   the assistant's own routes, which ask this; every other route asks for a person's session and refuses it. */
export async function requireAssistant(req: FastifyRequest, db: Db): Promise<Person> {
  const key = BEARER.exec(req.headers.authorization ?? '')?.[1];
  if (!key) throw badKey();
  const [row] = await db
    .select({ id: people.id, name: people.name, companyId: people.companyId, status: people.status, ownerId: people.assistantOf })
    .from(assistants)
    .innerJoin(people, eq(people.id, assistants.personId))
    .where(and(eq(assistants.keyHash, hashToken(key)), eq(people.isAgent, true)));
  if (!row?.ownerId || row.status !== 'active') throw badKey();
  const [owner] = await db.select(personColumns).from(people).where(and(eq(people.id, row.ownerId), eq(people.companyId, row.companyId), eq(people.isAgent, false)));
  if (!owner || owner.status !== 'active') {
    throw new ApiError(403, 'forbidden', 'The person this assistant belongs to is switched off or gone, so it can do nothing for them.', 'assistant_owner_inactive');
  }
  return { ...owner, assistant: { id: row.id, name: row.name } };
}

/* Whether the person sees the whole company: the CEO, the CEO delegate, or access to all of it. Only then does their
   assistant write to the orchestrator. */
export const wholeCompany = (me: Person): boolean => actsAsCeo(me) || me.scopeKind === 'company';
