import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { readerGrantsFor, readerRole } from '../src/db/agent-sql.js';
import { agents, assistants, companies, people } from '../src/db/schema.js';
import { createTestDb, ownDatabases } from './helpers-db.js';

ownDatabases();

it('enforces OPS-HEAD isolation of assistants tables and assistant agents through security_invoker views without table names in the query', async () => {
  const db = await createTestDb();
  const { $client: client } = db;
  const reader = readerRole('postgres');
  await client.exec(readerGrantsFor(reader));

  const [acme] = await db.insert(companies).values({ name: 'Acme' }).returning();
  const [owner] = await db
    .insert(people)
    .values({ companyId: acme!.id, name: 'Ivan', email: 'ivan@acme.test', status: 'active', scopeKind: 'company', isOwner: true })
    .returning();
  const [avaPerson] = await db
    .insert(people)
    .values({ companyId: acme!.id, name: 'Ava', email: null, status: 'active', scopeKind: 'listed', isAgent: true, assistantOf: owner!.id })
    .returning();
  const [worker] = await db.insert(agents).values({ companyId: acme!.id, kind: 'worker', name: 'Bruno', model: '' }).returning();
  const [avaAgent] = await db.insert(agents).values({ companyId: acme!.id, kind: 'assistant', name: 'Ava', model: '' }).returning();
  await db.insert(assistants).values({ personId: avaPerson!.id, companyId: acme!.id, program: 'avaclone', agentId: avaAgent!.id });

  await db.execute(sql.raw(`CREATE VIEW public.staff_directory WITH (security_invoker = true) AS SELECT id, name, kind FROM public.agents`));
  await db.execute(sql.raw(`CREATE VIEW public.helper_cards WITH (security_invoker = true) AS SELECT person_id, program, agent_id FROM public.assistants`));
  await db.execute(sql.raw(`GRANT SELECT ON public.staff_directory, public.helper_cards TO "${reader}"`));

  const asRole = (role: string, statement: string) =>
    client.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE "${role}"`);
      return tx.query(statement);
    });

  /* OPS-HEAD querying views whose SQL text names neither agents nor assistants still sees only Bruno and gets denied on assistants. */
  const visibleStaff = await asRole(reader, 'SELECT id, name, kind FROM public.staff_directory ORDER BY name');
  expect(visibleStaff.rows).toEqual([{ id: worker!.id, name: 'Bruno', kind: 'worker' }]);
  await expect(asRole(reader, 'SELECT person_id, program, agent_id FROM public.helper_cards')).rejects.toThrow(/permission denied/);

  /* The orchestrator, as Hornhoof itself, sees both rows through staff_directory and reads helper_cards. */
  const allStaff = await client.query('SELECT name, kind FROM public.staff_directory ORDER BY name');
  expect(allStaff.rows).toEqual([
    { name: 'Ava', kind: 'assistant' },
    { name: 'Bruno', kind: 'worker' },
  ]);
  const cards = await client.query('SELECT person_id, program, agent_id FROM public.helper_cards');
  expect(cards.rows).toEqual([{ person_id: avaPerson!.id, program: 'avaclone', agent_id: avaAgent!.id }]);
});
