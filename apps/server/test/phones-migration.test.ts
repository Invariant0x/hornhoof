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
  const companyId = '11111111-1111-4111-8111-111111111111';
  await client.exec(`INSERT INTO companies(id, name) VALUES ('${companyId}', 'Existing company'); INSERT INTO tasks(company_id, number, title) VALUES ('${companyId}', 1, 'Existing task');`);
  const through = await migrationsThrough('company_phones');
  await migrate(db, { migrationsFolder: through });
  await migrate(db, { migrationsFolder: through });
  expect((await client.query('SELECT name FROM companies')).rows).toEqual([{ name: 'Existing company' }]);
  expect((await client.query('SELECT title FROM tasks')).rows).toEqual([{ title: 'Existing task' }]);
  expect((await client.query('SELECT count(*)::int AS n FROM company_phones')).rows).toEqual([{ n: 0 }]);

  const [owner] = await db.insert(people).values({ companyId, name: 'Phone owner', email: 'owner@recorded.invalid', status: 'active', scopeKind: 'company' }).returning({ id: people.id });
  const [machine] = await db.insert(machines).values({ companyId, personId: owner!.id, machineKey: 'recorded-machine' }).returning({ id: machines.id });
  const [node] = await db.insert(nodes).values({ companyId, machineId: machine!.id }).returning({ id: nodes.id });
  const [agent] = await db.insert(agents).values({ companyId, kind: 'assistant', name: 'Existing assistant', model: '' }).returning({ id: agents.id });
  const [sub] = await db.insert(subscriptions).values({ companyId, ownerPersonId: owner!.id, provider: 'claude', kind: 'personal', label: 'Existing plan', status: 'ready' }).returning({ id: subscriptions.id });
  const [job] = await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: agent!.id, prompt: 'recorded', timeoutMs: 1000 }).returning({ id: jobs.id });
  const taskId = (await client.query<{ id: string }>('SELECT id FROM tasks')).rows[0]!.id;
  /* A turn may wait with no phone, but it never holds a session without one. */
  await db.insert(phoneSessions).values({ companyId, phoneId: null, agentId: agent!.id, jobId: job!.id, taskId });
  await expect(db.insert(phoneSessions).values({ companyId, phoneId: null, agentId: agent!.id, jobId: job!.id, taskId, status: 'active', generation: 1 })).rejects.toThrow();
  await expect(client.query('INSERT INTO company_phones(company_id, person_id, machine_id, node_id, serial, transport, name) VALUES ($1,$2,$3,$4,$5,$6,$7)', [companyId, owner!.id, machine!.id, node!.id, 'R58MIDENTITY', 'usb', 'Phone with no verified identity'])).rejects.toThrow();

  const fresh = await freshPglite();
  onTestFinished(() => fresh.close());
  await migrate(drizzle(fresh), { migrationsFolder: through });
  expect((await fresh.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('company_phones', 'phone_sessions', 'phone_frames', 'phone_actions') ORDER BY table_name")).rows).toEqual([{ table_name: 'company_phones' }, { table_name: 'phone_actions' }, { table_name: 'phone_frames' }, { table_name: 'phone_sessions' }]);
});
