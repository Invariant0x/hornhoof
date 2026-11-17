import { expect, it } from 'vitest';
import { agentRole, grantsFor } from '../src/db/agent-sql.js';
import { agents, companies, departments, people, requests, subscriptions, tasks, turnReleases, turns } from '../src/db/schema.js';
import { createTestDb, ownDatabases } from './helpers-db.js';

ownDatabases();

const SHA = (c: string) => c.repeat(40);

/* A turn's release names what approved its commit, and only a release kept there closes a turn; a task's route names
   who produced each candidate, its stages and the paths its head approved. Hornhoof alone writes both, through the head's
   release_turn and the task tools, so the orchestrator's SQL reads them and can neither forge, change nor remove a row. */
async function company() {
  const db = await createTestDb();
  const client = db.$client;
  const [{ id: companyId }] = (await db.insert(companies).values({ name: 'Acme' }).returning()) as [{ id: string }];
  const [person] = await db.insert(people).values({ companyId, name: 'Ivan', email: 'ivan@acme.example', status: 'active', scopeKind: 'company' }).returning();
  const [plan] = await db.insert(subscriptions).values({ companyId, provider: 'anthropic_api', kind: 'api_key', label: 'Plan', ownerPersonId: person!.id, status: 'ready' }).returning();
  const [agent] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Bruno', model: '', subscriptionId: plan!.id }).returning();
  const [department] = await db.insert(departments).values({ companyId, name: 'Engineering', roleCode: 'DEV' }).returning();
  const [turn] = await db.insert(turns).values({ companyId, departmentId: department!.id, number: 1, goal: 'Ship the tracker.' }).returning();
  const [routed, unrouted] = await db.insert(tasks).values([
    { companyId, number: 1, title: 'Checked change', turnId: turn!.id },
    { companyId, number: 2, title: 'Unchecked change', turnId: turn!.id },
  ]).returning();
  await client.query('INSERT INTO task_routes (task_id, company_id, state, paths) VALUES ($1, $2, $3, $4)', [
    routed!.id, companyId, JSON.stringify({ phase: 'active', stage: 'review' }), JSON.stringify(['apps/server/src/db/agent-sql.ts']),
  ]);
  const [approval] = await db.insert(requests).values({ companyId, taskId: routed!.id, agentId: agent!.id, kind: 'approval', text: 'Release?', status: 'approved', commit: SHA('c') }).returning();
  await db.insert(turnReleases).values({ companyId, turnId: turn!.id, commit: SHA('c'), baseCommitSha: SHA('a'), taskId: routed!.id, approvalRequestId: approval!.id, covered: false, uncovered: [unrouted!.id] });
  const role = agentRole('postgres');
  await client.exec(grantsFor(role));
  const run = (text: string) => client.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE "${role}"`);
    return tx.exec(text);
  });
  return { client, role, run, ids: { companyId, turnId: turn!.id, routed: routed!.id, unrouted: unrouted!.id, approval: approval!.id } };
}
type Ids = Awaited<ReturnType<typeof company>>['ids'];

const TABLES: { table: string; key: string; forged: (ids: Ids) => string; changed: string; read: string }[] = [
  {
    table: 'turn_releases',
    key: 'id',
    forged: ids => `INSERT INTO turn_releases (company_id, turn_id, commit, base_commit_sha, task_id, approval_request_id, covered)
      VALUES ('${ids.companyId}', '${ids.turnId}', '${SHA('d')}', '${SHA('a')}', '${ids.unrouted}', '${ids.approval}', true)`,
    changed: `UPDATE turn_releases SET covered = true, uncovered = '[]', commit = '${SHA('d')}'`,
    read: 'SELECT commit, base_commit_sha, task_id, approval_request_id, autonomous_release_id, covered, uncovered FROM turn_releases',
  },
  {
    table: 'task_routes',
    key: 'task_id',
    forged: ids => `INSERT INTO task_routes (task_id, company_id, state, paths) VALUES ('${ids.unrouted}', '${ids.companyId}', '{"phase":"done"}', '["**"]')`,
    changed: `UPDATE task_routes SET state = jsonb_set(state, '{stage}', '"tests"'), paths = '["**"]', revision = revision + 1`,
    read: 'SELECT task_id, revision, state, paths FROM task_routes',
  },
];

it.each(TABLES)('keeps $table out of the orchestrator\'s writes and open to its reads', async ({ table, key, forged, changed, read }) => {
  const { client, role, run, ids } = await company();
  const before = (await client.query(`${read} ORDER BY 1`)).rows;
  const denied = new RegExp(`permission denied for table ${table}`);
  for (const text of [
    forged(ids),
    `INSERT INTO ${table} SELECT * FROM ${table}`,
    changed,
    `DELETE FROM ${table}`,
    `TRUNCATE ${table}`,
    `WITH added AS (${forged(ids)} RETURNING 1) SELECT * FROM added`,
    `WITH moved AS (${changed} RETURNING 1) SELECT * FROM moved`,
    `WITH gone AS (DELETE FROM ${table} RETURNING 1) SELECT count(*) FROM gone`,
    `MERGE INTO ${table} t USING ${table} o ON t.${key} = o.${key} WHEN MATCHED THEN DELETE`,
    `DO $$ BEGIN DELETE FROM ${table}; END $$`,
  ]) await expect(run(text), text).rejects.toThrow(denied);
  expect((await run(`${read} ORDER BY 1`))[0]!.rows).toEqual(before);
  expect(before).toHaveLength(1);
  expect((await client.query(`${read} ORDER BY 1`)).rows).toEqual(before);
  const { rows } = await client.query<Record<string, boolean>>(`SELECT
    has_table_privilege('${role}', '${table}', 'INSERT') OR has_any_column_privilege('${role}', '${table}', 'INSERT') AS adds,
    has_table_privilege('${role}', '${table}', 'UPDATE') OR has_any_column_privilege('${role}', '${table}', 'UPDATE') AS changes,
    has_table_privilege('${role}', '${table}', 'DELETE') AS removes,
    has_table_privilege('${role}', '${table}', 'TRUNCATE') AS empties,
    has_any_column_privilege('${role}', '${table}', 'SELECT') AS reads`);
  expect(rows).toEqual([{ adds: false, changes: false, removes: false, empties: false, reads: true }]);
  await client.exec(`GRANT INSERT, UPDATE, DELETE, TRUNCATE ON ${table} TO "${role}"`);
  await client.exec(grantsFor(role));
  await expect(run(forged(ids)), 'a right left from an earlier build').rejects.toThrow(denied);
});
