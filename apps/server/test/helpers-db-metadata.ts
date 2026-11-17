import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';

/* A list of rights in one order: granted again after a revoke, a right goes to its end, and means the same. */
const rights = (acl: string) => `(select array_agg(item::text order by item::text) from unnest(${acl}) item)`;

/* All that a truncate leaves as it was and a test can change. Rows of pg_class and the like hold more, but that more moves
   with every truncate. */
const SHAPE = `select md5(string_agg(line, E'\n' order by line)) as shape from (
  select format('relation %s %s %s %s', c.oid::regclass, c.relkind, ${rights('c.relacl')}, c.relrowsecurity) as line
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
  union all select format('column %s %s %s %s %s', a.attrelid::regclass, a.attname, a.atttypid, ${rights('a.attacl')}, pg_get_expr(d.adbin, d.adrelid))
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attnum > 0 and not a.attisdropped and n.nspname = 'public'
  union all select format('constraint %s %s %s', c.conrelid::regclass, c.conname, pg_get_constraintdef(c.oid))
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public'
  union all select format('index %s', indexdef) from pg_indexes where schemaname = 'public'
  union all select format('trigger %s %s %s', t.tgrelid::regclass, t.tgname, t.tgenabled) from pg_trigger t where not t.tgisinternal
  union all select format('policy %s %s', p.polrelid::regclass, p.polname) from pg_policy p
  union all select format('function %s %s %s', p.oid::regprocedure, md5(p.prosrc), ${rights('p.proacl')})
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
  union all select format('type %s', t.oid::regtype) from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public'
  union all select format('value %s %s', e.enumtypid::regtype, e.enumlabel) from pg_enum e
  union all select format('schema %s %s', n.nspname, ${rights('n.nspacl')}) from pg_namespace n
  union all select format('role %s %s %s', r.rolname, r.rolsuper, r.rolcanlogin) from pg_roles r
  union all select format('member %s %s', m.roleid, m.member) from pg_auth_members m
  union all select format('default rights %s', ${rights('d.defaclacl')}) from pg_default_acl d
  union all select format('database settings %s', s.setconfig) from pg_db_role_setting s
  union all select format('statistics %s', s.starelid::regclass) from pg_statistic s join pg_class c on c.oid = s.starelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
) lines`;

export async function shapeOf(client: PGlite): Promise<string> {
  const { rows } = await client.query<{ shape: string }>(SHAPE);
  return rows[0]!.shape;
}

/* What the planner knows of each table and index of the database: how many pages and rows it has, and how many of its
   pages hold only rows every transaction sees. */
const PLANNER_VIEW = `select coalesce(json_agg(json_build_object('oid', c.oid, 'relpages', c.relpages, 'reltuples', c.reltuples, 'relallvisible', c.relallvisible)), '[]')::text as view
  from pg_class c where c.relnamespace in ('public'::regnamespace, 'net'::regnamespace) and c.relkind in ('r', 'i')`;

/* Each table, with the tables whose foreign keys point at it, each by its schema: the records of merges in net point at
   each other too. */
const POINTED_AT_BY = `select format('%I.%I', t.relnamespace::regnamespace, t.relname) as table, format('%I.%I', f.relnamespace::regnamespace, f.relname) as by
  from pg_constraint c join pg_class t on t.oid = c.confrelid join pg_class f on f.oid = c.conrelid where c.contype = 'f'`;

/* Only a table with pages can hold rows. The journal of changes, in the schema net, is emptied with the tables it tells of.
   By name, as the order pg_class is read in changes once a truncate rewrites a table, and rows made once are found by it. */
const WITH_PAGES = `select format('%I.%I', c.relnamespace::regnamespace, c.relname) as name from pg_class c
  where c.relnamespace in ('public'::regnamespace, 'net'::regnamespace) and c.relkind = 'r' and pg_relation_size(c.oid) > 0 order by 1`;
export const pagedTables = async (client: PGlite): Promise<string[]> => (await client.query<{ name: string }>(WITH_PAGES)).rows.map(t => t.name);

/* The tables of a database that hold rows, of those with pages: a table emptied in a test keeps its pages. */
export async function tablesWithRows(client: PGlite): Promise<string[]> {
  const tables = await pagedTables(client);
  if (!tables.length) return [];
  const { rows } = await client.query<{ at: number }>(tables.map((name, at) => `select ${at} as at where exists (select 1 from ${name})`).join(' union all '));
  return rows.map(r => tables[r.at]!);
}

export type Rows = { tables: { name: string; rows: Blob }[]; numbers: { name: string; value: string }[] };
const NUMBERS = `select format('%I.%I', schemaname, sequencename) as name, last_value::text as value from pg_sequences
  where schemaname = 'public' and last_value is not null`;

/* Every row of the database, table by table in the order a scan reads them, and where its numbers stand. */
export async function rowsOf(client: PGlite): Promise<Rows> {
  const tables = [];
  for (const name of await tablesWithRows(client)) tables.push({ name, rows: (await client.query(`copy ${name} to '/dev/blob' with (format binary)`)).blob! });
  return { tables, numbers: (await client.query<{ name: string; value: string }>(NUMBERS)).rows };
}

export type DatabaseMetadata = { shape: string; planner: string; pointedAtBy: [string, string[]][]; seeded: Rows };
type StoredMetadata = Omit<DatabaseMetadata, 'seeded'> & { version: 1; dumpDigest: string; seeded: { tables: { name: string; rows: string }[]; numbers: Rows['numbers'] } };

/* Every copy starts from the same immutable dump, so its catalog and seed description is prepared once per run. */
export async function databaseMetadata(client: PGlite): Promise<DatabaseMetadata> {
  const { rows } = await client.query<{ view: string }>(PLANNER_VIEW);
  const pointedAtBy = new Map<string, string[]>();
  for (const { table, by } of (await client.query<{ table: string; by: string }>(POINTED_AT_BY)).rows) pointedAtBy.set(table, [...(pointedAtBy.get(table) ?? []), by]);
  return { shape: await shapeOf(client), planner: rows[0]!.view, pointedAtBy: [...pointedAtBy], seeded: await rowsOf(client) };
}

const digest = (dump: Buffer): string => createHash('sha256').update(dump).digest('hex');

export async function encodeDatabaseMetadata(value: DatabaseMetadata, dump: Buffer): Promise<string> {
  const tables = await Promise.all(value.seeded.tables.map(async ({ name, rows }) => ({ name, rows: Buffer.from(await rows.arrayBuffer()).toString('base64') })));
  const stored: StoredMetadata = { ...value, version: 1, dumpDigest: digest(dump), seeded: { tables, numbers: value.seeded.numbers } };
  return JSON.stringify(stored);
}

export function decodeDatabaseMetadata(text: string, dump: Buffer): DatabaseMetadata {
  const stored = JSON.parse(text) as StoredMetadata;
  if (stored.version !== 1 || stored.dumpDigest !== digest(dump)) throw new Error('Test database metadata does not match its migrated dump.');
  return { shape: stored.shape, planner: stored.planner, pointedAtBy: stored.pointedAtBy,
    seeded: { tables: stored.seeded.tables.map(({ name, rows }) => ({ name, rows: new Blob([Buffer.from(rows, 'base64')]) })), numbers: stored.seeded.numbers } };
}
