import { DrizzleQueryError } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmCommits, keepErrors, logTimeouts, NotConfirmed, notConfirmed, requestRoute } from '../src/db/confirm.js';
import { FakePgClient } from './fake-pg-client.js';

const WARNING = { severity: 'WARNING', message: 'canceling wait for synchronous replication due to user request' };
const withCode = (code: string, message = 'gone'): Error => Object.assign(new Error(message), { code });

function confirming(): FakePgClient {
  const client = new FakePgClient();
  confirmCommits(client.asPg);
  return client;
}

/* What pg's callback forms answer, as a promise. */
const answerOf = (send: (done: (err: Error | null, result?: unknown) => void) => void): Promise<unknown> =>
  new Promise((resolve, reject) => send((err, result) => (err ? reject(err) : resolve(result))));

describe('confirmCommits', () => {
  it('fails a commit that got a warning', async () => {
    const client = confirming();
    for (const commit of ['COMMIT', 'end']) {
      client.answer = { notice: WARNING };
      const failed: unknown = await client.asPg.query(commit).catch((err: unknown) => err);
      expect(failed, commit).toBeInstanceOf(NotConfirmed);
      expect((failed as NotConfirmed).cause, commit).toBe(WARNING);
      await expect(client.asPg.query(commit), commit).resolves.toEqual({ rows: [] });
    }
  });

  it('fails a statement outside a transaction that got a warning', async () => {
    const client = confirming();
    client.answer = { notice: WARNING };
    await expect(client.asPg.query('INSERT INTO t VALUES (1)')).rejects.toBeInstanceOf(NotConfirmed);

    client.status = 'T';
    client.answer = { notice: WARNING };
    await expect(client.asPg.query('INSERT INTO t VALUES (1)')).resolves.toEqual({ rows: [] });

    client.status = 'I';
    for (const text of ['ROLLBACK', 'BEGIN']) {
      client.answer = { notice: WARNING };
      await expect(client.asPg.query(text), text).resolves.toEqual({ rows: [] });
    }
  });

  /* pg-pool hands out a new connection from inside its first ReadyForQuery, before pg notes the status that came with it. */
  it('fails a statement on a new connection, which has no status yet', async () => {
    const client = confirming();
    client.status = null;
    client.answer = { notice: WARNING };
    await expect(client.asPg.query('INSERT INTO t VALUES (1)')).rejects.toBeInstanceOf(NotConfirmed);
  });

  it('watches every form of query', async () => {
    const client = confirming();
    const forms: [string, () => Promise<unknown>][] = [
      ['a config object', () => client.asPg.query({ text: 'COMMIT' })],
      ['a config object with values', () => client.asPg.query({ text: 'COMMIT' }, [])],
      ['text with values', () => client.asPg.query('COMMIT', [])],
      ['text with a callback', () => answerOf(done => client.asPg.query('COMMIT', done))],
      ['text, values and a callback', () => answerOf(done => client.asPg.query('COMMIT', [], done))],
      ['a config object with a callback', () => answerOf(done => client.asPg.query({ text: 'COMMIT' }, done))],
      ['a config object that carries its callback', () => answerOf(done => client.asPg.query({ text: 'COMMIT', callback: done } as never))],
    ];
    for (const [form, send] of forms) {
      client.answer = { notice: WARNING };
      await expect(send(), form).rejects.toBeInstanceOf(NotConfirmed);
      await expect(send(), form).resolves.toEqual({ rows: [] });
    }
  });

  it('lets a Submittable through unwatched', async () => {
    const client = confirming();
    const submittable = { submit: () => {}, text: 'COMMIT' };
    client.answer = { notice: WARNING };
    await expect(client.asPg.query(submittable as never)).resolves.toEqual({ rows: [] });
    expect(client.sent).toEqual([submittable]);
  });

  it("keeps the database's own error", async () => {
    const client = confirming();
    const refused = withCode('HHF01');
    client.answer = { notice: WARNING, error: refused };
    await expect(client.asPg.query('COMMIT')).rejects.toBe(refused);
  });

  it('hears a notice only during the call it watches', async () => {
    const client = confirming();
    await client.asPg.query('COMMIT');
    client.emit('notice', WARNING);
    expect(client.listenerCount('notice')).toBe(0);
    await expect(client.asPg.query('COMMIT')).resolves.toEqual({ rows: [] });
  });

  it('is once on a client it is put on twice', async () => {
    const client = new FakePgClient();
    confirmCommits(client.asPg);
    const watching = client.query;
    confirmCommits(client.asPg);
    expect(client.query).toBe(watching);
  });
});

