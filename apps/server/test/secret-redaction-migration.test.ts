import { drizzle } from 'drizzle-orm/pglite';
import { expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { fingerprintOf } from '../src/modules/tasks/hide-secret.js';
import { AFTER_MIGRATIONS } from '../src/db/net.js';
import { freshPglite, ownDatabases } from './helpers-db.js';
import { migrate, migrationsUpTo } from './migrations-fixture.js';

ownDatabases();

it('upgrades an existing database without discarding prose, and a suppression row changes no row by itself', async () => {
  const client = await freshPglite();
  onTestFinished(() => client.close());
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: await migrationsUpTo('0136_outbound_contact_log') });
  const company = await client.query<{ id: string }>("insert into companies (name) values ('Acme') returning id");
  const companyId = company.rows[0]!.id;
  await client.query("insert into tasks (company_id, number, title, body) values ($1, 1, 'Kept', 'Old text')", [companyId]);
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await client.exec(AFTER_MIGRATIONS);
  expect((await client.query('select title, body from tasks')).rows).toEqual([{ title: 'Kept', body: 'Old text' }]);
  expect((await client.query('select * from secret_redactions')).rows).toEqual([]);
  const person = await client.query<{ id: string }>("insert into people (company_id, name, email, status, scope_kind) values ($1, 'Ivan', 'ivan@acme.test', 'active', 'company') returning id", [companyId]);
  const { fingerprint, characters, window_hash } = fingerprintOf('Old text');
  await client.query('insert into secret_redactions (company_id, person_id, fingerprint, characters, window_hash) values ($1, $2, $3, $4, $5)', [companyId, person.rows[0]!.id, fingerprint, characters, window_hash]);
  /* The server hides a value in its own process; the database has no trigger that would scan every row on its own. */
  expect((await client.query('select title, body from tasks')).rows).toEqual([{ title: 'Kept', body: 'Old text' }]);
  await client.query("update tasks set body = 'Old text again'");
  expect((await client.query('select body from tasks')).rows).toEqual([{ body: 'Old text again' }]);
});

it('lets frozen evidence lose a hidden value only in the named columns, from the server session itself', async () => {
  const client = await freshPglite();
  onTestFinished(() => client.close());
  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS });
  await client.exec(`CREATE TABLE frozen (id int PRIMARY KEY, note text, kind text);
    CREATE TRIGGER frozen_guard BEFORE UPDATE OR DELETE ON frozen FOR EACH ROW EXECUTE FUNCTION outbound_refuse_change();
    INSERT INTO frozen VALUES (1, 'a Secret1077!', 'kept');
    CREATE ROLE frozen_agent NOLOGIN; GRANT SELECT, UPDATE ON frozen TO frozen_agent;`);
  const attempt = (allowed: string[], change: string, role = '') => client.transaction(async tx => {
    await tx.query("SELECT set_config('hornhoof.hiding_secret', $1, true)", [JSON.stringify(allowed)]);
    if (role) await tx.exec(`SET LOCAL ROLE ${role}`);
    await tx.exec(`UPDATE frozen SET ${change} WHERE id = 1`);
  });
  await expect(attempt([], "note = 'a [hidden]'")).rejects.toThrow(/is refused/);
  await expect(attempt(['note'], "kind = 'changed'")).rejects.toThrow(/is refused/);
  await expect(attempt(['note'], "note = 'a [hidden]'", 'frozen_agent')).rejects.toThrow(/is refused/);
  await expect(client.exec('DELETE FROM frozen')).rejects.toThrow(/is refused/);
  await attempt(['note'], "note = 'a [hidden]'");
  expect((await client.query('SELECT note, kind FROM frozen')).rows).toEqual([{ note: 'a [hidden]', kind: 'kept' }]);
  await expect(client.exec("UPDATE frozen SET note = 'again' WHERE id = 1")).rejects.toThrow(/is refused/);
});
