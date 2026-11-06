import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';

it('preserves existing company, job, event and attachment data when adding empty operator structures', async () => {
  const previous = await mkdtemp(join(tmpdir(), 'hh-operator-migration-'));
  const client = new PGlite();
  onTestFinished(async () => { await client.close(); await rm(previous, { recursive: true, force: true }); });
  await cp(MIGRATIONS, previous, { recursive: true });
  const journalFile = join(previous, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalFile, 'utf8')) as { entries: { tag: string }[] };
  const at = journal.entries.findIndex(entry => /^\d{4}_program_operator$/.test(entry.tag));
  expect(at).toBeGreaterThan(-1);
  const operator = journal.entries[at]!;
  journal.entries.splice(at);
  await writeFile(journalFile, JSON.stringify(journal));
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: previous });
  await client.exec(`
    insert into companies (id, name) values ('00000000-0000-4000-8000-000000000001', 'Retained company');
    insert into people (id, company_id, name, email, status, scope_kind)
      values ('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', 'Owner', 'owner@example.test', 'active', 'company');
    insert into subscriptions (id, company_id, provider, kind, label, owner_person_id, status)
      values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'codex', 'personal', 'Retained plan', '00000000-0000-4000-8000-000000000005', 'ready');
    insert into agents (id, company_id, kind, name, model, subscription_id)
      values ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'worker', 'Developer', '', '00000000-0000-4000-8000-000000000002');
    insert into jobs (id, company_id, agent_id, subscription_id, prompt, timeout_ms, status)
      values ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 'Retained words', 60000, 'done');
    insert into agent_events (company_id, agent_id, job_id, kind, data)
      values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004', 'message', '{"text":"Retained words"}');
    insert into attachments (company_id, agent_id, job_id, person_id, media_type, bytes, size)
      values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000005', 'application/octet-stream', decode('010203', 'hex'), 3);
    insert into attachments (company_id, agent_id, person_id, media_type, bytes, size)
      values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000005', 'image/png', decode('040506', 'hex'), 3);
  `);
  const tables = ['companies', 'people', 'subscriptions', 'agents', 'jobs', 'agent_events', 'attachments'];
  const before = await Promise.all(tables.map(table => client.query(`select to_jsonb(t) as row from ${table} t`)));
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  /* Later migrations add columns of their own: what these rows held before stays as it was. */
  for (const [index, table] of tables.entries()) {
    const held = before[index]!.rows as { row: Record<string, unknown> }[];
    const rows = (await client.query<{ row: Record<string, unknown> }>(`select to_jsonb(t) as row from ${table} t`)).rows;
    expect(rows.map((now, at) => Object.fromEntries(Object.keys(held[at]!.row).map(column => [column, now.row[column]]))), table).toEqual(held.map(then => then.row));
  }
  expect((await client.query('select operator_case_id from attachments')).rows).toEqual([{ operator_case_id: null }, { operator_case_id: null }]);
  expect((await client.query('select limits_updated_at from subscriptions')).rows).toEqual([{ limits_updated_at: null }]);
  expect((await client.query("select person_id, job_id, size, encode(bytes, 'hex') as payload from attachments where job_id is null")).rows).toEqual([{ person_id: '00000000-0000-4000-8000-000000000005', job_id: null, size: 3, payload: '040506' }]);
  for (const table of ['program_instances', 'program_deliveries', 'program_operator_cases', 'program_operator_signals', 'program_operator_actions']) {
    expect((await client.query(`select * from ${table}`)).rows, table).toEqual([]);
  }
  expect(await readFile(join(MIGRATIONS, `${operator.tag}.sql`), 'utf8')).not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE|GRANT|REVOKE|DROP)\b/im);
});
