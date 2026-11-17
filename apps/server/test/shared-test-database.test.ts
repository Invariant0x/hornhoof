import type { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { agentRole, grantsFor, readerRole } from '../src/db/agent-sql.js';
import { agentEvents, agents, companies } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { until } from './helpers-basic.js';

/* A database left open at the end of a file is a whole Postgres in memory, and a file that leaves them grows until it is
   killed. Hooks run last first, so this one looks after the one helpers-db.ts adds as it loads below. */
let lastShared: PGlite | undefined;
afterAll(() => {
  expect(lastShared?.closed).toBe(true);
});
const { checkSharedDatabase, createTestDb, databasesOpened, fixture, shapeOf, sharedDatabase, truncatable } = await import('./helpers-db.js');
const { testApp } = await import('./helpers.js');
afterAll(() => {
  lastShared = sharedDatabase();
  expect(lastShared?.closed).toBe(false);
});

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
    expect(await db.select(only(companies, 'name')).from(companies)).toEqual([{ name: 'Acme' }]);
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

  /* A new copy holds rows its migrations wrote outside public too, as the horizon of merges in net. */
  let horizon: unknown[] = [];
  it('can change the rows a new copy holds', async () => {
    const db = await createTestDb();
    horizon = (await db.execute(sql`select below from net.horizon`)).rows;
    expect(horizon).toHaveLength(1);
    await db.execute(sql`update net.horizon set below = below + interval '1 day'`);
  });

  it('find those rows again as a new copy holds them', async () => {
    const db = await createTestDb();
    expect((await db.execute(sql`select below from net.horizon`)).rows).toEqual(horizon);
  });

  it('can ask for a second database in one test, and it is another one', async () => {
    const first = await createTestDb();
    const second = await createTestDb();
    await first.insert(companies).values({ name: 'Acme' });
    expect(await second.select().from(companies)).toEqual([]);
  });
});

describe('agent SQL in a test', { shuffle: false }, () => {
  it('finds its roles and rights in the database already, so it changes nothing beyond rows', async () => {
    const { app } = await testApp();
    const shape = await shapeOf(sharedDatabase()!);
    await app.ctx.agentSql!.run('select 1', 'read');
    expect(await shapeOf(sharedDatabase()!)).toBe(shape);
  });

  it('leaves the rights and roles of a new copy to the next test', async () => {
    const emptied = await createTestDb();
    const copy = await createTestDb();
    expect(await rights(emptied)).toEqual(await rights(copy));
  });
});

/* A change beyond rows outlives the emptying between tests and reaches every later test of the file, so the file fails
   when it ends, and its database is put aside. A test here asks for that check itself, so the file goes on. */
describe('what a test changes beyond rows', { shuffle: false }, () => {
  it('fails its file when the file ends, as a trigger', async () => {
    const db = await createTestDb();
    // eslint-disable-next-line hornhoof/no-ddl-on-shared-database -- This test is about what such a statement leaves behind.
    await db.execute(sql`create function refuse_company() returns trigger language plpgsql as $$ begin raise exception 'no company'; end $$`);
    // eslint-disable-next-line hornhoof/no-ddl-on-shared-database -- This test is about what such a statement leaves behind.
    await db.execute(sql`create trigger refuse_company before insert on companies for each row execute function refuse_company()`);
    await expect(checkSharedDatabase()).rejects.toThrow(/ownDatabases\(\)/);
  });

  it('leaves the next test a new copy once its file was told', async () => {
    const db = await createTestDb();
    await expect(db.insert(companies).values({ name: 'Acme' }).returning()).resolves.toHaveLength(1);
  });

  it('fails its file as a right taken away', async () => {
    const { app, db } = await testApp();
    await app.ctx.agentSql!.run('select 1', 'read');
    // eslint-disable-next-line hornhoof/no-ddl-on-shared-database -- This test is about what such a statement leaves behind.
    await db.execute(sql.raw(`revoke select on companies from "${reader}"`));
    await expect(app.ctx.agentSql!.run('select id from companies', 'read')).rejects.toThrow('permission denied');
    await expect(checkSharedDatabase()).rejects.toThrow(/ownDatabases\(\)/);
  });

  it('fails its file when a schema change prevents emptying the database', async () => {
    const db = await createTestDb();
    // eslint-disable-next-line hornhoof/no-ddl-on-shared-database -- This test checks that a broken cleanup cannot hide a schema change.
    await db.$client.exec('drop schema public cascade');
    await expect(checkSharedDatabase()).rejects.toThrow(/ownDatabases\(\)/);
  });

  it('does not hide a schema change by replacing a database that cannot be emptied', async () => {
    const db = await createTestDb();
    // eslint-disable-next-line hornhoof/no-ddl-on-shared-database -- This test checks cleanup before the next test asks for its database.
    await db.$client.exec('drop schema public cascade');
    await db.$client.close();
    await expect(createTestDb().then(() => null)).rejects.toThrow(/ownDatabases\(\)/);
  });

  it('does not fail its file when it gave the same rights again, in another order', async () => {
    const db = await createTestDb();
    await db.$client.exec(grantsFor(agentRole('postgres')));
    await expect(checkSharedDatabase()).resolves.toBeUndefined();
  });

  it('does not fail its file when it changed only rows', async () => {
    const db = await createTestDb();
    await db.insert(companies).values({ name: 'Acme' });
    await expect(checkSharedDatabase()).resolves.toBeUndefined();
  });
});

