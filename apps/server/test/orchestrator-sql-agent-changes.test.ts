import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { agentRole, grantsFor } from '../src/db/agent-sql.js';
import { agentChanges, agents, companies, people, subscriptions } from '../src/db/schema.js';
import { createTestDb, ownDatabases } from './helpers-db.js';

ownDatabases();

/* The history of an employee's card says who changed what, and the orchestrator reads it to find the cause of trouble. Only
   Hornhoof writes it, so the orchestrator's SQL can neither add a line, nor change who made one, nor take one out. */
it("keeps the history of an employee's card out of the orchestrator's writes and open to its reads", async () => {
  const db = await createTestDb();
  const client = db.$client;
  const [company] = await db.insert(companies).values({ name: 'Acme' }).returning();
  const companyId = company!.id;
  const [person] = await db.insert(people).values({ companyId, name: 'Ivan', email: 'ivan@acme.example', status: 'active', scopeKind: 'company' }).returning();
  const [plan] = await db.insert(subscriptions).values({ companyId, provider: 'anthropic_api', kind: 'api_key', label: 'Plan', ownerPersonId: person!.id, status: 'ready' }).returning();
  const [agent] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Bruno', model: '', subscriptionId: plan!.id }).returning();
  const [line] = await db.insert(agentChanges).values({ companyId, agentId: agent!.id, personId: person!.id, field: 'name', before: 'Bruno', after: 'Bruna' }).returning();
  const role = agentRole('postgres');
  await client.exec(grantsFor(role));
  const run = (text: string) => client.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE "${role}"`);
    return tx.exec(text);
  });
  const forged = `INSERT INTO agent_changes (company_id, agent_id, field, before, after) VALUES ('${companyId}', '${agent!.id}', 'model', '"a"', '"b"')`;
  for (const text of [
    forged,
    'INSERT INTO agent_changes SELECT * FROM agent_changes',
    `UPDATE agent_changes SET person_id = NULL, by_orchestrator = true WHERE id = '${line!.id}'`,
    `UPDATE agent_changes SET after = '"Forged"'`,
    `DELETE FROM agent_changes WHERE id = '${line!.id}'`,
    'TRUNCATE agent_changes',
    `WITH added AS (${forged} RETURNING id) SELECT id FROM added`,
    `WITH moved AS (UPDATE agent_changes SET created_at = created_at - interval '1 year' RETURNING id) SELECT id FROM moved`,
    'WITH gone AS (DELETE FROM agent_changes RETURNING id) SELECT count(*) FROM gone',
    'MERGE INTO agent_changes c USING agent_changes o ON c.id = o.id WHEN MATCHED THEN DELETE',
    `DO $$ BEGIN DELETE FROM agent_changes; END $$`,
  ]) await expect(run(text), text).rejects.toThrow(/permission denied for table agent_changes/);
  expect((await run('SELECT agent_id, person_id, by_orchestrator, field, before, after FROM agent_changes'))[0]!.rows).toEqual([
    { agent_id: agent!.id, person_id: person!.id, by_orchestrator: false, field: 'name', before: 'Bruno', after: 'Bruna' },
  ]);
  expect(await db.select().from(agentChanges).where(eq(agentChanges.companyId, companyId))).toEqual([line]);
  const { rows } = await client.query<Record<string, boolean>>(`SELECT
    has_table_privilege('${role}', 'agent_changes', 'INSERT') OR has_any_column_privilege('${role}', 'agent_changes', 'INSERT') AS adds,
    has_table_privilege('${role}', 'agent_changes', 'UPDATE') OR has_any_column_privilege('${role}', 'agent_changes', 'UPDATE') AS changes,
    has_table_privilege('${role}', 'agent_changes', 'DELETE') AS removes,
    has_table_privilege('${role}', 'agent_changes', 'TRUNCATE') AS empties,
    has_any_column_privilege('${role}', 'agent_changes', 'SELECT') AS reads`);
  expect(rows).toEqual([{ adds: false, changes: false, removes: false, empties: false, reads: true }]);
  await client.exec(`GRANT INSERT, UPDATE, DELETE, TRUNCATE ON agent_changes TO "${role}"`);
  await client.exec(grantsFor(role));
  await expect(run(forged), 'a right left from an earlier build').rejects.toThrow(/permission denied for table agent_changes/);
});
