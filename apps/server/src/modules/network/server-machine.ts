import { and, asc, eq, inArray, isNotNull, isNull, like, ne, notLike, sql } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import {
  certificates,
  companyPhones,
  computerRuns,
  machineAccess,
  machineOnline,
  machines,
  machineTickets,
  nodeCodes,
  nodeConnections,
  nodes,
  testParts,
} from '../../db/schema.js';
import { SERVER_KEY, isServerInstall } from '../nodes/nodes.js';
import { hostIdOf } from './join-proof.js';

type HostConfig = Pick<Config, 'hostId' | 'machineId'>;
type MachineRow = typeof machines.$inferSelect;

export type JoinMachineInput = {
  companyId: string;
  personId: string;
  machineKey: string;
  hostname: string;
  os: string;
  arch: string;
  kind: MachineRow['kind'];
};

const live = isNull(machines.revokedAt);
const serverKey = like(machines.machineKey, `${SERVER_KEY}%`);
const joinedKey = notLike(machines.machineKey, `${SERVER_KEY}%`);

const keptWhileConnected = (column: typeof machines.role | typeof machines.signKey | typeof machines.networkId) =>
  sql`CASE WHEN ${machines.revokedAt} IS NULL THEN ${column} END`;

const NO_PLACE_AFTER_DISCONNECT = {
  role: keptWhileConnected(machines.role),
  signKey: keptWhileConnected(machines.signKey),
  networkId: keptWhileConnected(machines.networkId),
};

/* Whether a server-install row and a joined computer's key prove the same physical host: never by display name. */
export function provenSameHost(config: HostConfig, serverNetworkId: string | null, nodeMachineKey: string): boolean {
  if (!serverNetworkId || isServerInstall(nodeMachineKey)) return false;
  const host = hostIdOf(nodeMachineKey);
  if (serverNetworkId === host) return true;
  return serverNetworkId === config.machineId && config.hostId === host;
}

/* Retires any other live unjoined server-install rows and their certificates when a new server identity is established. */
export async function retireOtherServerRows(tx: Db, keepId: string): Promise<void> {
  const now = new Date();
  const older = await tx
    .update(machines)
    .set({ revokedAt: now })
    .where(and(serverKey, live, ne(machines.id, keepId)))
    .returning({ id: machines.id });
  for (const { id } of older) {
    await tx.update(certificates).set({ revokedAt: now }).where(and(eq(certificates.machineId, id), isNull(certificates.revokedAt)));
  }
}

async function repointNodes(tx: Db, fromId: string, toId: string): Promise<void> {
  await tx.execute(sql`
    DELETE FROM nodes src
    USING nodes dst
    WHERE src.machine_id = ${fromId}::uuid
      AND dst.machine_id = ${toId}::uuid
      AND src.subscription_id IS NOT DISTINCT FROM dst.subscription_id
      AND src.key_hash IS NULL
  `);
  await tx.execute(sql`
    DELETE FROM nodes dst
    USING nodes src
    WHERE src.machine_id = ${fromId}::uuid
      AND dst.machine_id = ${toId}::uuid
      AND src.subscription_id IS NOT DISTINCT FROM dst.subscription_id
      AND dst.key_hash IS NULL
  `);
  await tx.execute(sql`
    UPDATE nodes src
    SET machine_id = ${toId}::uuid
    WHERE src.machine_id = ${fromId}::uuid
      AND NOT EXISTS (
        SELECT 1 FROM nodes dst
        WHERE dst.machine_id = ${toId}::uuid
          AND dst.subscription_id IS NOT DISTINCT FROM src.subscription_id
      )
  `);
  await tx.delete(nodes).where(eq(nodes.machineId, fromId));
}

