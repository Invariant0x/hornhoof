import { expect, it } from 'vitest';
import { openAgentSql, type AgentSql, type SqlMode } from '../../src/db/agent-sql.js';
import { privatePostgres } from './helpers.js';

/* A write by the reader may be refused for its read-only transaction before its rights are looked at: both are refusals. */
const refused = (mode: SqlMode) => ({ code: expect.stringMatching(mode === 'read' ? /^(42501|25006)$/ : /^42501$/) });

const noRowsChanged = [{ rows: [], changed: 0 }];

async function settingsClosed(sql: AgentSql, mode: SqlMode): Promise<void> {
  expect(await sql.run('SELECT id, channel, mode FROM approval_policies', mode)).toEqual(noRowsChanged);
  expect((await sql.run('SELECT owner_person_id FROM departments', mode))[0]!.changed).toBe(0);
  for (const statement of ['INSERT INTO approval_policies (id) SELECT id FROM approval_policies WHERE false', 'UPDATE approval_policies SET mode = mode WHERE false', 'DELETE FROM approval_policies WHERE false', 'UPDATE departments SET owner_person_id = owner_person_id WHERE false']) {
    await expect(sql.run(statement, mode), `${mode}: ${statement}`).rejects.toMatchObject(refused(mode));
  }
}

/* The deleted gateway's tables, its checks made by a model and its support desk are dropped with the function that
   guarded them. Only Operations' role is checked here: the orchestrator runs as Hornhoof itself (Ivan's word of 17 November 2026). */
it("leaves no table of the deleted gateway, and Operations' production SQL role, signed in as itself, changes no approval rule or owner", async () => {
  const fixture = await privatePostgres();
  const sql = await openAgentSql(fixture.url);
  expect(sql, 'Production openAgentSql must create both LOGIN pools').not.toBeNull();
  if (!sql) throw new Error('Production openAgentSql returned no SQL access');
  fixture.cleanup(() => sql.close());
  const gateway = await fixture.admin.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename ~ '^(outbound_|support_|model_check)'");
  expect(gateway.rows).toEqual([]);
  expect((await fixture.admin.query("SELECT proname FROM pg_proc WHERE proname = 'outbound_refuse_change'")).rows).toEqual([]);
  await settingsClosed(sql, 'read');
  expect((await fixture.admin.query("SELECT proname FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace")).rows).toEqual([]);
});
