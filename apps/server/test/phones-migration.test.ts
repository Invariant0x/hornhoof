import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { expect, it, onTestFinished } from 'vitest';
import { freshPglite, ownDatabases } from './helpers-db.js';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';
import { agents, jobs, machines, nodes, people, phoneSessions, subscriptions } from '../src/db/schema.js';

ownDatabases();

it('adds phones on a fresh database and upgrades existing company data without changing it', async () => {
  const client = await freshPglite();
  onTestFinished(() => client.close());
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: await migrationsBefore('company_phones') });
  await client.exec("INSERT INTO companies(id, name) VALUES ('11111111-1111-4111-8111-111111111111', 'Existing company'); INSERT INTO tasks(company_id, number, title) VALUES ('11111111-1111-4111-8111-111111111111', 1, 'Existing task');");
  const through = await migrationsThrough('company_phones');
  await migrate(db, { migrationsFolder: through });
  expect((await client.query('SELECT name FROM companies')).rows).toEqual([{ name: 'Existing company' }]);
  expect((await client.query('SELECT title FROM tasks')).rows).toEqual([{ title: 'Existing task' }]);
  expect((await client.query('SELECT count(*)::int AS n FROM company_phones')).rows).toEqual([{ n: 0 }]);
  expect((await client.query("SELECT column_default FROM information_schema.columns WHERE table_name = 'phone_sessions' AND column_name = 'queue_order'")).rows[0]).toHaveProperty('column_default');
  const companyId = '11111111-1111-4111-8111-111111111111';
  const [owner] = await db.insert(people).values({ companyId, name: 'Phone owner', email: 'owner@recorded.invalid', status: 'active', scopeKind: 'company' }).returning({ id: people.id });
  const [machine] = await db.insert(machines).values({ companyId, personId: owner!.id, machineKey: 'recorded-machine' }).returning({ id: machines.id });
  const [node] = await db.insert(nodes).values({ companyId, machineId: machine!.id }).returning({ id: nodes.id });
  const phoneId = '22222222-2222-4222-8222-222222222222';
  await client.query('INSERT INTO company_phones(id, company_id, person_id, machine_id, node_id, serial, transport, name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [phoneId, companyId, owner!.id, machine!.id, node!.id, 'R58MIDENTITY', 'usb', 'Existing phone']);
  const [agent] = await db.insert(agents).values({ companyId, kind: 'assistant', name: 'Existing assistant', model: '' }).returning({ id: agents.id });
  const [sub] = await db.insert(subscriptions).values({ companyId, ownerPersonId: owner!.id, provider: 'claude', kind: 'personal', label: 'Existing plan', status: 'ready' }).returning({ id: subscriptions.id });
  const [job] = await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: agent!.id, prompt: 'recorded', timeoutMs: 1000 }).returning({ id: jobs.id });
  const taskRows = await client.query<{ id: string }>('SELECT id FROM tasks');
  await db.insert(phoneSessions).values({ companyId, phoneId, agentId: agent!.id, jobId: job!.id, taskId: taskRows.rows[0]!.id, status: 'active', generation: 0 });
  const verified = await migrationsThrough('phone_identity');
  await migrate(db, { migrationsFolder: verified });
  expect((await client.query('SELECT name, lending, generation, hardware_key FROM company_phones')).rows).toEqual([{ name: 'Existing phone', lending: false, generation: 1, hardware_key: null }]);
  expect((await client.query('SELECT status, reason, ended_at IS NOT NULL AS ended FROM phone_sessions')).rows).toEqual([{ status: 'ended', reason: 'lost', ended: true }]);
  await migrate(db, { migrationsFolder: verified });
  expect((await client.query('SELECT generation FROM company_phones')).rows).toEqual([{ generation: 1 }]);
  expect((await client.query('SELECT title FROM tasks')).rows).toEqual([{ title: 'Existing task' }]);

  const fresh = await freshPglite();
  onTestFinished(() => fresh.close());
  await migrate(drizzle(fresh), { migrationsFolder: verified });
  expect((await fresh.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('company_phones', 'phone_sessions', 'phone_frames') ORDER BY table_name")).rows).toEqual([{ table_name: 'company_phones' }, { table_name: 'phone_frames' }, { table_name: 'phone_sessions' }]);
});
