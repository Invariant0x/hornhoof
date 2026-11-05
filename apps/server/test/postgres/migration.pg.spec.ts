import { expect, it } from 'vitest';
import { migrateCandidate, privatePostgres } from './helpers.js';
import { candidateHistory, migrationHistory, prepareUpgrade, savedRows, UPGRADE_PART, UPGRADE_RUN } from './migration-fixture.js';

it('upgrades nonempty 0059 rows through candidate migrations and preserves data and history on rerun', async () => {
  const fixture = await privatePostgres({ migrate: false });
  const before = await prepareUpgrade(fixture);
  expect(before.rows.subscriptions).toHaveLength(2);
  expect(before.rows.subscriptions!.map(row => row.limits)).toEqual([
    { status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt: '2026-11-05T15:00:00.000Z' }, { name: 'seven_day', utilization: 0.4, resetsAt: null }], complete: true },
    { status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.25, resetsAt: null }], complete: false },
  ]);
  expect(before.rows.test_runs).toHaveLength(1);
  expect(before.rows.test_parts).toHaveLength(1);
  expect(before.rows.subscriptions![0]).not.toHaveProperty('limits_updated_at');
  expect(before.rows.test_runs![0]).not.toHaveProperty('commit_sha');
  await migrateCandidate(fixture.db);
  const after = await savedRows(fixture);
  for (const [table, rows] of Object.entries(before.rows)) expect(after[table], `preserved ${table}`).toMatchObject(rows);
  expect(after.subscriptions!.map(row => row.limits_updated_at)).toEqual([null, null]);
  expect(after.test_runs![0]).toMatchObject({ id: UPGRADE_RUN, number: 9, commit_sha: null });
  expect(after.test_parts![0]).toMatchObject({ id: UPGRADE_PART, run_id: UPGRADE_RUN, part: 1, status: 'passed' });
  expect(after.tasks![0]).toMatchObject({ work_kind: null, risk_class: null });
  expect(after.departments![0]).toHaveProperty('owner_person_id', null);
  await fixture.admin.query('INSERT INTO test_part_timings (part_id, company_id, run_id) SELECT id, company_id, run_id FROM test_parts WHERE id = $1', [UPGRADE_PART]);
  const timings = (await fixture.admin.query('SELECT part_id, run_id, files, packages FROM test_part_timings')).rows;
  expect(timings).toEqual([{ part_id: UPGRADE_PART, run_id: UPGRADE_RUN, files: [], packages: [] }]);
  const history = await migrationHistory(fixture);
  expect(history).toEqual(candidateHistory());
  expect(history.length).toBeGreaterThan(before.history.length);
  expect(history).toEqual(expect.arrayContaining(before.history));
  await migrateCandidate(fixture.db);
  expect(await migrationHistory(fixture)).toEqual(history);
  expect(await savedRows(fixture)).toEqual(after);
  expect((await fixture.admin.query('SELECT part_id, run_id, files, packages FROM test_part_timings')).rows).toEqual(timings);
});
