import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Person } from '../src/auth/session.js';
import { companies, people, recoveryKeys } from '../src/db/schema.js';
import { ApiError } from '../src/errors.js';
import { activeRecovery, linkChanged, linkPrint, makeRecoveryFile, parseRecoveryFile, RECOVERY_KIND, type RecoveryFile } from '../src/modules/backups/recovery.js';
import { saveLink } from '../src/modules/link/link.js';
import { makeAuthorityOnce } from '../src/modules/network/store.js';
import { setUpCompany, testApp } from './helpers.js';
import { SERVER_MACHINE_ENV } from './helpers-computer.js';

const TUNNEL = { serverAddr: 'relay.hornhoof.test', serverPort: 443, protocol: 'wss' };

/* A company with its authority, and its CEO as a session knows them. */
async function company() {
  const { app, db, config } = await testApp(SERVER_MACHINE_ENV);
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const authority = await makeAuthorityOnce(db, config, acme!.id);
  const ceo: Person = { id: owner!.id, companyId: acme!.id, name: owner!.name, email: owner!.email, title: owner!.title, status: 'active', scopeKind: 'company', isOwner: true, isCeoDelegate: false };
  const link = (name: string, key = 'k'.repeat(32)) => saveLink(db, config, acme!.id, { name, url: `https://${name}.hornhoof.test`, key, tunnel: TUNNEL });
  const fileOf = (text: string) => JSON.parse(text.split('\n')[1]!) as RecoveryFile;
  return { app, db, config, acme: acme!, ceo, authority, link, fileOf };
}

/* Every row of every table Hornhoof keeps, as text. */
async function everything(db: Awaited<ReturnType<typeof company>>['db']): Promise<string> {
  const rowsOf = <T>(answer: unknown): T[] => (answer as { rows: T[] }).rows;
  const tables = rowsOf<{ name: string }>(await db.execute(sql`SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables WHERE schemaname IN ('public', 'net', 'net_local')`));
  let all = '';
  for (const { name } of tables) all += JSON.stringify(rowsOf(await db.execute(sql.raw(`SELECT row_to_json(t)::text AS row FROM ${name} t`))));
  return all;
}

describe('the recovery file', () => {
  it('holds the one private key the app never keeps', async () => {
    const c = await company();
    await c.link('acme');
    const made = await makeRecoveryFile(c.db, c.config, c.ceo);
    expect(made.name).toMatch(/^hornhoof-recovery-acme-\d{4}-\d{2}-\d{2}\.txt$/);
    expect(made.text.split('\n')[0]).toBe('# Hornhoof recovery file for Acme. It opens every backup made for it: keep it like a password.');
    const file = c.fileOf(made.text);
    expect(file).toMatchObject({ v: 1, kind: RECOVERY_KIND, company: c.acme.id, companyName: 'Acme', link: { name: 'acme', url: 'https://acme.hornhoof.test', key: 'k'.repeat(32), tunnel: TUNNEL }, authorityPem: c.authority.certPem });
    expect(file.identity).toMatch(/^AGE-SECRET-KEY-1/);
    /* The database has the public half, and nothing of the private one anywhere. */
    const [row] = await c.db.select().from(recoveryKeys);
    expect(row).toMatchObject({ recipient: file.recipient, linkName: 'acme', linkUrl: 'https://acme.hornhoof.test', linkPrint: linkPrint({ name: 'acme', key: 'k'.repeat(32) }), madeBy: c.ceo.id, retiredAt: null });
    const kept = await everything(c.db);
    expect(kept).toContain(file.recipient);
    expect(kept).not.toContain(file.identity);
    expect(kept).not.toContain(file.identity.slice(16, 40));
    expect(await activeRecovery(c.db, c.config)).toMatchObject({ recipient: file.recipient, link: { name: 'acme', url: 'https://acme.hornhoof.test' } });
  });

  it('retires the file before it, and is the company\'s only while its link is', async () => {
    const c = await company();
    await c.link('acme');
    const first = c.fileOf((await makeRecoveryFile(c.db, c.config, c.ceo)).text);
    const second = c.fileOf((await makeRecoveryFile(c.db, c.config, c.ceo)).text);
    expect(second.identity).not.toBe(first.identity);
    const rows = await c.db.select().from(recoveryKeys);
    expect(rows.find(row => row.recipient === first.recipient)!.retiredAt).not.toBeNull();
    expect(await activeRecovery(c.db, c.config)).toMatchObject({ recipient: second.recipient });
    expect(await linkChanged(c.db, c.config)).toBe(false);
    /* The link is renamed, with a new key from the relay: the key no longer stands for the company's link. */
    await c.link('acme-new', 'n'.repeat(32));
    expect(await activeRecovery(c.db, c.config)).toBeNull();
    expect(await linkChanged(c.db, c.config)).toBe(true);
    /* A file saved with no link is the company's while it has none. */
    const bare = await company();
    const without = bare.fileOf((await makeRecoveryFile(bare.db, bare.config, bare.ceo)).text);
    expect(without.link).toBeNull();
    expect((await makeRecoveryFile(bare.db, bare.config, bare.ceo)).name).toMatch(new RegExp(`^hornhoof-recovery-${bare.acme.id.slice(0, 8)}-`));
    expect(await activeRecovery(bare.db, bare.config)).toMatchObject({ link: null });
  });

  it('is not made before the company has its authority', async () => {
    const { app, db, config } = await testApp(SERVER_MACHINE_ENV);
    await setUpCompany(app);
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const ceo: Person = { id: owner!.id, companyId: owner!.companyId, name: owner!.name, email: owner!.email, title: owner!.title, status: 'active', scopeKind: 'company', isOwner: true, isCeoDelegate: false };
    await expect(makeRecoveryFile(db, config, ceo)).rejects.toMatchObject({ status: 409, reason: 'no_authority' });
    expect(await db.select().from(recoveryKeys)).toEqual([]);
  });

  it('reads back only a whole file, and says nothing of a key it refuses', async () => {
    const c = await company();
    const made = await makeRecoveryFile(c.db, c.config, c.ceo);
    const file = c.fileOf(made.text);
    expect(await parseRecoveryFile(made.text)).toEqual(file);
    const textOf = (over: object) => `# a comment\n\n${JSON.stringify({ ...file, ...over })}\n`;
    const other = c.fileOf((await makeRecoveryFile(c.db, c.config, c.ceo)).text);
    const broken = file.identity.slice(0, 30) + (file.identity[30] === 'Q' ? 'P' : 'Q') + file.identity.slice(31);
    for (const bad of [textOf({ recipient: other.recipient }), textOf({ identity: broken }), textOf({ authorityPem: 'not a certificate' }), textOf({ kind: 'other' }), textOf({ more: 1 }), 'not json', '', `${JSON.stringify(file)}\n${JSON.stringify(file)}`]) {
      const refused = await parseRecoveryFile(bad).then(() => null, (err: unknown) => err);
      expect(refused).toBeInstanceOf(ApiError);
      expect(refused).toMatchObject({ status: 400, reason: 'recovery_file_invalid', message: 'This is not a Hornhoof recovery file.' });
      const said = `${(refused as Error).stack ?? ''} ${String((refused as Error).cause ?? '')}`;
      for (let at = 0; at + 20 <= broken.length; at += 1) expect(said.includes(broken.slice(at, at + 20))).toBe(false);
    }
  });
});
