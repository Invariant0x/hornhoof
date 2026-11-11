import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type { Sql } from './lease-store.js';

export const REPLICA_ROLE = 'hornhoof_replica';
export const PUBLICATION = 'hornhoof';
const SCHEMAS = ['public', 'net', 'net_local', 'drizzle'];
const ITERATIONS = 4096;

type Closable = Sql & { close(): Promise<void> };

/* The password of the role a copy and a merge read another machine's database with: every data machine can tell it
   from the company's secret, and none stores it. */
export function replicaPassword(secret: Buffer): string {
  return createHmac('sha256', secret).update('hornhoof-replica').digest('base64url');
}

/* What Postgres keeps for a password, made here so that the password itself goes into no statement: as RFC 7677 and
   Postgres make it, 'SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>'. */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${ITERATIONS}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/* Whether the role is there and may enter each of the company's schemas this database has. The role belongs to the
   whole server and its rights to one database, so a database made since has none of them. */
export async function replicaReady(sql: Sql): Promise<boolean> {
  const { rows } = await sql.query<{ ready: boolean }>(
    `SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = $1)
       AND NOT EXISTS (SELECT FROM pg_namespace n WHERE n.nspname = ANY($2::text[]) AND NOT has_schema_privilege($1, n.oid, 'USAGE')) AS ready`,
    [REPLICA_ROLE, SCHEMAS],
  );
  return rows[0]?.ready === true;
}

/* One statement that makes the role or sets it right, and lets it read every table of the company's schemas, now and
   later. It reads through row level security, since the tables the app hides keep it with no policy and a copy would
   else get them empty. It writes nothing and makes nothing. */
const replicaStatement = (verifier: string): string => `DO $replica$
DECLARE
  verifier text := '${verifier}';
  owner name := (SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_catalog.pg_database WHERE datname = current_database());
  wanted text;
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${REPLICA_ROLE}') THEN
    EXECUTE format('ALTER ROLE ${REPLICA_ROLE} LOGIN REPLICATION BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', verifier);
  ELSE
    EXECUTE format('CREATE ROLE ${REPLICA_ROLE} LOGIN REPLICATION BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', verifier);
  END IF;
  FOREACH wanted IN ARRAY ARRAY[${SCHEMAS.map(name => `'${name}'`).join(', ')}] LOOP
    IF EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname = wanted) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO ${REPLICA_ROLE}', wanted);
      EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO ${REPLICA_ROLE}', wanted);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT ON TABLES TO ${REPLICA_ROLE}', owner, wanted);
    END IF;
  END LOOP;
END $replica$`;

/* Makes the role with this password and its rights in the database connect leads to, on a connection of its own that is
   closed whatever happens, so no session that stays holds the statement. */
export async function ensureReplica(connect: () => Closable | Promise<Closable>, password: string): Promise<void> {
  const sql = await connect();
  try {
    await sql.query(replicaStatement(scramVerifier(password)));
  } finally {
    await sql.close().catch(() => undefined);
  }
}

/* What a copy subscribes to: every table of the company's two schemas, those made later too. */
export async function ensurePublication(sql: Sql): Promise<void> {
  const { rows } = await sql.query('SELECT 1 FROM pg_publication WHERE pubname = $1', [PUBLICATION]);
  if (rows.length === 0) await sql.query(`CREATE PUBLICATION ${PUBLICATION} FOR TABLES IN SCHEMA public, net`);
}
