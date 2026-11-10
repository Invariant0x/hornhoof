import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { machines } from '../src/db/schema.js';
import { CERT_FILE } from '../src/modules/keeper/certificate.js';
import { MachineIdentity, publishedFrom, type IdentityOptions } from '../src/modules/keeper/identity.js';
import { certFacts } from '../src/modules/network/authority.js';
import type { Target } from '../src/net/proxy.js';
import { setUpCompany, testApp, until } from './helpers.js';

const MACHINE_ID = 'a1b2c3d4'.repeat(4);
const NOWHERE: Target = { host: '127.0.0.1', port: 1 };

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-keeper-identity-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* The app a keeper stands beside: it believes the keeper's address, which the test's own requests come from. */
async function appBeside(env: NodeJS.ProcessEnv = {}) {
  const { app, db } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: MACHINE_ID, ...env });
  await setUpCompany(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const target: Target = { host: '127.0.0.1', port: (app.server.address() as AddressInfo).port };
  const serverRow = async () => (await db.select().from(machines).where(eq(machines.networkId, MACHINE_ID)))[0];
  return { app, db, target, serverRow };
}

function identityOn(dir: string, app: Target, more: Partial<IdentityOptions> = {}) {
  const lines: string[] = [];
  const identity = new MachineIdentity({ dir, app, commit: 'c0ffee'.padEnd(40, '0'), published: { web: 8123, peer: 8223 }, leading: () => true, log: line => lines.push(line), reportEveryMs: 20, keyRetryMs: 20, ...more });
  identity.start();
  onTestFinished(() => identity.stop());
  return { identity, lines };
}

describe("the machine's identity in its keeper", () => {
  it("gets the machine's certificate from its app, keeps it, and reports the machine's measures", async () => {
    const { target, serverRow } = await appBeside();
    const dir = folder();
    const { identity } = identityOn(dir, target);
    await until(() => identity.certificate() !== null);
    const held = identity.certificate()!;
    const row = (await serverRow())!;
    expect(held).toMatchObject({ machine: row.id, role: 'data' });
    expect(certFacts(held.certPem)).toMatchObject({ machineId: row.id, role: 'data', signKey: identity.machineKey()!.publicPem });
    expect(JSON.parse(readFileSync(join(dir, CERT_FILE), 'utf8'))).toEqual(held);
    expect(statSync(join(dir, CERT_FILE)).mode & 0o777).toBe(0o600);

    await until(async () => (await serverRow())!.reportAt !== null);
    expect(await serverRow()).toMatchObject({ webPort: 8123, peerPort: 8223, commit: 'c0ffee'.padEnd(40, '0') });
    expect((await serverRow())!.diskFree).toBeGreaterThan(0);
  });

  it('keeps the same key and certificate when the keeper starts again', async () => {
    const { target, db } = await appBeside();
    const dir = folder();
    const first = identityOn(dir, target);
    await until(() => first.identity.certificate() !== null);
    const held = first.identity.certificate()!;
    await first.identity.stop();
    /* The app is not asked again: nothing listens where this keeper would ask. */
    const again = identityOn(dir, NOWHERE, { leading: () => false });
    expect(again.identity.certificate()).toEqual(held);
    expect(again.identity.machineKey()).toEqual(first.identity.machineKey());
    expect(again.lines).toEqual([]);
    expect(await db.select().from(machines).where(eq(machines.networkId, MACHINE_ID))).toHaveLength(1);
  });

  it('reports nothing where the app does not lead', async () => {
    const { target, serverRow } = await appBeside();
    const { identity } = identityOn(folder(), target, { leading: () => false });
    await until(() => identity.certificate() !== null);
    expect((await serverRow())!.reportAt).toBeNull();
  });

  it('says once that its folder cannot be written, tries again, and takes the key once it can', async () => {
    const { target } = await appBeside();
    const parent = folder();
    const dir = join(parent, 'keeper');
    /* A file where the folder should be. */
    writeFileSync(dir, 'not a folder');
    const { identity, lines } = identityOn(dir, target, { leading: () => false });
    expect(identity.machineKey()).toBeNull();
    expect(identity.certificate()).toBeNull();
    await until(() => lines.length > 0);
    rmSync(dir);
    mkdirSync(dir);
    await until(() => identity.certificate() !== null);
    expect(lines.filter(line => line.startsWith("The keeper cannot keep this machine's key"))).toHaveLength(1);
  });

  it('says once that the app cannot be reached for a certificate, and goes on trying', async () => {
    const { identity, lines } = identityOn(folder(), NOWHERE, { leading: () => false });
    await until(() => lines.length > 0);
    expect(identity.certificate()).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Could not get this machine's certificate: /);
  });
});

describe('a keeper that stops while its app does not answer', () => {
  it('gives up what it asked the app at once, without waiting for the answer', async () => {
    /* An app that takes every request and never says a word. */
    const asked: string[] = [];
    const silent = http.createServer(req => void asked.push(`${req.method} ${req.url}`));
    await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve));
    onTestFinished(() => {
      silent.closeAllConnections();
      silent.close();
    });
    const { identity } = identityOn(folder(), { host: '127.0.0.1', port: (silent.address() as AddressInfo).port });
    await until(() => asked.includes('POST /api/network/certificate') && asked.includes('POST /api/network/report'));
    let stopped = false;
    void identity.stop().then(() => (stopped = true));
    await until(() => stopped);
    expect(identity.certificate()).toBeNull();
  });
});

describe('the ports a machine publishes', () => {
  it('are read from what compose gives the keeper, and are none for anything that is no port', () => {
    expect(publishedFrom({ HORNHOOF_PORT: '8081', HORNHOOF_PEER_PORT: '8181' })).toEqual({ web: 8081, peer: 8181 });
    expect(publishedFrom({})).toEqual({ web: null, peer: null });
    expect(publishedFrom({ HORNHOOF_PORT: '', HORNHOOF_PEER_PORT: '70000' })).toEqual({ web: null, peer: null });
    expect(publishedFrom({ HORNHOOF_PORT: '80a', HORNHOOF_PEER_PORT: '0' })).toEqual({ web: null, peer: null });
  });
});
