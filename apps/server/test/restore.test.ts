import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as age from 'age-encryption';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, assistants, certificates, computerRuns, departments, invites, machineAccess, machines, peerSecrets, people, personAccess, publicLinks, recoveryKeys, sessions } from '../src/db/schema.js';
import { activeRecovery } from '../src/modules/backups/recovery.js';
import { applyCarry, knownMigrations, ORDER_MS, RESTORE_CARRY, RESTORE_STATUS, warningOf } from '../src/modules/backups/restore.js';
import type { Carry, HolderView, MakerView, RestoreStatus } from '../src/modules/backups/types.js';
import { writeKeeperState } from '../src/modules/keeper/state.js';
import { CHOICE_FILE } from '../src/modules/merge/kept.js';
import { appOn, as, invitePerson, ownPlan, sessionFrom, setUpCompany, SETUP, testApp } from './helpers.js';
import { backupCompany, from, MACHINE_ID, OWN } from './helpers-backups.js';
import { openTestDb, prepareSharedDatabase } from './helpers-db.js';

/* The embedded database opens as the file is collected, so its cold start is no test's time. */
await prepareSharedDatabase();

const folder = () => mkdtempSync(join(tmpdir(), 'hh-restore-'));
type Refusal = { error: { reason: string; message: string } };

/* A company with its updater there, a bundle its server recorded and holds, and the CEO's restore of a bundle. */
async function stand() {
  const control = folder();
  writeFileSync(join(control, 'alive'), '');
  const c = await backupCompany({ HORNHOOF_CONTROL_DIR: control });
  const made = await c.head();
  await c.record(made.head);
  await c.report({ heldBackups: [made.id] });
  const restore = (id: string, payload: object = {}, who: object = as(c.ceo)) => c.app.inject({ method: 'POST', url: `/api/backups/${id}/restore`, payload, ...who });
  const refusal = async (asked: ReturnType<typeof restore>) => {
    const answer = await asked;
    return [answer.statusCode, (answer.json() as Refusal).error.reason];
  };
  /* What the keeper or the updater says of the restore. */
  const says = (status: Partial<RestoreStatus>) => writeFileSync(join(control, RESTORE_STATUS), JSON.stringify({ id: made.id, state: 'running', step: 'fetch', line: '', at: new Date().toISOString(), kept: null, ...status }));
  /* A bundle recorded and held by this server, restored at once and then ended, so the next can start. */
  const ended = async (attempt: string) => {
    says({ attempt, state: 'failed', step: 'check' });
    expect((await c.view<MakerView>()).order).toBeNull();
  };
  return { ...c, control, made, restore, refusal, says, ended };
}

