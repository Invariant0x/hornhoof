import { sql } from 'drizzle-orm';
import { people, secretRedactions } from '../src/db/schema.js';
import { expect, it } from 'vitest';
import { ownDatabases, setUpCompany, testApp } from './helpers.js';

ownDatabases();

it('keeps suppression records from Operations, permits the orchestrator to change them, and leaves no value-scanning function or trigger', async () => {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const agentSql = app.ctx.agentSql!;
  await expect(agentSql.run('select * from secret_redactions', 'read')).rejects.toMatchObject({ code: '42501' });
  const [person] = await db.select().from(people);
  await db.insert(secretRedactions).values({ companyId: person!.companyId, personId: person!.id, fingerprint: 'fixture-fingerprint', characters: 8, windowHash: 1 });
  expect((await agentSql.run('delete from secret_redactions', 'write'))[0]!.changed).toBe(1);
  expect(await db.select().from(secretRedactions)).toEqual([]);
  await expect(agentSql.run('delete from secret_redactions', 'read')).rejects.toThrow();
  const left = await db.execute(sql`select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'net') and p.proname ~ '(hide_secret|hidden_secret|secret_company|secret_text)'
    union all select t.tgname from pg_trigger t where t.tgname ~ 'hidden_secrets'`) as { rows: { name: string }[] };
  expect(left.rows).toEqual([]);
});