describe('notConfirmed', () => {
  it.each<[string, unknown]>([
    ['NotConfirmed', new NotConfirmed(WARNING)],
    ['a session the server ended', { code: '57P01' }],
    ['a transaction the limit ended', { code: '25P04' }],
    ['a lost connection', new Error('Connection terminated unexpectedly')],
    ["drizzle's ROLLBACK on a dead connection", new Error('Client has encountered a connection error and is not queryable')],
    ['a wrapped loss', new DrizzleQueryError('commit', [], withCode('57P01'))],
    ['a wrapped dead connection', new DrizzleQueryError('rollback', [], new Error('Client has encountered a connection error and is not queryable'))],
  ])('is true for %s', (_name, err) => {
    expect(notConfirmed(err)).toBe(true);
  });

  /* The same codes come from any socket, as when a call to another service breaks: only a query of the database that
     broke may have changed the data. */
  it.each(['ECONNRESET', 'EPIPE'])('is true for a connection that broke with %s under a query, and false for the same code from anything else', async code => {
    const client = confirming();
    client.answer = { error: withCode(code) };
    const underQuery: unknown = await client.asPg.query('UPDATE t SET a = 1').catch((err: unknown) => err);
    expect(notConfirmed(underQuery)).toBe(true);
    expect(notConfirmed(new DrizzleQueryError('update', [], underQuery as Error))).toBe(true);
    client.answer = { error: withCode(code) };
    const byCallback: unknown = await answerOf(done => void client.asPg.query('COMMIT', done)).catch((err: unknown) => err);
    expect(notConfirmed(byCallback)).toBe(true);

    expect(notConfirmed(withCode(code))).toBe(false);
    expect(notConfirmed(new Error('fetch failed', { cause: withCode(code) }))).toBe(false);
  });

  it.each<[string, unknown]>([
    ['a unique violation', { code: '23505' }],
    ['a refused lease', { code: 'HHF01' }],
    ['another error', new Error('The disk is full.')],
    ['nothing', undefined],
  ])('is false for %s', (_name, err) => {
    expect(notConfirmed(err)).toBe(false);
  });
});

describe('keepErrors', () => {
  it('keeps an error between queries from ending the process', () => {
    const client = new FakePgClient();
    keepErrors(client.asPg);
    keepErrors(client.asPg);
    expect(client.listenerCount('error')).toBe(1);
    expect(() => client.emit('error', new Error('gone'))).not.toThrow();
  });
});

describe('logTimeouts', () => {
  let now = 1_000_000;
  const after = (ms: number) => {
    now += ms;
  };
  const lines: string[] = [];

  function timed(): FakePgClient {
    const client = new FakePgClient();
    keepErrors(client.asPg);
    logTimeouts(client.asPg, line => lines.push(line));
    return client;
  }

  beforeEach(() => {
    lines.length = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the route of a transaction the limit ended', async () => {
    const client = timed();
    await requestRoute.run('GET /api/org', () => client.asPg.query('begin'));
    after(120);
    client.emit('error', withCode('25P04'));
    client.answer = { error: withCode('25P04') };
    await expect(client.asPg.query('select 1')).rejects.toMatchObject({ code: '25P04' });
    expect(lines).toEqual(['The 5 s limit ended a transaction of GET /api/org after 120 ms.']);
  });

  it('names it when a query hears of the limit, and says when no request runs it', async () => {
    const client = timed();
    await client.asPg.query('BEGIN');
    after(5001);
    client.answer = { error: withCode('25P04') };
    await expect(client.asPg.query('select pg_sleep(6)')).rejects.toMatchObject({ code: '25P04' });
    expect(lines).toEqual(['The 5 s limit ended a transaction of work outside a request after 5001 ms.']);
  });

  it('says nothing of a session that ended otherwise', async () => {
    const client = timed();
    await client.asPg.query('begin');
    after(120);
    client.emit('error', withCode('57P01'));
    expect(lines).toEqual([]);
  });

  it('warns of a transaction that ran over 2 s', async () => {
    const client = timed();
    await requestRoute.run('POST /api/tasks', () => client.asPg.query('begin'));
    after(2100);
    await client.asPg.query('commit');
    expect(lines).toEqual(['A transaction of POST /api/tasks ran 2100 ms.']);
  });

  it('says nothing of a transaction under 2 s', async () => {
    const client = timed();
    await client.asPg.query('begin');
    after(1900);
    await client.asPg.query('commit');
    expect(lines).toEqual([]);
  });

  it('warns of a rollback too, and of none to a savepoint', async () => {
    const client = timed();
    await client.asPg.query('begin');
    after(2500);
    await client.asPg.query('rollback to savepoint sp1');
    expect(lines).toEqual([]);
    await client.asPg.query('rollback');
    expect(lines).toEqual(['A transaction of work outside a request ran 2500 ms.']);
  });

  it('counts a statement outside a transaction as a transaction of its own', async () => {
    const client = timed();
    client.answer = { during: () => after(2100) };
    await requestRoute.run('GET /api/org', () => client.asPg.query('select 1'));
    expect(lines).toEqual(['A transaction of GET /api/org ran 2100 ms.']);

    lines.length = 0;
    client.answer = { during: () => after(5001), error: withCode('25P04') };
    await expect(requestRoute.run('GET /api/org', () => client.asPg.query('select 1'))).rejects.toMatchObject({ code: '25P04' });
    expect(lines).toEqual(['The 5 s limit ended a transaction of GET /api/org after 5001 ms.']);
  });

  it('says nothing of a slow query inside a transaction before it ends', async () => {
    const client = timed();
    await client.asPg.query('begin');
    client.answer = { during: () => after(3000) };
    await client.asPg.query('select 1');
    expect(lines).toEqual([]);
  });

  it('does not take a failed commit for a transaction that ran', async () => {
    const client = timed();
    await client.asPg.query('begin');
    after(2100);
    client.answer = { error: withCode('HHF01') };
    await expect(client.asPg.query('commit')).rejects.toMatchObject({ code: 'HHF01' });
    expect(lines).toEqual([]);
  });

  it('is once on a client it is put on twice', async () => {
    const client = timed();
    logTimeouts(client.asPg, line => lines.push(line));
    await client.asPg.query('begin');
    after(2100);
    await client.asPg.query('commit');
    expect(lines).toHaveLength(1);
  });
});
