import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { certificates, companies, departments, invites, machines, peerSecrets, people, personAccess, publicLinks, recoveryKeys } from '../src/db/schema.js';
import { applyCarry } from '../src/modules/backups/restore.js';
import type { Carry } from '../src/modules/backups/types.js';
import { setCopies } from '../src/modules/files/copies.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';

/* What the updater runs on the database a restore replaces, read from where its image takes it. */
const CARRY = readFileSync(new URL('../../updater/carry.sql', import.meta.url), 'utf8');

describe('the carry of a restore', () => {
  it('carries the permanent removal time from the old database', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    await invitePerson(app, ceo, { name: 'Dana', email: 'dana@acme.com', access: { whole: true } });
    const row = (await db.select().from(people).where(eq(people.name, 'Dana')))[0]!;
    const removedAt = new Date('2026-11-10T08:00:00.000Z');
    await db.update(people).set({ status: 'disabled', removedAt }).where(eq(people.id, row.id));

    const result = (await db.execute(sql.raw(CARRY))) as unknown as { rows: Record<string, unknown>[] };
    const carry = Object.values(result.rows[0]!)[0] as Carry;
    expect(carry.people.find(person => person.id === row.id)).toMatchObject({ removedName: 'Dana', removedAt: expect.any(String) });
    expect(new Date(carry.people.find(person => person.id === row.id)!.removedAt!)).toEqual(removedAt);
  });

  it('takes the carry when the old database closes', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const [department] = await db.insert(departments).values({ companyId: acme!.id, name: 'Sales', roleCode: 'SAL' }).returning();
    /* Dana was disabled, Eli reaches one department, and Finn has not taken the invite yet. */
    await invitePerson(app, ceo, { name: 'Dana', email: 'dana@acme.com', access: { whole: true } });
    await invitePerson(app, ceo, { name: 'Eli', email: 'eli@acme.com', access: { whole: true } });
    const open = await app.inject({ method: 'POST', url: '/api/people/invite', payload: { name: 'Finn', email: 'finn@acme.com', title: '', access: { whole: true } }, ...as(ceo) });
    expect(open.statusCode).toBe(201);
    const byName = async (name: string) => (await db.select().from(people).where(eq(people.name, name)))[0]!;
    const [dana, eli, finn] = [await byName('Dana'), await byName('Eli'), await byName('Finn')];
    await db.update(people).set({ status: 'disabled' }).where(eq(people.id, dana.id));
    await db.update(people).set({ isCeoDelegate: true }).where(eq(people.id, eli.id));
    await db.delete(personAccess).where(eq(personAccess.personId, eli.id));
    await db.insert(personAccess).values({ companyId: acme!.id, personId: eli.id, departmentId: department!.id });
    /* An invite that ran out is as closed as one that was used. */
    await db.insert(invites).values({ tokenHash: hashToken('ran out'), companyId: acme!.id, personId: finn.id, createdBy: owner!.id, expiresAt: new Date(Date.now() - 1000) });
    const [live, gone] = await db.insert(machines).values([
      { companyId: acme!.id, personId: owner!.id, machineKey: 'live', networkId: hashToken('live'), role: 'worker', lendsTests: false, computerClosed: true },
      { companyId: acme!.id, personId: owner!.id, machineKey: 'gone', networkId: hashToken('gone'), role: 'worker', revokedAt: new Date(), keepsBackups: false },
    ]).returning();
    const later = new Date(Date.now() + 86_400_000);
    await db.insert(certificates).values([
      { serial: 'aa01', machineId: live!.id, until: later },
      { serial: 'bb02', machineId: gone!.id, until: later, revokedAt: new Date() },
    ]);
    const [retired, active] = await db.insert(recoveryKeys).values([
      { companyId: acme!.id, recipient: 'age1retired', madeBy: owner!.id, retiredAt: new Date() },
      { companyId: acme!.id, recipient: 'age1active', linkPrint: 'ab'.repeat(32), linkName: 'acme', linkUrl: 'https://acme.hornhoof.org', madeBy: owner!.id },
    ]).returning();

    const answered = (await db.execute(sql.raw(CARRY))) as unknown as { rows: Record<string, unknown>[] };
    expect(answered.rows).toHaveLength(1);
    const carry = Object.values(answered.rows[0]!)[0] as Carry;

    const person = (id: string) => carry.people.find(one => one.id === id)!;
    expect(carry.people).toHaveLength(4);
    expect(person(owner!.id)).toMatchObject({ status: 'active', isOwner: true, isCeoDelegate: false, passwordHash: owner!.passwordHash, scopeKind: owner!.scopeKind });
    expect(person(eli.id).isCeoDelegate).toBe(true);
    expect(person(dana.id)).toMatchObject({ status: 'disabled', isOwner: false, passwordHash: dana.passwordHash });
    expect(person(eli.id).access).toEqual([{ departmentId: department!.id, teamId: null }]);
    expect(person(finn.id)).toMatchObject({ status: 'invited', passwordHash: null });
    const [openInvite] = await db.select().from(invites).where(sql`${invites.personId} = ${finn.id} AND ${invites.expiresAt} > now()`);
    expect(carry.invites).toEqual([openInvite!.tokenHash]);
    const machine = (id: string) => carry.machines.find(one => one.id === id);
    expect(machine(live!.id)).toEqual({ id: live!.id, revoked: false, lendsTests: false, keepsBackups: true, computerClosed: true, role: 'worker', dataLeftAt: null, uploadState: null });
    expect(machine(gone!.id)).toEqual({ id: gone!.id, revoked: true, lendsTests: true, keepsBackups: false, computerClosed: false, role: 'worker', dataLeftAt: null, uploadState: null });
    /* A company with no link and no secrets of its peer services says so. */
    expect(carry.link).toBeNull();
    expect(carry.peerSecrets).toEqual([]);
    expect(carry.serials).toEqual(['bb02']);
    expect(carry.revokedSerials).toEqual([{ serial: 'bb02', until: expect.any(String) }]);
    expect(new Date(carry.revokedSerials![0]!.until)).toEqual(later);
    const key = (id: string) => carry.recoveryKeys.find(one => one.id === id)!;
    expect(carry.recoveryKeys).toHaveLength(2);
    expect(key(active!.id)).toMatchObject({ recipient: 'age1active', linkPrint: 'ab'.repeat(32), linkName: 'acme', linkUrl: 'https://acme.hornhoof.org', madeBy: owner!.id, retiredAt: null });
    expect(new Date(key(active!.id).madeAt).getTime()).toBe(active!.madeAt.getTime());
    expect(new Date(key(retired!.id).retiredAt!).getTime()).toBe(retired!.retiredAt!.getTime());
    /* No assistant and no node has a key yet. */
    expect(carry.assistantKeys).toEqual([]);
    expect(carry.nodeKeys).toEqual([]);
  });

  it('takes who holds the data and the link', async () => {
    const { app, db } = await testApp();
    await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const left = new Date('2026-11-10T08:00:00.000Z');
    const [copy, was] = await db.insert(machines).values([
      { companyId: acme!.id, personId: owner!.id, machineKey: 'copy', networkId: hashToken('copy'), role: 'data', serverOrder: 2, copyState: 'ready' },
      { companyId: acme!.id, personId: owner!.id, machineKey: 'was', networkId: hashToken('was'), role: 'worker', dataLeftAt: left, uploadState: 'waiting' },
    ]).returning();
    const made = new Date('2026-11-01T00:00:00.000Z');
    await db.insert(publicLinks).values({ companyId: acme!.id, name: 'acme', url: 'https://acme.hornhoof.org', keyEnc: 'sealed-key', nextKeyEnc: 'sealed-next', tunnelEnc: 'sealed-tunnel', createdAt: made });
    await db.insert(peerSecrets).values([{ kind: 'app', secretEnc: 'sealed-app' }, { kind: 'data', secretEnc: 'sealed-data' }]);
    const answered = (await db.execute(sql.raw(CARRY))) as unknown as { rows: Record<string, unknown>[] };
    const carry = Object.values(answered.rows[0]!)[0] as Carry;
    const machine = (id: string) => carry.machines.find(one => one.id === id)!;
    expect(machine(copy!.id)).toMatchObject({ role: 'data', dataLeftAt: null, uploadState: null });
    expect(machine(was!.id)).toMatchObject({ role: 'worker', uploadState: 'waiting' });
    expect(new Date(machine(was!.id).dataLeftAt!).getTime()).toBe(left.getTime());
    /* The link whole, each secret as it is stored: sealed. */
    expect(carry.link).toMatchObject({ name: 'acme', url: 'https://acme.hornhoof.org', hidden: false, keyEnc: 'sealed-key', nextKeyEnc: 'sealed-next', tunnelEnc: 'sealed-tunnel' });
    expect(new Date(carry.link!.createdAt).getTime()).toBe(made.getTime());
    expect([...carry.peerSecrets!].sort((a, b) => a.kind.localeCompare(b.kind))).toMatchObject([{ kind: 'app', secretEnc: 'sealed-app' }, { kind: 'data', secretEnc: 'sealed-data' }]);
    /* Each secret with when it was made, so the restored row is the one the database from before holds. */
    const stored = await db.select().from(peerSecrets);
    for (const secret of carry.peerSecrets!) expect(new Date(secret.createdAt!).getTime()).toBe(stored.find(row => row.kind === secret.kind)!.createdAt.getTime());
  });

  it("carries the key the company's files are sealed with and the copies the CEO asked for, so a database from before the store opens every file", async () => {
    const { app, db } = await testApp();
    await setUpCompany(app);
    const read = async () => Object.values(((await db.execute(sql.raw(CARRY))) as unknown as { rows: Record<string, unknown>[] }).rows[0]!)[0] as Carry;
    /* Before the first file: no key, and the copies as the default. */
    expect(await read()).toMatchObject({ fileKeyEnc: null, fileCopies: null });

    const kept = await app.ctx.files.putBytes(db, Buffer.from('a file of the company'));
    await setCopies(db, 3, 'person:ceo');
    const carry = await read();
    const keyEnc = ((await db.execute(sql`SELECT key_enc FROM net.file_key`)) as unknown as { rows: { key_enc: string }[] }).rows[0]!.key_enc;
    expect(carry).toMatchObject({ fileKeyEnc: keyEnc, fileCopies: { copies: 3, setBy: 'person:ceo' } });

    /* A backup from before the store comes back: the store's key and setting come back with the carry, and the file opens,
       where a key made anew would open none. */
    await db.execute(sql`DELETE FROM net.file_key`);
    await db.execute(sql`DELETE FROM net.file_settings`);
    await applyCarry(app.ctx, carry);
    expect((await read()).fileCopies).toEqual({ copies: 3, setBy: 'person:ceo' });
    expect(((await db.execute(sql`SELECT key_enc FROM net.file_key`)) as unknown as { rows: { key_enc: string }[] }).rows).toEqual([{ key_enc: keyEnc }]);
    expect((await app.ctx.files.bytes(db, kept.sha256)).toString()).toBe('a file of the company');
  });
});
