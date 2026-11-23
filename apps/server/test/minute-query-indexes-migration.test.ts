import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { createTestDb } from './helpers-db.js';

/* #1981: what the minute checks ask of the jobs and the events of every agent (1.5 M rows, 934 MB) has an index that answers
   it, and a statistic that tells the planner how rare it is, so no check reads a whole table once a minute. */
const TAG = '_minute_query_indexes';
const tagged = async (): Promise<string> => {
  const journal = JSON.parse(await readFile(`${MIGRATIONS}/meta/_journal.json`, 'utf8')) as { entries: { tag: string }[] };
  return journal.entries.find(entry => entry.tag.endsWith(TAG))!.tag;
};

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

async function definition(db: TestDb, name: string): Promise<string[]> {
  const { rows } = await db.execute<{ indexdef: string }>(sql`select indexdef from pg_indexes where schemaname = 'public' and indexname = ${name}`);
  return rows.map(row => row.indexdef);
}

it('indexes the conversations of an agent with what the quiet check reads of them, so it needs no row of the table', async () => {
  const [def] = await definition(await createTestDb(), 'jobs_conversation_activity');
  expect(def).toContain('(agent_id, company_id, status, started_at, finished_at)');
  expect(def).toContain("WHERE (kind = 'conversation'::text)");
});

it('indexes the operator\'s fallback turns by agent and delivery, as the check of unheard words asks for them', async () => {
  const [def] = await definition(await createTestDb(), 'agent_events_operator_fallback');
  expect(def).toContain("(agent_id, ((data ->> 'operatorFallback'::text)))");
  expect(def).toContain("kind = 'typed'::text");
  expect(def).toContain("(data ->> 'operatorFallback'::text) IS NOT NULL");
});

it('tells the planner how rare the pending Operations notices are, so it goes to their index', async () => {
  const db = await createTestDb();
  const { rows } = await db.execute<{ stxname: string }>(sql`select stxname from pg_statistic_ext where stxname = 'agent_events_operations_pending_stat'`);
  expect(rows).toHaveLength(1);
});

it('runs again over what is there already: an index or a statistic someone made by hand is adopted', async () => {
  const db = await createTestDb();
  const text = await readFile(`${MIGRATIONS}/${await tagged()}.sql`, 'utf8');
  for (const part of text.split('--> statement-breakpoint')) if (part.trim()) await db.execute(sql.raw(part));
  expect((await definition(db, 'jobs_conversation_activity')).length).toBe(1);
});
