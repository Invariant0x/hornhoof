import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, inject, it, onTestFinished } from 'vitest';
import { createTestDb } from './helpers-db.js';

/* Values of the kinds a test reads back: Postgres's own types and arrays of them. */
const BUILT_IN = `select 1::int4 as int4, 5::int8 as int8, 1.5::numeric as numeric, true as bool, '{"k":[1]}'::jsonb as jsonb, 'a'::text as text,
  '2026-11-09 12:00:00+00'::timestamptz as at, array[1, 2]::int4[] as int4s, array[5]::int8[] as int8s, array['x', 'y']::text[] as texts,
  array['00000000-0000-0000-0000-000000000001']::uuid[] as uuids, array[true, false] as bools, array['{"a":1}'::jsonb] as jsonbs,
  array[1.5]::numeric[] as numerics, array['2026-11-09 12:00:00+00'::timestamptz] as ats, array[array[1, 2], array[3, 4]] as grid`;
/* An array of a type of the schema itself. */
const OWN = `insert into companies (id, name, created_at) values ('00000000-0000-0000-0000-000000000001', 'Acme', '2026-11-09 12:00:00+00');
  select array_agg(c) as companies from companies c`;

/* A copy of the migrated database as PGlite opens one, with every parser it has. */
function plainCopy(): PGlite {
  const db = new PGlite({ loadDataDir: new Blob([readFileSync(inject('migratedDataDir'))]) });
  onTestFinished(() => db.close());
  return db;
}

describe('a test database', () => {
  it("reads values of Postgres's own types back as PGlite reads them with all its parsers", async () => {
    const db = await createTestDb();
    expect((await db.$client.query(BUILT_IN)).rows).toEqual((await plainCopy().query(BUILT_IN)).rows);
  });

  it('reads an array of a type of its schema back as PGlite does', async () => {
    const db = await createTestDb();
    expect((await db.$client.exec(OWN))[1]!.rows).toEqual((await plainCopy().exec(OWN))[1]!.rows);
  });

  it('keeps only the parsers of the types of its own schema, as those of the others are the same in every database', async () => {
    const db = await createTestDb();
    expect(Object.keys(db.$client.parsers).filter(oid => Number(oid) < 16384)).toEqual([]);
  });
});
