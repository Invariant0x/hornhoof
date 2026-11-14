import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Decrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { companies, machines, people } from '../src/db/schema.js';
import { writeKeeperState } from '../src/modules/keeper/state.js';
import { certFacts } from '../src/modules/network/authority.js';
import { setUpCompany, TEST_SECRET, testApp, until } from './helpers.js';

const MACHINE_ID = 'a1b2c3d4'.repeat(4);
const NODE_KEY = 'n'.repeat(44);
const RELAY_URL = 'https://relay.hornhoof.test';
const OWN = { remoteAddress: '127.0.0.1', headers: { 'x-hornhoof-via': 'keeper' } };
/* A peer machine's keeper, as the peer door passes its own requests on: named by its certificate. */
const from = (machine: string) => ({ remoteAddress: '127.0.0.1', headers: { 'x-hornhoof-via': machine, 'x-hornhoof-keeper': '1' } });
/* Anybody who came through that machine's front door. */
const through = (machine: string) => ({ remoteAddress: '127.0.0.1', headers: { 'x-hornhoof-via': machine } });

async function company(env: NodeJS.ProcessEnv = {}) {
  const { app, db, config } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: MACHINE_ID, NODE_KEY, RELAY_URL, ...env });
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const [maria] = await db.insert(people).values({ companyId: acme!.id, name: 'Maria', email: 'maria@acme.test', status: 'active', scopeKind: 'company' }).returning();
  const identity = await generateX25519Identity();
  const row = async (personId: string, role: 'data' | 'worker', more: Partial<typeof machines.$inferInsert> = {}) =>
    (await db.insert(machines).values({ companyId: acme!.id, personId, machineKey: `joined-${Math.random()}`, role, networkId: `${Math.random()}`.slice(2).padEnd(32, '0'), signKey: 'key', ...more }).returning())[0]!;
  const d = await row(maria!.id, 'data', { ageKey: await identityToRecipient(identity) });
  const w = await row(owner!.id, 'worker', { ageKey: await identityToRecipient(await generateX25519Identity()) });
  const secrets = (who: object) => app.inject({ method: 'POST', url: '/api/network/secrets', ...who });
  return { app, db, config, mariaId: maria!.id, d, w, identity, secrets, row };
}

async function opened(sealed: string, identity: string): Promise<unknown> {
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  return JSON.parse(await decrypter.decrypt(Buffer.from(sealed, 'base64'), 'text'));
}

describe("the company's secrets for a machine that becomes a copy", () => {
  it('seals the secrets to a copy alone', async () => {
    const c = await company();
    const res = await c.secrets(from(c.d.id));
    expect(res.statusCode).toBe(200);
    const { sealed } = res.json() as { sealed: string };
    expect(Object.keys(res.json())).toEqual(['sealed']);
    expect(await opened(sealed, c.identity)).toEqual({ HORNHOOF_SECRET: TEST_SECRET, NODE_KEY, RELAY_URL });
    await expect(opened(sealed, await generateX25519Identity())).rejects.toThrow();
    for (const secret of [TEST_SECRET, NODE_KEY]) expect(res.body).not.toContain(secret);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('refuses everyone else', async () => {
    const c = await company();
    const refused = async (who: object, status: number, reason: string | undefined) => {
      const res = await c.secrets(who);
      expect([res.statusCode, res.json().error?.reason]).toEqual([status, reason]);
      for (const secret of [TEST_SECRET, NODE_KEY]) expect(res.body).not.toContain(secret);
      expect(res.body).not.toContain('sealed');
    };
    await refused(from(c.w.id), 403, 'not_data');
    /* The server's own keeper holds them already, and a visitor who came through the copy is not its keeper. */
    await refused(OWN, 403, 'not_data');
    await refused(through(c.d.id), 403, 'not_keeper');
    await refused({ remoteAddress: '127.0.0.1' }, 403, 'not_keeper');
    await refused(from('00000000-0000-4000-8000-000000000000'), 404, 'not_a_machine');
    /* A copy with no key to seal to. */
    const bare = await c.row(c.mariaId, 'data');
    await refused(from(bare.id), 409, 'no_age_key');
    /* Its person no longer sees the whole company, though the row still says data. */
    await c.db.update(people).set({ scopeKind: 'listed' }).where(eq(people.id, c.mariaId));
    await refused(from(c.d.id), 403, 'not_data');
    await c.db.update(people).set({ scopeKind: 'company', status: 'disabled' }).where(eq(people.id, c.mariaId));
    await refused(from(c.d.id), 403, 'not_data');
    await c.db.update(people).set({ status: 'active' }).where(eq(people.id, c.mariaId));
    expect((await c.secrets(from(c.d.id))).statusCode).toBe(200);
    /* The row is a worker's again, or disconnected. */
    await c.db.update(machines).set({ role: 'worker' }).where(eq(machines.id, c.d.id));
    await refused(from(c.d.id), 403, 'not_data');
    await c.db.update(machines).set({ role: 'data', revokedAt: new Date() }).where(eq(machines.id, c.d.id));
    await refused(from(c.d.id), 404, 'not_a_machine');
  });

  it('hands nothing out where the app does not lead', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hh-copies-routes-'));
    onTestFinished(() => rmSync(control, { recursive: true, force: true }));
    writeKeeperState(control, { mode: 'lead', at: new Date().toISOString(), link: null });
    const c = await company({ HORNHOOF_KEEPER: 'on', HORNHOOF_CONTROL_DIR: control });
    await c.app.ready();
    await until(() => c.app.ctx.mode.current() === 'lead');
    expect((await c.secrets(from(c.d.id))).statusCode).toBe(200);
    writeKeeperState(control, { mode: 'read', at: new Date().toISOString(), link: null });
    await c.app.ctx.mode.check();
    const res = await c.secrets(from(c.d.id));
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('sealed');
  });

  it('gives a data certificate only to a row whose person sees the whole company', async () => {
    const c = await company();
    /* The same key on every row: these tests look only at the role the route gives. */
    const signKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await c.db.update(machines).set({ signKey }).where(eq(machines.companyId, c.d.companyId));
    const role = async (machine: string) => {
      const said = (await c.app.inject({ method: 'POST', url: '/api/network/certificate', payload: { signKey }, ...from(machine) })).json() as { role: string; certPem: string };
      return [said.role, certFacts(said.certPem).role];
    };
    expect(await role(c.d.id)).toEqual(['data', 'data']);
    expect(await role(c.w.id)).toEqual(['worker', 'worker']);
    await c.db.update(people).set({ scopeKind: 'listed' }).where(eq(people.id, c.mariaId));
    expect(await role(c.d.id)).toEqual(['worker', 'worker']);
  });
});
