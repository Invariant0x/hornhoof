import { describe, expect, it } from 'vitest';
import { openPool } from '../src/db/client.js';

describe('the database pool', () => {
  it('outlives a connection the database drops, as when Postgres restarts', async () => {
    const dropped: Error[] = [];
    const pool = openPool('postgres://hornhoof@127.0.0.1:1/hornhoof', err => dropped.push(err));
    /* pg reports a dropped idle connection as an error on the pool; without a listener Node ends the process. */
    expect(() => pool.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();
    expect(dropped.map(e => e.message)).toEqual(['Connection terminated unexpectedly']);
    await pool.end();
  });
});
