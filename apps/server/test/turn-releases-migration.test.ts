import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { encryptSecret } from '../src/crypto/secrets.js';
import { MIGRATIONS } from '../src/db/client.js';
import { agents, people, subscriptions } from '../src/db/schema.js';
import { reconcile } from '../src/modules/tasks/reconcile.js';
import { appOn, TEST_API_KEY } from './helpers.js';
import { freshPglite } from './helpers-db.js';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';

const ACME = '00000000-0000-4000-8000-000000000a01';
const DEV = '00000000-0000-4000-8000-000000000b01';
const SHOP = '00000000-0000-4000-8000-000000000b02';
const MARKETING = '00000000-0000-4000-8000-000000000b03';
const DESIGN = '00000000-0000-4000-8000-000000000b04';
const DEV_HEAD = '00000000-0000-4000-8000-000000000e01';
const MKT_HEAD = '00000000-0000-4000-8000-000000000e02';
const WORKER = '00000000-0000-4000-8000-000000000e03';
const T = (n: number) => `00000000-0000-4000-8000-000000000c${String(n).padStart(2, '0')}`;
const K = (n: number) => `00000000-0000-4000-8000-000000000d${String(n).padStart(2, '0')}`;
const CODE = { kind: 'development_echelons', phase: 'active', stage: 'review', stages: [{ stage: 'review', status: 'pending', ownerAgentId: WORKER }], version: 1, security: { reason: null, addedBy: null, required: false }, abilities: {}, assignment: null, resultKind: 'code', candidateId: null };
const TURNKEY = { ...CODE, stage: null, stages: [], resultKind: 'turnkey' };

/* Acme as turn 24 left it: Development running turn 24 in echelons with a closed turn 23 behind it and a planned turn 25
   after it, Marketing running a turn of its own, Design running none. */
async function migrated(): Promise<PGlite> {
  const client = await freshPglite();
  onTestFinished(() => client.close());
  await migrate(drizzle(client), { migrationsFolder: await migrationsBefore('turn_releases') });
  await client.exec(`
    INSERT INTO companies(id, name, turn_numbers_used) VALUES ('${ACME}', 'Acme', 25);
    INSERT INTO departments(id, company_id, template_key, role_code, position, parent_id, repo_url, work_mode) VALUES
      ('${DEV}', '${ACME}', 'development', 'DEV', 1, null, 'https://github.com/acme/shop.git', 'turns'),
      ('${SHOP}', '${ACME}', null, 'DEV', 4, '${DEV}', null, 'turns'),
      ('${MARKETING}', '${ACME}', 'marketing', 'MKT', 2, null, null, 'continuous'),
      ('${DESIGN}', '${ACME}', 'design', 'DSN', 3, null, null, 'turns');
    INSERT INTO agents(id, company_id, kind, name, model, department_id) VALUES
      ('${DEV_HEAD}', '${ACME}', 'head', 'Head of development', '', '${DEV}'),
      ('${MKT_HEAD}', '${ACME}', 'head', 'Head of marketing', '', '${MARKETING}'),
      ('${WORKER}', '${ACME}', 'worker', 'Sigma', '', '${DEV}');
    INSERT INTO turns(id, company_id, department_id, number, title, goal, status, mode, messages, opened_at, closed_at) VALUES
      ('${T(23)}', '${ACME}', '${DEV}', 23, 'Payments', 'Take card payments.', 'closed', 'echelons', '[]', now(), now()),
      ('${T(24)}', '${ACME}', '${DEV}', 24, 'Tracker', 'A tracker people read.', 'open', 'echelons', '[]', now(), null),
      ('${T(25)}', '${ACME}', '${DEV}', 25, 'Spring', 'The spring release.', 'planned', 'turnkey', '[]', null, null),
      ('${T(22)}', '${ACME}', '${MARKETING}', 22, 'Launch', 'Tell about the launch.', 'open', 'echelons', '[]', now(), null);
    INSERT INTO tasks(id, company_id, number, title, turn_id, parent_id, department_id, product_id, status, assignee_agent_id, executor_agent_id, closed_at) VALUES
      ('${K(1)}', '${ACME}', 1, 'Old build', '${T(23)}', null, '${DEV}', null, 'done', null, '${WORKER}', now()),
      ('${K(2)}', '${ACME}', 2, 'Accepted change', '${T(24)}', null, '${DEV}', null, 'done', null, '${WORKER}', now()),
      ('${K(3)}', '${ACME}', 3, 'Turnkey change', '${T(24)}', null, '${DEV}', null, 'done', null, '${WORKER}', now()),
      ('${K(4)}', '${ACME}', 4, 'Coordination', '${T(24)}', null, '${DEV}', null, 'done', null, null, now()),
      ('${K(5)}', '${ACME}', 5, 'Change on its way', '${T(24)}', null, '${DEV}', null, 'review', '${WORKER}', '${WORKER}', null),
      ('${K(6)}', '${ACME}', 6, 'Part of it', '${T(24)}', '${K(5)}', '${DEV}', null, 'working', '${WORKER}', '${WORKER}', null),
      ('${K(7)}', '${ACME}', 7, 'Spring build', '${T(25)}', null, '${DEV}', null, 'planned', null, null, null),
      ('${K(8)}', '${ACME}', 8, 'Spring shop', '${T(25)}', null, '${SHOP}', '${SHOP}', 'planned', null, null, null),
      ('${K(9)}', '${ACME}', 9, 'Launch post', '${T(22)}', null, '${MARKETING}', null, 'working', '${MKT_HEAD}', null, null);
    INSERT INTO task_routes(task_id, company_id, state) VALUES
      ('${K(2)}', '${ACME}', '${JSON.stringify({ ...CODE, phase: 'done' })}'),
      ('${K(3)}', '${ACME}', '${JSON.stringify({ ...TURNKEY, phase: 'done' })}'),
      ('${K(4)}', '${ACME}', '${JSON.stringify({ ...TURNKEY, resultKind: 'coordination', phase: 'done' })}'),
      ('${K(5)}', '${ACME}', '${JSON.stringify(CODE)}'),
      ('${K(7)}', '${ACME}', '${JSON.stringify({ ...TURNKEY, resultKind: 'coordination' })}'),
      ('${K(8)}', '${ACME}', '${JSON.stringify({ ...TURNKEY, resultKind: 'coordination' })}');
    INSERT INTO task_events(company_id, task_id, kind, text, data, agent_id) VALUES
      ('${ACME}', '${K(2)}', 'report', 'Accepted.', '{"done":true,"acceptedCandidate":{"integration":{"branch":"turn-24","commit":"${'b'.repeat(40)}"}}}', '${DEV_HEAD}');
  `);
  await migrate(drizzle(client), { migrationsFolder: await migrationsThrough('turn_releases') });
  return client;
}