/* What a test sets on its connection ends with the test, as each test starts by discarding it. */
describe('a setting of the connection', { shuffle: false }, () => {
  it('can be one every read depends on', async () => {
    const db = await createTestDb();
    await db.execute(sql`select set_config('search_path', 'pg_catalog', false)`);
    await expect(db.select().from(companies)).rejects.toThrow();
  });

  it('does not reach the next test as such a setting', async () => {
    const db = await createTestDb();
    await expect(db.select().from(companies)).resolves.toEqual([]);
  });

  it('can be one no read depends on', async () => {
    const db = await createTestDb();
    await db.execute(sql`select set_config('application_name', 'left behind', false)`);
    expect(await applicationName(db)).toEqual([{ name: 'left behind' }]);
  });

  it('does not reach the next test as that setting', async () => {
    const emptied = await createTestDb();
    const copy = await createTestDb();
    expect(await applicationName(emptied)).toEqual(await applicationName(copy));
  });
});

/* What the planner knows of the tables and indexes, and of the rows in them: the next test is planned as on a new copy,
   and the order a query reads rows in does not depend on the tests before. */
const plannerView = (db: Db) => db.execute(sql`select c.relname, c.relkind, c.relpages, c.reltuples, c.relallvisible, pg_relation_size(c.oid)::int as size from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'i') order by c.relname`);

describe('what a test leaves for the planner', { shuffle: false }, () => {
  it('can be rows in the tables it wrote', async () => {
    const db = await createTestDb();
    await numberedEvent(db);
  });

  it('is gone for the next test, as on a new copy', async () => {
    const emptied = await createTestDb();
    const copy = await createTestDb();
    expect((await plannerView(emptied)).rows).toEqual((await plannerView(copy)).rows);
  });

  it('can be statistics an analyze made of every table', async () => {
    const db = await createTestDb();
    await db.insert(companies).values({ name: 'Acme' });
    await db.execute(sql`analyze`);
    expect((await statistics(db)).rows).not.toEqual([]);
  });

  it('does not reach the next test as statistics', async () => {
    const emptied = await createTestDb();
    expect((await statistics(emptied)).rows).toEqual([]);
    const copy = await createTestDb();
    expect((await plannerView(emptied)).rows).toEqual((await plannerView(copy)).rows);
  });

  it('does not fail its file', async () => {
    const db = await createTestDb();
    await db.execute(sql`analyze`);
    await expect(checkSharedDatabase()).resolves.toBeUndefined();
  });
});

/* A truncate empties a table for less than a rewrite does, but must name every table whose foreign keys point at the ones
   it empties, and the tables a test left alone are many. */
describe('the tables a test wrote', () => {
  it('are truncated when only tables emptied with them point at them', () => {
    const pointedAtBy = new Map([['agents', ['agent_events', 'agents', 'jobs']], ['jobs', ['agent_events']], ['companies', ['agents', 'people']]]);
    expect(truncatable(['agent_events', 'agents', 'jobs', 'companies'], pointedAtBy)).toEqual(['agent_events', 'agents', 'jobs']);
  });

  it('are not truncated when a table left alone points at them, or at a table that points at them', () => {
    const pointedAtBy = new Map([['agents', ['agent_events', 'jobs']], ['jobs', ['turns']]]);
    expect(truncatable(['agent_events', 'agents', 'jobs'], pointedAtBy)).toEqual(['agent_events']);
  });
});