describe('a restore from a backup', () => {
  it('restores only a bundle its database knows', async () => {
    const s = await stand();
    const asked = await s.restore(s.made.id);
    expect(asked.statusCode).toBe(202);
    const { attempt } = asked.json() as { attempt: string };
    expect(attempt).toMatch(/^[0-9a-f-]{36}$/);
    const view = await s.view<MakerView>();
    expect(view.order).toEqual({
      attempt, id: s.made.id, dumpedAt: s.made.manifest.dumpedAt, source: 'store', identity: null, carry: true, company: s.acme.id, authorityPem: s.held.authorityPem,
      expect: { sha256: s.made.manifest.sha256, size: s.made.manifest.size, signer: s.made.manifest.signer },
    });
    expect(view.wanted).toEqual([]);
    /* One at a time. */
    expect(await s.refusal(s.restore(s.made.id))).toEqual([409, 'restore_busy']);
    await s.ended(attempt);

    expect((await s.restore(randomUUID())).statusCode).toBe(404);
    expect((await s.restore('not-an-id')).statusCode).toBe(400);
    const newer = await s.head({ migrations: knownMigrations() + 1 });
    const unheld = await s.head();
    for (const bundle of [newer, unheld]) await s.record(bundle.head);
    await s.report({ heldBackups: [s.made.id, newer.id] });
    expect(await s.refusal(s.restore(newer.id))).toEqual([409, 'newer_build']);
    expect(await s.refusal(s.restore(unheld.id))).toEqual([409, 'not_held']);
    /* A machine that holds it but has not been heard from is no holder to ask. */
    const silent = await s.worker('silent', { heldBackups: [unheld.id], reportAt: new Date(Date.now() - 3 * 60_000) });
    expect(await s.refusal(s.restore(unheld.id))).toEqual([409, 'not_held']);
    void silent;

    /* Sealed to another key than this server's: only the recovery file it was made for opens it. */
    const file = ((await s.recoveryFile()).json() as { text: string }).text;
    const said = JSON.parse(file.split('\n')[1]!) as { recipient: string; identity: string; company: string };
    const stranger = await age.identityToRecipient(await age.generateX25519Identity());
    const sealedAway = await s.head({ recipients: [stranger], recovery: said.recipient });
    await s.record(sealedAway.head);
    await s.report({ heldBackups: [s.made.id, sealedAway.id] });
    expect(await s.refusal(s.restore(sealedAway.id))).toEqual([409, 'needs_recovery_file']);
    expect(await s.refusal(s.restore(sealedAway.id, { recoveryFile: 'not a file' }))).toEqual([400, 'recovery_file_invalid']);
    /* Another company's file, and a file of this company made for another bundle's key. */
    const elsewhere = file.replace(said.company, randomUUID());
    expect(await s.refusal(s.restore(sealedAway.id, { recoveryFile: elsewhere }))).toEqual([409, 'needs_recovery_file']);
    const later = ((await s.recoveryFile()).json() as { text: string }).text;
    expect(await s.refusal(s.restore(sealedAway.id, { recoveryFile: later }))).toEqual([409, 'needs_recovery_file']);
    /* A refusal leaves the updater free. */
    expect(s.app.ctx.updater.claimed()).toBeNull();
    const withFile = await s.restore(sealedAway.id, { recoveryFile: file });
    expect(withFile.statusCode).toBe(202);
    expect((await s.view<MakerView>()).order).toMatchObject({ id: sealedAway.id, identity: said.identity, carry: true });
    await s.ended((withFile.json() as { attempt: string }).attempt);

    /* Only the CEO, by himself or through the orchestrator. */
    const zed = await invitePerson(s.app, s.ceo, { name: 'Zed', email: 'zed@acme.com', access: { whole: true } });
    expect(await s.refusal(s.restore(s.made.id, {}, as(zed)))).toEqual([403, 'not_owner_session']);
    expect((await s.app.inject({ url: `/api/backups/${s.made.id}/warning`, ...as(zed) })).statusCode).toBe(403);
    expect(s.app.ctx.updater.claimed()).toBeNull();
    const [orchestrator] = await s.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const inside = { headers: orchestratorHeaders(s.owner.id, orchestrator!.id) };
    expect((await s.app.inject({ url: `/api/backups/${s.made.id}/warning`, ...inside })).statusCode).toBe(200);
    const restored = await s.restore(s.made.id, {}, inside);
    expect(restored.statusCode).toBe(202);
    await s.ended((restored.json() as { attempt: string }).attempt);
  });

  it('tries a bundle again, and lets an order go after an hour', async () => {
    const s = await stand();
    const first = ((await s.restore(s.made.id)).json() as { attempt: string }).attempt;
    s.says({ attempt: first, state: 'failed', step: 'open', line: 'Not enough free disk for the restore.' });
    const again = await s.restore(s.made.id);
    expect(again.statusCode).toBe(202);
    const second = (again.json() as { attempt: string }).attempt;
    expect(second).not.toBe(first);
    expect((await s.view<MakerView>()).order).toMatchObject({ attempt: second, id: s.made.id });
    /* The order is out before its keeper wrote a word: it runs, whatever the attempt before left. */
    const listed = (await s.app.inject({ url: '/api/backups', ...as(s.ceo) })).json() as { restore: RestoreStatus | null; bundles: { id: string; restorable: boolean; why: string | null }[] };
    expect(listed.restore).toMatchObject({ attempt: second, id: s.made.id, state: 'running', step: 'fetch', kept: null });
    expect(listed.bundles.find(bundle => bundle.id === s.made.id)).toMatchObject({ restorable: true, why: null });
    const shown = async () => ((await s.app.inject({ url: '/api/backups', ...as(s.ceo) })).json() as { restore: RestoreStatus }).restore;
    s.says({ attempt: second, state: 'running', step: 'open' });
    expect(await shown()).toMatchObject({ attempt: second, state: 'running', step: 'open' });
    /* After its hour the order is gone, and the updater free. */
    const realNow = Date.now;
    Date.now = () => realNow() + ORDER_MS;
    try {
      expect((await s.view<MakerView>()).order).toBeNull();
    } finally {
      Date.now = realNow;
    }
    expect(s.app.ctx.updater.claimed()).toBeNull();
    /* A status at a step of the keeper's counts as running only while its order is out. */
    expect(await shown()).toMatchObject({ attempt: second, state: 'failed', line: 'The restore was called off.' });
  });

  it('asks the holder for a bundle the leader lacks', async () => {
    const s = await stand();
    const away = await s.head();
    await s.record(away.head);
    const [holder, other] = [await s.worker('mac'), await s.worker('mini')];
    await s.report({ heldBackups: [away.id] }, from(holder));
    expect((await s.restore(away.id)).statusCode).toBe(202);
    expect((await s.view<MakerView>()).wanted).toEqual([{ id: away.id, from: holder }]);
    expect((await s.view<HolderView>(from(holder))).want).toEqual([away.id]);
    expect((await s.view<HolderView>(from(other))).want).toEqual([]);
    /* Once the server's own keeper holds it, nobody is asked any more. */
    await s.report({ heldBackups: [s.made.id, away.id] });
    expect((await s.view<MakerView>()).wanted).toEqual([]);
    expect((await s.view<HolderView>(from(holder))).want).toEqual([]);
  });

  it('hands the recovery identity to its keeper without logging it', async () => {
    const control = folder();
    writeFileSync(join(control, 'alive'), '');
    const lines: string[] = [];
    const c = await backupCompany({ HORNHOOF_CONTROL_DIR: control }, { level: 'trace', stream: { write: (line: string) => void lines.push(line) } });
    const file = ((await c.recoveryFile()).json() as { text: string }).text;
    const said = JSON.parse(file.split('\n')[1]!) as { recipient: string; identity: string };
    const stranger = await age.identityToRecipient(await age.generateX25519Identity());
    const made = await c.head({ recipients: [stranger], recovery: said.recipient });
    await c.record(made.head);
    await c.report({ heldBackups: [made.id] });
    lines.length = 0;
    expect((await c.app.inject({ method: 'POST', url: `/api/backups/${made.id}/restore`, payload: { recoveryFile: file }, ...as(c.ceo) })).statusCode).toBe(202);
    /* It crosses to the server's own keeper, and to nobody else. */
    expect((await c.view<MakerView>()).order?.identity).toBe(said.identity);
    const worker = await c.worker('mac');
    expect(JSON.stringify(await c.view<HolderView>(from(worker)))).not.toContain('AGE-SECRET-KEY');
    expect(JSON.stringify((await c.app.inject({ url: '/api/backups', ...as(c.ceo) })).json())).not.toContain('AGE-SECRET-KEY');
    /* A refused file is not logged either. */
    await c.app.inject({ method: 'POST', url: `/api/backups/${made.id}/restore`, payload: { recoveryFile: file.replace(said.recipient, stranger) }, ...as(c.ceo) });
    const stretches = Array.from({ length: said.identity.length - 20 }, (_, at) => said.identity.slice(at, at + 20));
    /* The log is read: a line of the app's own is in it, and no stretch of the identity. */
    c.app.log.info('a line of the app');
    expect(lines.some(line => line.includes('a line of the app'))).toBe(true);
    expect(lines.filter(line => stretches.some(stretch => line.includes(stretch)))).toEqual([]);
  });

  it('keeps who may get in now', async () => {
    const s = await stand();
    const { db } = s;
    const [dana, eli, finn] = await Promise.all(['Dana', 'Eli', 'Finn'].map(async name => {
      const token = await invitePerson(s.app, s.ceo, { name, email: `${name.toLowerCase()}@acme.com`, access: { whole: true } });
      return { token, row: (await db.select().from(people).where(eq(people.name, name)))[0]! };
    }));
    const [sales] = await db.insert(departments).values({ companyId: s.acme.id, name: 'Sales', roleCode: 'SAL' }).returning();
    await db.insert(personAccess).values({ companyId: s.acme.id, personId: finn!.row.id, departmentId: sales!.id });
    await db.update(people).set({ scopeKind: 'listed' }).where(eq(people.id, finn!.row.id));
    /* An invite open here that was used or called off since the backup, and one that is open still. */
    const [gone, open] = [hashToken('gone'), hashToken('open')];
    const soon = new Date(Date.now() + 86_400_000);
    await db.insert(invites).values([gone, open].map(tokenHash => ({ tokenHash, companyId: s.acme.id, personId: finn!.row.id, createdBy: s.owner.id, expiresAt: soon })));
    const [danas, kept] = [await s.worker('danas', { personId: dana!.row.id }), await s.worker('kept')];
    const revoked = await s.worker('revoked');
    await db.insert(certificates).values([{ serial: 'aa01', machineId: revoked, until: soon }, { serial: 'bb02', machineId: kept, until: soon }]);
    await db.insert(machineAccess).values({ machineId: kept, companyId: s.acme.id, scope: 'all_agents' });
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    void orchestrator;
    /* The recovery keys: this database's active one was retired since, and another made. */
    const here = JSON.parse(((await s.recoveryFile()).json() as { text: string }).text.split('\n')[1]!) as { recipient: string };
    const [hereRow] = await db.select().from(recoveryKeys).where(eq(recoveryKeys.recipient, here.recipient));
    const newer = { id: randomUUID(), recipient: `age1${'q'.repeat(58)}`, linkPrint: null, linkName: null, linkUrl: null, madeBy: s.owner.id, madeAt: new Date().toISOString(), retiredAt: null };

    /* Eli was the CEO's delegate when the bundle was made, and the CEO took the mark off since. */
    await db.update(people).set({ isCeoDelegate: true }).where(eq(people.id, eli!.row.id));
    const asCarried = (person: typeof people.$inferSelect, over: Partial<Carry['people'][number]> = {}): Carry['people'][number] =>
      ({ id: person.id, status: person.status, passwordHash: person.passwordHash, scopeKind: person.scopeKind, isOwner: person.isOwner, isCeoDelegate: person.isCeoDelegate, access: [], ...over });
    const carry: Carry = {
      people: [
        asCarried((await db.select().from(people).where(eq(people.id, s.owner.id)))[0]!),
        asCarried(dana!.row, { status: 'disabled' }),
        asCarried(eli!.row, { passwordHash: 'a-new-hash', scopeKind: 'listed', isCeoDelegate: false, access: [{ departmentId: sales!.id, teamId: null }, { departmentId: randomUUID(), teamId: null }] }),
        asCarried(finn!.row, { scopeKind: 'listed', access: [] }),
        asCarried({ ...finn!.row, id: randomUUID() }),
      ],
      invites: [open, hashToken('made since')],
      machines: [
        { id: revoked, revoked: true, lendsTests: true, keepsBackups: true },
        { id: kept, revoked: false, lendsTests: false, keepsBackups: false, computerClosed: true },
        { id: randomUUID(), revoked: true, lendsTests: true, keepsBackups: true },
      ],
      serials: ['aa01', 'never-here'],
      recoveryKeys: [
        { id: hereRow!.id, recipient: hereRow!.recipient, linkPrint: hereRow!.linkPrint, linkName: null, linkUrl: null, madeBy: s.owner.id, madeAt: hereRow!.madeAt.toISOString(), retiredAt: new Date().toISOString() },
        newer,
      ],
    };
    await applyCarry(s.app.ctx, carry);

    const person = async (id: string) => (await db.select().from(people).where(eq(people.id, id)))[0]!;
    /* Dana was disabled since: her account, her sessions and her machine went as when the CEO disables someone. */
    expect((await person(dana!.row.id)).status).toBe('disabled');
    expect((await db.select().from(machines).where(eq(machines.id, danas)))[0]!.revokedAt).not.toBeNull();
    /* Eli's password and reach are as they were when the old database closed, as far as this one has the places. */
    expect(await person(eli!.row.id)).toMatchObject({ passwordHash: 'a-new-hash', scopeKind: 'listed', status: 'active', isCeoDelegate: false });
    expect((await db.select().from(personAccess).where(eq(personAccess.personId, eli!.row.id))).map(row => row.departmentId)).toEqual([sales!.id]);
    expect(await db.select().from(personAccess).where(eq(personAccess.personId, finn!.row.id))).toEqual([]);
    expect((await person(s.owner.id)).isOwner).toBe(true);
    expect((await db.select({ hash: invites.tokenHash }).from(invites).where(isNull(invites.usedAt))).map(row => row.hash)).toEqual([open]);
    const machine = async (id: string) => (await db.select().from(machines).where(eq(machines.id, id)))[0]!;
    expect((await machine(revoked)).revokedAt).not.toBeNull();
    expect(await machine(kept)).toMatchObject({ revokedAt: null, lendsTests: false, keepsBackups: false, computerClosed: true });
    const serials = await db.select().from(certificates);
    expect(serials.filter(row => row.revokedAt !== null).map(row => row.serial).sort()).toContain('aa01');
    expect(serials.find(row => row.serial === 'bb02')!.revokedAt).toBeNull();
    /* The key that was active when the old database closed is the company's recovery key. */
    expect((await activeRecovery(db, s.config))?.recipient).toBe(newer.recipient);
    expect((await db.select().from(recoveryKeys).where(and(eq(recoveryKeys.id, hereRow!.id)))).map(row => row.retiredAt !== null)).toEqual([true]);
    /* The owner keeps their switch, employee grants end, and everyone signs in again. */
    expect(await db.select().from(machineAccess).where(eq(machineAccess.machineId, kept))).toEqual([]);
    expect(await db.select().from(sessions)).toEqual([]);
    expect((await s.app.inject({ url: '/api/people', ...as(s.ceo) })).statusCode).toBe(401);
    /* Twice is as once. */
    await applyCarry(s.app.ctx, carry);
    expect((await activeRecovery(db, s.config))?.recipient).toBe(newer.recipient);
  });

  it('keeps a permanent removal and applies it to assistants present only in the backup', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const dana = await invitePerson(app, ceo, { name: 'Dana', email: 'dana@acme.com', access: { whole: true } });
    const row = (await db.select().from(people).where(eq(people.name, 'Dana')))[0]!;
    await db.update(people).set({ telegramUsername: 'dana', telegramUserId: 1234 }).where(eq(people.id, row.id));
    const added = await app.inject({ method: 'POST', url: '/api/people/assistants', payload: { name: 'Ava', owner: row.id, program: 'avaclone' }, ...as(ceo) });
    expect(added.statusCode).toBe(201);
    const helper = added.json().person.id as string;
    const plan = await ownPlan(db, row.email!);
    expect((await app.inject({ method: 'PATCH', url: `/api/people/${helper}/assistant`, payload: { plan }, ...as(dana) })).statusCode).toBe(200);
    const [assistant] = await db.select().from(assistants).where(eq(assistants.personId, helper));
    const key = await app.inject({ method: 'POST', url: `/api/people/${helper}/key`, ...as(ceo) });
    expect(key.statusCode).toBe(201);
    const removedAt = '2026-11-10T08:00:00.000Z';
    const older = { id: row.id, status: row.status, passwordHash: row.passwordHash, scopeKind: row.scopeKind, isOwner: false, isCeoDelegate: false, access: [] };
    const person = { ...older, status: 'disabled' as const, removedAt };
    const carry: Carry = { people: [person], invites: [], machines: [], serials: [], recoveryKeys: [] };

    await applyCarry(app.ctx, carry);
    await applyCarry(app.ctx, carry);
    await applyCarry(app.ctx, { ...carry, people: [older] });
    const stored = async (id: string) => (await db.select().from(people).where(eq(people.id, id)))[0]!;
    expect(await stored(row.id)).toMatchObject({ name: 'Dana', status: 'disabled', removedAt: new Date(removedAt), email: null, passwordHash: null, telegramUsername: null, telegramUserId: null });
    expect(await stored(helper)).toMatchObject({ name: 'Ava', status: 'disabled', removedAt: new Date(removedAt) });
    expect((await db.select().from(agents).where(eq(agents.id, assistant!.agentId!)))[0]).toMatchObject({ removedAt: expect.any(Date), subscriptionId: null });
    expect((await db.select().from(assistants).where(eq(assistants.personId, helper)))[0]).toMatchObject({ keyHash: null, wakeSecretEnc: null });
  });

  it('keeps a removal when the restored backup is older than the person', async () => {
    const { app, db } = await testApp();
    await setUpCompany(app);
    const id = randomUUID();
    const removedAt = '2026-11-10T08:00:00.000Z';
    const carry: Carry = {
      people: [{ id, status: 'disabled', passwordHash: null, scopeKind: 'listed', isOwner: false, isCeoDelegate: false, access: [], removedAt, removedName: 'Dana' }],
      invites: [], machines: [], serials: [], recoveryKeys: [],
    };
    await applyCarry(app.ctx, carry);
    expect(await db.select().from(people).where(eq(people.id, id))).toMatchObject([{ id, name: 'Dana', removedAt: new Date(removedAt), status: 'disabled', email: null }]);
  });

  it('keeps who holds the data and the link', async () => {
    const s = await stand();
    const { db } = s;
    /* As the bundle has them: a machine that held the data then, a link key from then, and the secrets of then. */
    const copy = await s.worker('mac');
    const stays = await s.worker('laptop');
    await db.update(machines).set({ role: 'data', serverOrder: 2 }).where(eq(machines.id, copy));
    await db.insert(publicLinks).values({ companyId: s.acme.id, name: 'acme', url: 'https://acme.hornhoof.org', keyEnc: 'older-key', tunnelEnc: 'older-tunnel' });
    await db.delete(peerSecrets);
    await db.insert(peerSecrets).values([{ kind: 'app', secretEnc: 'older-app' }, { kind: 'data', secretEnc: 'older-data' }]);
    const left = '2026-11-10T08:00:00.000Z';
    /* Times as the database gives them, to the microsecond: the restored rows keep them whole, so they are the rows
       the database from before holds and nothing differs when that one is merged. */
    const made = '2026-11-01T00:00:00.123456+00:00';
    const sealed = '2026-11-02T00:00:00.654321+00:00';
    const carry: Carry = {
      people: [], invites: [], serials: [], recoveryKeys: [],
      machines: [
        { id: copy, revoked: false, lendsTests: true, keepsBackups: true, role: 'worker', dataLeftAt: left, uploadState: 'waiting' },
        { id: stays, revoked: false, lendsTests: true, keepsBackups: true, role: 'data', dataLeftAt: null, uploadState: null },
      ],
      link: { name: 'acme', url: 'https://acme.hornhoof.org', keyEnc: 'newer-key', nextKeyEnc: 'newer-next', tunnelEnc: 'newer-tunnel', createdAt: made },
      /* The carry of a build before named no time for a secret: that one counts from the restore. */
      peerSecrets: [{ kind: 'app', secretEnc: 'newer-app', createdAt: sealed }, { kind: 'data', secretEnc: 'newer-data', createdAt: sealed }, { kind: 'visit', secretEnc: 'newer-visit' }],
    };
    const before = new Date();
    await applyCarry(s.app.ctx, carry);
    const machine = async (id: string) => (await db.select().from(machines).where(eq(machines.id, id)))[0]!;
    /* The machine that stopped holding the data since does not hold it again, and still owes its upload. */
    expect(await machine(copy)).toMatchObject({ role: 'worker', dataLeftAt: new Date(left), uploadState: 'waiting', serverOrder: null });
    expect(await machine(stays)).toMatchObject({ role: 'data', dataLeftAt: null, uploadState: null });
    /* The link's key is the one the relay takes now, with a change that was under way, and the secrets are today's. */
    expect(await db.select().from(publicLinks)).toMatchObject([{ name: 'acme', keyEnc: 'newer-key', nextKeyEnc: 'newer-next', tunnelEnc: 'newer-tunnel', createdAt: new Date(made) }]);
    expect((await db.select().from(peerSecrets)).map(row => `${row.kind}=${row.secretEnc}`).sort()).toEqual(['app=newer-app', 'data=newer-data', 'visit=newer-visit']);
    const times = async (query: string) => ((await db.execute(sql.raw(query))) as unknown as { rows: { at: string }[] }).rows.map(row => row.at);
    expect(await times(`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS at FROM public_links`)).toEqual(['2026-11-01T00:00:00.123456']);
    expect(await times(`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS at FROM peer_secrets WHERE kind <> 'visit' ORDER BY kind`)).toEqual(['2026-11-02T00:00:00.654321', '2026-11-02T00:00:00.654321']);
    expect((await db.select().from(peerSecrets).where(eq(peerSecrets.kind, 'visit')))[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    /* A hidden name stays hidden across a restore, and a public link stays public over a hidden row. */
    await applyCarry(s.app.ctx, { ...carry, link: { ...carry.link!, name: 'x9', hidden: true } });
    expect(await db.select().from(publicLinks)).toMatchObject([{ name: 'x9', hidden: true, keyEnc: 'newer-key' }]);
    await applyCarry(s.app.ctx, carry);
    expect(await db.select().from(publicLinks)).toMatchObject([{ name: 'acme', hidden: false }]);
    /* A company that has no link now gets none back with an older bundle. */
    await applyCarry(s.app.ctx, { ...carry, link: null, peerSecrets: [] });
    expect(await db.select().from(publicLinks)).toEqual([]);
    expect(await db.select().from(peerSecrets)).toEqual([]);
    /* A carry of an updater from before knows none of this, and leaves it all as the bundle has it. */
    await db.insert(publicLinks).values({ companyId: s.acme.id, name: 'acme', url: 'https://acme.hornhoof.org', keyEnc: 'older-key', tunnelEnc: 'older-tunnel' });
    await applyCarry(s.app.ctx, { people: [], invites: [], serials: [], recoveryKeys: [], machines: [{ id: stays, revoked: false, lendsTests: true, keepsBackups: true }] });
    expect(await db.select().from(publicLinks)).toMatchObject([{ keyEnc: 'older-key' }]);
    expect(await machine(stays)).toMatchObject({ role: 'data' });
  });

  it('marks a command that was on its way as lost', async () => {
    const s = await stand();
    const machine = await s.worker('mac');
    const [orchestrator] = await s.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const run = { companyId: s.acme.id, machineId: machine, agentId: orchestrator!.id, command: 'true', timeoutS: 10 };
    const made = await s.db.insert(computerRuns).values([{ ...run, state: 'waiting' }, { ...run, state: 'sent' }, { ...run, state: 'done', exit: 0, output: '' }] as (typeof computerRuns.$inferInsert)[]).returning();
    await applyCarry(s.app.ctx, { people: [], invites: [], machines: [], serials: [], recoveryKeys: [] });
    const states = await s.db.select({ id: computerRuns.id, state: computerRuns.state }).from(computerRuns);
    expect(made.map(row => states.find(state => state.id === row.id)!.state)).toEqual(['lost', 'lost', 'done']);
  });

  it('applies the carry only after a committed swap', async () => {
    /* One company for every case, as a second one in this test would open a whole database of its own: each case brings
       its own machine and certificate, the updater's word on its own swap, or none, and its own carry. */
    const s = await stand();
    const attempt = randomUUID();
    const cases: [Partial<RestoreStatus> | null, string, boolean][] = [
      [{ attempt, state: 'running', step: 'start' }, attempt, true],
      [{ attempt, state: 'done', step: 'start' }, attempt, true],
      [{ attempt, state: 'failed', step: 'start' }, attempt, false],
      [{ attempt, state: 'running', step: 'swap' }, attempt, false],
      [{ attempt: randomUUID(), state: 'done', step: 'start' }, attempt, false],
      [null, attempt, false],
    ];
    for (const [n, [status, carried, applies]] of cases.entries()) {
      const serial = `aa0${n}`;
      const carry: Carry = { people: [], invites: [], machines: [], serials: [serial], recoveryKeys: [] };
      const machine = await s.worker('mac');
      await s.db.insert(certificates).values({ serial, machineId: machine, until: new Date(Date.now() + 86_400_000) });
      rmSync(join(s.control, RESTORE_STATUS), { force: true });
      if (status) s.says(status);
      writeFileSync(join(s.control, RESTORE_CARRY), JSON.stringify({ attempt: carried, carry }));
      await s.app.ctx.restores.afterSwap();
      const [held] = await s.db.select().from(certificates).where(eq(certificates.serial, serial));
      expect([held!.revokedAt !== null, existsSync(join(s.control, RESTORE_CARRY))], JSON.stringify(status)).toEqual([applies, false]);
    }
  });

  it('restores a fork after newer bundles', async () => {
    const s = await stand();
    const fork = randomUUID();
    await s.db.execute(sql`INSERT INTO net.merges (source, label, status, fork) VALUES ('kept:hornhoof_before_20261110_090000', 'a database', 'merged', ${fork})`);
    const set = await s.head({ reason: 'fork', id: fork });
    expect((await s.record(set.head)).statusCode).toBe(201);
    const newer: string[] = [];
    for (let made = 0; made < 17; made += 1) {
      const head = await s.head({ now: new Date(Date.now() + (made + 1) * 1000) });
      expect((await s.record(head.head)).statusCode).toBe(201);
      newer.push(head.id);
    }
    /* The server's keeper says it holds the newest sixteen and the fork beside them. */
    expect((await s.report({ heldBackups: [...[...newer].reverse().slice(0, 16), fork] })).statusCode).toBe(204);
    const answer = await s.restore(fork);
    expect(answer.statusCode).toBe(202);
    expect((await s.view<MakerView>()).order).toMatchObject({ id: fork, source: 'store', expect: { sha256: set.manifest.sha256, size: set.manifest.size } });
  });

  it("remembers the CEO's choice across the swap", async () => {
    const s = await stand();
    const file = join(s.control, CHOICE_FILE);
    /* Unless the CEO says otherwise, what came after comes back. */
    const first = ((await s.restore(s.made.id)).json() as { attempt: string }).attempt;
    expect([JSON.parse(readFileSync(file, 'utf8')), statSync(file).mode & 0o777]).toEqual([{ attempt: first, bringBack: true }, 0o600]);
    await s.ended(first);
    const second = ((await s.restore(s.made.id, { bringBack: false })).json() as { attempt: string }).attempt;
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ attempt: second, bringBack: false });
    expect((await s.restore(s.made.id, { bringBack: 'no' })).statusCode).toBe(400);
  });

  it('marks every restore', async () => {
    /* One company for every case, as a second one in this test would open a whole database of its own: each case is a
       restore of an attempt of its own, and the marks of that attempt are its own. */
    const s = await stand();
    const marks = (attempt?: string) => s.db.execute(sql`SELECT attempt, backup, dumped_at, kept FROM net.restores ORDER BY at`).then(answer => (answer as unknown as { rows: { attempt: string; backup: string; dumped_at: string; kept: string | null }[] }).rows.filter(row => attempt === undefined || row.attempt === attempt));
    const marked: string[] = [];
    const dumpedAt = '2026-11-10T08:00:00.000Z';
    /* With something carried over, and with nothing, as after a restore from a recovery file. */
    for (const carried of [true, false]) {
      const attempt = randomUUID();
      s.says({ attempt, state: 'running', step: 'start', dumpedAt });
      if (carried) writeFileSync(join(s.control, RESTORE_CARRY), JSON.stringify({ attempt, carry: { people: [], invites: [], machines: [], serials: [], recoveryKeys: [] } }));
      await s.app.ctx.restores.afterSwap();
      const [mark] = await marks(attempt);
      expect([mark!.attempt, mark!.backup, new Date(mark!.dumped_at).toISOString(), mark!.kept], String(carried)).toEqual([attempt, s.made.id, dumpedAt, null]);
      /* Once per attempt, however often the app starts. */
      await s.app.ctx.restores.afterSwap();
      expect(await marks(attempt)).toHaveLength(1);
      marked.push(attempt);
    }
    /* A restore that failed, or did not swap the databases yet, left nothing to mark. */
    for (const status of [{ state: 'failed', step: 'start', dumpedAt }, { state: 'running', step: 'swap', dumpedAt }] as const) {
      const attempt = randomUUID();
      s.says({ attempt, ...status });
      await s.app.ctx.restores.afterSwap();
      expect(await marks(attempt), JSON.stringify(status)).toEqual([]);
    }
    /* An updater from before merges says no time of the dump: its restore is marked all the same, with the time of its
       word, so what waited to go outside when it ran is still told from what was written since. */
    const attempt = randomUUID();
    s.says({ attempt, state: 'done', step: 'start' });
    await s.app.ctx.restores.afterSwap();
    const [mark] = await marks(attempt);
    expect(mark).toMatchObject({ attempt, backup: s.made.id, kept: null });
    expect(Number.isNaN(new Date(mark!.dumped_at).getTime())).toBe(false);
    /* And no case marked anything but its own restore. */
    expect((await marks()).map(row => row.attempt)).toEqual([...marked, attempt]);
  });

  it('serves nobody on a restored database before the carry is applied', async () => {
    /* A carry that cannot be read yet, as the app first leads. */
    const control = folder();
    mkdirSync(join(control, RESTORE_CARRY));
    const { app } = await testApp({ HORNHOOF_CONTROL_DIR: control });
    expect(app.ctx.restores.ready()).toBe(false);
    for (const url of ['/api/people', '/api/setup', '/api/network/backups', '/api/version']) {
      const refused = await app.inject({ url, ...OWN });
      expect([url, refused.statusCode, (refused.json() as Refusal).error.reason]).toEqual([url, 503, 'starting']);
    }
    expect((await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP })).statusCode).toBe(503);
    const health = await app.inject({ url: '/api/health' });
    expect([health.statusCode, (health.json() as { ok: boolean }).ok]).toEqual([200, true]);
    /* Once it can be read, or is gone, the company is served. */
    rmSync(join(control, RESTORE_CARRY), { recursive: true });
    await app.ctx.restores.afterSwap();
    expect(app.ctx.restores.ready()).toBe(true);
    expect(sessionFrom(await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP }))).toBeTruthy();
    void setUpCompany;
    void MACHINE_ID;
  });

  it('serves nobody on a restored database that does not lead yet, and everybody on one that was not restored', async () => {
    /* Each app on the one database the test holds: a second testApp here would open a whole database of its own. */
    const { client } = await openTestDb();
    onTestFinished(() => client.close());
    const appWith = (env: NodeJS.ProcessEnv) => appOn(client, env);
    /* The keeper holds the app in maintenance while the restored company starts, or in read while it has no lease:
       what was carried over waits, so the sessions the bundle brought back open nothing. */
    for (const mode of ['maintenance', 'read'] as const) {
      const control = folder();
      writeFileSync(join(control, RESTORE_CARRY), JSON.stringify({ attempt: randomUUID(), carry: { people: [], invites: [], machines: [], serials: [], recoveryKeys: [] } }));
      writeKeeperState(control, { mode, at: new Date().toISOString(), link: null });
      const { app } = await appWith({ HORNHOOF_CONTROL_DIR: control, HORNHOOF_KEEPER: 'on' });
      for (const url of ['/api/people', '/api/version', '/api/updates/current']) {
        const refused = await app.inject({ url });
        expect([mode, url, refused.statusCode, (refused.json() as Refusal).error.reason]).toEqual([mode, url, 503, 'starting']);
      }
      expect((await app.inject({ method: 'POST', url: '/mcp', payload: {} })).statusCode).toBe(503);
      expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
    }
    /* An app that only reads and was never restored serves what it can read, as before. */
    const control = folder();
    writeKeeperState(control, { mode: 'read', at: new Date().toISOString(), link: null });
    const plain = await appWith({ HORNHOOF_CONTROL_DIR: control, HORNHOOF_KEEPER: 'on' });
    expect((await plain.app.inject({ url: '/api/version' })).statusCode).toBe(200);
    expect((await plain.app.inject({ url: '/api/setup' })).statusCode).toBe(200);
  });

  it('names what the restore undoes', async () => {
    const s = await stand();
    const before = await s.worker('before');
    await invitePerson(s.app, s.ceo, { name: 'Early', email: 'early@acme.com', access: { whole: true } });
    await new Promise(resolve => setTimeout(resolve, 20));
    const dumpedAt = new Date();
    await new Promise(resolve => setTimeout(resolve, 20));
    await s.worker('after');
    await s.worker('gone', { revokedAt: new Date() });
    await s.worker('no-core', { networkId: null, role: null });
    await invitePerson(s.app, s.ceo, { name: 'Late', email: 'late@acme.com', access: { whole: true } });
    expect(await warningOf(s.db, dumpedAt)).toEqual({ machines: [{ name: 'after', owner: 'Ivan' }], people: ['Late'] });
    void before;
    /* The CEO reads it for a bundle before he starts. */
    const asked = await s.app.inject({ url: `/api/backups/${s.made.id}/warning`, ...as(s.ceo) });
    expect([asked.statusCode, Object.keys(asked.json() as object).sort()]).toEqual([200, ['machines', 'people']]);
    expect((await s.app.inject({ url: `/api/backups/${randomUUID()}/warning`, ...as(s.ceo) })).statusCode).toBe(404);
  });
});
