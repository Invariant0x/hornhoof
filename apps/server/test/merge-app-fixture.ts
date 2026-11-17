import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import type { Db } from '../src/db/client.js';
import { agents, companies, departments, jobs, people, subscriptions, tasks, turns } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { runMerge, type MergeResult } from '../src/modules/merge/apply.js';
import { appOn, setUpCompany } from './helpers.js';
import { openTestDb } from './helpers-db.js';
import { forkOf, pgliteSource } from './merge-fixture.js';

export const ORCHESTRATOR_TOKEN = 'tool-token-merge-0123456789abcdef0123';

export type Conflict = { id: string; merge: string; tbl: string; key: Record<string, unknown>; op: string; kind: string; topic: string; task_id: string | null; cols: string[]; here: Record<string, unknown> | null; there: Record<string, unknown> | null; picked: string | null; value: Record<string, unknown> | null; picked_by: string | null; why: string };

export const rowsOf = async <T>(db: Db, query: ReturnType<typeof sql>): Promise<T[]> => ((await db.execute(query)) as unknown as { rows: T[] }).rows;

/* An app that leads on a company: its owner, its orchestrator with a turn that runs, Development with a repository, a
   head and two workers, an open turn with two tasks; and forks of its database that are merged back into it. */
export async function mergeApp(env: NodeJS.ProcessEnv = {}) {
  const opened = await openTestDb();
  onTestFinished(() => opened.client.close());
  const control = mkdtempSync(join(tmpdir(), 'hh-control-'));
  const { app, db } = await appOn(opened.client, { HORNHOOF_CONTROL_DIR: control, ...env });
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const on = { companyId: acme!.id };
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [plan] = await db.select().from(subscriptions);
  const staff = { ...on, subscriptionId: plan!.id, model: '' };
  const [dev] = await db.insert(departments).values({ ...on, name: 'Development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/app' }).returning();
  const [hana] = await db.insert(agents).values({ ...staff, kind: 'head', name: 'Hana', departmentId: dev!.id }).returning();
  const [ana] = await db.insert(agents).values({ ...staff, kind: 'worker', name: 'Ana', departmentId: dev!.id }).returning();
  const [turn] = await db.insert(turns).values({ ...on, departmentId: dev!.id, number: 1, goal: 'Ship', status: 'open' }).returning();
  const task = async (side: Db, number: number, title: string, over: Partial<typeof tasks.$inferInsert> = {}) =>
    (await side.insert(tasks).values({ ...on, number, title, departmentId: dev!.id, turnId: turn!.id, createdByPersonId: owner!.id, ...over }).returning())[0]!;
  const [one, two] = [await task(db, 1, 'One'), await task(db, 2, 'Two')];
  /* The orchestrator's turn is the CEO's, so every tool of his works in it. */
  await db.insert(jobs).values({ ...on, subscriptionId: plan!.id, agentId: orchestrator!.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900_000, status: 'running', toolTokenHash: hashToken(ORCHESTRATOR_TOKEN), answersCeo: true, createdBy: owner!.id });
  let made = 0;
  const fork = async () => {
    const side = await forkOf(opened.client);
    return { ...side, source: (label = 'the fork') => pgliteSource(side.client, label) };
  };
  type Fork = Awaited<ReturnType<typeof fork>>;
  /* A merge of this fork into the app's database, as the merger would run it. */
  const merge = async (side: Fork, over: { kept?: boolean; label?: string } = {}): Promise<{ id: string; result: MergeResult }> => {
    made += 1;
    const kept = over.kept ?? false;
    const label = over.label ?? 'the fork';
    const [row] = await rowsOf<{ id: string }>(db, sql`INSERT INTO net.merges (source, label) VALUES (${kept ? `kept:hornhoof_before_t${made}` : `machine:${made}`}, ${label}) RETURNING id`);
    const source = await side.source(label);
    try {
      return { id: row!.id, result: await runMerge(db, { id: row!.id, label, kept, companyId: acme!.id }, source, { log: () => undefined }) };
    } finally {
      await source.close();
    }
  };
  const conflicts = (id?: string) => rowsOf<Conflict>(db, id ? sql`SELECT * FROM net.merge_conflicts WHERE merge = ${id} ORDER BY tbl, created_at, id` : sql`SELECT * FROM net.merge_conflicts ORDER BY tbl, created_at, id`);
  const titleOf = async (id: string) => (await db.select(only(tasks, 'title')).from(tasks).where(eq(tasks.id, id)))[0]?.title ?? null;
  return { app, db, ceo, control, acme: acme!, on, owner: owner!, orchestrator: orchestrator!, plan: plan!, staff, dev: dev!, hana: hana!, ana: ana!, turn: turn!, one, two, task, fork, merge, conflicts, titleOf };
}
