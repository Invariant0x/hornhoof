import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { machines } from '../src/db/schema.js';
import { minuteRound } from '../src/modules/agents/timers.js';
import { aclCompany, type AclCompany } from './agent-view-company.js';
import { as } from './helpers.js';
import { freshPglite } from './helpers-db.js';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';

const SINCE = '2026-11-20T12:00:00.000Z';
const HOUR = 60 * 60_000;
const from = (id: string) => ({ remoteAddress: '127.0.0.1', headers: { 'x-hornhoof-via': id, 'x-hornhoof-keeper': '1' } });

async function failures(c: AclCompany, token: string, query = '') {
  const answer = await c.app.inject({ url: `/api/requests${query}`, ...as(token) });
  expect(answer.statusCode).toBe(200);
  return answer.json<{ copySchemaFailures?: unknown[] }>().copySchemaFailures ?? [];
}

describe('a replica that cannot load the database schema', () => {
  it('shows the original attempt after one hour only to the machine owner and CEO, until the schema loads', async () => {
    const c = await aclCompany({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: 'a1b2c3d4'.repeat(4) });
    const [copy, worker] = await c.db.insert(machines).values([
      { companyId: c.companyId, personId: c.ids.bob, machineKey: 'copy-key-12345', hostname: 'Replica', role: 'data' },
      { companyId: c.companyId, personId: c.ids.bob, machineKey: 'worker-key-12345', hostname: 'Worker', role: 'worker' },
    ]).returning();
    let now = Date.parse(SINCE);
    c.app.ctx.clock = () => now;
    const report = async (machine: string, attempt: number, schema: { attempt: number; since: string } | null) => {
      const answer = await c.app.inject({ method: 'POST', url: '/api/network/report', ...from(machine), payload: {
        copy: { state: 'making', progress: 0, at: null, error: null, name: `copy_0123456789abcdef_${attempt}`, old: null, schema },
      } });
      expect(answer.statusCode).toBe(204);
    };
    await report(copy!.id, 1, { attempt: 1, since: SINCE });
    await report(worker!.id, 1, { attempt: 1, since: SINCE });
    now += HOUR;
    expect(await failures(c, c.tokens.ceo)).toEqual([]);
    await report(copy!.id, 6, { attempt: 1, since: SINCE });
    now++;
    const card = { id: copy!.id, hostname: 'Replica', since: SINCE, attempt: 1 };
    const events: string[] = [];
    const unsub = c.app.ctx.bus.subscribe(c.companyId, event => { if (event.type === 'requests') events.push(event.type); });
    try {
      await minuteRound(c.app.ctx, new Date(now), () => () => {});
      expect(events).toContain('requests');
      for (const token of [c.tokens.ceo, c.tokens.bob]) expect(await failures(c, token)).toEqual([card]);
      for (const token of [c.tokens.ann, c.tokens.wes, c.tokens.clara]) expect(await failures(c, token)).toEqual([]);
      expect(await failures(c, c.tokens.ceo, `?person=${c.ids.ann}`)).toEqual([]);
      events.length = 0;
      await report(copy!.id, 6, null);
      expect(events).toContain('requests');
      expect(await failures(c, c.tokens.ceo)).toEqual([]);
      expect(await failures(c, c.tokens.bob)).toEqual([]);
    } finally {
      unsub();
    }
  });
});

it('upgrades existing replica rows without inventing a failed attempt', async () => {
  const client = await freshPglite();
  onTestFinished(() => client.close());
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: await migrationsBefore('copy_schema_wait') });
  await db.execute(sql`INSERT INTO companies (name) VALUES ('Example')`);
  await db.execute(sql`INSERT INTO people (company_id, name, email, status, scope_kind)
    SELECT id, 'Owner', 'owner@example.test', 'active', 'company' FROM companies`);
  await db.execute(sql`INSERT INTO machines (company_id, person_id, machine_key, hostname, role, copy_state, copy_name)
    SELECT company_id, id, 'stand-copy-key', 'Replica', 'data', 'making', 'copy_0123456789abcdef_2' FROM people`);
  const migrationsFolder = await migrationsThrough('copy_schema_wait');
  await migrate(db, { migrationsFolder });
  await migrate(db, { migrationsFolder });
  const result = await db.execute(sql`SELECT hostname, copy_state, copy_name, copy_schema_attempt, copy_schema_since FROM machines`);
  expect(result.rows).toEqual([{
    hostname: 'Replica', copy_state: 'making', copy_name: 'copy_0123456789abcdef_2', copy_schema_attempt: null, copy_schema_since: null,
  }]);
});
