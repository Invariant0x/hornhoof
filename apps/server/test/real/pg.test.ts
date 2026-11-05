import pg from 'pg';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agentRole } from '../../src/db/agent-sql.js';
import { realDatabase, realServer } from './pg.js';

describe('dropping a test database', () => {
  it('still removes its roles when the database could not be dropped', async () => {
    const real = await realDatabase();
    const name = new URL(real.url).pathname.slice(1);
    const server = new pg.Client({ connectionString: realServer() });
    await server.connect();
    onTestFinished(() => server.end());
    await server.query(`CREATE ROLE ${agentRole(name)}`);
    await real.admin.end();
    await server.query(`DROP DATABASE ${name}`);

    await expect(real.drop()).rejects.toThrow(/does not exist/);

    const { rowCount } = await server.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [agentRole(name)]);
    expect(rowCount).toBe(0);
  });
});
