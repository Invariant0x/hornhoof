import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { migrationsBefore } from './migrations-before.js';
import { freshPglite } from './helpers-db.js';

type Db = ReturnType<typeof drizzle>;
const ids = async (db: Db, query: ReturnType<typeof sql>) => (await db.execute<{ id: string }>(query)).rows[0]!.id;

/* A company as a database at the previous release holds it, with what the migration must and must not touch. */
async function company(db: Db, name: string, singleton = true) {
  const id = await ids(db, sql`insert into companies (name, singleton) values (${name}, ${singleton}) returning id`);
  const person = await ids(db, sql`insert into people (company_id, name, email, status, scope_kind) values (${id}, ${name}, ${`${randomUUID()}@acme.test`}, 'active', 'company') returning id`);
  const ops = await ids(db, sql`insert into departments (company_id, template_key, role_code) values (${id}, 'operations', 'OPS') returning id`);
  const plan = (kind: 'personal' | 'api_key', removed = false) => ids(db, sql`insert into subscriptions (company_id, provider, kind, label, owner_person_id, status, removed_at) values (${id}, 'codex', ${kind}, 'Plan', ${person}, 'ready', ${removed ? new Date().toISOString() : null}) returning id`);
  const machine = () => ids(db, sql`insert into machines (company_id, person_id, machine_key, hostname) values (${id}, ${person}, ${randomUUID()}, 'Machine') returning id`);
  const node = async (subscription: string, key: string | null, createdAt = '2026-11-01T00:00:00Z') => ids(db, sql`insert into nodes (company_id, machine_id, subscription_id, key_hash, status, version, created_at) values (${id}, ${await machine()}, ${subscription}, ${key}, 'ready', '0.7.0', ${createdAt}) returning id`);
  const agent = (values: { role?: string; plan?: string | null; node?: string | null; removed?: boolean; kind?: 'worker' | 'head' }) => ids(db, sql`insert into agents (company_id, name, kind, role_key, department_id, subscription_id, node_id, model, removed_at) values (${id}, ${randomUUID()}, ${values.kind ?? 'worker'}, ${values.role ?? 'OPS-PROGRAM'}, ${ops}, ${values.plan ?? null}, ${values.node ?? null}, '', ${values.removed ? new Date().toISOString() : null}) returning id`);
  return { plan, node, agent };
}

const nodeOf = async (db: Db, agent: string) => (await db.execute<{ node_id: string | null }>(sql`select node_id from agents where id = ${agent}`)).rows[0]!.node_id;

async function previousRelease() {
  const client = await freshPglite();
  onTestFinished(() => client.close());
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: await migrationsBefore('program_operator_nodes') });
  return db;
}

it('puts each program operator of every company on the oldest live machine of its plan, and leaves everyone else alone', { timeout: 120_000 }, async () => {
  const db = await previousRelease();
  const acme = await company(db, 'Acme'), other = await company(db, 'Other', false);

  const plan = await acme.plan('personal');
  const dead = await acme.node(plan, null, '2026-10-01T00:00:00Z');
  const oldest = await acme.node(plan, 'key-1', '2026-11-01T00:00:00Z');
  await acme.node(plan, 'key-2', '2026-11-02T00:00:00Z');
  const operator = await acme.agent({ plan });

  const otherPlan = await other.plan('personal');
  const otherNode = await other.node(otherPlan, 'key-3');
  const otherOperator = await other.agent({ plan: otherPlan });

  const placed = await acme.agent({ plan, node: dead });
  const worker = await acme.agent({ plan, role: 'OPS-WATCH' });
  const head = await acme.agent({ plan, role: 'OPS-HEAD', kind: 'head' });
  const gone = await acme.agent({ plan, removed: true });
  const planless = await acme.agent({ plan: null });
  const onKey = await acme.agent({ plan: await acme.plan('api_key') });
  const noMachine = await acme.agent({ plan: await acme.plan('personal') });
  const onlyDead = await acme.plan('personal');
  await acme.node(onlyDead, null);
  const deadMachine = await acme.agent({ plan: onlyDead });
  const removedPlan = await acme.plan('personal', true);
  await acme.node(removedPlan, 'key-4');
  const planGone = await acme.agent({ plan: removedPlan });

  const before = (await db.execute(sql`select id, name, kind, role_key, department_id, subscription_id, model, removed_at from agents order by id`)).rows;
  await migrate(db, { migrationsFolder: MIGRATIONS });

  expect(await nodeOf(db, operator)).toBe(oldest);
  expect(await nodeOf(db, otherOperator)).toBe(otherNode);
  expect(await nodeOf(db, placed)).toBe(dead);
  for (const untouched of [worker, head, gone, planless, onKey, noMachine, deadMachine, planGone]) expect(await nodeOf(db, untouched)).toBeNull();
  expect((await db.execute(sql`select id, name, kind, role_key, department_id, subscription_id, model, removed_at from agents order by id`)).rows).toEqual(before);
});

it('changes nothing on a fresh database', { timeout: 120_000 }, async () => {
  const client = await freshPglite();
  onTestFinished(() => client.close());
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: MIGRATIONS });
  expect((await db.execute(sql`select count(*)::int as n from agents`)).rows).toEqual([{ n: 0 }]);
});
