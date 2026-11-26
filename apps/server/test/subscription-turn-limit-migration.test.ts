import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { freshPglite } from './helpers-db.js';
import { migrationsCut } from './migrations-before.js';
import { migrate } from './migrations-fixture.js';

const patch = '0175_subscription_turn_limit';
const lastBeforePatch = '0167_file_store';
const numberOf = (tag: string) => Number(tag.slice(0, 4));

it('keeps the subscription setting and applies each migration once when a patched 0.44 database upgrades', async () => {
  const journal = JSON.parse(await readFile(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string; when: number }[] };
  const patchEntry = journal.entries.find(entry => entry.tag === patch);
  expect(patchEntry).toBeDefined();
  const intermediate = journal.entries.filter(entry => numberOf(entry.tag) > 167 && numberOf(entry.tag) < 175);
  // The patch has no intermediate migrations. Once any arrive through the turn take-in, they must all be present.
  if (intermediate.length) expect(intermediate.map(entry => numberOf(entry.tag))).toEqual([168, 169, 170, 171, 172, 173, 174]);

  const client = await freshPglite();
  onTestFinished(() => client.close());
  const db = drizzle(client);
  const before = await migrationsCut('hh-before-turn-limit-', entries => entries.slice(0, entries.findIndex(entry => entry.tag === lastBeforePatch) + 1));
  await migrate(db, { migrationsFolder: before });
  await client.exec(`
    insert into companies (id, name) values ('00000000-0000-4000-8000-000000000101', 'Retained company');
    insert into people (id, company_id, name, email, status, scope_kind)
      values ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000101', 'Plan owner', 'owner@example.com', 'active', 'company');
    insert into subscriptions (company_id, provider, kind, label, owner_person_id, status)
      values ('00000000-0000-4000-8000-000000000101', 'codex', 'personal', 'Retained plan', '00000000-0000-4000-8000-000000000102', 'ready');
  `);
  const patched = await migrationsCut('hh-with-turn-limit-', entries => entries.filter(entry => numberOf(entry.tag) <= 167 || entry.tag === patch));
  await migrate(db, { migrationsFolder: patched });
  expect((await db.execute(sql`select turn_limit from subscriptions where label = 'Retained plan'`)).rows).toEqual([{ turn_limit: 4 }]);
  await db.execute(sql`update subscriptions set turn_limit = 5 where label = 'Retained plan'`);

  const records = async () => (await db.execute<{ id: number; hash: string; created_at: string }>(
    sql`select id, hash, created_at from drizzle.__drizzle_migrations order by id`,
  )).rows;
  const beforeTakeIn = await records();
  expect(beforeTakeIn.filter(row => Number(row.created_at) === patchEntry!.when)).toHaveLength(1);
  const config = { migrationsFolder: MIGRATIONS };
  await migrate(db, config);
  const afterTakeIn = await records();
  expect(afterTakeIn).toEqual(expect.arrayContaining(beforeTakeIn));
  expect(afterTakeIn.map(row => Number(row.created_at)).sort()).toEqual(journal.entries.map(entry => entry.when).sort());
  expect((await db.execute(sql`select turn_limit from subscriptions where label = 'Retained plan'`)).rows).toEqual([{ turn_limit: 5 }]);
  await migrate(db, config);
  expect(await records()).toEqual(afterTakeIn);
});
