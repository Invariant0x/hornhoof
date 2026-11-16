import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { createTestDb, freshPglite, ownDatabases } from './helpers-db.js';
import { freshInstall, migrate, migrationsUpTo } from './migrations-fixture.js';

ownDatabases();

const ASSISTANT_TABLES = ['assistants', 'assistant_events', 'assistant_seqs', 'assistant_replies', 'assistant_requests'];

describe('personal assistants migration', () => {
  it('adds a required reply origin with a false default on fresh and upgraded installations', async () => {
    const client = await freshPglite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0131_plan_fallbacks') });
    await client.exec(`
      insert into companies (id, name) values ('00000000-0000-4000-8000-000000000001', 'Acme');
      insert into people (id, company_id, name, email, status, scope_kind)
        values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'Ivan', 'ivan@example.com', 'active', 'company');
      insert into people (id, company_id, name, status, scope_kind, is_agent, assistant_of)
        values ('00000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001', 'Ava', 'active', 'listed', true, '00000000-0000-4000-8000-000000000002');
      insert into assistants (person_id, company_id, program)
        values ('00000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001', 'avaclone');
      insert into subscriptions (id, company_id, provider, kind, label, owner_person_id, status)
        values ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'codex', 'personal', 'Plan', '00000000-0000-4000-8000-000000000002', 'ready');
      insert into agents (id, company_id, kind, name, model)
        values ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', 'worker', 'Developer', '');
      insert into jobs (id, company_id, subscription_id, agent_id, prompt, timeout_ms)
        values ('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004', 'Hello', 60000);
      insert into assistant_replies (company_id, assistant_id, agent_id, message_id, job_id, after_seq)
        values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000005', 7);
    `);
    const before = (await db.execute(sql`select to_jsonb(r) as row from assistant_replies r`)).rows;
    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const column = sql`select data_type, is_nullable, column_default from information_schema.columns where table_name = 'assistant_replies' and column_name = 'by_own_agent'`;
    const expected = [{ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' }];
    expect((await db.execute(column)).rows).toEqual(expected);
    expect((await db.execute(sql`select to_jsonb(r) - 'by_own_agent' as row from assistant_replies r`)).rows).toEqual(before);
    expect((await db.execute(sql`select by_own_agent from assistant_replies`)).rows).toEqual([{ by_own_agent: false }]);
    await db.execute(sql`update assistant_replies set by_own_agent = true`);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect((await db.execute(sql`select by_own_agent from assistant_replies`)).rows).toEqual([{ by_own_agent: true }]);
    await expect(db.execute(sql`update assistant_replies set by_own_agent = null`)).rejects.toThrow();
    /* global-setup.ts migrates a fresh database for this run; open its copy for the fresh-schema assertion. */
    const fresh = await createTestDb();
    expect((await fresh.execute(column)).rows).toEqual(expected);
  });

  it('makes every person a person and no assistant, adds its tables empty and touches no older row', async () => {
    const client = await freshPglite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0099_map_layouts') });
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Acme') returning id`)).rows[0]!.id;
    await db.execute(sql`insert into people (company_id, name, email, status, scope_kind, is_owner, password_hash) values (${company}, 'Ivan', 'ivan@acme.example', 'active', 'company', true, 'hash')`);
    await db.execute(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Dana', 'dana@acme.example', 'invited', 'listed')`);
    const older = async () => (await db.execute(sql`select to_jsonb(p) - 'is_agent' - 'assistant_of' as row from people p order by id`)).rows;
    const before = await older();

    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect(await older()).toEqual(before);
    expect((await db.execute(sql`select distinct is_agent, assistant_of from people`)).rows).toEqual([{ is_agent: false, assistant_of: null }]);
    for (const table of ASSISTANT_TABLES) expect((await db.execute(sql.raw(`select count(*)::int as n from ${table}`))).rows, table).toEqual([{ n: 0 }]);
    expect((await db.execute(sql`select count(*)::int as n from requests where answered_by_assistant_id is not null`)).rows).toEqual([{ n: 0 }]);
  });

  it('takes Hermes as a program, and keeps the assistants of before with theirs', async () => {
    const client = await freshPglite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0101_repo_hosts') });
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Acme') returning id`)).rows[0]!.id;
    const owner = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Ivan', 'ivan@acme.example', 'active', 'company') returning id`)).rows[0]!.id;
    const helper = async (name: string) => (await db.execute<{ id: string }>(sql`insert into people (company_id, name, status, scope_kind, is_agent, assistant_of) values (${company}, ${name}, 'active', 'listed', true, ${owner}) returning id`)).rows[0]!.id;
    const ava = await helper('Ava');
    await db.execute(sql`insert into assistants (person_id, company_id, program) values (${ava}, ${company}, 'openclaw')`);
    const max = await helper('Max');
    await expect(db.execute(sql`insert into assistants (person_id, company_id, program) values (${max}, ${company}, 'hermes')`)).rejects.toThrow();

    await migrate(db, { migrationsFolder: MIGRATIONS });

    await db.execute(sql`insert into assistants (person_id, company_id, program) values (${max}, ${company}, 'hermes')`);
    expect((await db.execute(sql`select program from assistants order by program`)).rows).toEqual([{ program: 'hermes' }, { program: 'openclaw' }]);
    await expect(db.execute(sql`update assistants set program = 'somebot' where person_id = ${max}`)).rejects.toThrow();
  });

  it('keeps an assistant tied to an owner, without a password, and every person with an email', async () => {
    const db = drizzle(await freshInstall());
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Acme') returning id`)).rows[0]!.id;
    const owner = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Ivan', 'ivan@acme.example', 'active', 'company') returning id`)).rows[0]!.id;
    const person = (fields: string, values: string) => db.execute(sql.raw(`insert into people (company_id, name, status, scope_kind, ${fields}) values ('${company}', 'Ava', 'active', 'listed', ${values})`));

    await expect(person('is_agent', 'true')).rejects.toThrow();
    await expect(person('is_agent, assistant_of, password_hash', `true, '${owner}', 'hash'`)).rejects.toThrow();
    await expect(person('assistant_of, email', `'${owner}', 'ava@acme.example'`)).rejects.toThrow();
    await expect(person('is_agent', 'false')).rejects.toThrow();
    await person('is_agent, assistant_of', `true, '${owner}'`);
    await person('is_agent, assistant_of', `true, '${owner}'`);
    expect((await db.execute(sql`select count(*)::int as n from people where is_agent and email is null`)).rows).toEqual([{ n: 2 }]);
  });

  it('keeps a key and its signing secret together, and one number for each event of a company', async () => {
    const db = drizzle(await freshInstall());
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Acme') returning id`)).rows[0]!.id;
    const owner = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Ivan', 'ivan@acme.example', 'active', 'company') returning id`)).rows[0]!.id;
    const ava = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, status, scope_kind, is_agent, assistant_of) values (${company}, 'Ava', 'active', 'listed', true, ${owner}) returning id`)).rows[0]!.id;
    await expect(db.execute(sql`insert into assistants (person_id, company_id, program, key_hash) values (${ava}, ${company}, 'avaclone', 'h')`)).rejects.toThrow();
    await expect(db.execute(sql`insert into assistants (person_id, company_id, program) values (${ava}, ${company}, 'somebot')`)).rejects.toThrow();
    await db.execute(sql`insert into assistants (person_id, company_id, program, key_hash, key_created_at, wake_secret_enc) values (${ava}, ${company}, 'avaclone', 'h', now(), 'e')`);
    await db.execute(sql`insert into assistant_events (company_id, assistant_id, seq, kind, data) values (${company}, ${ava}, 1, 'reply', '{}')`);
    await expect(db.execute(sql`insert into assistant_events (company_id, assistant_id, seq, kind, data) values (${company}, ${ava}, 1, 'request', '{}')`)).rejects.toThrow();
    await expect(db.execute(sql`insert into assistant_events (company_id, assistant_id, seq, kind, data) values (${company}, ${ava}, 2, 'other', '{}')`)).rejects.toThrow();
  });
});
