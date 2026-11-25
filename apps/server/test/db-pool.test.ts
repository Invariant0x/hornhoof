import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { APP_NAME, KEEPER_NAME, openDb, openPool, stripSettings } from '../src/db/client.js';
import { NotConfirmed } from '../src/db/confirm.js';
import { FakePgClient } from './fake-pg-client.js';

const WARNING = { severity: 'WARNING', message: 'canceling wait for synchronous replication due to user request' };

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

  it("fences the app's pool, ends its transactions after 5 s and sets the commit under which the fence lets one through", async () => {
    const url = 'postgres://hornhoof@127.0.0.1:1/hornhoof';
    const fenced = openPool(url, () => {}, APP_NAME, { fenced: true });
    const unfenced = openPool(url, () => {}, APP_NAME);
    const keeper = openPool(url, () => {}, KEEPER_NAME);
    /* net.assert_lease lets a commit through only under synchronous_commit on, so the app asks for it itself and does not
       take what the server gives: a postgresql.auto.conf with local in it made every write refuse. */
    expect(fenced.options).toMatchObject({ options: '-c transaction_timeout=5s -c client_min_messages=warning -c synchronous_commit=on -c hornhoof.fenced=on' });
    expect(unfenced.options).toMatchObject({ options: '-c transaction_timeout=5s -c client_min_messages=warning -c synchronous_commit=on' });
    expect(keeper.options).not.toHaveProperty('options');
    await Promise.all([fenced.end(), unfenced.end(), keeper.end()]);
  });

  it('takes the settings out of the address', async () => {
    const address = 'postgres://u:p@h:5432/d?options=-c%20a%3Db&sslmode=disable&application_name=x';
    expect(stripSettings(address)).toBe('postgres://u:p@h:5432/d?sslmode=disable');
    expect(stripSettings('postgres://u:p@h:5432/d')).toBe('postgres://u:p@h:5432/d');
    const pool = openPool(address, () => {}, APP_NAME);
    expect(pool.options.connectionString).not.toMatch(/options=|application_name=/);
    await pool.end();
  });

  it('keeps errors on every client it connects, and watches the commits of the app alone', async () => {
    const url = 'postgres://hornhoof@127.0.0.1:1/hornhoof';
    const connect = (name: string) => {
      const pool = openPool(url, () => {}, name);
      const client = new FakePgClient();
      pool.emit('connect', client.asPg as pg.PoolClient);
      client.answer = { notice: WARNING };
      return { pool, client };
    };
    const app = connect(APP_NAME);
    const keeper = connect(KEEPER_NAME);
    expect(() => app.client.emit('error', new Error('gone'))).not.toThrow();
    expect(() => keeper.client.emit('error', new Error('gone'))).not.toThrow();
    await expect(app.client.asPg.query('COMMIT')).rejects.toBeInstanceOf(NotConfirmed);
    await expect(keeper.client.asPg.query('COMMIT')).resolves.toEqual({ rows: [] });
    await Promise.all([app.pool.end(), keeper.pool.end()]);
  });
});
