import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { ownDatabases, setUpCompany, testApp } from './helpers.js';

ownDatabases();

it('keeps suppression records out of agent SQL, and leaves the database no function or trigger that sees a value', async () => {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const agentSql = app.ctx.agentSql!;
  await expect(agentSql.run('select * from secret_redactions', 'read')).rejects.toMatchObject({ code: '42501' });
  await expect(agentSql.run('delete from secret_redactions', 'write')).rejects.toMatchObject({ code: '42501' });
  const left = await db.execute(sql`select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'net') and p.proname ~ '(hide_secret|hidden_secret|secret_company|secret_text)'
    union all select t.tgname from pg_trigger t where t.tgname ~ 'hidden_secrets'`) as { rows: { name: string }[] };
  expect(left.rows).toEqual([]);
});
