import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readerRole } from '../src/db/agent-sql.js';
import { agentEvents, agents, companies } from '../src/db/schema.js';

const closes = vi.spyOn(PGlite.prototype, 'close');
/* Hooks run last first, so this one looks after the one helpers-db.ts adds as it loads below. A database left open at the
   end of a file is a whole Postgres in memory, and a file that leaves them grows until it is killed. */
afterAll(() => {
  expect(closes.mock.calls.length).toBe(databasesOpened());
});
const { createTestDb, databasesOpened } = await import('./helpers-db.js');
const { testApp } = await import('./helpers.js');

type Db = Awaited<ReturnType<typeof createTestDb>>;
const reader = readerRole('postgres');

async function numberedEvent(db: Db): Promise<number> {
  const [company] = await db.insert(companies).values({ name: 'Acme' }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company!.id, kind: 'orchestrator', name: 'Orchestrator', model: '' }).returning();
  const [event] = await db.insert(agentEvents).values({ companyId: company!.id, agentId: agent!.id, kind: 'message', data: {} }).returning();
  return event!.seq;
}

async function rowsOfEachTable(db: Db): Promise<unknown[]> {
  const tables = await db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
  const counts = tables.rows.map(t => `select '${t.tablename}' as name, count(*)::int as count from "${t.tablename}"`);
  const { rows } = await db.execute<{ name: string; count: number }>(sql.raw(counts.join(' union all ')));
  return rows.filter(r => r.count > 0);
}

async function rights(db: Db): Promise<unknown[]> {
  const roles = await db.execute(sql`select rolname from pg_roles order by rolname`);
  const tables = await db.execute(sql`select relname, relacl::text from pg_class where relacl is not null order by relname`);
  return [roles.rows, tables.rows];
}

describe('the tests of one file', { shuffle: false }, () => {
  let opened = 0;
  let firstNumber = 0;

  it('have a database of their own to write in', async () => {
    const db = await createTestDb();
    opened = databasesOpened();
    firstNumber = await numberedEvent(db);
    expect(await db.select({ name: companies.name }).from(companies)).toEqual([{ name: 'Acme' }]);
  });

  it('share that database and do not see what the test before wrote, and numbers start over', async () => {
    const db = await createTestDb();
    expect(databasesOpened()).toBe(opened);
    expect(await db.select().from(companies)).toEqual([]);
    expect(await numberedEvent(db)).toBe(firstNumber);
  });

  it('find in it the same rows as in a new copy of the migrated database', async () => {
    const emptied = await createTestDb();
    const copy = await createTestDb();
    expect(await rowsOfEachTable(emptied)).toEqual(await rowsOfEachTable(copy));
  });

  it('can ask for a second database in one test, and it is another one', async () => {
    const first = await createTestDb();
    const second = await createTestDb();
    await first.insert(companies).values({ name: 'Acme' });
    expect(await second.select().from(companies)).toEqual([]);
  });
});

describe('a test that takes a right away', { shuffle: false }, () => {
  it('has it gone for itself', async () => {
    const { app, db } = await testApp();
    await app.ctx.agentSql!.run('select 1', 'read');
    // eslint-disable-next-line hornhoof/no-ddl-on-shared-database -- This test is about what such a statement leaves behind.
    await db.execute(sql.raw(`revoke select on companies from "${reader}"`));
    await expect(app.ctx.agentSql!.run('select id from companies', 'read')).rejects.toThrow('permission denied');
  });

  it('leaves the rights and roles of a new copy to the next test', async () => {
    const emptied = await createTestDb();
    const copy = await createTestDb();
    expect(await rights(emptied)).toEqual(await rights(copy));
  });

  it('does not stop the next test from reading', async () => {
    const { app } = await testApp();
    const [result] = await app.ctx.agentSql!.run('select id from companies', 'read');
    expect(result!.rows).toEqual([]);
  });
});

describe('what a test changes beyond rows', { shuffle: false }, () => {
  it('can be a trigger', async () => {
    const db = await createTestDb();
    // eslint-disable-next-line hornhoof/no-ddl-on-shared-database -- This test is about what such a statement leaves behind.
    await db.execute(sql`create function refuse_company() returns trigger language plpgsql as $$ begin raise exception 'no company'; end $$`);
    // eslint-disable-next-line hornhoof/no-ddl-on-shared-database -- This test is about what such a statement leaves behind.
    await db.execute(sql`create trigger refuse_company before insert on companies for each row execute function refuse_company()`);
    await expect(db.insert(companies).values({ name: 'Acme' })).rejects.toThrow();
  });

  it('does not reach the next test as a trigger', async () => {
    const db = await createTestDb();
    await expect(db.insert(companies).values({ name: 'Acme' }).returning()).resolves.toHaveLength(1);
  });

  it('can be a setting of the connection', async () => {
    const db = await createTestDb();
    await db.execute(sql`select set_config('search_path', 'pg_catalog', false)`);
    await expect(db.select().from(companies)).rejects.toThrow();
  });

  it('does not reach the next test as a setting', async () => {
    const db = await createTestDb();
    await expect(db.select().from(companies)).resolves.toEqual([]);
  });

  it('can be a statistic the planner goes by', async () => {
    const db = await createTestDb();
    await db.insert(companies).values({ name: 'Acme' });
    await db.execute(sql`analyze companies`);
    expect((await statistics(db)).rows).not.toEqual([]);
  });

  it('does not reach the next test as a statistic', async () => {
    const db = await createTestDb();
    expect((await statistics(db)).rows).toEqual([]);
  });
});

function statistics(db: Db) {
  return db.execute(sql`select attname from pg_stats where schemaname = 'public' and tablename = 'companies'`);
}

describe('work a test leaves behind', { shuffle: false }, () => {
  let late: () => Promise<unknown>;
  let running: Promise<unknown>;

  it('can be something to write later', async () => {
    const { db } = await testApp();
    late = () => db.insert(companies).values({ name: 'Late' });
  });

  it('cannot write into the next test', async () => {
    const db = await createTestDb();
    await expect(late()).rejects.toThrow('PGlite is closed');
    expect(await db.select().from(companies)).toEqual([]);
  });

  it('can be a transaction still running', async () => {
    const db = await createTestDb();
    await new Promise<void>(begun => {
      running = db.transaction(async tx => {
        await tx.insert(companies).values({ name: 'Running' });
        begun();
        await new Promise(wait => setTimeout(wait, 100));
        await tx.update(companies).set({ name: 'Still running' });
      });
    });
  });

  it('ends before the next test starts, and leaves nothing in it', async () => {
    const db = await createTestDb();
    await running;
    expect(await db.select().from(companies)).toEqual([]);
  });
});

describe('after a test fails', { shuffle: false }, () => {
  let opened = 0;

  it.fails('its database may be in any state', async () => {
    await createTestDb();
    opened = databasesOpened();
    throw new Error('As if this test had failed.');
  });

  it('so the next test gets a new one', async () => {
    await createTestDb();
    expect(databasesOpened()).toBe(opened + 1);
  });
});

describe('a test run', () => {
  it('is in one time zone, wherever the machine is', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC');
  });
});
