import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { expect, it } from 'vitest';
import { applyMissingMigrations } from '../../src/db/client.js';
import { migrationsBefore } from '../migrations-before.js';
import { migrateCandidate, privatePostgres } from './helpers.js';
import { candidateHistory, migrationHistory, prepareUpgrade, savedRows, UPGRADE_PART, UPGRADE_RUN } from './migration-fixture.js';

/* Migration 0088 removes the gate columns of a task; its required route replaces them. */
const GATE_COLUMNS = ['gates', 'panel', 'stage', 'merging', 'bounces'];

it('keeps retired developer lines in pending staffing proposals without changing their other choices or history', async () => {
  const fixture = await privatePostgres({ migrate: false });
  const migrationsFolder = await migrationsBefore('composable_skills');
  await migrate(fixture.db, { migrationsFolder });
  await applyMissingMigrations(fixture.db, { migrationsFolder });
  const company = (await fixture.admin.query<{ id: string }>("INSERT INTO companies (name) VALUES ('Proposal upgrade') RETURNING id")).rows[0]!.id;
  const agent = (await fixture.admin.query<{ id: string }>("INSERT INTO agents (company_id, kind, name, model) VALUES ($1, 'orchestrator', 'Coordinator', '') RETURNING id", [company])).rows[0]!.id;
  const legacy = {
    role: 'DEV-GEN', name: 'Mira', model: 'saved-model', subscription: '10000000-0000-4000-8000-000000000001',
    product: '10000000-0000-4000-8000-000000000002', team: '10000000-0000-4000-8000-000000000003',
    checked: true, skills: { on: ['dev-tdd'], off: ['dev-api-design'] }, note: 'Keep literal DEV-GEN text.',
  };
  const other = { role: 'DEV-BE', name: 'Backend', checked: true };
  const unchecked = { ...legacy, name: 'Later', checked: false };
  const cases = [
    { brief: '01 sole', kind: 'staff', status: 'pending', items: [legacy], expected: [{ ...legacy, role: 'DEV-ENG' }] },
    { brief: '02 mixed', kind: 'staff', status: 'pending', items: [other, unchecked, legacy], expected: [other, { ...unchecked, role: 'DEV-ENG' }, { ...legacy, role: 'DEV-ENG' }] },
    { brief: '03 current', kind: 'staff', status: 'pending', items: [{ ...legacy, role: 'DEV-ENG' }], expected: [{ ...legacy, role: 'DEV-ENG' }] },
    { brief: '04 applied', kind: 'staff', status: 'applied', items: [legacy], expected: [legacy] },
    { brief: '05 dismissed', kind: 'staff', status: 'dismissed', items: [legacy], expected: [legacy] },
    { brief: '06 structure', kind: 'structure', status: 'pending', items: [legacy], expected: [legacy] },
    { brief: '07 empty', kind: 'staff', status: 'pending', items: [], expected: [] },
    { brief: '08 legacy shape', kind: 'staff', status: 'pending', items: { role: 'DEV-GEN' }, expected: { role: 'DEV-GEN' } },
  ];
  for (const row of cases) {
    await fixture.admin.query('INSERT INTO proposals (company_id, agent_id, brief, kind, status, items) VALUES ($1, $2, $3, $4, $5, $6::jsonb)', [company, agent, row.brief, row.kind, row.status, JSON.stringify(row.items)]);
  }
  const rows = async () => (await fixture.admin.query<{ fields: Record<string, unknown>; items: unknown }>("SELECT to_jsonb(p) - 'items' AS fields, items FROM proposals p ORDER BY brief")).rows;
  const before = await rows();
  await migrateCandidate(fixture.db);
  const after = await rows();
  expect(after.map(row => row.fields)).toEqual(before.map(row => row.fields));
  expect(after.map(row => row.items)).toEqual(cases.map(row => row.expected));
  await migrateCandidate(fixture.db);
  expect(await rows()).toEqual(after);
});

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
  expect(before.rows.agents).toMatchObject([{ kind: 'worker', role_key: 'DEV-BE', skills: [] }]);
  await migrateCandidate(fixture.db);
  const after = await savedRows(fixture);
  for (const [table, rows] of Object.entries(before.rows)) {
    // Migrations 0084 and 0085 add these abilities to the existing developer.
    const kept = table === 'tasks' ? rows.map(row => Object.fromEntries(Object.entries(row).filter(([column]) => !GATE_COLUMNS.includes(column)))) : rows;
    const expected = table === 'agents' ? kept.map(row => ({ ...row, skills: ['dev-task-flow', 'hh-work-fast'] })) : kept;
    expect(after[table], `preserved ${table}`).toMatchObject(expected);
  }
  for (const column of GATE_COLUMNS) expect(after.tasks![0]).not.toHaveProperty(column);
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
