import { expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { ANSWERED, COMMIT, COMPANY, FIRST, HISTORY, LEGACY, PERSON } from '../fixtures/question-storage.js';
import { migrationsBefore, migrationsThrough } from '../migrations-before.js';
import { privatePostgres } from './helpers.js';

it('upgrades actual nonempty PostgreSQL question rows without rewriting human decisions or replaying work', async () => {
  const fixture = await privatePostgres({ migrate: false });
  await migrate(fixture.db, { migrationsFolder: await migrationsBefore('internal_first_questions') });
  await fixture.admin.query(LEGACY);
  const beforeRequests = (await fixture.admin.query('SELECT to_jsonb(r) AS row FROM requests r ORDER BY id')).rows;
  const beforeProposals = (await fixture.admin.query('SELECT to_jsonb(p) AS row FROM proposals p ORDER BY id')).rows;
  const through = await migrationsThrough('internal_first_questions');
  await migrate(fixture.db, { migrationsFolder: through });
  const added = "ARRAY['audience','question_revision','source_key','source_job_id','source_sequence','triage_agent_id','route_revision','classification']";
  expect((await fixture.admin.query(`SELECT to_jsonb(r) - ${added} AS row FROM requests r ORDER BY id`)).rows).toEqual(beforeRequests);
  expect((await fixture.admin.query(`SELECT to_jsonb(p) - ${added} AS row FROM proposals p ORDER BY id`)).rows).toEqual(beforeProposals);
  expect((await fixture.admin.query('SELECT material_snapshot,technical_text FROM request_internal WHERE request_id=$1', [FIRST])).rows).toEqual([
    { material_snapshot: HISTORY, technical_text: 'Original technical question' },
  ]);
  expect((await fixture.admin.query('SELECT status,audience,classification,source_job_id,source_sequence FROM requests ORDER BY id')).rows).toEqual([
    { status: 'open', audience: 'internal', classification: null, source_job_id: null, source_sequence: null },
    { status: 'open', audience: 'internal', classification: null, source_job_id: null, source_sequence: null },
    { status: 'answered', audience: 'legacy', classification: null, source_job_id: null, source_sequence: null },
    { status: 'approved', audience: 'legacy', classification: null, source_job_id: null, source_sequence: null },
    { status: 'declined', audience: 'legacy', classification: null, source_job_id: null, source_sequence: null },
  ]);
  expect((await fixture.admin.query('SELECT status,audience FROM proposals ORDER BY id')).rows).toEqual([
    { status: 'pending', audience: 'internal' }, { status: 'applied', audience: 'legacy' }, { status: 'dismissed', audience: 'legacy' },
  ]);
  expect((await fixture.admin.query('SELECT source_key FROM requests WHERE status=\'open\' ORDER BY id')).rows).toEqual([
    { source_key: `legacy:task_request:${FIRST}` }, { source_key: 'legacy:task_request:00000000-0000-4000-8000-000000000006' },
  ]);
  expect((await fixture.admin.query('SELECT answer,answered_by FROM requests WHERE id=$1', [ANSWERED])).rows).toEqual([
    { answer: 'Actual human answer', answered_by: PERSON },
  ]);
  expect((await fixture.admin.query("SELECT commit FROM requests WHERE status='approved'")).rows).toEqual([{ commit: COMMIT }]);
  for (const table of ['computer_access_intents', 'jobs', 'task_waits']) {
    expect((await fixture.admin.query(`SELECT count(*)::int AS n FROM ${table}`)).rows).toEqual([{ n: 0 }]);
  }
  const history = (await fixture.admin.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows;
  await migrate(fixture.db, { migrationsFolder: through });
  expect((await fixture.admin.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows).toEqual(history);
  expect((await fixture.admin.query(`SELECT to_jsonb(r) - ${added} AS row FROM requests r ORDER BY id`)).rows).toEqual(beforeRequests);
});

it('enforces native question ownership, private resolution and fixed apply fences at the PostgreSQL boundary', async () => {
  const fixture = await privatePostgres();
  await fixture.admin.query(LEGACY);
  await fixture.admin.query("INSERT INTO companies(id,name,singleton) VALUES ('00000000-0000-4000-8000-000000000020','Other synthetic company',false)");
  await expect(fixture.admin.query('INSERT INTO request_internal(request_id,company_id) VALUES ($1,$2)', [ANSWERED, '00000000-0000-4000-8000-000000000020']))
    .rejects.toMatchObject({ code: '23503' });
  await expect(fixture.admin.query("UPDATE requests SET status='resolved_internal',answered_by=$1 WHERE id=$2", [PERSON, FIRST])).rejects.toMatchObject({ code: '23514' });
  await expect(fixture.admin.query('UPDATE request_internal SET resolved_at=now() WHERE request_id=$1', [FIRST])).rejects.toMatchObject({ code: '23514' });
  const intent = '00000000-0000-4000-8000-000000000030';
  await fixture.admin.query(`INSERT INTO computer_access_intents(id,company_id,agent_id,source_key,technical_text)
    VALUES ($1,$2,'00000000-0000-4000-8000-000000000003','fixture:ask','Private access question')`, [intent, COMPANY]);
  for (const fields of ["status='granted'", "status='apply_unknown'", "apply_operation_id='00000000-0000-4000-8000-000000000031'", 'applied_at=now()']) {
    await expect(fixture.admin.query(`UPDATE computer_access_intents SET ${fields} WHERE id=$1`, [intent])).rejects.toMatchObject({ code: '23514' });
  }
  await fixture.admin.query(`UPDATE computer_access_intents SET status='apply_unknown',
    apply_operation_id='00000000-0000-4000-8000-000000000031',apply_revision=3,apply_route_revision=2,
    apply_control_revision=0,apply_target_until='2026-11-07T00:00:00Z' WHERE id=$1`, [intent]);
  for (const fields of ['apply_control_revision=-1', 'apply_revision=0', 'apply_route_revision=0', 'apply_target_until=null', 'applied_at=now()', "status='open'", "status='resolved_internal'"]) {
    await expect(fixture.admin.query(`UPDATE computer_access_intents SET ${fields} WHERE id=$1`, [intent])).rejects.toMatchObject({ code: '23514' });
  }
  expect((await fixture.admin.query('SELECT status,apply_revision::text,apply_route_revision::text,apply_control_revision::text,applied_at FROM computer_access_intents')).rows).toEqual([
    { status: 'apply_unknown', apply_revision: '3', apply_route_revision: '2', apply_control_revision: '0', applied_at: null },
  ]);
  for (const status of ['declined', 'withdrawn']) {
    await fixture.admin.query('UPDATE computer_access_intents SET status=$1 WHERE id=$2', [status, intent]);
    expect((await fixture.admin.query('SELECT status,apply_operation_id FROM computer_access_intents')).rows).toEqual([
      { status, apply_operation_id: '00000000-0000-4000-8000-000000000031' },
    ]);
  }
  // These SQL constraints prove storage fencing, not a native computer access grant or file readback.
});
