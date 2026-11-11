import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { agents, departments, machines } from '../src/db/schema.js';
import { bundleRow, bundleRows } from '../src/modules/backups/records.js';
import type { HolderView, MakerView } from '../src/modules/backups/types.js';
import { saveLink } from '../src/modules/link/link.js';
import { issueCertificate, makeAuthority } from '../src/modules/network/authority.js';
import { authorityOf } from '../src/modules/network/store.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';
import { ageRecipient, backupCompany as company, from, machineKey, MACHINE_ID, VIA } from './helpers-backups.js';

describe('the backups routes', () => {
  it('seals only to the machines that hold the data, and to the recovery key', async () => {
    const c = await company();
    const worker = await c.worker('mac');
    expect((await c.report({ ageKey: await ageRecipient() }, from(worker))).statusCode).toBe(204);
    const before = await c.view<MakerView>();
    expect(before).toMatchObject({ company: c.acme.id, recipients: [c.ownAge], recovery: null, last: null, holders: {}, wanted: [], order: null });
    await saveLink(c.db, c.config, c.acme.id, { name: 'acme', url: 'https://acme.hornhoof.test', key: 'k'.repeat(32), tunnel: { serverAddr: 'relay.hornhoof.test' } });
    const file = JSON.parse(((await c.recoveryFile()).json() as { text: string }).text.split('\n')[1]!) as { recipient: string };
    expect((await c.view<MakerView>()).recovery).toMatchObject({ recipient: file.recipient, link: { name: 'acme', url: 'https://acme.hornhoof.test' } });
    /* Whoever is no keeper gets none of it. */
    expect((await c.app.inject({ url: '/api/network/backups', ...as(c.ceo) })).statusCode).toBe(403);
    expect((await c.app.inject({ url: '/api/network/backups', remoteAddress: '127.0.0.1', headers: { [VIA]: worker } })).statusCode).toBe(403);
  });

  it("records only its own data machine's bundle", async () => {
    const c = await company();
    const made = await c.head();
    const first = await c.record(made.head);
    expect([first.statusCode, first.json()]).toEqual([201, { holders: [] }]);
    expect(await bundleRow(c.db, made.id)).toMatchObject({ id: made.id, sha256: made.manifest.sha256, size: made.manifest.size, head: made.head, holders: [] });
    expect((await c.record(made.head)).statusCode).toBe(200);
    expect(await bundleRows(c.db)).toHaveLength(1);
    expect((await c.view<MakerView>()).last).toMatchObject({ id: made.id, recovery: null });

    /* A worker records nothing: not by its own word, and not with its own certificate under the server's word. */
    const worker = await c.worker('mac');
    expect((await c.record((await c.head()).head, from(worker))).statusCode).toBe(403);
    const authority = (await authorityOf(c.db, c.config))!;
    const workerKey = machineKey();
    const issued = await issueCertificate(authority, { machineId: worker, role: 'worker', signKey: workerKey.publicPem });
    const byWorker = await c.head({ key: workerKey, held: { machine: worker, role: 'worker', certPem: issued.certPem, authorityPem: authority.certPem, until: issued.until.toISOString() } });
    const refused = await c.record(byWorker.head);
    expect([refused.statusCode, (refused.json() as { error: { reason: string } }).error.reason]).toEqual([400, 'bundle_role']);
    /* Another data machine's certificate of this authority is not this server's. */
    const elseKey = machineKey();
    const elseId = randomUUID();
    const elsewhere = await issueCertificate(authority, { machineId: elseId, role: 'data', signKey: elseKey.publicPem });
    const byOther = await c.head({ key: elseKey, held: { machine: elseId, role: 'data', certPem: elsewhere.certPem, authorityPem: authority.certPem, until: elsewhere.until.toISOString() } });
    expect((await c.record(byOther.head)).statusCode).toBe(403);
    /* Another authority's bundle, and one made two days ago. */
    const strangers = await makeAuthority(c.acme.id);
    const strangerKey = machineKey();
    const strange = await issueCertificate(strangers, { machineId: c.held.machine, role: 'data', signKey: strangerKey.publicPem });
    const byStranger = await c.head({ key: strangerKey, held: { ...c.held, certPem: strange.certPem, authorityPem: strangers.certPem } });
    expect(((await c.record(byStranger.head)).json() as { error: { reason: string } }).error.reason).toBe('bundle_authority');
    const old = await c.head({ now: new Date(Date.now() - 2 * 86_400_000) });
    expect((await c.record(old.head)).statusCode).toBe(400);
    expect(await bundleRows(c.db)).toHaveLength(1);
  });

  it('hands each holder what it holds', async () => {
    const c = await company();
    const [first, second, third] = [await c.worker('one'), await c.worker('two'), await c.worker('three', { keepsBackups: false })];
    /* Without a recovery key a bundle stays on the data machine: nobody could open a copy of it once that is lost. */
    const bare = await c.head();
    expect((await c.record(bare.head)).json()).toEqual({ holders: [] });
    const file = JSON.parse(((await c.recoveryFile()).json() as { text: string }).text.split('\n')[1]!) as { recipient: string };
    const made = await c.head({ recovery: file.recipient });
    const recorded = (await c.record(made.head)).json() as { holders: string[] };
    expect(recorded.holders.sort()).toEqual([first, second].sort());
    expect((await c.view<MakerView>()).holders).toEqual({ [made.id]: recorded.holders });
    for (const holder of [first, second]) expect(await c.view<HolderView>(from(holder))).toEqual({ keeps: true, hold: [{ id: made.id, size: made.manifest.size, sha256: made.manifest.sha256 }], want: [] });
    expect(await c.view<HolderView>(from(third))).toEqual({ keeps: false, hold: [], want: [] });
    await c.db.update(machines).set({ keepsBackups: false }).where(eq(machines.id, first));
    expect((await c.view<HolderView>(from(first))).keeps).toBe(false);
  });

  it('gives the recovery file to the CEO alone, on his own session', async () => {
    const c = await company();
    const zed = await invitePerson(c.app, c.ceo, { name: 'Zed', email: 'zed@acme.com', access: { whole: true } });
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    for (const who of [as(zed), { headers: orchestratorHeaders(c.owner.id, orchestrator!.id) }]) {
      const refused = await c.app.inject({ method: 'POST', url: '/api/backups/recovery', ...who });
      expect([refused.statusCode, (refused.json() as { error: { reason: string } }).error.reason]).toEqual([403, 'not_owner_session']);
    }
    const given = await c.recoveryFile();
    expect(given.statusCode).toBe(200);
    expect(given.headers['cache-control']).toBe('no-store');
    expect((given.json() as { name: string; text: string }).text).toContain('AGE-SECRET-KEY-1');
    /* Before the company has its authority there is nothing a file could be checked against later. */
    const young = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: MACHINE_ID });
    const token = await setUpCompany(young.app);
    const early = await young.app.inject({ method: 'POST', url: '/api/backups/recovery', ...as(token) });
    expect([early.statusCode, (early.json() as { error: { reason: string } }).error.reason]).toEqual([409, 'no_authority']);
  });

  it('lists the bundles with where they are, for the CEO', async () => {
    const c = await company();
    const holder = await c.worker('mac');
    type Listed = { last: string | null; recovery: { madeAt: string; madeBy: string } | null; recoveryNeeded: boolean; linkChanged: boolean; bundles: { id: string; reason: string; size: number; recovery: string; where: { machine: string | null; name: string; online: boolean }[] }[] };
    const list = async () => (await c.app.inject({ url: '/api/backups', ...as(c.ceo) })).json() as Listed;
    expect(await list()).toEqual({ last: null, recovery: null, recoveryNeeded: true, linkChanged: false, restore: null, kept: [], bundles: [] });
    const older = await c.head();
    await c.record(older.head);
    const file = JSON.parse(((await c.recoveryFile()).json() as { text: string }).text.split('\n')[1]!) as { recipient: string };
    const made = await c.head({ recovery: file.recipient });
    await c.record(made.head);
    /* The server's keeper and the holder say what they hold. */
    await c.report({ heldBackups: [made.id, older.id] });
    await c.report({ heldBackups: [made.id] }, from(holder));
    const listed = await list();
    expect(listed).toMatchObject({ last: made.manifest.madeAt, recovery: { madeBy: 'Ivan' }, recoveryNeeded: false, linkChanged: false });
    expect(listed.bundles.map(bundle => [bundle.id, bundle.recovery, bundle.where.map(place => [place.machine, place.name])])).toEqual([
      [made.id, 'current', [[null, 'this server'], [holder, 'mac']]],
      [older.id, 'none', [[null, 'this server']]],
    ]);
    const zed = await invitePerson(c.app, c.ceo, { name: 'Zed', email: 'zed@acme.com', access: { whole: true } });
    expect((await c.app.inject({ url: '/api/backups', ...as(zed) })).statusCode).toBe(403);
  });

  it("stores a machine's age key and what it holds, and takes no other word for either", async () => {
    const c = await company();
    const worker = await c.worker('mac');
    const key = await ageRecipient();
    const ids = Array.from({ length: 16 }, () => randomUUID());
    expect((await c.report({ ageKey: key, heldBackups: ids }, from(worker))).statusCode).toBe(204);
    const [row] = await c.db.select().from(machines).where(eq(machines.id, worker));
    expect(row).toMatchObject({ ageKey: key, heldBackups: ids });
    for (const bad of [{ ageKey: 'age1short' }, { ageKey: `${key}x` }, { heldBackups: [...ids, randomUUID()] }, { heldBackups: ['not an id'] }]) expect((await c.report(bad, from(worker))).statusCode).toBe(400);
  });

  it('ticks backups as it ticks test runs', async () => {
    const c = await company();
    const zed = await invitePerson(c.app, c.ceo, { name: 'Zed', email: 'zed@acme.com', access: { whole: true } });
    const [dev] = await c.db.insert(departments).values({ companyId: c.acme.id, templateKey: 'development', roleCode: 'DEV', position: 0 }).returning();
    const dan = await invitePerson(c.app, c.ceo, { name: 'Dan', email: 'dan@acme.com', access: { departments: [dev!.id], teams: [] } });
    const worker = await c.worker('mac');
    const patch = (payload: object, token: string) => c.app.inject({ method: 'PATCH', url: `/api/machines/${worker}`, payload, ...as(token) });
    expect((await patch({ keepsBackups: false }, c.ceo)).json()).toEqual({ lendsTests: true, keepsBackups: false });
    expect((await patch({ keepsBackups: true }, zed)).json()).toEqual({ lendsTests: true, keepsBackups: true });
    expect((await patch({ lendsTests: false }, c.ceo)).json()).toEqual({ lendsTests: false, keepsBackups: true });
    expect((await patch({ keepsBackups: false }, dan)).statusCode).toBe(403);
    expect((await patch({}, c.ceo)).statusCode).toBe(400);
    expect((await patch({ keepsBackups: false, more: true }, c.ceo)).statusCode).toBe(400);
    type Listed = { machines: { id: string; keepsBackups: boolean | null; heldBackups: number | null }[] };
    await c.report({ heldBackups: [randomUUID(), randomUUID()] }, from(worker));
    const bare = (await c.db.insert(machines).values({ companyId: c.acme.id, personId: c.owner.id, machineKey: 'tower-1', hostname: 'tower' }).returning())[0]!.id;
    const listed = ((await c.app.inject({ url: '/api/machines', ...as(c.ceo) })).json() as Listed).machines;
    expect(listed.find(machine => machine.id === worker)).toMatchObject({ keepsBackups: true, heldBackups: 2 });
    expect(listed.find(machine => machine.id === bare)).toMatchObject({ keepsBackups: null, heldBackups: null });
  });
});
