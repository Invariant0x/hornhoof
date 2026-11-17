import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { checkAgentSql, ONLY_STATEMENTS, REFUSED_FUNCTIONS, SqlRefused } from '../src/db/sql-check.js';

const refusedFor = (name: string) => expect.objectContaining({ kind: 'function', message: `This tool does not call ${name}.` });

describe("the check on the orchestrator's SQL", () => {
  let warn: MockInstance;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it.each([
    'SELECT 1',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    "INSERT INTO notebook_notes (id, body) VALUES (1, 'a')",
    "UPDATE notebook_notes SET body = 'b' WHERE id = 1",
    'DELETE FROM notebook_notes WHERE id = 1',
    'WITH d AS (DELETE FROM notebook_notes RETURNING id) SELECT count(*) FROM d',
    'SELECT pg_sleep(1)',
    "SELECT 1; UPDATE notebook_notes SET body = 'b'",
  ])('lets reads and row changes through: %s', async text => {
    await expect(checkAgentSql(text)).resolves.toBeUndefined();
  });

  /* Each of these holds a refused name where it calls nothing, so a check that only looked for the words would stop them. */
  it.each([
    "SELECT 'pg_cancel_backend(1)', 'net.assert_lease'",
    'SELECT set_config FROM agents',
    'SELECT net.id FROM agents net',
    'SELECT a.name, a.* FROM agents a',
    'SELECT (a).name, tags[1] FROM agents a',
    "SELECT lower(name), logs FROM agents",
    '/* only a comment */',
  ])('leaves alone what only looks like a refused name: %s', async text => {
    await expect(checkAgentSql(text)).resolves.toBeUndefined();
  });

  const notRowChanges = [
    'COMMIT',
    'BEGIN',
    'SET LOCAL synchronous_commit = local',
    'RESET transaction_timeout',
    'SET CONSTRAINTS ALL IMMEDIATE',
    'DO $$ BEGIN END $$',
    'CALL p()',
    "PREPARE TRANSACTION 'x'",
    'MERGE INTO agents a USING agents b ON a.id = b.id WHEN MATCHED THEN DELETE',
    'EXPLAIN SELECT 1',
    'SELECT 1 INTO t',
    // eslint-disable-next-line hornhoof/no-ddl-on-shared-database -- A text the check must refuse: no database runs it.
    'CREATE TABLE t (id int)',
  ];
  it.each([...notRowChanges, ...notRowChanges.map(text => `SELECT 1; ${text}`)])(
    'refuses what is not a row change, also after a first statement: %s',
    async text => {
      await expect(checkAgentSql(text)).rejects.toMatchObject({ kind: 'statement', message: ONLY_STATEMENTS });
    },
  );

  /* Postgres takes INTO on the leftmost branch of a set operation, and MERGE inside WITH, so looking only at the top misses both. */
  it.each([
    'SELECT 1 INTO t UNION SELECT 2',
    'WITH x AS (SELECT 1) SELECT * INTO t FROM x',
    'WITH m AS (MERGE INTO agents a USING agents b ON a.id = b.id WHEN MATCHED THEN DELETE RETURNING a.id) SELECT * FROM m',
  ])('refuses a statement hidden inside an allowed one: %s', async text => {
    await expect(checkAgentSql(text)).rejects.toMatchObject({ kind: 'statement', message: ONLY_STATEMENTS });
  });

  it.each([
    ['SELECT pg_cancel_backend(1)', 'pg_cancel_backend'],
    ['SELECT pg_catalog.pg_terminate_backend(1)', 'pg_terminate_backend'],
    ['SELECT pg_reload_conf()', 'pg_reload_conf'],
    ["SELECT set_config('transaction_timeout', '0', true)", 'set_config'],
    ["SELECT set_config('search_path', 'public', true)", 'set_config'],
    ["SELECT lo_from_bytea(0, '\\x00')", 'lo_from_bytea'],
    ['SELECT loread(0, 1)', 'loread'],
    ["SELECT query_to_xml('select 1', true, true, '')", 'query_to_xml'],
    ["SELECT * FROM ts_stat('select 1')", 'ts_stat'],
    ["SELECT ts_rewrite('x'::tsquery, $$SELECT 'x'::tsquery, 'y'::tsquery FROM net.assert_lease('0s', NULL)$$)", 'ts_rewrite'],
    ["SELECT net.assert_lease('0 s', NULL)", 'net.assert_lease'],
    ['SELECT 1 FROM agents WHERE id IN (SELECT id FROM agents WHERE pg_cancel_backend(1))', 'pg_cancel_backend'],
    ["UPDATE agents SET name = set_config('a.b', 'c', true)", 'set_config'],
    ['SELECT (pg_backend_pid()).pg_cancel_backend', 'pg_cancel_backend'],
    ['SELECT a.pg_terminate_backend FROM agents a', 'pg_terminate_backend'],
  ])('refuses the functions that reach other sessions, settings, large objects or hidden queries: %s', async (text, name) => {
    await expect(checkAgentSql(text)).rejects.toEqual(refusedFor(name));
  });

  /* Each place is one a list of node kinds could forget. */
  it.each([
    'WITH d AS (DELETE FROM agents WHERE pg_reload_conf() RETURNING id) SELECT * FROM d',
    'WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r WHERE pg_reload_conf()) SELECT * FROM r',
    'SELECT lower(coalesce(pg_reload_conf()::text, name)) FROM agents',
    'SELECT CASE WHEN pg_reload_conf() THEN 1 END',
    'SELECT ARRAY[pg_reload_conf()]',
    'SELECT 1 FROM agents ORDER BY pg_reload_conf()',
    'SELECT 1 FROM agents GROUP BY 1 HAVING pg_reload_conf()',
    'SELECT 1 LIMIT (SELECT 1 WHERE pg_reload_conf())',
    'SELECT count(*) FILTER (WHERE pg_reload_conf()) FROM agents',
    'SELECT sum(1) OVER (PARTITION BY pg_reload_conf()) FROM agents',
    'SELECT * FROM agents a, LATERAL (SELECT pg_reload_conf()) x',
    'SELECT * FROM agents a JOIN agents b ON pg_reload_conf()',
    'SELECT 1 UNION SELECT 1 WHERE pg_reload_conf()',
    'SELECT 1 FROM agents WHERE EXISTS (SELECT 1 WHERE pg_reload_conf())',
    "SELECT * FROM JSON_TABLE('[]'::jsonb, '$' PASSING pg_reload_conf() AS p COLUMNS (x int PATH '$'))",
    "SELECT * FROM XMLTABLE('/a' PASSING (pg_reload_conf()::text::xml) COLUMNS x int)",
    'INSERT INTO agents (name) VALUES (pg_reload_conf()::text)',
    'INSERT INTO agents (name) SELECT pg_reload_conf()::text',
    "INSERT INTO agents (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET name = pg_reload_conf()::text",
    'UPDATE agents SET (name, kind) = (SELECT pg_reload_conf()::text, 1)',
    'UPDATE agents SET name = name FROM agents b WHERE pg_reload_conf()',
    'DELETE FROM agents USING agents b WHERE pg_reload_conf()',
    'DELETE FROM agents RETURNING pg_reload_conf()',
  ])('finds a refused call wherever it stands: %s', async text => {
    await expect(checkAgentSql(text)).rejects.toEqual(refusedFor('pg_reload_conf'));
  });

  it.each([
    ['SELECT PG_CANCEL_BACKEND(1)', 'pg_cancel_backend'],
    ['SELECT "pg_cancel_backend"(1)', 'pg_cancel_backend'],
    ['SELECT U&"pg\\005fcancel\\005fbackend"(1)', 'pg_cancel_backend'],
    ['SELECT lo_unlink(1)', 'lo_unlink'],
    ['SELECT (1).lo_unlink', 'lo_unlink'],
    ['SELECT net_local.whatever()', 'net_local.whatever'],
    ['SELECT * FROM net.anything(1)', 'net.anything'],
    /* Postgres takes a three part name when its first part is the database it runs in. */
    ["SELECT hornhoof.net.assert_lease('0 s', NULL)", 'hornhoof.net.assert_lease'],
    ['SELECT public.t.pg_cancel_backend FROM public.t', 'pg_cancel_backend'],
    ['SELECT ((a).name).pg_cancel_backend FROM agents a', 'pg_cancel_backend'],
    ['SELECT (a).pg_cancel_backend.name FROM agents a', 'pg_cancel_backend'],
  ])('sees a refused name however it is spelled: %s', async (text, name) => {
    await expect(checkAgentSql(text)).rejects.toEqual(refusedFor(name));
  });

  /* Written out here, not read from the code, as the other side of this list is what the database takes away from PUBLIC. */
  const refusedNames = [
    'pg_cancel_backend',
    'pg_terminate_backend',
    'pg_reload_conf',
    'set_config',
    'lo_*',
    'loread',
    'lowrite',
    'query_to_xml',
    'query_to_xmlschema',
    'query_to_xml_and_xmlschema',
    'ts_stat',
    'ts_rewrite',
  ];
  it('shares the names of the refused functions', () => {
    expect(REFUSED_FUNCTIONS).toEqual(refusedNames);
  });

  it.each(refusedNames.map(entry => entry.replace('*', 'x')))('refuses %s as a call and as a field', async name => {
    await expect(checkAgentSql(`SELECT ${name}(1)`)).rejects.toEqual(refusedFor(name));
    await expect(checkAgentSql(`SELECT a.${name} FROM agents a`)).rejects.toEqual(refusedFor(name));
    await expect(checkAgentSql(`SELECT (1).${name}`)).rejects.toEqual(refusedFor(name));
  });

  it.each(['COMMIT', 'SELECT pg_reload_conf()', 'SELEC 1'])('throws its own error, for the tool to tell from the database: %s', async text => {
    await expect(checkAgentSql(text)).rejects.toBeInstanceOf(SqlRefused);
  });

  it('says what the parser says about a typo', async () => {
    await expect(checkAgentSql('SELEC 1')).rejects.toMatchObject({ kind: 'syntax', message: expect.stringContaining('syntax error') });
  });

  /* Half a surrogate pair is counted short when the parser's copy is made, so the copy loses the text's end, while the
     database gets all of it. Here that end is the COMMIT. A NUL ends the copy the same way. */
  it.each([
    'SELECT 1 /*' + '\uD800\u4E00'.repeat(4) + '*/;COMMIT;',
    'SELECT 1\0; COMMIT',
    "SELECT '\uDC00'",
  ])('refuses a text the parser would read differently from the database: %j', async text => {
    await expect(checkAgentSql(text)).rejects.toMatchObject({ kind: 'syntax' });
  });

  it('takes a text with whole characters of any size', async () => {
    await expect(checkAgentSql("SELECT '\u{1F600} \u4E00 \u00E9'")).resolves.toBeUndefined();
  });

  it('refuses a text the parser gives up on, and still answers after it', async () => {
    await expect(checkAgentSql(' ')).rejects.toMatchObject({ kind: 'syntax' });
    await expect(checkAgentSql(`SELECT ${'('.repeat(100_000)}1${')'.repeat(100_000)}`)).rejects.toMatchObject({ kind: 'syntax' });
    /* A tree this deep runs the parser out of call stack, which it reports as no parse error of its own. */
    await expect(checkAgentSql(`SELECT 1${'+1'.repeat(100_000)}`)).rejects.toMatchObject({ kind: 'syntax' });
    await expect(checkAgentSql('SELECT 1; COMMIT')).rejects.toMatchObject({ kind: 'statement' });
  });

  /* A star names no field, so nothing here can be a call, whatever the alias is called. */
  it.each([
    'SELECT lo_rows.* FROM (SELECT 1) lo_rows',
    'SELECT set_config.* FROM agents set_config',
    'SELECT public.set_config.* FROM public.set_config',
  ])('leaves alone a star after an alias named like a refused function: %s', async text => {
    await expect(checkAgentSql(text)).resolves.toBeUndefined();
  });

  /* The tool words its refusal by kind, so a text with two faults must hear about the one it reaches first. */
  it.each([
    ['COMMIT; SELECT pg_cancel_backend(1)', { kind: 'statement', message: ONLY_STATEMENTS }],
    ['SELECT pg_cancel_backend(1); COMMIT', { kind: 'function', message: 'This tool does not call pg_cancel_backend.' }],
    ['SELECT pg_reload_conf(), pg_cancel_backend(1)', { kind: 'function', message: 'This tool does not call pg_reload_conf.' }],
  ])('names the first fault in the order of the text: %s', async (text, refusal) => {
    await expect(checkAgentSql(text)).rejects.toMatchObject(refusal);
  });

  /* Looping output has this very shape, and it fits within the tool's limit of 20,000 characters. Each one overflows the
     parser's stack, and forty of them used to kill a parser that was kept, until the app restarted. Now each one costs
     its parser and no other, so no parser meets a second one: a few in a row show it as well as forty, each a new parser
     that takes most of a second to start. */
  const FLOOD = 3;
  it('keeps answering after a flood of texts too deep for the parser', async () => {
    const tooDeep = `SELECT 1${'+1'.repeat(9990)}`;
    for (let call = 1; call <= FLOOD; call++) {
      await expect(checkAgentSql(tooDeep)).rejects.toMatchObject({ kind: 'syntax' });
      expect(warn).toHaveBeenCalledTimes(call);
    }
    await expect(checkAgentSql('SELECT 1; COMMIT')).rejects.toMatchObject({ kind: 'statement' });
    await expect(checkAgentSql('SELECT 1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(FLOOD);
  });

  /* The log goes where the company's people and agents read it, and the text is what the orchestrator wrote. */
  it('logs that it replaced a parser, without the text', async () => {
    const tooDeep = `SELECT 'the text itself'${'+1'.repeat(9990)}`;
    await expect(checkAgentSql(tooDeep)).rejects.toMatchObject({ kind: 'syntax', message: expect.not.stringContaining('the text itself') });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).not.toContain('the text itself');
  });

  it('replaces no parser over a typo or an empty text', async () => {
    await expect(checkAgentSql('SELEC 1')).rejects.toMatchObject({ kind: 'syntax' });
    await expect(checkAgentSql(' ')).rejects.toMatchObject({ kind: 'syntax' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('finds a refused call at the bottom of a deep expression', async () => {
    await expect(checkAgentSql(`SELECT pg_reload_conf()::int${'+1'.repeat(1000)}`)).rejects.toEqual(refusedFor('pg_reload_conf'));
  });
});
