import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agentRole, grantsFor, readerGrantsFor, readerRole } from '../src/db/agent-sql.js';
import { createTestDb } from './helpers-db.js';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';

const COMPANY = '00000000-0000-4000-8000-000000000001';
const PERSON = '00000000-0000-4000-8000-000000000002';
const FIRST = '00000000-0000-4000-8000-000000000005';
const ANSWERED = '00000000-0000-4000-8000-000000000007';
const COMMIT = 'a'.repeat(40);
const HISTORY = { schemaVersion: 1, versions: [] };
const LEGACY = `
  INSERT INTO companies(id,name) VALUES ('${COMPANY}','Question migration fixture');
  INSERT INTO people(id,company_id,name,email,status,scope_kind,is_owner) VALUES
    ('${PERSON}','${COMPANY}','Real decision maker','question-fixture@example.test','active','company',true);
  INSERT INTO agents(id,company_id,kind,name,model) VALUES
    ('00000000-0000-4000-8000-000000000003','${COMPANY}','worker','Source author','');
  INSERT INTO tasks(id,company_id,number,title) VALUES
    ('00000000-0000-4000-8000-000000000004','${COMPANY}',1,'Retained task');
  INSERT INTO requests(id,company_id,task_id,agent_id,kind,text,status,answer,answered_by,answered_at,commit) VALUES
    ('${FIRST}','${COMPANY}','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','question','Original technical question','open',null,null,null,null),
    ('00000000-0000-4000-8000-000000000006','${COMPANY}','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','question','Independent second question','open',null,null,null,null),
    ('${ANSWERED}','${COMPANY}','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','question','Historical question','answered','Actual human answer','${PERSON}','2026-11-05T01:00:00Z',null),
    ('00000000-0000-4000-8000-000000000008','${COMPANY}','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','approval','Approved exact result','approved','Approved by person','${PERSON}','2026-11-05T01:00:00Z','${COMMIT}'),
    ('00000000-0000-4000-8000-000000000009','${COMPANY}','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','approval','Declined exact result','declined','Declined by person','${PERSON}','2026-11-05T01:00:00Z','${'b'.repeat(40)}');
  INSERT INTO request_internal(request_id,company_id,material_snapshot) VALUES ('${FIRST}','${COMPANY}','${JSON.stringify(HISTORY)}');
  INSERT INTO proposals(id,company_id,agent_id,brief,items,status,applied_by,applied_at) VALUES
    ('00000000-0000-4000-8000-000000000010','${COMPANY}','00000000-0000-4000-8000-000000000003','Private pending staff proposal','[]','pending',null,null),
    ('00000000-0000-4000-8000-000000000011','${COMPANY}','00000000-0000-4000-8000-000000000003','Historical applied proposal','[]','applied','${PERSON}','2026-11-05T01:00:00Z'),
    ('00000000-0000-4000-8000-000000000012','${COMPANY}','00000000-0000-4000-8000-000000000003','Historical dismissed proposal','[]','dismissed',null,null);
`;

