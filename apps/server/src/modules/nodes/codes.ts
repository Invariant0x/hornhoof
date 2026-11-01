import type { Db } from '../../db/client.js';
import { nodeCodes } from '../../db/schema.js';
import { hashToken, newToken } from '../../crypto/tokens.js';

export const NODE_CODE_TTL_MS = 24 * 60 * 60 * 1000;

/* A one-time code for the install command. Works inside a transaction too. With a machine it works only there. */
export async function createNodeCode(db: Db, input: { companyId: string; personId: string; subscriptionIds: string[]; machineId?: string }): Promise<string> {
  const code = newToken();
  await db.insert(nodeCodes).values({
    codeHash: hashToken(code),
    companyId: input.companyId,
    personId: input.personId,
    subscriptionIds: input.subscriptionIds,
    machineId: input.machineId ?? null,
    expiresAt: new Date(Date.now() + NODE_CODE_TTL_MS),
  });
  return code;
}