const rows = async <T,>(client: PGlite, query: string) => (await client.query<T>(query)).rows;

describe('turns become releases', () => {
  it('keeps one open turn for every top-level department and no planned one', async () => {
    const client = await migrated();
    const open = await rows<{ department_id: string; number: number }>(client, `SELECT department_id, number FROM turns WHERE status = 'open' ORDER BY number`);
    expect(open.map(turn => turn.department_id).sort()).toEqual([DEV, MARKETING, DESIGN].sort());
    expect(open.find(turn => turn.department_id === DEV)!.number).toBe(24);
    expect(open.find(turn => turn.department_id === MARKETING)!.number).toBe(22);
    expect(open.find(turn => turn.department_id === DESIGN)!.number).toBeGreaterThan(25);
    expect(await rows(client, `SELECT id FROM turns WHERE id = '${T(25)}' OR status = 'planned'`)).toEqual([]);
    expect(await rows(client, `SELECT id FROM turns WHERE id = '${T(23)}' AND status = 'closed'`)).toHaveLength(1);
  });

  it('keeps in turn 24 only what was accepted into its branch or done turnkey', async () => {
    const client = await migrated();
    const kept = await rows<{ id: string }>(client, `SELECT id FROM tasks WHERE turn_id = '${T(24)}' ORDER BY number`);
    expect(kept.map(task => task.id)).toEqual([K(2), K(3)]);
    expect(await rows<{ turn_id: string }>(client, `SELECT turn_id FROM tasks WHERE id = '${K(1)}'`)).toEqual([{ turn_id: T(23) }]);
  });

  it('lets work on its way go on as it was, outside every turn until it is accepted', async () => {
    const client = await migrated();
    const going = await rows<Record<string, unknown>>(client, `SELECT id, turn_id, status, assignee_agent_id, executor_agent_id FROM tasks WHERE id IN ('${K(5)}', '${K(6)}', '${K(9)}') ORDER BY number`);
    expect(going).toEqual([
      { id: K(5), turn_id: null, status: 'review', assignee_agent_id: WORKER, executor_agent_id: WORKER },
      { id: K(6), turn_id: null, status: 'working', assignee_agent_id: WORKER, executor_agent_id: WORKER },
      { id: K(9), turn_id: null, status: 'working', assignee_agent_id: MKT_HEAD, executor_agent_id: null },
    ]);
    expect(await rows<{ state: unknown }>(client, `SELECT state FROM task_routes WHERE task_id = '${K(5)}'`)).toEqual([{ state: CODE }]);
  });

  it('gives the planned work to the head of its department, with what its turn was for in its log', async () => {
    const client = await migrated();
    const given = await rows<Record<string, unknown>>(client, `SELECT id, turn_id, status, assignee_agent_id FROM tasks WHERE id IN ('${K(7)}', '${K(8)}') ORDER BY number`);
    expect(given).toEqual([
      { id: K(7), turn_id: null, status: 'open', assignee_agent_id: DEV_HEAD },
      { id: K(8), turn_id: null, status: 'open', assignee_agent_id: DEV_HEAD },
    ]);
    const notes = await rows<{ text: string }>(client, `SELECT text FROM task_events WHERE task_id = '${K(7)}' AND kind = 'updated'`);
    expect(notes.map(note => note.text).join(' ')).toMatch(/Spring.*The spring release\./);
    expect(await rows(client, `SELECT id FROM tasks WHERE status = 'planned'`)).toEqual([]);
  });

  it('wakes the head the planned work went to at the next check of lost wakes', async () => {
    const client = await migrated();
    /* The server that wakes it runs on every later migration too, as an upgrade applies them all. */
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS });
    const { app, db } = await appOn(client);
    /* Its employees on the company's key, on the machine Hornhoof keeps, ready to run. */
    const [owner] = await db.insert(people).values({ companyId: ACME, name: 'Owner', email: 'owner@acme.test', status: 'active', scopeKind: 'company', isOwner: true }).returning();
    const [key] = await db.insert(subscriptions).values({ companyId: ACME, provider: 'anthropic_api', kind: 'api_key', label: 'Key', ownerPersonId: owner!.id, secretEnc: encryptSecret(TEST_API_KEY, app.ctx.config.secret), last4: TEST_API_KEY.slice(-4), status: 'ready', targetKind: 'any' }).returning();
    await db.update(agents).set({ subscriptionId: key!.id, model: 'claude-opus-5-5' });
    vi.spyOn(app.ctx.hub, 'isReady').mockReturnValue(true);
    vi.spyOn(app.ctx.hub, 'hasTerminals').mockReturnValue(false);
    vi.spyOn(app.ctx.hub, 'send').mockReturnValue(true);
    const later = new Date(Date.now() + 10 * 60_000);
    await reconcile(app.ctx, later);
    /* One turn at a time: the other given task waits for this one to end rather than run beside it. */
    const woken = await rows<{ task_id: string; status: string }>(client, `SELECT task_id, status FROM jobs WHERE agent_id = '${DEV_HEAD}'`);
    expect(woken).toEqual([{ task_id: K(7), status: 'running' }]);
  });

  it('drops the modes of turns and departments and keeps a release for each turn', async () => {
    const client = await migrated();
    const columns = await rows<{ table_name: string; column_name: string }>(client, `SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('turns', 'departments', 'turn_releases')`);
    const of = (table: string) => columns.filter(column => column.table_name === table).map(column => column.column_name);
    expect(of('turns')).not.toContain('mode');
    expect(of('departments')).not.toContain('work_mode');
    expect(of('turns')).toEqual(expect.arrayContaining(['version', 'commit', 'base_version', 'base_commit', 'start_commit']));
    expect(of('turn_releases')).toEqual(expect.arrayContaining(['turn_id', 'commit', 'base_commit_sha', 'run_id', 'tasks', 'approval_request_id', 'autonomous_release_id']));
    await expect(client.query(`INSERT INTO tasks(company_id, number, title, status) VALUES ('${ACME}', 99, 'Planned again', 'planned')`)).rejects.toThrow();
  });

  it('allows releases without approval after upgrade and keeps prior approvals and their exclusivity', async () => {
    const client = await migrated();
    await migrate(drizzle(client), { migrationsFolder: await migrationsBefore('release_approval_optional') });
    const [{ id: request }] = await rows<{ id: string }>(client, `INSERT INTO requests(company_id, task_id, agent_id, kind, text, status, commit) VALUES ('${ACME}', '${K(2)}', '${DEV_HEAD}', 'approval', 'Release?', 'approved', '${'c'.repeat(40)}') RETURNING id`) as [{ id: string }];
    const [{ id: logged }] = await rows<{ id: string }>(client, `INSERT INTO autonomous_releases(company_id, task_number, agent_name, commit_sha, base_commit_sha, test_run_number, reviewer_name, verdict_stage)
      VALUES ('${ACME}', 2, 'Sigma', '${'c'.repeat(40)}', '${'a'.repeat(40)}', 1, 'Rho', 'review') RETURNING id`) as [{ id: string }];
    const release = (approval: string, autonomous: string) => client.query(`INSERT INTO turn_releases(company_id, turn_id, commit, base_commit_sha, covered, approval_request_id, autonomous_release_id)
      VALUES ('${ACME}', '${T(24)}', '${'c'.repeat(40)}', '${'a'.repeat(40)}', true, ${approval}, ${autonomous})`);
    await expect(release('null', 'null')).rejects.toThrow(/turn_releases_approved_once/);
    await expect(release(`'${request}'`, `'${logged}'`)).rejects.toThrow(/turn_releases_approved_once/);
    await release(`'${request}'`, 'null');
    await release('null', `'${logged}'`);
    await migrate(drizzle(client), { migrationsFolder: await migrationsThrough('release_approval_optional') });
    await release('null', 'null');
    await expect(release(`'${request}'`, `'${logged}'`)).rejects.toThrow(/turn_releases_approved_once/);
    const proofs = await rows(client, 'SELECT approval_request_id, autonomous_release_id FROM turn_releases');
    expect(proofs).toHaveLength(3);
    expect(proofs).toEqual(expect.arrayContaining([
      { approval_request_id: request, autonomous_release_id: null },
      { approval_request_id: null, autonomous_release_id: logged },
      { approval_request_id: null, autonomous_release_id: null },
    ]));
  });
});
