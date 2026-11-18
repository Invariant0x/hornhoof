import type { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { freshInstall, migrate, olderInstall, prepareInstalls } from './migrations-fixture.js';

const OLD = '0144_agent_change_actor';
const INDEX = 'agent_events_message_sender_window';
const CREATED = new Date('2030-01-01T12:00:00Z');
await prepareInstalls([OLD]);

async function installed(client: PGlite) {
  const result = await client.query(`select to_regclass($1)::text as message_index,
    to_regclass('improvement_submissions')::text as improvements, to_regclass('feedback_submissions')::text as feedback`, [INDEX]);
  return Object.values(result.rows[0]!);
}

describe('the submission receipts and message index migration', () => {
  it('installs both receipt tables without the message quota index', async () => {
    expect(await installed(await freshInstall())).toEqual([null, 'improvement_submissions', 'feedback_submissions']);
  });

  it('upgrades 0144 twice without changing its stored messages', async () => {
    const client = await olderInstall(OLD);
    const db = drizzle(client);
    expect(await installed(client)).toEqual([INDEX, null, null]);
    await db.execute(sql`insert into companies (id, name) values ('00000000-0000-4000-8000-000000000001', 'Acme')`);
    await db.execute(sql`insert into agents (id, company_id, kind, name, model)
      values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'worker', 'Bruno', '')`);
    await db.execute(sql`insert into agent_events (company_id, agent_id, kind, data, created_at)
      values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'message', '{"by":"recorded sender","text":"Keep this."}', ${CREATED})`);
    const before = await client.query('select to_jsonb(e) as data from agent_events e order by seq');
    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect((await client.query('select to_jsonb(e) as data from agent_events e order by seq')).rows).toEqual(before.rows);
    expect(await installed(client)).toEqual([null, 'improvement_submissions', 'feedback_submissions']);
  });
});
