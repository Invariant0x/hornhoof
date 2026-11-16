import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';

const ACME = '00000000-0000-4000-8000-000000000a21';
const IVAN = '00000000-0000-4000-8000-000000000b21';
const MAC = '00000000-0000-4000-8000-000000000c21';
const NODE = '00000000-0000-4000-8000-000000000d21';
const LINK = '00000000-0000-4000-8000-000000000e21';
const BUILTIN_LINK = '00000000-0000-4000-8000-000000000e22';

/* #1060: the built-in node of a machine has no node of its own, and its connections go with the machine. */
describe('the built-in node connections migration', { timeout: 60_000 }, () => {
  it("keeps every node's connection and takes one of a machine's built-in node, with no node", async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    await migrate(drizzle(client), { migrationsFolder: await migrationsBefore('builtin_node_connections') });
    await client.exec(`
      INSERT INTO companies(id, name) VALUES ('${ACME}', 'Acme');
      INSERT INTO people(id, company_id, name, email, scope_kind, status) VALUES ('${IVAN}', '${ACME}', 'Ivan', 'ivan@test', 'company', 'active');
      INSERT INTO machines(id, company_id, person_id, machine_key, hostname) VALUES ('${MAC}', '${ACME}', '${IVAN}', 'mac-key', 'home-api');
      INSERT INTO nodes(id, company_id, machine_id) VALUES ('${NODE}', '${ACME}', '${MAC}');
      INSERT INTO node_connections(id, company_id, machine_id, node_id, connected_at, disconnected_at, cause, close_code)
        VALUES ('${LINK}', '${ACME}', '${MAC}', '${NODE}', '2026-11-15T22:13:23Z', '2026-11-16T01:00:00Z', 'node_closed', 1000);
    `);
    await expect(client.exec(`INSERT INTO node_connections(id, company_id, machine_id, connected_at) VALUES ('${BUILTIN_LINK}', '${ACME}', '${MAC}', now())`)).rejects.toThrow();
    await migrate(drizzle(client), { migrationsFolder: await migrationsThrough('builtin_node_connections') });

    const kept = await client.query<{ id: string; node_id: string | null; cause: string; close_code: number }>('SELECT id, node_id, cause, close_code FROM node_connections');
    expect(kept.rows).toEqual([{ id: LINK, node_id: NODE, cause: 'node_closed', close_code: 1000 }]);
    await client.exec(`INSERT INTO node_connections(id, company_id, machine_id, connected_at) VALUES ('${BUILTIN_LINK}', '${ACME}', '${MAC}', '2026-11-16T02:00:00Z')`);
    /* A node's connections still go with the node; the built-in node's stay with the machine. */
    await client.exec(`DELETE FROM nodes WHERE id = '${NODE}'`);
    const left = await client.query<{ id: string; node_id: string | null }>('SELECT id, node_id FROM node_connections');
    expect(left.rows).toEqual([{ id: BUILTIN_LINK, node_id: null }]);
  });
});
