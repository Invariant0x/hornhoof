import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { Ctx } from '../../src/app.js';
import { nodeConnected, nodeDisconnected, nodeReported } from '../../src/modules/nodes/connections.js';
import { builtinOf } from '../../src/modules/nodes/hub.js';
import { migrationsBefore } from '../migrations-before.js';
import { migrateCandidate, migrateFolder, privatePostgres, type PostgresFixture } from './helpers.js';

/* #1060: migration 0129 lets a connection of a machine's built-in node, which has no node of its own, go without one. On a
   live PostgreSQL 17, as the release runs it: rows of nodes kept through the upgrade, and a built-in node's written. */

const MACHINE = 'c'.repeat(64);

async function machineWithNode(fixture: PostgresFixture) {
  const one = async (text: string, values: unknown[] = []) => (await fixture.admin.query<{ id: string }>(text, values)).rows[0]!.id;
  const company = await one("INSERT INTO companies (name) VALUES ('Built-in connections') RETURNING id");
  const person = await one("INSERT INTO people (company_id, name, email, status, scope_kind) VALUES ($1, 'Ivan', 'ivan@example.test', 'active', 'company') RETURNING id", [company]);
  const machine = await one("INSERT INTO machines (company_id, person_id, machine_key, hostname, network_id) VALUES ($1, $2, 'test-server-key', 'test-server', $3) RETURNING id", [company, person, MACHINE]);
  const node = await one("INSERT INTO nodes (company_id, machine_id, status) VALUES ($1, $2, 'ready') RETURNING id", [company, machine]);
  return { company, machine, node };
}

const rows = async (fixture: PostgresFixture) =>
  (await fixture.admin.query<{ id: string; machine_id: string; node_id: string | null; cause: string | null; close_code: number | null; report: unknown }>(
    'SELECT id, machine_id, node_id, cause, close_code, report FROM node_connections ORDER BY connected_at',
  )).rows;

it('upgrades a database with connections of nodes through 0129, keeps them, and then takes one with no node', async () => {
  const fixture = await privatePostgres({ migrate: false });
  await migrateFolder(fixture, await migrationsBefore('builtin_node_connections'));
  const { company, machine, node } = await machineWithNode(fixture);
  const link = randomUUID();
  await fixture.admin.query(
    "INSERT INTO node_connections (id, company_id, machine_id, node_id, connected_at, disconnected_at, cause, close_code) VALUES ($1, $2, $3, $4, '2026-11-15T22:13:23Z', '2026-11-16T01:00:00Z', 'node_closed', 1000)",
    [link, company, machine, node],
  );
  await expect(fixture.admin.query('INSERT INTO node_connections (company_id, machine_id, connected_at) VALUES ($1, $2, now())', [company, machine])).rejects.toThrow(/node_id/);

  await migrateCandidate(fixture);
  expect(await rows(fixture)).toEqual([{ id: link, machine_id: machine, node_id: node, cause: 'node_closed', close_code: 1000, report: null }]);
  const column = (await fixture.admin.query<{ is_nullable: string }>("SELECT is_nullable FROM information_schema.columns WHERE table_name = 'node_connections' AND column_name = 'node_id'")).rows;
  expect(column).toEqual([{ is_nullable: 'YES' }]);
  const builtin = randomUUID();
  await fixture.admin.query("INSERT INTO node_connections (id, company_id, machine_id, connected_at) VALUES ($1, $2, $3, '2026-11-16T02:00:00Z')", [builtin, company, machine]);
  /* A node's connections still go with the node; the built-in node's stay with the machine. */
  await fixture.admin.query('DELETE FROM nodes WHERE id = $1', [node]);
  expect((await rows(fixture)).map(row => ({ id: row.id, node_id: row.node_id }))).toEqual([{ id: builtin, node_id: null }]);
  /* A second run of the migrations changes nothing. */
  await migrateCandidate(fixture);
  expect((await rows(fixture)).map(row => row.id)).toEqual([builtin]);
});

it("writes the connections of a machine's built-in node on its machine with no node, its end, and what it said of the drop", async () => {
  const fixture = await privatePostgres();
  const { machine } = await machineWithNode(fixture);
  const ctx = { db: fixture.db, log: { info: vi.fn() } } as unknown as Ctx;
  const id = builtinOf(MACHINE);
  const first = randomUUID(), second = randomUUID();
  await nodeConnected(ctx, id, first, new Date('2026-11-16T03:00:00Z'));
  await nodeDisconnected(ctx, id, { link: first, at: new Date('2026-11-16T03:01:00Z'), cause: 'network', code: 1006, reason: null, error: null });
  await nodeConnected(ctx, id, second, new Date('2026-11-16T03:01:10Z'));
  const said = {
    disconnectedAt: '2026-11-16T03:01:00.000Z', reconnectedAt: '2026-11-16T03:01:10.000Z', offlineMs: 10_000, attempts: 1, cause: 'watchdog_timeout' as const,
    closeCode: null, closeReason: null, errorCode: null, error: null, dnsFailed: false, watchdogTimedOut: true, clockJumpMs: null, networkChanged: false,
  };
  await nodeReported(ctx, id, { type: 'node.reconnect', ...said });
  expect(await rows(fixture)).toEqual([
    { id: first, machine_id: machine, node_id: null, cause: 'network', close_code: 1006, report: said },
    { id: second, machine_id: machine, node_id: null, cause: null, close_code: null, report: null },
  ]);
  expect(vi.mocked(ctx.log.info).mock.calls.at(-1)).toEqual([{ machine: 'test-server', node: 'builtin', offlineMs: 10_000 }, 'A node connected.']);
});
