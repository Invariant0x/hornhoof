import { and, arrayOverlaps, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { nodeCodes, people, subscriptions } from '../../db/schema.js';
import { hashToken, newToken } from '../../crypto/tokens.js';
import { idOnly } from '../../db/selections.js';
import { ApiError } from '../../errors.js';

export const NODE_CODE_TTL_MS = 24 * 60 * 60 * 1000;

/* core: a command that brings the company's core to its machine, and no node. */
type Place = { companyId: string; personId: string; subscriptionIds: string[]; machineId?: string; core?: boolean };

/* Lock the owner before preparing plans too, so two connect requests cannot create the same plan twice. */
export async function lockCommandOwner(db: Db, personId: string): Promise<void> {
  await db.select(idOnly(people)).from(people).where(eq(people.id, personId)).for('update');
}

function commandPlace(input: Place) {
  if (input.machineId) return and(eq(nodeCodes.machineId, input.machineId), eq(nodeCodes.core, input.core ?? false));
  const plans = input.subscriptionIds.length ? arrayOverlaps(nodeCodes.subscriptionIds, input.subscriptionIds) : sql`cardinality(${nodeCodes.subscriptionIds}) = 0`;
  return and(isNull(nodeCodes.machineId), plans);
}

/* A visible command keeps its place; replacing an older invisible one consumes that code. */
async function insertNodeCode(tx: Db, input: Place): Promise<string> {
  await lockCommandOwner(tx, input.personId);
  const at = new Date();
  const place = and(eq(nodeCodes.personId, input.personId), isNull(nodeCodes.usedAt), gt(nodeCodes.expiresAt, at), commandPlace(input));
  const [active] = await tx.select({ id: nodeCodes.codeHash }).from(nodeCodes).where(and(place, isNotNull(nodeCodes.commandEnc))).limit(1);
  if (active) throw new ApiError(409, 'conflict', 'There is an active command for this place. Use it or wait until it expires.', 'command_active');
  /* Older person-made commands had only a hash. A replacement consumes those invisible codes in this place. */
  await tx.update(nodeCodes).set({ usedAt: at }).where(and(place, isNull(nodeCodes.commandEnc)));
  const code = newToken();
  await tx.insert(nodeCodes).values({
    codeHash: hashToken(code), companyId: input.companyId, personId: input.personId,
    subscriptionIds: input.subscriptionIds, machineId: input.machineId ?? null, core: input.core ?? false,
    expiresAt: new Date(Date.now() + NODE_CODE_TTL_MS),
  });
  return code;
}

/* A command that waits to install only plans that are gone ends with them: no screen shows it any more, and it would keep
   the plan from a new command when it connects again. */
export async function endRemovedPlanCommands(tx: Db, planIds: string[]): Promise<void> {
  if (!planIds.length) return;
  await tx.update(nodeCodes).set({ commandEnc: null, usedAt: new Date() }).where(and(
    isNull(nodeCodes.usedAt), arrayOverlaps(nodeCodes.subscriptionIds, planIds),
    sql`not exists (select 1 from ${subscriptions} where ${subscriptions.id} = any(${nodeCodes.subscriptionIds}) and ${subscriptions.removedAt} is null)`,
  ));
}

export async function createNodeCode(db: Db, input: Place): Promise<string> {
  return db.transaction(tx => insertNodeCode(tx, input));
}
