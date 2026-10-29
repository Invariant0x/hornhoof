import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';

/* A copy of the migrations folder that stops after the given tag, as an older install would have it. */
async function migrationsUpTo(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hh-migrations-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await cp(MIGRATIONS, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const last = journal.entries.findIndex(e => e.tag === tag);
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalPath, JSON.stringify(journal));
  return dir;
}

describe('migration 0003', () => {
  it('renames the chief of an older install to the orchestrator', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0002_indexes') });

    await db.execute(sql`insert into companies (id, name) values ('00000000-0000-4000-8000-000000000001', 'Acme')`);
    await db.execute(sql`insert into people (id, company_id, name, email, status, scope_kind)
      values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'Ivan', 'ivan@acme.com', 'active', 'company')`);
    await db.execute(sql`insert into subscriptions (id, company_id, provider, kind, label, owner_person_id, status, target_kind)
      values ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'anthropic_api', 'api_key', 'Chief',
        '00000000-0000-4000-8000-000000000002', 'ready', 'chief')`);
    await db.execute(sql`insert into subscriptions (id, company_id, provider, kind, label, owner_person_id, status, target_kind)
      values ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', 'anthropic_api', 'api_key', 'Chief of staff',
        '00000000-0000-4000-8000-000000000002', 'ready', 'any')`);
    await db.execute(sql`insert into agents (company_id, kind, name, model, subscription_id)
      values ('00000000-0000-4000-8000-000000000001', 'chief', 'Chief', 'claude-opus-5-5', '00000000-0000-4000-8000-000000000003')`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const agents = await db.execute<{ kind: string; name: string }>(sql`select kind, name from agents`);
    expect(agents.rows).toEqual([{ kind: 'orchestrator', name: 'Orchestrator' }]);
    const subs = await db.execute<{ label: string; target_kind: string }>(sql`select label, target_kind from subscriptions order by id`);
    expect(subs.rows).toEqual([
      { label: 'Orchestrator', target_kind: 'orchestrator' },
      { label: 'Chief of staff', target_kind: 'any' },
    ]);
  });
});
