import { eq } from 'drizzle-orm';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { encryptSecret } from '../src/crypto/secrets.js';
import { authority, certificates, companies, machines, peerSecrets, people, publicLinks } from '../src/db/schema.js';
import { REPLICA_FILE } from '../src/modules/keeper/become.js';
import { followFromHere, seedView } from '../src/modules/keeper/seed-view.js';
import { PEERS_FILE } from '../src/modules/keeper/worker.js';
import { createTestSql, TEST_SECRET } from './helpers.js';

const SECRET = Buffer.from(TEST_SECRET, 'base64');
const A = 'a0'.repeat(16);
const B = 'b0'.repeat(16);
const TUNNEL = { serverAddr: 'relay.hornhoof.test', serverPort: 443, protocol: 'wss' };

/* The database of A, which led: its own row, the copy B, a worker, a machine that left, the authority, a revoked
   certificate and one that still stands, and the link with the secrets machines reach each other by. */
async function database(over: { visit?: boolean } = {}) {
  const { db, sql } = await createTestSql();
  const [acme] = await db.insert(companies).values({ name: 'Acme' }).returning();
  const [ivan] = await db.insert(people).values({ companyId: acme!.id, name: 'Ivan', email: 'ivan@acme.test', status: 'active', scopeKind: 'company', isOwner: true }).returning();
  const row = async (hostname: string, more: Partial<typeof machines.$inferInsert>) =>
    (await db.insert(machines).values({ companyId: acme!.id, personId: ivan!.id, machineKey: `key-${hostname}`, hostname, ...more }).returning())[0]!;
  const a = await row('rack', { role: 'data', networkId: A, addresses: ['10.0.0.1'], peerPort: 7443, webPort: 8080, serverOrder: 1 });
  const b = await row('studio', { role: 'data', networkId: B, addresses: ['10.0.0.2', '192.168.1.2'], peerPort: 7444, webPort: 8081, serverOrder: 2, copyName: 'copy_b0b0b0b0b0b0b0b0_3' });
  await row('laptop', { role: 'worker', networkId: 'c0'.repeat(16) });
  await row('gone', { role: 'data', networkId: 'd0'.repeat(16), revokedAt: new Date() });
  await db.insert(authority).values({ certPem: 'the authority', keyEnc: encryptSecret('the key', SECRET) });
  const day = 86_400_000;
  await db.insert(certificates).values([
    { serial: 'bb02', machineId: b.id, until: new Date(Date.now() + day), revokedAt: new Date() },
    { serial: 'aa01', machineId: a.id, until: new Date(Date.now() + day), revokedAt: new Date() },
    { serial: 'cc03', machineId: b.id, until: new Date(Date.now() + day) },
    { serial: 'dd04', machineId: b.id, until: new Date(Date.now() - day), revokedAt: new Date() },
  ]);
  await db.insert(publicLinks).values({ companyId: acme!.id, name: 'acme', url: 'https://acme.hornhoof.test', keyEnc: encryptSecret('the link key', SECRET), tunnelEnc: encryptSecret(JSON.stringify(TUNNEL), SECRET) });
  await db.insert(peerSecrets).values([
    { kind: 'app', secretEnc: encryptSecret('app secret', SECRET) },
    { kind: 'data', secretEnc: encryptSecret('data secret', SECRET) },
    ...(over.visit === false ? [] : [{ kind: 'visit' as const, secretEnc: encryptSecret(JSON.stringify({ name: 'acme', key: 'visitor key' }), SECRET) }]),
  ]);
  return { db, sql, a, b };
}

describe('the view a machine that led builds from its own database', () => {
  it('builds the view from the database', async () => {
    const d = await database();
    expect(await seedView(d.sql, A, SECRET)).toEqual({
      machine: d.a.id, role: 'data', authorityPem: 'the authority', revoked: ['aa01', 'bb02'],
      /* The other machines that hold the data, with where their keepers said they are. */
      data: [{ machine: d.b.id, networkId: B, hostname: 'studio', addresses: ['10.0.0.2', '192.168.1.2'], peerPort: 7444, webPort: 8081, number: 2, copyName: 'copy_b0b0b0b0b0b0b0b0_3' }],
      link: { name: 'acme', url: 'https://acme.hornhoof.test', serverAddr: 'relay.hornhoof.test', serverPort: 443, appSecret: 'app secret', visitorKey: 'visitor key', dataSecret: 'data secret', hidden: false },
      build: null, go: null, copy: null,
    });
    /* A hidden name goes to the machines with its secrets, marked as one nobody follows the address of. */
    await d.db.update(publicLinks).set({ hidden: true });
    expect((await seedView(d.sql, A, SECRET)).link).toMatchObject({ name: 'acme', hidden: true, appSecret: 'app secret', dataSecret: 'data secret' });
    /* As B sees it. */
    expect(await seedView(d.sql, B, SECRET)).toMatchObject({ machine: d.b.id, data: [{ machine: d.a.id, networkId: A, hostname: 'rack', number: 1, copyName: null }] });
  });

  it('writes down that this machine follows another from here on', async () => {
    const d = await database();
    const [dir, controlDir] = [mkdtempSync(join(tmpdir(), 'hh-seed-keeper-')), mkdtempSync(join(tmpdir(), 'hh-seed-control-'))];
    onTestFinished(() => void [dir, controlDir].forEach(folder => rmSync(folder, { recursive: true, force: true })));
    await followFromHere({ dir, controlDir, sql: d.sql, machineId: A, secret: SECRET, now: () => Date.parse('2026-11-11T12:00:00Z') });
    /* What the keeper that follows starts from: the network as this database knew it, and the mark of a copy, which
       its updater and its app read too. */
    expect(JSON.parse(readFileSync(join(dir, PEERS_FILE), 'utf8'))).toEqual(await seedView(d.sql, A, SECRET));
    expect(statSync(join(dir, PEERS_FILE)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(controlDir, REPLICA_FILE), 'utf8'))).toEqual({ since: '2026-11-11T12:00:00.000Z' });
    expect(statSync(join(controlDir, REPLICA_FILE)).mode & 0o777).toBe(0o644);
  });

  it('names no link while a secret of it is missing', async () => {
    const d = await database({ visit: false });
    expect((await seedView(d.sql, A, SECRET)).link).toBeNull();
    /* A visitor key of another link is none for this one. */
    await d.db.insert(peerSecrets).values({ kind: 'visit', secretEnc: encryptSecret(JSON.stringify({ name: 'other', key: 'visitor key' }), SECRET) });
    expect((await seedView(d.sql, A, SECRET)).link).toBeNull();
    await d.db.delete(publicLinks);
    expect((await seedView(d.sql, A, SECRET)).link).toBeNull();
  });

  it('gives nothing under another secret, or for a machine that has no row', async () => {
    const d = await database();
    await expect(seedView(d.sql, A, Buffer.alloc(32, 9))).rejects.toThrow();
    await expect(seedView(d.sql, 'e0'.repeat(16), SECRET)).rejects.toThrow('This machine has no row in its own database.');
    await d.db.update(machines).set({ revokedAt: new Date() }).where(eq(machines.id, d.a.id));
    await expect(seedView(d.sql, A, SECRET)).rejects.toThrow('This machine has no row in its own database.');
  });
});
