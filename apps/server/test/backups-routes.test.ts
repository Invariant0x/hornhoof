import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { agents, certificates, departments, machines } from '../src/db/schema.js';
import { bundleRow, bundleRows } from '../src/modules/backups/records.js';
import type { HolderView, MakerView } from '../src/modules/backups/types.js';
import { saveLink } from '../src/modules/link/link.js';
import { issueCertificate, makeAuthority } from '../src/modules/network/authority.js';
import { authorityOf } from '../src/modules/network/store.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';
import { ageRecipient, backupCompany as company, from, machineKey, MACHINE_ID, OWN, VIA } from './helpers-backups.js';

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

  it('records a fork from another data machine through its keeper', async () => {
    const c = await company();
    const authority = (await authorityOf(c.db, c.config))!;
    /* B holds the data and led before: its keeper sealed what its database held, and this server's keeper took it. */
    const b = await c.worker('studio', { role: 'data' });
    const bKey = machineKey();
    const issued = await issueCertificate(authority, { machineId: b, role: 'data', signKey: bKey.publicPem });
    await c.db.insert(certificates).values({ serial: issued.serial, machineId: b, until: issued.until });
    const held = { machine: b, role: 'data' as const, certPem: issued.certPem, authorityPem: authority.certPem, until: issued.until.toISOString() };
    const record = (head: string, more: object, who: object = OWN) => c.app.inject({ method: 'POST', url: '/api/network/backups', payload: { head, ...more }, ...who });
    const fork = await c.head({ key: bKey, held, reason: 'fork' });
    /* Without the keeper's word on whom it took it from, another machine's bundle is not this server's. */
    expect((await c.record(fork.head)).statusCode).toBe(403);
    const first = await record(fork.head, { from: b });
    expect([first.statusCode, await bundleRow(c.db, fork.id)]).toMatchObject([201, { id: fork.id, head: fork.head }]);
    expect((await record(fork.head, { from: b })).statusCode).toBe(200);
    /* Only the server's own keeper passes one on, only a fork, and only one its signer gave. */
    expect((await record((await c.head({ key: bKey, held, reason: 'fork' })).head, { from: b }, from(b))).statusCode).toBe(403);
    const timer = await record((await c.head({ key: bKey, held })).head, { from: b });
    expect([timer.statusCode, (timer.json() as { error: { reason?: string } }).error.reason]).toEqual([400, 'bundle_refused']);
    const other = await c.worker('laptop', { role: 'data' });
    expect((await record((await c.head({ key: bKey, held, reason: 'fork' })).head, { from: other })).statusCode).toBe(403);
    expect((await record((await c.head({ reason: 'fork' })).head, { from: c.held.machine })).statusCode).toBe(403);
    /* From a machine that holds the data no more, or a certificate that was revoked, nothing is recorded. */
    await c.db.update(certificates).set({ revokedAt: new Date() }).where(eq(certificates.serial, issued.serial));
    expect((await record((await c.head({ key: bKey, held, reason: 'fork' })).head, { from: b })).statusCode).toBe(403);
    expect((await bundleRows(c.db)).filter(row => row.reason === 'fork')).toHaveLength(1);
  });

  it("answers the maker's view to the keeper of a machine that holds the data", async () => {
    const c = await company();
    expect((await c.recoveryFile()).statusCode).toBe(200);
    const b = await c.worker('studio', { role: 'data', ageKey: await ageRecipient() });
    const worker = await c.worker('mac');
    const asMaker = (who: object) => c.app.inject({ url: '/api/network/backups?as=maker', ...who });
    const own = await c.view<MakerView>();
    /* Whom to seal to, and nothing of what only the leader's keeper acts on. */
    const said = (await asMaker(from(b))).json() as MakerView;
    expect(said).toEqual({ company: c.acme.id, recipients: own.recipients, recovery: own.recovery, last: null, holders: {}, wanted: [], order: null, fork: null });
    expect(said.recipients.length).toBe(2);
    /* A machine that holds none of the data hears what it holds, as before, whatever it asks for. */
    expect((await asMaker(from(worker))).json()).toHaveProperty('keeps');
    expect((await c.app.inject({ url: '/api/network/backups', ...from(b) })).json()).toHaveProperty('keeps');
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

  it('gives the recovery file to the CEO alone, and to the orchestrator acting for him', async () => {
    const c = await company();
    const zed = await invitePerson(c.app, c.ceo, { name: 'Zed', email: 'zed@acme.com', access: { whole: true } });
    const refused = await c.app.inject({ method: 'POST', url: '/api/backups/recovery', ...as(zed) });
    expect([refused.statusCode, (refused.json() as { error: { reason: string } }).error.reason]).toEqual([403, 'not_owner_session']);
    const given = await c.recoveryFile();
    expect(given.statusCode).toBe(200);
    expect(given.headers['cache-control']).toBe('no-store');
    expect((given.json() as { name: string; text: string }).text).toContain('AGE-SECRET-KEY-1');
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const inside = await c.app.inject({ method: 'POST', url: '/api/backups/recovery', headers: orchestratorHeaders(c.owner.id, orchestrator!.id) });
    expect((inside.json() as { text: string }).text).toContain('AGE-SECRET-KEY-1');
    /* Before the company has its authority there is nothing a file could be checked against later. */
    const young = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: MACHINE_ID });
    const token = await setUpCompany(young.app);
    const early = await young.app.inject({ method: 'POST', url: '/api/backups/recovery', ...as(token) });
    expect([early.statusCode, (early.json() as { error: { reason: string } }).error.reason]).toEqual([409, 'no_authority']);
  });

  it("shows each kept database's merge, and leaves one out when the CEO says so", async () => {
    const c = await company();
    type Kept = { name: string; at: string; merge: { id: string; status: string; added: number; conflicts: number; error: string | null } | null };
    const kept = async () => ((await c.app.inject({ url: '/api/backups', ...as(c.ceo) })).json() as { kept: Kept[] }).kept;
    /* The databases there are, as the server's Postgres names them: none in a test, so the merges are listed by theirs. */
    await c.db.execute(sql`INSERT INTO net.merges (id, source, label, status, counts, error) VALUES
      ('00000000-0000-4000-8000-00000000000a', 'kept:hornhoof_before_20261110_090000', 'a database', 'applied', '{"added": 4, "conflicts": 2}'::jsonb, 'Not complete yet: tasks {"id": "x"}'),
      ('00000000-0000-4000-8000-00000000000b', 'kept:hornhoof_before_20261109_080000', 'an older one', 'done', '{}'::jsonb, NULL)`);
    expect(await kept()).toEqual([
      { name: 'hornhoof_before_20261110_090000', at: '2026-11-10T09:00:00.000Z', merge: { id: '00000000-0000-4000-8000-00000000000a', status: 'applied', added: 4, conflicts: 2, error: 'Not complete yet: tasks {"id": "x"}' } },
    ]);
    const leave = (name: string, who = c.ceo) => c.app.inject({ method: 'POST', url: `/api/backups/kept/${name}/leave`, ...as(who) });
    const zed = await invitePerson(c.app, c.ceo, { name: 'Zed', email: 'zed@acme.com', access: { whole: true } });
    expect((await leave('hornhoof_before_20261110_090000', zed)).statusCode).toBe(403);
    expect((await leave('hornhoof_before_20261110_090000')).statusCode).toBe(204);
    expect((await kept())[0]!.merge).toMatchObject({ status: 'removing' });
    /* Only one that still waits can be left out. */
    const again = await leave('hornhoof_before_20261110_090000');
    expect([again.statusCode, (again.json() as { error: { reason: string } }).error.reason]).toEqual([409, 'not_pending']);
    expect((await leave('hornhoof_before_20261109_080000')).statusCode).toBe(409);
    expect((await leave('hornhoof')).statusCode).toBe(400);
    await c.db.execute(sql`UPDATE net.merges SET status = 'pending' WHERE id = '00000000-0000-4000-8000-00000000000a'`);
    expect((await leave('hornhoof_before_20261110_090000')).statusCode).toBe(204);
  });

  it('asks the keeper for the fork, and takes its record for that database alone', async () => {
    const c = await company();
    const fork = randomUUID();
    await c.db.execute(sql`INSERT INTO net.merges (source, label, status, fork) VALUES ('kept:hornhoof_before_20261110_090000', 'a database', 'merged', ${fork})`);
    expect((await c.view<MakerView>()).fork).toEqual({ id: fork, database: 'hornhoof_before_20261110_090000' });
    /* A bundle that says it is a fork, of nothing the company set aside. */
    const stray = await c.head({ reason: 'fork' });
    const refused = await c.record(stray.head);
    expect([refused.statusCode, (refused.json() as { error: { reason: string } }).error.reason]).toEqual([400, 'bundle_refused']);
    const made = await c.head({ reason: 'fork', id: fork });
    expect((await c.record(made.head)).statusCode).toBe(201);
    expect((await c.view<MakerView>()).fork).toBeNull();
  });

  it('counts no backup made before a restore as the last one of the database as it is now', async () => {
    const c = await company();
    const made = await c.head();
    expect((await c.record(made.head)).statusCode).toBe(201);
    expect((await c.view<MakerView>()).last).toMatchObject({ id: made.id });
    /* The company was restored since: what it holds now is in no backup, whatever records came back with a merge. */
    await c.db.execute(sql`INSERT INTO net.restores (attempt, backup, dumped_at, at) VALUES (gen_random_uuid(), ${made.id}, now(), now() + interval '1 minute')`);
    expect((await c.view<MakerView>()).last).toBeNull();
    /* The CEO is told the same: the company as it is now has no backup yet. */
    expect(((await c.app.inject({ url: '/api/backups', ...as(c.ceo) })).json() as { last: string | null }).last).toBeNull();
    const after = await c.head({ now: new Date(Date.now() + 120_000) });
    expect((await c.record(after.head)).statusCode).toBe(201);
    expect((await c.view<MakerView>()).last).toMatchObject({ id: after.id });
    /* The CEO's list still shows them all. */
    expect(((await c.app.inject({ url: '/api/backups', ...as(c.ceo) })).json() as { bundles: unknown[] }).bundles).toHaveLength(2);
  });

  it('lists forks beyond the newest ten, and never counts one as the last backup', async () => {
    const c = await company();
    const fork = randomUUID();
    await c.db.execute(sql`INSERT INTO net.merges (source, label, status, fork) VALUES ('kept:hornhoof_before_20261110_090000', 'a database', 'merged', ${fork})`);
    type Listed = { last: string | null; bundles: { id: string; reason: string }[] };
    const list = async () => (await c.app.inject({ url: '/api/backups', ...as(c.ceo) })).json() as Listed;
    /* The database in use has no backup yet: one of a database that was set aside is none of it. */
    const set = await c.head({ reason: 'fork', id: fork });
    expect((await c.record(set.head)).statusCode).toBe(201);
    expect((await list()).last).toBeNull();
    expect((await c.view<MakerView>()).last).toBeNull();
    const newer: string[] = [];
    for (let made = 0; made < 12; made += 1) {
      /* Each a moment after the one before, all after the fork. */
      const head = await c.head({ now: new Date(Date.now() + (made + 1) * 1000) });
      expect((await c.record(head.head)).statusCode).toBe(201);
      newer.push(head.id);
    }
    const listed = await list();
    expect(listed.bundles.map(bundle => bundle.id)).toEqual([...[...newer].reverse().slice(0, 10), fork]);
    expect(listed.bundles.at(-1)).toMatchObject({ id: fork, reason: 'fork' });
    expect(listed.last).not.toBeNull();
    expect((await c.view<MakerView>()).last!.id).toBe(newer.at(-1));
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
    /* What the CEO's banner asks, in a few words. */
    expect((await c.app.inject({ url: '/api/backups/recovery', ...as(c.ceo) })).json()).toEqual({ recoveryNeeded: false, linkChanged: false });
    expect((await c.app.inject({ url: '/api/backups/recovery', ...as(zed) })).statusCode).toBe(403);
    /* A hidden name Hornhoof takes by itself for the company's machines is no link: the file the CEO saved still opens
       what is made from now on, and nothing asks for a new one. */
    await saveLink(c.db, c.config, c.acme.id, { name: 'x9k2', url: 'https://x9k2.hornhoof.test', key: 'h'.repeat(32), tunnel: { serverAddr: 'relay.hornhoof.test' } }, true);
    expect((await c.app.inject({ url: '/api/backups/recovery', ...as(c.ceo) })).json()).toEqual({ recoveryNeeded: false, linkChanged: false });
    await saveLink(c.db, c.config, c.acme.id, { name: 'acme', url: 'https://acme.hornhoof.test', key: 'k'.repeat(32), tunnel: { serverAddr: 'relay.hornhoof.test' } });
    expect((await c.app.inject({ url: '/api/backups/recovery', ...as(c.ceo) })).json()).toEqual({ recoveryNeeded: true, linkChanged: true });
  });

  it("stores a machine's age key and what it holds, and takes no other word for either", async () => {
    const c = await company();
    const worker = await c.worker('mac');
    const key = await ageRecipient();
    /* The newest sixteen, and every bundle set aside before a merge beside them: thirty-two at most. */
    const ids = Array.from({ length: 32 }, () => randomUUID());
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
