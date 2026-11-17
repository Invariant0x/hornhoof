import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { expect, it, onTestFinished } from 'vitest';
import { freshPglite, ownDatabases } from './helpers-db.js';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';

ownDatabases();

it('adds empty private field storage on fresh installs and upgrades existing contacts without changing consent', async () => {
  const client = await freshPglite();
  onTestFinished(() => client.close());
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: await migrationsBefore('outbound_contact_fields') });
  await client.exec("INSERT INTO companies(id, name) VALUES ('11111111-1111-4111-8111-111111111111', 'Existing company'); INSERT INTO outbound_contacts(company_id, kind, address_enc, address_hash) VALUES ('11111111-1111-4111-8111-111111111111', 'email', 'sealed', repeat('a', 64));");
  const through = await migrationsThrough('outbound_contact_fields');
  await migrate(db, { migrationsFolder: through });
  await migrate(db, { migrationsFolder: through });
  expect((await client.query('SELECT address_enc, do_not_contact FROM outbound_contacts')).rows).toEqual([{ address_enc: 'sealed', do_not_contact: false }]);
  expect((await client.query('SELECT count(*)::int AS n FROM outbound_contact_fields')).rows).toEqual([{ n: 0 }]);
  const fresh = await freshPglite();
  onTestFinished(() => fresh.close());
  await migrate(drizzle(fresh), { migrationsFolder: through });
  expect((await fresh.query('SELECT count(*)::int AS n FROM outbound_contact_fields')).rows).toEqual([{ n: 0 }]);
});
