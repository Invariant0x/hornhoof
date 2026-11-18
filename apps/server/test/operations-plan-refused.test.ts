import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { subscriptions } from '../src/db/schema.js';
import { ownDatabases } from './helpers.js';
import { company, operator, addKey } from './operations-plan-fixture.js';

/* A trigger here refuses to move the operator, which changes more than rows, so each test opens a database of its own. */
ownDatabases();

describe("the program operator's plan", () => {
  it('still adds the key when placing the operator fails', async () => {
    const c = await company();
    await c.db.execute(sql`create function refuse_move() returns trigger language plpgsql as $$ begin if new.role_key = 'OPS-PROGRAM' then raise exception 'no move'; end if; return new; end $$`);
    await c.db.execute(sql`create trigger refuse_move before update on agents for each row execute function refuse_move()`);
    const key = await addKey(c);
    expect((await c.db.select().from(subscriptions).where(eq(subscriptions.id, key)))[0]).toBeDefined();
    expect((await operator(c.db)).subscriptionId).toBeNull();
  });
});