async function roles(client: PGlite) {
  const names = [agentRole('postgres'), readerRole('postgres')];
  await client.exec(`${grantsFor(names[0]!)};\n${readerGrantsFor(names[1]!)}`);
  return { names, run: (name: string, statement: string) => client.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE "${name}"`);
    return tx.exec(statement);
  }) };
}

describe('canonical private question storage', () => {
  it('has independent source and route revisions without making a non-task source a task', async () => {
    const { $client: client } = await createTestDb();
    for (const table of ['requests', 'proposals']) {
      expect((await client.query(`SELECT audience,question_revision,source_key,source_job_id,source_sequence,triage_agent_id,route_revision,classification FROM ${table}`)).rows).toEqual([]);
    }
    expect((await client.query('SELECT id,source_key,question_revision,route_revision FROM computer_access_intents')).rows).toEqual([]);
    const columns = await client.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='computer_access_intents'");
    expect(columns.rows.map(row => row.column_name)).not.toContain('task_id');
  });

  it('preserves valid legacy answers, exact approval commits and private material history in its fixture', async () => {
    const { $client: client } = await createTestDb();
    await client.exec(LEGACY);
    expect((await client.query('SELECT status,answer,answered_by FROM requests WHERE id=$1', [ANSWERED])).rows).toEqual([
      { status: 'answered', answer: 'Actual human answer', answered_by: PERSON },
    ]);
    expect((await client.query("SELECT commit FROM requests WHERE status='approved'")).rows).toEqual([{ commit: COMMIT }]);
    expect((await client.query('SELECT material_snapshot FROM request_internal WHERE request_id=$1', [FIRST])).rows).toEqual([{ material_snapshot: HISTORY }]);
  });

  it.each([
    { table: 'requests', columns: 'text,options,explained' },
    { table: 'proposals', columns: 'brief,items' },
  ])('keeps $table raw source content out of both generic SQL roles', async ({ table, columns }) => {
    const { $client: client } = await createTestDb();
    const { names, run } = await roles(client);
    for (const name of names) {
      for (const column of columns.split(',')) await expect(run(name, `SELECT ${column} FROM ${table}`)).rejects.toThrow(/permission denied/);
      expect((await run(name, `SELECT id,status FROM ${table}`))[0]!.rows).toEqual([]);
    }
  });

  it('hides the actual ASK source from both roles and creates no access grant', async () => {
    const { $client: client } = await createTestDb();
    expect((await client.query('SELECT * FROM computer_access_intents')).rows).toEqual([]);
    const { names, run } = await roles(client);
    for (const name of names) {
      for (const statement of [
        'SELECT * FROM computer_access_intents',
        'INSERT INTO computer_access_intents(id) SELECT id FROM computer_access_intents WHERE false',
        'UPDATE computer_access_intents SET id=id WHERE false',
        'DELETE FROM computer_access_intents WHERE false',
      ]) await expect(run(name, statement)).rejects.toThrow(/permission denied/);
    }
  });

  it('cannot attach private content to another company request', async () => {
    const { $client: client } = await createTestDb();
    await client.exec(LEGACY);
    await client.exec("INSERT INTO companies(id,name,singleton) VALUES ('00000000-0000-4000-8000-000000000020','Other synthetic company',false)");
    await expect(client.exec(`INSERT INTO request_internal(request_id,company_id) VALUES ('${ANSWERED}','00000000-0000-4000-8000-000000000020')`)).rejects.toThrow(/foreign key/);
  });

  it('never records a person answer as an internal agent resolution', async () => {
    const { $client: client } = await createTestDb();
    await client.exec(LEGACY);
    await expect(client.exec(`UPDATE requests SET status='resolved_internal',answered_by='${PERSON}' WHERE id='${FIRST}'`)).rejects.toThrow(/check constraint/);
  });
});

it('upgrades only its prefix, retaining terminal decisions and independent open source identities', async () => {
  const beforeFolder = await migrationsBefore('internal_first_questions');
  const throughFolder = await migrationsThrough('internal_first_questions');
  const client = new PGlite(); onTestFinished(() => client.close());
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: beforeFolder });
  await client.exec(LEGACY);
  const beforeRequests = (await client.query('SELECT to_jsonb(r) AS row FROM requests r ORDER BY id')).rows;
  const beforeProposals = (await client.query('SELECT to_jsonb(p) AS row FROM proposals p ORDER BY id')).rows;
  const beforeSidecar = (await client.query('SELECT material_snapshot FROM request_internal WHERE request_id=$1', [FIRST])).rows;
  await migrate(db, { migrationsFolder: throughFolder });
  const added = "ARRAY['audience','question_revision','source_key','source_job_id','source_sequence','triage_agent_id','route_revision','classification']";
  expect((await client.query(`SELECT to_jsonb(r) - ${added} AS row FROM requests r ORDER BY id`)).rows).toEqual(beforeRequests);
  expect((await client.query(`SELECT to_jsonb(p) - ${added} AS row FROM proposals p ORDER BY id`)).rows).toEqual(beforeProposals);
  expect((await client.query('SELECT material_snapshot FROM request_internal WHERE request_id=$1', [FIRST])).rows).toEqual(beforeSidecar);
  expect((await client.query('SELECT technical_text FROM request_internal WHERE request_id=$1', [FIRST])).rows).toEqual([{ technical_text: 'Original technical question' }]);
  expect((await client.query('SELECT status,audience,classification,source_job_id,source_sequence FROM requests ORDER BY id')).rows).toEqual([
    { status: 'open', audience: 'internal', classification: null, source_job_id: null, source_sequence: null },
    { status: 'open', audience: 'internal', classification: null, source_job_id: null, source_sequence: null },
    { status: 'answered', audience: 'legacy', classification: null, source_job_id: null, source_sequence: null },
    { status: 'approved', audience: 'legacy', classification: null, source_job_id: null, source_sequence: null },
    { status: 'declined', audience: 'legacy', classification: null, source_job_id: null, source_sequence: null },
  ]);
  expect((await client.query('SELECT status,audience FROM proposals ORDER BY id')).rows).toEqual([
    { status: 'pending', audience: 'internal' }, { status: 'applied', audience: 'legacy' }, { status: 'dismissed', audience: 'legacy' },
  ]);
  const sources = (await client.query<{ source_key: string }>("SELECT source_key FROM requests WHERE status='open' ORDER BY id")).rows.map(row => row.source_key);
  expect(sources.every(key => typeof key === 'string' && key.length > 0)).toBe(true);
  expect(new Set(sources).size).toBe(2);
  expect((await client.query('SELECT count(*)::int AS n FROM computer_access_intents')).rows).toEqual([{ n: 0 }]);
  const history = (await client.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows;
  await migrate(db, { migrationsFolder: throughFolder });
  expect((await client.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows).toEqual(history);
  expect((await client.query("SELECT source_key FROM requests WHERE status='open' ORDER BY id")).rows.map(row => row.source_key)).toEqual(sources);
});
