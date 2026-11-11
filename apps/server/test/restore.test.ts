import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as age from 'age-encryption';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, certificates, computerRuns, departments, invites, machineAccess, machines, people, personAccess, recoveryKeys, sessions } from '../src/db/schema.js';
import { activeRecovery } from '../src/modules/backups/recovery.js';
import { applyCarry, knownMigrations, ORDER_MS, RESTORE_CARRY, RESTORE_STATUS, warningOf } from '../src/modules/backups/restore.js';
import type { Carry, HolderView, MakerView, RestoreStatus } from '../src/modules/backups/types.js';
import { as, invitePerson, sessionFrom, setUpCompany, SETUP, testApp } from './helpers.js';
import { backupCompany, from, MACHINE_ID, OWN } from './helpers-backups.js';

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

    /* Only the CEO, on his own session. */
    const zed = await invitePerson(s.app, s.ceo, { name: 'Zed', email: 'zed@acme.com', access: { whole: true } });
    const [orchestrator] = await s.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    for (const who of [as(zed), { headers: orchestratorHeaders(s.owner.id, orchestrator!.id) }]) {
      expect(await s.refusal(s.restore(s.made.id, {}, who))).toEqual([403, 'not_owner_session']);
      const warning = await s.app.inject({ url: `/api/backups/${s.made.id}/warning`, ...who });
      expect(warning.statusCode).toBe(403);
    }
    expect(s.app.ctx.updater.claimed()).toBeNull();
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
    /* The status of the attempt before says nothing of this one. */
    const listed = (await s.app.inject({ url: '/api/backups', ...as(s.ceo) })).json() as { restore: RestoreStatus | null; bundles: { id: string; restorable: boolean; why: string | null }[] };
    expect(listed.restore).toMatchObject({ attempt: first, state: 'failed' });
    expect(listed.bundles.find(bundle => bundle.id === s.made.id)).toMatchObject({ restorable: true, why: null });
    /* A status at a step of the keeper's counts as running only while its order is out. */
    s.says({ attempt: randomUUID(), state: 'running', step: 'open' });
    const stale = (await s.app.inject({ url: '/api/backups', ...as(s.ceo) })).json() as { restore: RestoreStatus };
    expect(stale.restore).toMatchObject({ state: 'failed', line: 'The restore was called off.' });
    s.says({ attempt: second, state: 'running', step: 'open' });
    expect(((await s.app.inject({ url: '/api/backups', ...as(s.ceo) })).json() as { restore: RestoreStatus }).restore).toMatchObject({ attempt: second, state: 'running', step: 'open' });
    /* After its hour the order is gone, and the updater free. */
    const realNow = Date.now;
    Date.now = () => realNow() + ORDER_MS;
    try {
      expect((await s.view<MakerView>()).order).toBeNull();
    } finally {
      Date.now = realNow;
    }
    expect(s.app.ctx.updater.claimed()).toBeNull();
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
    await db.insert(machineAccess).values({ machineId: kept, companyId: s.acme.id, until: soon, openedBy: s.owner.id, openedAt: new Date(), grant: { payload: 'p', signature: 's' } });
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    void orchestrator;
    /* The recovery keys: this database's active one was retired since, and another made. */
    const here = JSON.parse(((await s.recoveryFile()).json() as { text: string }).text.split('\n')[1]!) as { recipient: string };
    const [hereRow] = await db.select().from(recoveryKeys).where(eq(recoveryKeys.recipient, here.recipient));
    const newer = { id: randomUUID(), recipient: `age1${'q'.repeat(58)}`, linkPrint: null, linkName: null, linkUrl: null, madeBy: s.owner.id, madeAt: new Date().toISOString(), retiredAt: null };

    const asCarried = (person: typeof people.$inferSelect, over: Partial<Carry['people'][number]> = {}): Carry['people'][number] =>
      ({ id: person.id, status: person.status, passwordHash: person.passwordHash, scopeKind: person.scopeKind, isOwner: person.isOwner, access: [], ...over });
    const carry: Carry = {
      people: [
        asCarried((await db.select().from(people).where(eq(people.id, s.owner.id)))[0]!),
        asCarried(dana!.row, { status: 'disabled' }),
        asCarried(eli!.row, { passwordHash: 'a-new-hash', scopeKind: 'listed', access: [{ departmentId: sales!.id, teamId: null }, { departmentId: randomUUID(), teamId: null }] }),
        asCarried(finn!.row, { scopeKind: 'listed', access: [] }),
        asCarried({ ...finn!.row, id: randomUUID() }),
      ],
      invites: [open, hashToken('made since')],
      machines: [
        { id: revoked, revoked: true, lendsTests: true, keepsBackups: true },
        { id: kept, revoked: false, lendsTests: false, keepsBackups: false },
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
    expect(await person(eli!.row.id)).toMatchObject({ passwordHash: 'a-new-hash', scopeKind: 'listed', status: 'active' });
    expect((await db.select().from(personAccess).where(eq(personAccess.personId, eli!.row.id))).map(row => row.departmentId)).toEqual([sales!.id]);
    expect(await db.select().from(personAccess).where(eq(personAccess.personId, finn!.row.id))).toEqual([]);
    expect((await person(s.owner.id)).isOwner).toBe(true);
    expect((await db.select({ hash: invites.tokenHash }).from(invites).where(isNull(invites.usedAt))).map(row => row.hash)).toEqual([open]);
    const machine = async (id: string) => (await db.select().from(machines).where(eq(machines.id, id)))[0]!;
    expect((await machine(revoked)).revokedAt).not.toBeNull();
    expect(await machine(kept)).toMatchObject({ revokedAt: null, lendsTests: false, keepsBackups: false });
    const serials = await db.select().from(certificates);
    expect(serials.filter(row => row.revokedAt !== null).map(row => row.serial).sort()).toContain('aa01');
    expect(serials.find(row => row.serial === 'bb02')!.revokedAt).toBeNull();
    /* The key that was active when the old database closed is the company's recovery key. */
    expect((await activeRecovery(db, s.config))?.recipient).toBe(newer.recipient);
    expect((await db.select().from(recoveryKeys).where(and(eq(recoveryKeys.id, hereRow!.id)))).map(row => row.retiredAt !== null)).toEqual([true]);
    /* Every machine is closed, and everyone signs in again. */
    expect(await db.select().from(machineAccess).where(eq(machineAccess.machineId, kept))).toMatchObject([{ until: null, grant: null, openedBy: null, openedAt: null }]);
    expect(await db.select().from(sessions)).toEqual([]);
    expect((await s.app.inject({ url: '/api/people', ...as(s.ceo) })).statusCode).toBe(401);
    /* Twice is as once. */
    await applyCarry(s.app.ctx, carry);
    expect((await activeRecovery(db, s.config))?.recipient).toBe(newer.recipient);
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
    const attempt = randomUUID();
    const carry: Carry = { people: [], invites: [], machines: [], serials: ['aa01'], recoveryKeys: [] };
    const cases: [Partial<RestoreStatus> | null, string, boolean][] = [
      [{ attempt, state: 'running', step: 'start' }, attempt, true],
      [{ attempt, state: 'done', step: 'start' }, attempt, true],
      [{ attempt, state: 'failed', step: 'start' }, attempt, false],
      [{ attempt, state: 'running', step: 'swap' }, attempt, false],
      [{ attempt: randomUUID(), state: 'done', step: 'start' }, attempt, false],
      [null, attempt, false],
    ];
    for (const [status, carried, applies] of cases) {
      const s = await stand();
      const machine = await s.worker('mac');
      await s.db.insert(certificates).values({ serial: 'aa01', machineId: machine, until: new Date(Date.now() + 86_400_000) });
      if (status) s.says(status);
      writeFileSync(join(s.control, RESTORE_CARRY), JSON.stringify({ attempt: carried, carry }));
      await s.app.ctx.restores.afterSwap();
      const [serial] = await s.db.select().from(certificates).where(eq(certificates.serial, 'aa01'));
      expect([serial!.revokedAt !== null, existsSync(join(s.control, RESTORE_CARRY))], JSON.stringify(status)).toEqual([applies, false]);
    }
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
