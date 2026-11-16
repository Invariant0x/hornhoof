import { expect, it } from 'vitest';
import { ownDatabases, setUpCompany, testApp } from './helpers.js';

ownDatabases();

it('keeps suppression records and privileged scrub functions out of agent SQL', async () => {
  const { app } = await testApp();
  await setUpCompany(app);
  const agentSql = app.ctx.agentSql!;
  await expect(agentSql.run('select * from secret_redactions', 'read')).rejects.toMatchObject({ code: '42501' });
  await expect(agentSql.run('delete from secret_redactions', 'write')).rejects.toMatchObject({ code: '42501' });
  await expect(agentSql.run("select net.hide_secret_text('value')", 'write')).rejects.toMatchObject({ code: '42501' });
  await expect(agentSql.run("select net.hide_secret_row('{}', 'public.tasks')", 'write')).rejects.toMatchObject({ code: '42501' });
});
