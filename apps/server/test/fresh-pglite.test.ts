import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { freshPglite } from './helpers-db.js';

const dumps = vi.spyOn(PGlite.prototype, 'dumpDataDir');

async function fresh(): Promise<PGlite> {
  const client = await freshPglite();
  onTestFinished(() => client.close());
  return client;
}

/* What migrations meet: the settings of the database and everything in it. */
async function whatItHolds(client: PGlite): Promise<unknown[]> {
  const settings = await client.query(`select name, setting from pg_settings where name in ('server_encoding', 'lc_collate', 'lc_ctype', 'TimeZone', 'server_version', 'search_path', 'standard_conforming_strings') order by name`);
  const databases = await client.query(`select datname, encoding, datcollate, datctype from pg_database order by datname`);
  const objects = await client.query(`select n.nspname, count(*)::int as count from pg_class c join pg_namespace n on n.oid = c.relnamespace group by n.nspname order by n.nspname`);
  const roles = await client.query(`select rolname, rolsuper from pg_roles order by rolname`);
  return [settings.rows, databases.rows, objects.rows, roles.rows];
}

describe('a fresh database for a migration test', () => {
  it('holds what a database just made by initdb holds, with no table of the product', async () => {
    const initdb = new PGlite();
    onTestFinished(() => initdb.close());
    const client = await fresh();
    expect(await whatItHolds(client)).toEqual(await whatItHolds(initdb));
    expect((await client.query(`select tablename from pg_tables where schemaname = 'public'`)).rows).toEqual([]);
  });

  it('keeps what one writes from the next', async () => {
    const first = await fresh();
    await first.exec('create table notes (id int)');
    const second = await fresh();
    expect((await second.query(`select tablename from pg_tables where schemaname = 'public'`)).rows).toEqual([]);
  });

  it('runs initdb once however many a file opens', async () => {
    await fresh();
    await fresh();
    expect(dumps).toHaveBeenCalledOnce();
  });
});
