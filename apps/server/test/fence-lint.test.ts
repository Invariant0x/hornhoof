import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVER = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(SERVER, 'src');

/* The merge's source reads a database that came back, on a connection of its own that only reads. */
const POOL_OWNERS = ['src/db/client.ts', 'src/db/agent-sql.ts', 'src/modules/keeper/lease-store.ts', 'src/modules/merge/source.ts'];
/* The keeper's own session writes what is this machine's alone. A copy's subscription applies what the leader has
   confirmed already, on a machine that has no copy of its own to wait for; so does the one an old leader joins the new
   one with. */
const LOOSE_COMMIT_ALLOWED = ['src/modules/keeper/lease-store.ts', 'src/modules/keeper/copy.ts', 'src/modules/keeper/promote.ts'];
/* net.assert_lease lets a commit through only under synchronous_commit on, and what a session gets of the server is
   whatever its postgresql.auto.conf says: one with local in it refused every write of the app. So each owner of a pool
   that writes under the fence turns it on itself, the keeper's own session alone loosens it, and the merge's source only reads. */
const COMMIT_ON_ITSELF = ['src/db/client.ts', 'src/db/agent-sql.ts'];
const COMMIT_NOT_ON = ['src/modules/keeper/lease-store.ts', 'src/modules/merge/source.ts'];

type Rule = { name: string; matches: (line: string) => boolean; allowedIn?: string[]; sample: string };

const has = (pattern: RegExp) => (line: string) => pattern.test(line);

/* A line may turn the setting on and set something else after a semicolon, as the agent role does right before its COMMIT. */
const RULES: Rule[] = [
  { name: 'session_replication_role skips triggers', matches: has(/session_replication_role/i), sample: 'SET session_replication_role = replica' },
  { name: 'SET CONSTRAINTS IMMEDIATE runs the fence early', matches: has(/SET CONSTRAINTS.*IMMEDIATE/i), sample: 'SET CONSTRAINTS ALL IMMEDIATE' },
  {
    name: 'a loose synchronous_commit lets a commit go without its copy',
    matches: has(/synchronous_commit\b[^;]*\b(off|local|remote_write)\b/i),
    allowedIn: LOOSE_COMMIT_ALLOWED,
    sample: 'SET LOCAL synchronous_commit = local',
  },
  /* The statement, which names what it empties; the right of that name in a list of rights is no statement. */
  { name: 'TRUNCATE writes no journal row', matches: has(/\bTRUNCATE\s+["\w$]/i), sample: 'TRUNCATE tasks' },
  // eslint-disable-next-line hornhoof/no-ddl-on-shared-database -- A sample of text for the lint to read: no database runs it.
  { name: 'DISABLE TRIGGER takes the journal off', matches: has(/DISABLE TRIGGER/i), sample: 'ALTER TABLE tasks DISABLE TRIGGER net_journal' },
  { name: 'PREPARE TRANSACTION commits later, past the fence', matches: has(/PREPARE TRANSACTION/i), sample: "PREPARE TRANSACTION 'x'" },
  { name: 'a pool or client opened outside the files that own them', matches: has(/new (pg\.)?(Pool|Client)\(/i), allowedIn: POOL_OWNERS, sample: 'const pool = new pg.Pool({ connectionString: url });' },
  { name: 'the app opened without its fence', matches: has(/openDb\(.*APP_NAME(?!.*fenced)/i), sample: 'const db = openDb(url, APP_NAME);' },
];

const brokenBy = (file: string, line: string): Rule | undefined => RULES.find(rule => !rule.allowedIn?.includes(file) && rule.matches(line));

function tsFilesUnder(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return tsFilesUnder(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function violationsIn(path: string): string[] {
  const file = relative(SERVER, path).split(sep).join('/');
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line, index) => {
      const rule = brokenBy(file, line);
      return rule ? [`${file}:${index + 1}: ${rule.name}`] : [];
    });
}

describe('the lint of the fences', () => {
  it('takes the right to truncate, named in a list of rights, for no TRUNCATE', () => {
    expect(brokenBy('src/modules/x.ts', "has_table_privilege(r.oid, c.oid, 'DELETE, TRUNCATE, REFERENCES')")).toBeUndefined();
    expect(brokenBy('src/modules/x.ts', 'truncate table "tasks" cascade')?.name).toBe('TRUNCATE writes no journal row');
    expect(brokenBy('src/modules/x.ts', 'TRUNCATE ${table}')?.name).toBe('TRUNCATE writes no journal row');
  });

  it("keeps the app's code from getting past a fence", () => {
    expect(tsFilesUnder(SRC).flatMap(violationsIn)).toEqual([]);
  });

  it.each(RULES.map(rule => [rule.name, rule] as const))('fails on a line where %s', (_name, rule) => {
    expect(brokenBy('src/modules/x.ts', rule.sample)).toBe(rule);
    expect(brokenBy('src/modules/x.ts', rule.sample.toLowerCase())).toBe(rule);
  });

  it('lets the owners of a pool open one, and the lease store loosen its own commit', () => {
    expect(brokenBy('src/db/agent-sql.ts', 'new pg.Client({ connectionString: url })')).toBeUndefined();
    expect(brokenBy('src/modules/keeper/lease-store.ts', 'new pg.Client({ connectionString: url })')).toBeUndefined();
    expect(brokenBy('src/modules/keeper/lease-store.ts', 'SET synchronous_commit = off')).toBeUndefined();
    expect(brokenBy('src/modules/keeper/copy.ts', "CREATE SUBSCRIPTION copy_1 WITH (synchronous_commit = 'local')")).toBeUndefined();
    expect(brokenBy('src/modules/keeper/promote.ts', "CREATE SUBSCRIPTION copy_1 WITH (create_slot = false, synchronous_commit = 'local')")).toBeUndefined();
    expect(brokenBy('src/modules/keeper/sync.ts', "SET synchronous_commit = 'local'")?.name).toBe('a loose synchronous_commit lets a commit go without its copy');
  });

  it('lets the merge source alone open a client', () => {
    expect(POOL_OWNERS).toEqual(['src/db/client.ts', 'src/db/agent-sql.ts', 'src/modules/keeper/lease-store.ts', 'src/modules/merge/source.ts']);
    expect(brokenBy('src/modules/merge/source.ts', 'const client = new Client({ connectionString: url });')).toBeUndefined();
    expect(brokenBy('src/modules/merge/apply.ts', 'const client = new Client({ connectionString: url });')?.name).toBe('a pool or client opened outside the files that own them');
  });

  it('takes turning synchronous_commit on, and what follows it, for no loose commit', () => {
    expect(brokenBy('src/db/agent-sql.ts', "SET LOCAL synchronous_commit = on; SET LOCAL statement_timeout = 0; SELECT net.assert_lease('2 s', NULL)")).toBeUndefined();
  });

  it('has each pool that writes under the fence turn synchronous_commit on itself, and none left out', () => {
    for (const file of COMMIT_ON_ITSELF) expect(readFileSync(join(SERVER, file), 'utf8'), file).toMatch(/synchronous_commit(=| = )on\b/);
    expect([...COMMIT_ON_ITSELF, ...COMMIT_NOT_ON].sort()).toEqual([...POOL_OWNERS].sort());
  });

  it('takes an app that says whether it is fenced', () => {
    expect(brokenBy('src/main.ts', 'const db = openDb(url, APP_NAME, { fenced: config.keeper });')).toBeUndefined();
  });
});
