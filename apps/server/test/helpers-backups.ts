import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as age from 'age-encryption';
import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { companies, machines, people } from '../src/db/schema.js';
import { sealBundle } from '../src/modules/backups/bundle.js';
import type { HeldCertificate } from '../src/modules/keeper/certificate.js';
import type { MachineKey } from '../src/modules/keeper/machine-keys.js';
import { hostIdOf } from '../src/modules/network/join.js';
import type { Deps } from '../src/app.js';
import { as, setUpCompany, testApp } from './helpers.js';

/* What the tests of backups share: a company whose server's keeper took its certificate, and the keeper's own asks. */

export const MACHINE_ID = hostIdOf('server-0001-abcd');
export const VIA = 'x-hornhoof-via';
export const OWN = { remoteAddress: '127.0.0.1', headers: { [VIA]: 'keeper' } };
export const from = (machine: string) => ({ remoteAddress: '127.0.0.1', headers: { [VIA]: machine, 'x-hornhoof-keeper': '1' } });
export const GIB = 1024 ** 3;

export function machineKey(): MachineKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string };
}
export const ageRecipient = async () => age.identityToRecipient(await age.generateX25519Identity());

/* A company whose server's keeper took its certificate, and what it seals bundles with. */
export async function backupCompany(env: NodeJS.ProcessEnv = {}, logger?: Deps['logger']) {
  const { app, db, config } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: MACHINE_ID, ...env }, logger);
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const key = machineKey();
  const taken = (await app.inject({ method: 'POST', url: '/api/network/certificate', payload: { signKey: key.publicPem }, ...OWN })).json() as HeldCertificate;
  const held: HeldCertificate = { machine: taken.machine, role: 'data', certPem: taken.certPem, authorityPem: taken.authorityPem, until: taken.until };
  const ownIdentity = await age.generateX25519Identity();
  const ownAge = await age.identityToRecipient(ownIdentity);
  const report = (payload: object, who: object = OWN) => app.inject({ method: 'POST', url: '/api/network/report', payload, ...who });
  expect((await report({ ageKey: ownAge, addresses: ['127.0.0.1'] })).statusCode).toBe(204);
  const dir = mkdtempSync(join(tmpdir(), 'hh-backups-'));
  /* A bundle's head as the server's keeper makes it; the sealed part stays in the test's folder. */
  const head = async (over: Partial<Parameters<typeof sealBundle>[0]> = {}) => {
    const id = over.id ?? randomUUID();
    const sealed = await sealBundle({
      dump: Readable.from([randomBytes(2048)]), id, company: acme!.id, dumpedAt: new Date(), reason: 'timer', migrations: 106, secrets: { HORNHOOF_SECRET: 's', NODE_KEY: 'n', RELAY_URL: 'r' },
      recipients: [ownAge], recovery: null, recoveryLink: null, key, held, out: join(dir, `${id}-${randomUUID()}.age`), ...over,
    });
    return { id, ...sealed };
  };
  const record = (said: string, who: object = OWN) => app.inject({ method: 'POST', url: '/api/network/backups', payload: { head: said }, ...who });
  const view = async <T>(who: object = OWN) => (await app.inject({ url: '/api/network/backups', ...who })).json() as T;
  let made = 0;
  const worker = async (name: string, over: Partial<typeof machines.$inferInsert> = {}) =>
    (await db.insert(machines).values({ companyId: acme!.id, personId: owner!.id, machineKey: `${name}-${++made}`, hostname: name, role: 'worker', networkId: hostIdOf(`${name}-${made}`), addresses: ['127.0.0.1'], reportAt: new Date(), diskFree: 100 * GIB, ...over }).returning())[0]!.id;
  const recoveryFile = () => app.inject({ method: 'POST', url: '/api/backups/recovery', ...as(ceo) });
  return { app, db, config, ceo, acme: acme!, owner: owner!, key, held, ownIdentity, ownAge, report, head, record, view, worker, recoveryFile };
}