describe('rows a file makes once', { shuffle: false }, () => {
  let made = 0;
  const acme = (db: Db) => fixture(db.$client, 'acme', async () => {
    made += 1;
    const seq = await numberedEvent(db);
    const [company] = await db.select().from(companies);
    return { company: company!, seq };
  });
  const nextEvent = async (db: Db) => {
    const [agent] = await db.select().from(agents);
    const [event] = await db.insert(agentEvents).values({ companyId: agent!.companyId, agentId: agent!.id, kind: 'message', data: {} }).returning();
    return event!.seq;
  };
  let first: Awaited<ReturnType<typeof acme>>;

  it('are made by the first test that asks for them', async () => {
    const db = await createTestDb();
    first = await acme(db);
    expect(made).toBe(1);
    expect(await db.select().from(companies)).toEqual([first.company]);
  });

  it('are there for the next test as they were made, without being made again', async () => {
    const db = await createTestDb();
    const again = await acme(db);
    expect(made).toBe(1);
    expect(again).toEqual(first);
    expect(await db.select().from(companies)).toEqual([first.company]);
    expect(await nextEvent(db)).toBe(first.seq + 1);
    await db.update(companies).set({ name: 'Changed' });
    again.company.name = 'Changed';
  });

  it('come back for each test without what the test before changed', async () => {
    const db = await createTestDb();
    const again = await acme(db);
    expect(again).toEqual(first);
    expect(await db.select().from(companies)).toEqual([first.company]);
    expect(await nextEvent(db)).toBe(first.seq + 1);
  });

  it('are made again on other rows, as on any database', async () => {
    const db = await createTestDb();
    await db.insert(companies).values({ name: 'Other' });
    /* Here the second company is refused, as a Hornhoof has one. */
    await expect(acme(db)).rejects.toThrow();
    expect(made).toBe(2);
  });

  it('can stand on other rows made once, and come back on them', async () => {
    let layers = 0;
    const team = (db: Db) => fixture(db.$client, 'team', async () => {
      layers += 1;
      const [company] = await db.select().from(companies);
      const [agent] = await db.insert(agents).values({ companyId: company!.id, kind: 'worker', name: 'Bruno', model: '' }).returning();
      return agent!;
    });
    const names = (db: Db) => db.select(only(agents, 'name')).from(agents).orderBy(agents.name);
    const first = await createTestDb();
    await acme(first);
    const bruno = await team(first);
    await first.$client.close();
    const second = await createTestDb();
    await acme(second);
    expect(await team(second)).toEqual(bruno);
    expect(layers).toBe(1);
    expect(await names(second)).toEqual([{ name: 'Bruno' }, { name: 'Orchestrator' }]);
  });

  it('are made again while the clock is not real, as made ones would hold the time of the real one', async () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T00:00:00Z'), toFake: ['Date'] });
    try {
      const db = await createTestDb();
      await acme(db);
      expect(made).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

async function applicationName(db: Db): Promise<unknown[]> {
  return (await db.execute(sql`select current_setting('application_name') as name`)).rows;
}

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
    await expect(late()).rejects.toMatchObject({ cause: { message: 'PGlite is closed' } });
    expect(await db.select().from(companies)).toEqual([]);
  });

  it('can be a transaction still running', async () => {
    const db = await createTestDb();
    await new Promise<void>(begun => {
      running = db.transaction(async tx => {
        await tx.insert(companies).values({ name: 'Running' });
        begun();
        /* It goes on once its test has let go of the database, so it still runs when the test ends. */
        await until(() => db.$client.closed);
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

/* A test can end while the rows it asked for are still being made, as when its time runs out on a busy machine. Made
   again, they would cost the next test the same time, and it would run out of time too. */
describe('rows a test was still making when it ended', { shuffle: false }, () => {
  let made = 0;
  let firstSeq = 0;
  let begun: () => void = () => {};
  let ended: () => void = () => {};
  const acme = (db: Db) => fixture(db.$client, 'acme, made as its test ends', async () => {
    made += 1;
    const seq = await numberedEvent(db);
    if (made === 1) {
      firstSeq = seq;
      begun();
      /* The rest is made once its test has ended, a turn of the event loop later. */
      await new Promise<void>(go => (ended = go));
      await new Promise(next => setImmediate(next));
    }
    const [agent] = await db.select().from(agents);
    const [event] = await db.insert(agentEvents).values({ companyId: agent!.companyId, agentId: agent!.id, kind: 'message', data: {} }).returning();
    return { seq, last: event!.seq };
  });
  /* Rows that stand on those, which a test cut off goes on to ask for once they are made. */
  let layers = 0;
  const team = (db: Db) => fixture(db.$client, 'team on acme, made as its test ends', async () => {
    layers += 1;
    const [company] = await db.select().from(companies);
    return (await db.insert(agents).values({ companyId: company!.id, kind: 'worker', name: 'Bruno', model: '' }).returning())[0]!;
  });
  let bruno: unknown;

  it.fails('can end with them half made, as at its time limit', async () => {
    const db = await createTestDb();
    await new Promise<void>(go => {
      begun = go;
      acme(db).then(async () => (bruno = await team(db))).catch(() => {});
    });
    onTestFinished(() => ended());
    throw new Error('As if this test had run out of time.');
  });

  it('are kept for the next test whole, with those it went on to, and it does not make them again', async () => {
    const db = await createTestDb();
    expect(await acme(db)).toEqual({ seq: firstSeq, last: firstSeq + 1 });
    expect(await team(db)).toEqual(bruno);
    expect([made, layers]).toEqual([1, 1]);
    expect(await db.select({ seq: agentEvents.seq }).from(agentEvents).orderBy(agentEvents.seq)).toEqual([{ seq: firstSeq }, { seq: firstSeq + 1 }]);
    expect(await db.select({ name: agents.name }).from(agents).orderBy(agents.name)).toEqual([{ name: 'Bruno' }, { name: 'Orchestrator' }]);
  });

  it('do not hold up the end of a test that left the clock not real', async () => {
    /* Hooks run last first: the clock is real again only after the wait for rows. */
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const db = await createTestDb();
    await acme(db);
    vi.useFakeTimers();
  });
});

describe('a test run', () => {
  it('is in one time zone, wherever the machine is', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC');
  });
});
