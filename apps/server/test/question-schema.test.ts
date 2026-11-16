import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agentRole, grantsFor, readerGrantsFor, readerRole } from '../src/db/agent-sql.js';
import { createTestDb, freshPglite } from './helpers-db.js';
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

  it.each(['requests', 'proposals'])('bounds %s source metadata and keeps private authority out of generic SQL', async table => {
    const { $client: client } = await createTestDb();
    await client.exec(LEGACY);
    await client.query(`SELECT question_revision,route_revision,source_key,source_sequence,classification FROM ${table}`);
    for (const fields of [
      'question_revision=0', 'question_revision=9007199254740992', 'route_revision=-1', 'source_sequence=-1',
      "audience='everybody'", "source_key=''", "source_key=E'bad\\nkey'", "classification='[]'::jsonb",
      "classification=jsonb_build_object('oversized',repeat('x',32769))",
    ]) await expect(client.exec(`UPDATE ${table} SET ${fields}`), fields).rejects.toThrow(/check constraint/);
    const { names, run } = await roles(client);
    for (const name of names) {
      for (const column of ['source_key', 'source_job_id', 'source_sequence', 'triage_agent_id', 'classification']) {
        await expect(run(name, `SELECT ${column} FROM ${table}`)).rejects.toThrow(/permission denied/);
      }
    }
  });

  it('keeps internal resolver provenance in the private sidecar without borrowing person-answer fields', async () => {
    const { $client: client } = await createTestDb();
    await client.exec(LEGACY);
    await client.query('SELECT technical_text,executor_instruction,resolved_by_agent_id,resolved_by_job_id,resolved_source_sequence,resolved_at,recovery_intent FROM request_internal');
    await expect(client.exec(`UPDATE request_internal SET resolved_at=now() WHERE request_id='${FIRST}'`)).rejects.toThrow(/check constraint/);
    await expect(client.exec(`UPDATE request_internal SET resolved_source_sequence=-1 WHERE request_id='${FIRST}'`)).rejects.toThrow(/check constraint/);
    const { names, run } = await roles(client);
    for (const name of names) {
      await expect(run(name, 'SELECT technical_text,executor_instruction,recovery_intent FROM request_internal')).rejects.toThrow(/permission denied/);
    }
  });
});

/* Only the head or orchestrator named on an internal stuck request can answer it, and one from before names nobody. */
it('leaves a stuck request open at the upgrade with the people it already asked', async () => {
  const client = await freshPglite(); onTestFinished(() => client.close());
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: await migrationsBefore('internal_first_questions') });
  await client.exec(LEGACY);
  await client.exec(`INSERT INTO requests(company_id,task_id,agent_id,kind,text,status) VALUES ('${COMPANY}','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','stuck','Hornhoof stopped waking the agent','open')`);
  await migrate(db, { migrationsFolder: await migrationsThrough('internal_first_questions') });
  expect((await client.query("SELECT status,audience,triage_agent_id FROM requests WHERE kind='stuck'")).rows).toEqual([{ status: 'open', audience: 'human', triage_agent_id: null }]);
  expect((await client.query("SELECT DISTINCT audience FROM requests WHERE kind='question' AND status='open'")).rows).toEqual([{ audience: 'internal' }]);
});

it('upgrades only its prefix, retaining terminal decisions and independent open source identities', async () => {
  const beforeFolder = await migrationsBefore('internal_first_questions');
  const throughFolder = await migrationsThrough('internal_first_questions');
  const client = await freshPglite(); onTestFinished(() => client.close());
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
  expect((await client.query<{ source_key: string }>("SELECT source_key FROM requests WHERE status='open' ORDER BY id")).rows.map(row => row.source_key)).toEqual(sources);
});
