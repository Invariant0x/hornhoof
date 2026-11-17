import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gt, isNotNull, isNull, like, ne, sql } from 'drizzle-orm';
import type { Config } from '../../config.js';
import { decryptSecret, encryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import { authority, certificates, companies, machines, peerSecrets, people, type MachineRole } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { issueCertificate, makeAuthority, type Authority, type Issued } from './authority.js';
import { SERVER_KEY } from '../nodes/nodes.js';

/* The row of the machine the app itself runs on is no computer anyone joined: its key says so, and the screens and the
   test pool leave such rows out. */
const serverRow = like(machines.machineKey, `${SERVER_KEY}%`);
const live = isNull(machines.revokedAt);

/* The company's authority with its key opened; null when it has none yet. */
export async function authorityOf(db: Db, config: Config): Promise<Authority | null> {
  const [row] = await db.select().from(authority);
  return row ? { certPem: row.certPem, keyPem: decryptSecret(row.keyEnc, config.secret) } : null;
}

/* Two asks at once make one authority: the second finds the first's row. */
export async function makeAuthorityOnce(db: Db, config: Config, companyId: string): Promise<Authority> {
  const there = await authorityOf(db, config);
  if (there) return there;
  const made = await makeAuthority(companyId);
  await db.insert(authority).values({ certPem: made.certPem, keyEnc: encryptSecret(made.keyPem, config.secret) }).onConflictDoNothing();
  return (await authorityOf(db, config))!;
}

/* The person a row nobody joined belongs to: the owner, who cannot be disabled, else the company's first person. */
async function ownerOf(tx: Db, companyId: string): Promise<string> {
  const [person] = await tx.select(idOnly(people)).from(people).where(eq(people.companyId, companyId)).orderBy(desc(people.isOwner), asc(people.createdAt)).limit(1);
  if (!person) throw new ApiError(409, 'conflict', 'This company has no person yet.');
  return person.id;
}

const noMachineId = () => new ApiError(409, 'conflict', 'This server has no machine id. Run the install command again.', 'no_machine_id');

/* The row of the machine this app runs on, made when it has none. It is a row of its own with the role data, never the
   row of a computer someone joined, so disconnecting that computer or disabling a person never reaches it. A database
   keeps one such live row made here: when this call makes this machine's row, any other, as after a restore onto an
   install with another machine id, is retired with its certificates, so an old identity never counts as another data
   machine. A machine that finds its row retires none: a copy that took the server finds the computer its owner joined,
   and the machine the company was installed on stays a machine of the company. */
export async function thisMachine(db: Db, config: Config, companyId: string): Promise<{ id: string }> {
  const networkId = config.machineId;
  if (!networkId) throw noMachineId();
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT 1 FROM ${companies} WHERE ${companies.id} = ${companyId} FOR UPDATE`);
    const values = { companyId, personId: await ownerOf(tx, companyId), machineKey: `${SERVER_KEY}${networkId}`, networkId, role: 'data' as const };
    const [found] = await tx.select(idOnly(machines)).from(machines).where(and(eq(machines.networkId, networkId), live));
    /* An identity retired earlier that this install comes back to is this machine again. */
    await tx.insert(machines).values(values).onConflictDoUpdate({ target: machines.networkId, set: { revokedAt: null, role: 'data' } });
    const [mine] = await tx.select(idOnly(machines)).from(machines).where(and(eq(machines.networkId, networkId), live));
    if (found) return mine!;
    const older = await tx.update(machines).set({ revokedAt: new Date() }).where(and(serverRow, live, ne(machines.id, mine!.id))).returning({ id: machines.id });
    for (const { id } of older) await tx.update(certificates).set({ revokedAt: new Date() }).where(and(eq(certificates.machineId, id), isNull(certificates.revokedAt)));
    return mine!;
  });
}

/* The same row, when it is there: nothing is made. */
export async function findThisMachine(db: Db, config: Config): Promise<{ id: string; webPort: number | null } | null> {
  if (!config.machineId) return null;
  const [mine] = await db.select({ id: machines.id, webPort: machines.webPort }).from(machines).where(and(eq(machines.networkId, config.machineId), live));
  return mine ?? null;
}

/* A machine of the network by its id: live, and with a role. */
export async function networkMachine(db: Db, id: string): Promise<typeof machines.$inferSelect | null> {
  const [row] = await db.select().from(machines).where(and(eq(machines.id, id), live, isNotNull(machines.role)));
  return row ?? null;
}

/* A new certificate for a machine's key, with its row, so it can be revoked. The caller holds the machine's row locked
   and found it live (lockLiveMachine): Disconnect marks that row first, so it revokes whatever was issued before it. */
export async function certify(tx: Db, by: Authority, holder: { id: string; role: MachineRole; signKey: string }): Promise<Issued> {
  const issued = await issueCertificate(by, { machineId: holder.id, role: holder.role, signKey: holder.signKey }).catch((err: Error) => {
    throw new ApiError(400, 'validation', err.message);
  });
  await tx.insert(certificates).values({ serial: issued.serial, machineId: holder.id, until: issued.until });
  return issued;
}

/* The serials revoked and not yet expired, sorted: what a peer must refuse now. */
export async function revokedSerials(db: Db, now = new Date()): Promise<string[]> {
  const rows = await db.select(only(certificates, 'serial')).from(certificates).where(and(isNotNull(certificates.revokedAt), gt(certificates.until, now))).orderBy(asc(certificates.serial));
  return rows.map(row => row.serial);
}

/* The secret of one of the two services a machine offers its peers through the relay. It is made on first use, and only
   by the app that leads: a missing one outside lead means the services are not offered yet. */
export async function peerSecret(db: Db, config: Config, kind: 'data' | 'app', leading: boolean): Promise<string | null> {
  const read = async () => (await db.select().from(peerSecrets).where(eq(peerSecrets.kind, kind)))[0];
  const there = await read();
  if (there) return decryptSecret(there.secretEnc, config.secret);
  if (!leading) return null;
  await db.insert(peerSecrets).values({ kind, secretEnc: encryptSecret(randomBytes(32).toString('base64url'), config.secret) }).onConflictDoNothing();
  return decryptSecret((await read())!.secretEnc, config.secret);
}
