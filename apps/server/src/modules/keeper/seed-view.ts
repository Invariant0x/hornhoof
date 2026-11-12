import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { decryptSecret } from '../../crypto/secrets.js';
import type { MachineRole } from '../../db/schema.js';
import { Server } from '../link/client.js';
import type { DataMachine, WorkerLink, WorkerView } from '../network/join.js';
import { writeReplicaMarker } from './become.js';
import type { Sql } from './lease-store.js';
import { writePrivately } from './machine-keys.js';
import { readHeldCrl } from './peer-link.js';
import { PEERS_FILE } from './worker.js';

const VisitSecret = z.object({ name: z.string(), key: z.string() });

/* The link as a data machine uses it, from what the database keeps of it: none without a link, or while one of its
   three secrets is not stored. A secret that does not open under this machine's secret throws. */
async function linkOf(sql: Sql, secret: Buffer): Promise<WorkerLink | null> {
  const [link] = (await sql.query<{ name: string; url: string; tunnel: string; hidden: boolean }>('SELECT name, url, tunnel_enc AS tunnel, hidden FROM public.public_links LIMIT 1')).rows;
  if (!link) return null;
  const kept = (await sql.query<{ kind: string; secret: string }>('SELECT kind, secret_enc AS secret FROM public.peer_secrets')).rows;
  const opened = new Map(kept.map(row => [row.kind, decryptSecret(row.secret, secret)]));
  const server = Server.safeParse(JSON.parse(decryptSecret(link.tunnel, secret)));
  const visit = VisitSecret.safeParse(JSON.parse(opened.get('visit') ?? 'null'));
  const [appSecret, dataSecret] = [opened.get('app'), opened.get('data')];
  if (!server.success || !visit.success || visit.data.name !== link.name || !appSecret || !dataSecret) return null;
  return { name: link.name, url: link.url, serverAddr: server.data.serverAddr, serverPort: server.data.serverPort, appSecret, visitorKey: visit.data.key, dataSecret, hidden: link.hidden === true };
}

/* The view of the network a machine that led builds for itself as it starts to follow another, from what its own
   database holds and nothing else: no relay is asked and nothing is made. It is the view the server would answer this
   machine's row with: who it is, the authority, the revoked certificates that still count, the other machines that
   hold the data, and the link with the secrets of its services opened. machineId: the id this machine's keeper runs
   under. */
export async function seedView(sql: Sql, machineId: string, secret: Buffer): Promise<WorkerView> {
  const [me] = (await sql.query<{ id: string; role: MachineRole | null }>('SELECT id::text AS id, role FROM public.machines WHERE network_id = $1 AND revoked_at IS NULL', [machineId])).rows;
  if (!me?.role) throw new Error('This machine has no row in its own database.');
  const [authority] = (await sql.query<{ pem: string }>('SELECT cert_pem AS pem FROM public.authority LIMIT 1')).rows;
  const revoked = (await sql.query<{ serial: string }>('SELECT serial FROM public.certificates WHERE revoked_at IS NOT NULL AND until > now() ORDER BY serial')).rows;
  const data = (
    await sql.query<DataMachine>(
      `SELECT id::text AS machine, network_id AS "networkId", NULLIF(hostname, '') AS hostname, addresses, peer_port AS "peerPort", web_port AS "webPort", server_order AS number, copy_name AS "copyName"
         FROM public.machines WHERE revoked_at IS NULL AND role = 'data' AND network_id IS NOT NULL AND network_id <> $1 ORDER BY created_at, id`,
      [machineId],
    )
  ).rows;
  return { machine: me.id, role: me.role, authorityPem: authority?.pem ?? null, revoked: revoked.map(row => row.serial), data, link: await linkOf(sql, secret), build: null, go: null, copy: null };
}

/* The signed list in the view this machine kept while it followed before, as one that took the server and never led
   holds no other; none when there is no such view. */
function listBefore(path: string): string | null {
  try {
    const kept = (JSON.parse(readFileSync(path, 'utf8')) as { crlPem?: unknown }).crlPem;
    return typeof kept === 'string' && kept ? kept : null;
  } catch {
    return null;
  }
}

/* A machine that led follows another from here on: its keeper writes down the network as its own database knew it,
   which the keeper that follows starts from, and the mark of a machine that keeps a copy, which its updater and its
   app read too. The keeper then ends, and starts again as one that follows. */
export async function followFromHere(o: { dir: string; controlDir: string; sql: Sql; machineId: string; secret: Buffer; now?: () => number }): Promise<void> {
  /* With the list of revoked certificates this keeper held while it led: a keeper that follows opens its door to the
     other machines only with a signed list, and gets a new one only from a leader. With none in reach, as when a
     switch was given up or the leader stopped, nobody could ask this machine where it stands. */
  const crlPem = readHeldCrl(o.dir)?.crlPem ?? listBefore(join(o.dir, PEERS_FILE));
  writePrivately(join(o.dir, PEERS_FILE), JSON.stringify({ ...(await seedView(o.sql, o.machineId, o.secret)), ...(crlPem ? { crlPem } : {}) }));
  writeReplicaMarker(o.controlDir, o.now?.() ?? Date.now());
}
