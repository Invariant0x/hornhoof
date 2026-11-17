import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';

const ACME = '00000000-0000-4000-8000-000000000a39';
const IVAN = '00000000-0000-4000-8000-000000000b39';
const MARIA = '00000000-0000-4000-8000-000000000c39';

/* Deleting people: nobody is deleted by the migration, and only a deleted person may be left without an email. */
describe('the migration of deleted people', { timeout: 60_000 }, () => {
  it('keeps everyone as they were, and lets only a deleted person go without an email', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    await migrate(drizzle(client), { migrationsFolder: await migrationsBefore('people_removed') });
    await client.exec(`
      INSERT INTO companies(id, name) VALUES ('${ACME}', 'Acme');
      INSERT INTO people(id, company_id, name, email, scope_kind, status, is_owner) VALUES ('${IVAN}', '${ACME}', 'Ivan', 'ivan@test', 'company', 'active', true);
      INSERT INTO people(id, company_id, name, email, scope_kind, status) VALUES ('${MARIA}', '${ACME}', 'Maria', 'maria@test', 'company', 'disabled');
    `);
    await migrate(drizzle(client), { migrationsFolder: await migrationsThrough('people_removed') });

    expect((await client.query('SELECT name, email, status, removed_at FROM people ORDER BY name')).rows).toEqual([
      { name: 'Ivan', email: 'ivan@test', status: 'active', removed_at: null },
      { name: 'Maria', email: 'maria@test', status: 'disabled', removed_at: null },
    ]);
    await expect(client.exec(`UPDATE people SET email = NULL WHERE id = '${MARIA}'`)).rejects.toThrow(/people_assistant/);
    await client.exec(`UPDATE people SET email = NULL, removed_at = now() WHERE id = '${MARIA}'`);
    expect((await client.query(`SELECT email FROM people WHERE id = '${MARIA}'`)).rows).toEqual([{ email: null }]);
  });
});
