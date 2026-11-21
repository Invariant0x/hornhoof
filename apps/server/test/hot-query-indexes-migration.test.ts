import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { createTestDb, freshPglite, ownDatabases, timed } from './helpers-db.js';
import { migrationsThrough } from './migrations-before.js';

ownDatabases();

const EXPECTED_INDEXES = [
  'jobs_agent_conversation_ended',
  'jobs_agent_conversation_retry_waiting',
  'jobs_agent_conversation_obsolete',
  'jobs_agent_conversation_finished',
  'jobs_task_conversation_finished',
  'jobs_company_conversation_running',
  'program_deliveries_live_not_taken',
  'agent_events_operator_fallback',
  'agent_events_operator_delivery',
  'agent_events_operator_evidence_delivery',
  'agent_events_operator_evidence_instance',
  'agent_events_operator_recovery_case',
] as const;

const before = await migrationsThrough('request_unchecked');

const previous = await freshPglite();
let previousDump: Blob;
try {
  await migrate(drizzle(previous), { migrationsFolder: before });
  previousDump = await previous.dumpDataDir('none');
} finally {
  await previous.close();
}

it('installs every hot-path index on a fresh migrated database', async () => {
  const db = await createTestDb();
  const { rows } = await db.execute<{ indexname: string }>(
    sql`select indexname from pg_indexes where schemaname = 'public' and indexname = any(${`{${EXPECTED_INDEXES.join(',')}}`}::text[])`,
  );
  expect(rows.map(r => r.indexname).sort()).toEqual([...EXPECTED_INDEXES].sort());
});

it.each([false, true])('upgrades existing rows without loss and tolerates pre-installed indexes=%s across repeated migrations', async installed => {
  const client = await timed('setupMs', async () => {
    const copy = new PGlite({ loadDataDir: previousDump });
    await copy.waitReady;
    return copy;
  });
  onTestFinished(() => client.close());
  const db = drizzle(client);
  const id = async (query: ReturnType<typeof sql>) => (await db.execute<{ id: string }>(query)).rows[0]!.id;
  const company = await id(sql`insert into companies(name, singleton) values('Acme', true) returning id`);
  const person = await id(sql`insert into people(company_id, name, email, status, scope_kind) values(${company}, 'Ann', 'ann@example.test', 'active', 'company') returning id`);
  const agent = await id(sql`insert into agents(company_id, kind, name, model) values(${company}, 'worker', 'Worker', '') returning id`);
  const subscription = await id(sql`insert into subscriptions(company_id, provider, kind, label, owner_person_id, status) values(${company}, 'codex', 'personal', 'Plan', ${person}, 'ready') returning id`);
  const machine = await id(sql`insert into machines(company_id, person_id, machine_key, hostname) values(${company}, ${person}, 'mk-1', 'Host') returning id`);
  const node = await id(sql`insert into nodes(company_id, machine_id, subscription_id, status) values(${company}, ${machine}, ${subscription}, 'ready') returning id`);
  const job = await id(sql`insert into jobs(company_id, subscription_id, agent_id, node_id, kind, prompt, timeout_ms, status, started_at, finished_at) values(${company}, ${subscription}, ${agent}, ${node}, 'conversation', 'Check queue', 60000, 'done', now() - interval '5 minutes', now() - interval '1 minute') returning id`);
  const delivery = await id(sql`insert into program_deliveries(company_id, agent_id, job_id, node_id, ordinal, reference, kind, digest, outcome) values(${company}, ${agent}, ${job}, ${node}, 1, 'ref-1', 'live', 'digest-1', 'not_taken') returning id`);
  await db.execute(sql`insert into agent_events(company_id, agent_id, job_id, kind, data) values(${company}, ${agent}, ${job}, 'message', ${JSON.stringify({ text: 'Hello', operatorDelivery: { id: delivery, ordinal: 1 } })}::jsonb)`);
  const jobsBefore = (await db.execute(sql`select id, status, prompt from jobs`)).rows;
  const eventsBefore = (await db.execute(sql`select id, kind, data from agent_events`)).rows;
  const deliveriesBefore = (await db.execute(sql`select id, kind, outcome from program_deliveries`)).rows;

  if (installed) await client.exec(await readFile(`${MIGRATIONS}/0158_hot_query_indexes.sql`, 'utf8'));
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await migrate(db, { migrationsFolder: MIGRATIONS });

  expect((await db.execute(sql`select id, status, prompt from jobs`)).rows).toEqual(jobsBefore);
  expect((await db.execute(sql`select id, kind, data from agent_events`)).rows).toEqual(eventsBefore);
  expect((await db.execute(sql`select id, kind, outcome from program_deliveries`)).rows).toEqual(deliveriesBefore);
  const { rows } = await db.execute<{ indexname: string }>(
    sql`select indexname from pg_indexes where schemaname = 'public' and indexname = any(${`{${EXPECTED_INDEXES.join(',')}}`}::text[])`,
  );
  expect(rows.map(r => r.indexname).sort()).toEqual([...EXPECTED_INDEXES].sort());
});
