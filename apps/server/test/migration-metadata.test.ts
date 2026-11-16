import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { freshPglite } from './helpers-db.js';

const folder = fileURLToPath(new URL('../drizzle', import.meta.url));
type JournalEntry = { idx: number; when: number; tag: string };
type Snapshot = { id: string; prevId: string; tables: Record<string, { columns: Record<string, unknown>; indexes: Record<string, unknown> }> };

async function journal(): Promise<{ entries: JournalEntry[] }> {
  return JSON.parse(await readFile(join(folder, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] };
}

async function snapshot(tag: string): Promise<Snapshot> {
  return JSON.parse(await readFile(join(folder, 'meta', `${tag.slice(0, 4)}_snapshot.json`), 'utf8')) as Snapshot;
}

/* Named by the journal and not by a tag, so that each new migration does not have to move these tests along. */
async function latestSnapshot(): Promise<Snapshot> {
  return snapshot((await journal()).entries.at(-1)!.tag);
}

describe('merged migration metadata', () => {
  it('carries both histories into the latest snapshot used to generate the next migration', async () => {
    const latest = await latestSnapshot();
    expect(Object.keys(latest.tables['public.person_changes']!.columns)).toEqual(expect.arrayContaining([
      'company_id', 'person_id', 'actor_id', 'field', 'before', 'after', 'created_at',
    ]));
    expect(Object.keys(latest.tables['public.jobs']!.columns)).toEqual(expect.arrayContaining([
      'failure', 'not_before', 'restarted_at', 'requested_prompt',
    ]));
    expect(Object.keys(latest.tables['public.agent_events']!.indexes)).toEqual(expect.arrayContaining([
      'agent_events_failure_case', 'agent_events_operations_pending', 'agent_events_program_history', 'agent_events_silent_job',
    ]));
    expect(Object.keys(latest.tables['public.node_codes']!.columns)).toContain('dismissed_subscription_ids');
    expect(Object.keys(latest.tables['public.node_codes']!.indexes)).toContain('node_codes_active_owner');
  });

  it('records every SQL migration once in increasing index and timestamp order', async () => {
    const { entries } = await journal();
    const files = (await readdir(folder)).filter(file => file.endsWith('.sql')).map(file => file.slice(0, -4));
    expect(entries.map(entry => entry.tag).sort()).toEqual(files.sort());
    expect(new Set(entries.map(entry => entry.when)).size).toBe(entries.length);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.idx).toBeGreaterThan(entries[i - 1]!.idx);
      expect(entries[i]!.when).toBeGreaterThan(entries[i - 1]!.when);
    }
  });

  it('links snapshots in execution order without a second child of the same predecessor', async () => {
    const { entries } = await journal();
    let previous = '00000000-0000-0000-0000-000000000000';
    const ids = new Set<string>();
    for (const entry of entries) {
      const current = await snapshot(entry.tag);
      expect(current.prevId, entry.tag).toBe(previous);
      expect(ids.has(current.id), entry.tag).toBe(false);
      ids.add(current.id);
      previous = current.id;
    }
  });

  it('describes the columns and regular indexes of a freshly migrated database', async () => {
    const client = await freshPglite();
    onTestFinished(() => client.close());
    await migrate(drizzle(client), { migrationsFolder: folder });
    const latest = await latestSnapshot();
    for (const [table, definition] of Object.entries(latest.tables)) {
      const name = table.slice('public.'.length);
      const columns = await client.query<{ column_name: string }>('select column_name from information_schema.columns where table_schema = $1 and table_name = $2', ['public', name]);
      expect(columns.rows.map(column => column.column_name).sort(), table).toEqual(Object.keys(definition.columns).sort());
      const indexes = await client.query<{ indexname: string }>(`select indexname from pg_indexes i
        where schemaname = $1 and tablename = $2
          and not exists (select 1 from pg_constraint c where c.conindid = (quote_ident(i.schemaname) || '.' || quote_ident(i.indexname))::regclass)`, ['public', name]);
      expect(indexes.rows.map(index => index.indexname).sort(), table).toEqual(Object.keys(definition.indexes).sort());
    }
  });
});