async function repointOnlineAndAccess(tx: Db, fromId: string, toId: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO machine_online (machine_id, day, seconds)
    SELECT ${toId}::uuid, day, seconds FROM machine_online WHERE machine_id = ${fromId}::uuid
    ON CONFLICT (machine_id, day) DO UPDATE
      SET seconds = LEAST(86400, GREATEST(machine_online.seconds, EXCLUDED.seconds))
  `);
  await tx.delete(machineOnline).where(eq(machineOnline.machineId, fromId));
  await tx.execute(sql`
    INSERT INTO machine_access (machine_id, company_id, scope, employees)
    SELECT ${toId}::uuid, company_id, scope, employees FROM machine_access WHERE machine_id = ${fromId}::uuid
    ON CONFLICT (machine_id) DO NOTHING
  `);
  await tx.delete(machineAccess).where(eq(machineAccess.machineId, fromId));
}

async function repointNetTables(tx: Db, fromId: string, toId: string): Promise<void> {
  await tx.execute(sql`UPDATE net.move SET machine_id = ${toId}::uuid WHERE machine_id = ${fromId}::uuid`);
  await tx.execute(sql`UPDATE net.move SET from_machine_id = ${toId}::uuid WHERE from_machine_id = ${fromId}::uuid`);
  await tx.execute(sql`UPDATE net.handovers SET from_machine_id = ${toId}::uuid WHERE from_machine_id = ${fromId}::uuid`);
  await tx.execute(sql`UPDATE net.handovers SET to_machine_id = ${toId}::uuid WHERE to_machine_id = ${fromId}::uuid`);
  await tx.execute(sql`UPDATE net.merges SET machine = ${toId}::uuid WHERE machine = ${fromId}::uuid`);
}

async function repointMachineChildren(tx: Db, fromId: string, toId: string): Promise<void> {
  await repointNodes(tx, fromId, toId);
  await tx.update(nodeCodes).set({ machineId: toId }).where(eq(nodeCodes.machineId, fromId));
  await tx.update(nodeConnections).set({ machineId: toId }).where(eq(nodeConnections.machineId, fromId));
  await tx
    .update(testParts)
    .set({
      machineId: toId,
      computer: sql`CASE WHEN ${testParts.computer} = ${`machine:${fromId}`} THEN ${`machine:${toId}`} ELSE ${testParts.computer} END`,
    })
    .where(eq(testParts.machineId, fromId));
  await tx.update(companyPhones).set({ machineId: toId }).where(eq(companyPhones.machineId, fromId));
  await tx.update(machineTickets).set({ machineId: toId }).where(eq(machineTickets.machineId, fromId));
  await tx.update(certificates).set({ machineId: toId }).where(eq(certificates.machineId, fromId));
  await tx.update(computerRuns).set({ machineId: toId }).where(eq(computerRuns.machineId, fromId));
  await repointOnlineAndAccess(tx, fromId, toId);
  await repointNetTables(tx, fromId, toId);
}

function mergedFields(server: MachineRow, node: MachineRow) {
  return {
    personId: node.personId,
    machineKey: node.machineKey,
    hostname: node.hostname || server.hostname,
    os: node.os || server.os,
    arch: node.arch || server.arch,
    kind: node.kind,
    lendsTests: node.lendsTests && server.lendsTests,
    keepsBackups: server.keepsBackups && node.keepsBackups,
    computerClosed: server.computerClosed || node.computerClosed,
    createdAt: server.createdAt <= node.createdAt ? server.createdAt : node.createdAt,
  };
}

async function mergePairInTx(tx: Db, serverId: string, nodeId: string): Promise<boolean> {
  const locked = await tx
    .select()
    .from(machines)
    .where(inArray(machines.id, [serverId, nodeId]))
    .orderBy(asc(machines.id))
    .for('update');
  const server = locked.find(row => row.id === serverId);
  const node = locked.find(row => row.id === nodeId);
  if (!server || !node || server.revokedAt !== null || !isServerInstall(server.machineKey)) return false;
  await repointMachineChildren(tx, node.id, server.id);
  await tx.delete(machines).where(eq(machines.id, node.id));
  await tx.update(machines).set(mergedFields(server, node)).where(eq(machines.id, server.id));
  return true;
}

function pickMatchingNode(server: MachineRow, candidates: MachineRow[], config: HostConfig): MachineRow | null {
  return (
    candidates.find(
      c =>
        c.companyId === server.companyId &&
        c.personId === server.personId &&
        provenSameHost(config, server.networkId, c.machineKey),
    ) ?? null
  );
}

/* Joins existing server-install and node rows that prove the same physical computer on startup or step-up to lead. */
export async function joinServerMachines(db: Db, config: HostConfig): Promise<number> {
  const servers = await db
    .select()
    .from(machines)
    .where(and(live, serverKey, isNotNull(machines.networkId)))
    .orderBy(asc(machines.createdAt), asc(machines.id));
  if (servers.length === 0) return 0;

  const joined = await db
    .select()
    .from(machines)
    .where(and(live, joinedKey, eq(machines.kind, 'computer'), isNull(machines.networkId)))
    .orderBy(asc(machines.createdAt), asc(machines.id));

  let merged = 0;
  const used = new Set<string>();
  for (const server of servers) {
    const match = pickMatchingNode(
      server,
      joined.filter(c => !used.has(c.id)),
      config,
    );
    if (!match) continue;
    used.add(match.id);
    if (await db.transaction(tx => mergePairInTx(tx, server.id, match.id))) merged += 1;
  }
  return merged;
}

/* When the owner joined the computer before the server requested its first certificate, claim that joined row directly. */
export async function claimJoinedServerHost(
  tx: Db,
  config: HostConfig,
  companyId: string,
  ownerId: string,
  networkId: string,
): Promise<{ id: string } | null> {
  const joined = await tx
    .select()
    .from(machines)
    .where(and(eq(machines.companyId, companyId), eq(machines.personId, ownerId), live, joinedKey, eq(machines.kind, 'computer'), isNull(machines.networkId)))
    .orderBy(asc(machines.createdAt), asc(machines.id))
    .for('update');

  const match = joined.find(c => provenSameHost(config, networkId, c.machineKey));
  if (!match) return null;
  await tx.update(machines).set({ networkId, role: 'data' }).where(eq(machines.id, match.id));
  await retireOtherServerRows(tx, match.id);
  return { id: match.id };
}

async function findClaimableServerRow(
  tx: Db,
  config: HostConfig,
  input: JoinMachineInput,
): Promise<MachineRow | null> {
  if (input.kind !== 'computer') return null;
  const servers = await tx
    .select()
    .from(machines)
    .where(and(eq(machines.companyId, input.companyId), eq(machines.personId, input.personId), live, serverKey, isNotNull(machines.networkId)))
    .orderBy(asc(machines.createdAt), asc(machines.id))
    .for('update');
  return servers.find(s => provenSameHost(config, s.networkId, input.machineKey)) ?? null;
}

/* Inserts or updates the joining computer's row, claiming an existing server-install row for the same host when present. */
export async function upsertJoinedMachine(tx: Db, config: HostConfig, input: JoinMachineInput): Promise<{ id: string }> {
  const details = { hostname: input.hostname, os: input.os, arch: input.arch, kind: input.kind };
  const server = await findClaimableServerRow(tx, config, input);
  if (server) {
    const [existingNode] = await tx
      .select()
      .from(machines)
      .where(and(eq(machines.personId, input.personId), eq(machines.machineKey, input.machineKey)));
    if (existingNode) await mergePairInTx(tx, server.id, existingNode.id);
    await tx
      .update(machines)
      .set({ personId: input.personId, machineKey: input.machineKey, ...details, revokedAt: null })
      .where(eq(machines.id, server.id));
    return { id: server.id };
  }
  const [machine] = await tx
    .insert(machines)
    .values({ companyId: input.companyId, personId: input.personId, machineKey: input.machineKey, ...details })
    .onConflictDoUpdate({ target: [machines.personId, machines.machineKey], set: { ...details, revokedAt: null, ...NO_PLACE_AFTER_DISCONNECT } })
    .returning({ id: machines.id });
  return { id: machine!.id };
}
