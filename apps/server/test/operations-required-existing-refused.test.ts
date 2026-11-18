import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies } from '../src/db/schema.js';
import { checkOperations } from '../src/modules/operations/ensure.js';
import { ownDatabases } from './helpers.js';
import { company, FOUR, staffedLike } from './operations-required-fixture.js';

/* A trigger here refuses the hires of one company, which changes more than rows, so each test opens a database of its own. */
ownDatabases();

describe('a company that lives already', () => {
  it('goes on with the rest of the check when one company fails, and reports it', async () => {
    const { app, db, companyId } = await company();
    await db.insert(companies).values({ name: 'Globex', singleton: false });
    await db.execute(sql`create function refuse_hire() returns trigger language plpgsql as $$ begin if new.company_id = ${sql.raw(`'${companyId}'`)} then raise exception 'no hire'; end if; return new; end $$`);
    await db.execute(sql`create trigger refuse_hire before insert on agents for each row execute function refuse_hire()`);
    await staffedLike(db, companyId, () => false);
    const failures: unknown[] = [];
    await checkOperations(app.ctx, err => failures.push(err));
    expect(failures).toHaveLength(1);
    const globex = (await db.select().from(companies)).find(c => c.name === 'Globex')!;
    const hired = await db.select().from(agents).where(eq(agents.companyId, globex.id));
    expect(hired.map(a => a.roleKey).sort()).toEqual(FOUR);
  });
});
