import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { openDb, openPool } from '../src/db/client.js';

describe('the database pool', () => {
  it('outlives a connection the database drops, as when Postgres restarts', async () => {
    const dropped: Error[] = [];
    const pool = openPool('postgres://hornhoof@127.0.0.1:1/hornhoof', err => dropped.push(err), 'hornhoof-app');
    /* pg reports a dropped idle connection as an error on the pool; without a listener Node ends the process. */
    expect(() => pool.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
    expect(dropped.map(e => e.message)).toEqual(['Connection terminated unexpectedly']);
    await pool.end();
  });

  it('names each pool to Postgres', async () => {
    const url = 'postgres://hornhoof@127.0.0.1:1/hornhoof';
    const keeper = openPool(url, () => {}, 'hornhoof-keeper', { statementTimeoutMs: 2000 });
    const app = openPool(url, () => {}, 'hornhoof-app');
    expect(keeper.options).toMatchObject({ application_name: 'hornhoof-keeper', statement_timeout: 2000 });
    expect(app.options).toMatchObject({ application_name: 'hornhoof-app' });
    expect(app.options).not.toHaveProperty('statement_timeout');
    await Promise.all([keeper.end(), app.end()]);
  });

  it('hands the name and the statement timeout of openDb to its pool', async () => {
    const db = openDb('postgres://hornhoof@127.0.0.1:1/hornhoof', 'hornhoof-keeper', { statementTimeoutMs: 2000 });
    const pool = (db as unknown as { $client: pg.Pool }).$client;
    expect(pool.options).toMatchObject({ application_name: 'hornhoof-keeper', statement_timeout: 2000 });
    await pool.end();
  });
});
