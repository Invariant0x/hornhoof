import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { MIGRATIONS } from '../../src/db/client.js';
import { migrateFolder, type PostgresFixture } from './helpers.js';

type Journal = { version: string; dialect: string; entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[] };
export type HistoryRow = { hash: string; created_at: string };
export type SavedRows = Record<string, Record<string, unknown>[]>;
export const UPGRADE_RUN = '38900000-0000-4000-8000-000000000009';
export const UPGRADE_PART = '38900000-0000-4000-8000-000000000010';

async function oldMigrations(fixture: PostgresFixture): Promise<string> {
  const journal = JSON.parse(await readFile(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as Journal;
  const at = journal.entries.findIndex(entry => entry.tag === '0059_node_connections');
  if (at < 0) throw new Error('The required 0059 journal prefix is missing');
  const folder = await mkdtemp(join(tmpdir(), 'hh-pg-upgrade-'));
  fixture.cleanup(() => rm(folder, { recursive: true, force: true }));
  const entries = journal.entries.slice(0, at + 1);
  await mkdir(join(folder, 'meta'));
  await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  await Promise.all(entries.map(entry => copyFile(join(MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))));
  return folder;
}

async function insertRows(fixture: PostgresFixture, table: string, rows: Record<string, unknown>[]): Promise<void> {
  for (const row of rows) {
    const columns = Object.keys(row).map(column => `"${column}"`).join(', ');
    const values = Object.values(row).map(value => value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
    const parameters = values.map((_, index) => `$${index + 1}`).join(', ');
    await fixture.admin.query(`INSERT INTO "${table}" (${columns}) VALUES (${parameters})`, values);
  }
}

export async function savedRows(fixture: PostgresFixture): Promise<SavedRows> {
  const rows = JSON.parse(await readFile(new URL('./fixtures/upgrade-rows.json', import.meta.url), 'utf8')) as SavedRows;
  const saved: SavedRows = {};
  for (const table of Object.keys(rows)) {
    const found = await fixture.admin.query<{ data: Record<string, unknown> }>(`SELECT to_jsonb(saved) AS data FROM "${table}" saved ORDER BY id`);
    saved[table] = found.rows.map(row => row.data);
  }
  return saved;
}

export async function prepareUpgrade(fixture: PostgresFixture): Promise<{ rows: SavedRows; history: HistoryRow[] }> {
  const migrationsFolder = await oldMigrations(fixture);
  await migrateFolder(fixture, migrationsFolder);
  const rows = JSON.parse(await readFile(new URL('./fixtures/upgrade-rows.json', import.meta.url), 'utf8')) as SavedRows;
  for (const [table, values] of Object.entries(rows)) await insertRows(fixture, table, values);
  return { rows: await savedRows(fixture), history: await migrationHistory(fixture) };
}

export async function migrationHistory(fixture: PostgresFixture): Promise<HistoryRow[]> {
  return (await fixture.admin.query<HistoryRow>('SELECT hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at, hash')).rows;
}

export function candidateHistory(): HistoryRow[] {
  return readMigrationFiles({ migrationsFolder: MIGRATIONS }).map(migration => ({ hash: migration.hash, created_at: String(migration.folderMillis) })).sort((a, b) => Number(a.created_at) - Number(b.created_at) || a.hash.localeCompare(b.hash));
}
