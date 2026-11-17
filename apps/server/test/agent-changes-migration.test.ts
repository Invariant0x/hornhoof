import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { ownDatabases } from './helpers-db.js';
import { freshInstall, migrate, olderInstall, prepareInstalls } from './migrations-fixture.js';

ownDatabases();
await prepareInstalls(['0136_outbound_contact_log']);

describe('employee change actor migration', () => {
  it('gives a fresh install a nullable acting agent linked to the employee table', async () => {
    const client = await freshInstall();
    const db = drizzle(client);
    const column = await db.execute(sql`select data_type, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'agent_changes' and column_name = 'acting_agent_id'`);
    expect(column.rows).toEqual([{ data_type: 'uuid', is_nullable: 'YES', column_default: null }]);
    const foreignKey = await db.execute<{ definition: string }>(sql`select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = 'agent_changes'::regclass and contype = 'f' and pg_get_constraintdef(oid) like '%acting_agent_id%'`);
    expect(foreignKey.rows).toHaveLength(1);
    expect(foreignKey.rows[0]!.definition).toContain('REFERENCES agents(id)');
  });

  it('upgrades without attributing old changes to an agent, and can migrate again', async () => {
    const client = await olderInstall('0136_outbound_contact_log');
    const db = drizzle(client);
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Acme') returning id`)).rows[0]!.id;
    const person = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind, is_owner)
      values (${company}, 'Dana', 'dana@acme.example', 'active', 'company', true) returning id`)).rows[0]!.id;
    const dept = (await db.execute<{ id: string }>(sql`insert into departments (company_id, name, role_code) values (${company}, 'Development', 'DEV') returning id`)).rows[0]!.id;
    const agent = (await db.execute<{ id: string }>(sql`insert into agents (company_id, name, kind, department_id, model) values (${company}, 'Hana', 'head', ${dept}, '') returning id`)).rows[0]!.id;
    await db.execute(sql`insert into agent_changes (company_id, agent_id, person_id, field, before, after)
      values (${company}, ${agent}, ${person}, 'name', '"Hana"'::jsonb, '"Hannah"'::jsonb)`);
    const oldRows = async () => (await db.execute(sql`select to_jsonb(c) - 'acting_agent_id' as row from agent_changes c order by id`)).rows;
    const before = await oldRows();

    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect(await oldRows()).toEqual(before);
    expect((await db.execute(sql`select acting_agent_id from agent_changes`)).rows).toEqual([{ acting_agent_id: null }]);
    await db.execute(sql`insert into agent_changes (company_id, agent_id, person_id, acting_agent_id, field)
      values (${company}, ${agent}, ${person}, ${agent}, 'reset')`);
    expect((await db.execute(sql`select acting_agent_id, person_id from agent_changes where field = 'reset'`)).rows).toEqual([{ acting_agent_id: agent, person_id: person }]);
  });
});
