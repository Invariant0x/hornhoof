import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/client.js';
import { agentEvents, agents, attachments, companies, departments, jobs, people, subscriptions, taskEvents, tasks } from '../src/db/schema.js';
import { runMerge } from '../src/modules/merge/apply.js';
import { factsOf, type Query } from '../src/modules/merge/facts.js';
import {
  backupsOf, consumedIds, horizonOf, journalIds, journalRows, keyText, lastChange, listedSources, netTables, nonEmptyTables, openConflicts, restoresOf, rowsByKeys, rowsOf,
} from '../src/modules/merge/read.js';
import { KEPT_NAME, keptSource, sourceUrl } from '../src/modules/merge/source.js';
import { ownDatabases, TEST_SECRET } from './helpers.js';
import { asPlan7, twoSides, type Side } from './merge-fixture.js';
import { sha256Of, stored } from './files-fixture.js';

/* Each test forks its database, which a shared one would not survive. */
ownDatabases();

const queryOf = (side: Side): Query => async <T>(text: string, params?: unknown[]) => (await side.client.query<T>(text, params)).rows;

/* A company on the leader, by plain inserts: its owner, a department and two tasks. */
async function company(db: Db) {
  const [acme] = await db.insert(companies).values({ name: 'Acme' }).returning();
  const [owner] = await db.insert(people).values({ companyId: acme!.id, name: 'Ivan', email: 'ivan@acme.test', status: 'active', scopeKind: 'company', isOwner: true }).returning();
  const [sales] = await db.insert(departments).values({ companyId: acme!.id, name: 'Sales', roleCode: 'SALES' }).returning();
  const task = async (number: number, title: string) => (await db.insert(tasks).values({ companyId: acme!.id, number, title, departmentId: sales!.id, createdByPersonId: owner!.id }).returning())[0]!;
  return { acme: acme!, owner: owner!, sales: sales!, one: await task(1, 'One'), two: await task(2, 'Two') };
}

describe('reading both sides of a merge', () => {
  it('reads only', async () => {
    const sides = await twoSides();
    const c = await company(sides.leader.db);
    const fork = await sides.fork();
    await fork.db.update(tasks).set({ title: 'On the fork' }).where(eq(tasks.id, c.one.id));
    const source = await fork.source();
    expect(source.label).toBe('the fork');
    expect(await source.query<{ title: string }>('SELECT title FROM public.tasks ORDER BY number')).toEqual([{ title: 'On the fork' }, { title: 'Two' }]);
    await expect(source.query(`INSERT INTO public.teams (company_id, department_id, name) VALUES ('${c.acme.id}', '${c.sales.id}', 'x')`)).rejects.toThrow(/read-only transaction/);
    await source.close();
  });

  it('sees where the two parted', async () => {
    const sides = await twoSides();
    const c = await company(sides.leader.db);
    const fork = await sides.fork();
    const before = await journalIds(queryOf(sides.leader), null);
    expect(before.size).toBeGreaterThan(4);
    await sides.leader.db.update(tasks).set({ title: 'Here' }).where(eq(tasks.id, c.one.id));
    await fork.db.update(tasks).set({ title: 'There' }).where(eq(tasks.id, c.one.id));
    const [here, there] = [await journalIds(queryOf(sides.leader), null), await journalIds(queryOf(fork), null)];
    /* What was before the fork is on both; each side's change on its own alone. */
    for (const id of before.keys()) expect([here.has(id), there.has(id)]).toEqual([true, true]);
    const own = (mine: Map<string, Date>, other: Map<string, Date>) => [...mine.keys()].filter(id => !other.has(id));
    const [onlyHere, onlyThere] = [own(here, there), own(there, here)];
    expect([onlyHere.length, onlyThere.length]).toEqual([1, 1]);
    expect(there.get(onlyThere[0]!)).toBeInstanceOf(Date);
    const [change] = await journalRows(queryOf(fork), onlyThere);
    expect(change).toMatchObject({ id: onlyThere[0], tbl: 'tasks', op: 'update', key: { id: c.one.id } });
    /* The title, and what the app writes beside it. */
    expect(change!.cols).toContain('title');
    expect(change!.old).toMatchObject({ title: 'One' });
    expect(change!.at).toBeInstanceOf(Date);
    const [mine] = await journalRows(queryOf(sides.leader), onlyHere);
    expect(mine!.xact).not.toBe(change!.xact);
    /* Oldest first, whatever order they were asked in. */
    const all = await journalRows(queryOf(fork), [...there.keys()].reverse());
    expect(all.map(row => row.at.getTime())).toEqual(all.map(row => row.at.getTime()).sort((a, b) => a - b));
    expect(all.at(-1)!.id).toBe(onlyThere[0]);
    /* From a time on. */
    expect((await journalIds(queryOf(fork), change!.at)).has(onlyThere[0]!)).toBe(true);
    expect((await journalIds(queryOf(fork), new Date(Date.now() + 60_000))).size).toBe(0);
    expect((await lastChange(queryOf(fork)))!.getTime()).toBe(change!.at.getTime());
  });

  it('reads keys, matches and pages', async () => {
    const sides = await twoSides();
    const c = await company(sides.leader.db);
    const [first, second] = await sides.leader.db.insert(taskEvents).values([{ companyId: c.acme.id, taskId: c.one.id, kind: 'created' }, { companyId: c.acme.id, taskId: c.two.id, kind: 'created' }]).returning();
    const q = queryOf(sides.leader);
    const facts = await factsOf(q);
    const byKey = await rowsByKeys(q, facts.tables.get('tasks')!, [{ id: c.one.id }, { id: c.two.id }, { id: randomUUID() }]);
    expect([...byKey.keys()].sort()).toEqual([keyText({ id: c.one.id }), keyText({ id: c.two.id })].sort());
    expect(byKey.get(keyText({ id: c.one.id }))).toMatchObject({ id: c.one.id, number: 1, title: 'One', company_id: c.acme.id });
    /* A time comes as text with its microseconds, as to_jsonb writes it. */
    expect(byKey.get(keyText({ id: c.one.id }))!.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00$/);
    const byUuid = await rowsByKeys(q, facts.tables.get('task_events')!, [{ uuid: first!.uuid }, { uuid: second!.uuid }], 'uuid');
    expect(byUuid.get(keyText({ uuid: second!.uuid }))).toMatchObject({ id: second!.id, task_id: c.two.id });
    const pages: string[][] = [];
    for await (const page of rowsOf(q, facts.tables.get('tasks')!, 1)) pages.push(page.map(row => String(row.id)));
    expect(pages).toEqual([c.one.id, c.two.id].sort().map(id => [id]));
    /* A key of several columns pages by all of them. */
    const online = facts.tables.get('machine_online')!;
    expect(online.key).toEqual(['machine_id', 'day']);
    const whole: unknown[] = [];
    for await (const page of rowsOf(q, online, 2)) whole.push(...page);
    expect(whole).toEqual([]);
    expect(keyText({ b: 1, a: 2 })).toBe(keyText({ a: 2, b: 1 }));
  });

  it('reads the records a merge needs', async () => {
    const sides = await twoSides();
    const c = await company(sides.leader.db);
    const { db } = sides.leader;
    const q = queryOf(sides.leader);
    /* A week back from when the database was migrated, until a prune moves it. */
    expect((await horizonOf(q))!.getTime()).toBeLessThan(Date.now() - 6 * 86_400_000);
    const below = new Date('2026-11-01T00:00:00Z');
    await db.execute(sql`UPDATE net.horizon SET below = ${below.toISOString()}`);
    expect((await horizonOf(q))!.getTime()).toBe(below.getTime());
    const [early, late] = [randomUUID(), randomUUID()];
    await db.execute(sql`INSERT INTO net.restores (attempt, backup, dumped_at, at) VALUES (${late}, ${randomUUID()}, now(), now()), (${early}, ${randomUUID()}, now(), now() - interval '1 day')`);
    expect(await restoresOf(q)).toEqual([early, late]);
    const made = (await db.execute(sql`INSERT INTO net.merges (source, label) VALUES ('kept:hornhoof_before_t1', 'a database') RETURNING id`)) as unknown as { rows: { id: string }[] };
    const merge = made.rows[0]!.id;
    const [taken, other] = [randomUUID(), randomUUID()];
    await db.execute(sql`INSERT INTO net.merge_consumed (journal, merge, at, how) VALUES (${taken}, ${merge}, now(), 'applied')`);
    expect(await consumedIds(q, [taken, other])).toEqual(new Set([taken]));
    await db.execute(sql`INSERT INTO applied (source, base) VALUES ('node:n1:jobs:7:0', 'node:n1:jobs:7')`);
    const call = randomUUID();
    const [plan] = await db.insert(subscriptions).values({ companyId: c.acme.id, provider: 'claude', kind: 'personal', label: 'Plan', ownerPersonId: c.owner.id, status: 'ready' }).returning();
    const [job] = await db.insert(jobs).values({ companyId: c.acme.id, subscriptionId: plan!.id, prompt: 'Say hi', timeoutMs: 60_000 }).returning();
    await db.execute(sql`INSERT INTO tool_calls (id, job_id, answer) VALUES (${call}, ${job!.id}, '{}'::jsonb)`);
    expect(await listedSources(q, ['node:n1:jobs:7:0', 'node:n1:jobs:8:0'], [call, randomUUID()])).toEqual({ sources: new Set(['node:n1:jobs:7:0']), calls: new Set([call]) });
    const conflict = (picked: string | null, key: string) =>
      db.execute(sql`INSERT INTO net.merge_conflicts (merge, tbl, key, op, kind, topic, why, picked) VALUES (${merge}, 'tasks', ${JSON.stringify({ id: key })}::jsonb, 'update', 'differs', 'work', 'Both changed it.', ${picked})`);
    await conflict(null, c.one.id);
    await conflict('here', c.two.id);
    expect(await openConflicts(q)).toMatchObject([{ merge, tbl: 'tasks', key: { id: c.one.id }, picked: null }]);
    const backup = randomUUID();
    await db.execute(sql`INSERT INTO net.backups (id, company_id, dumped_at, made_at, reason, size, sha256, signer, serial, recipients, migrations, head)
      VALUES (${backup}, ${c.acme.id}, now(), now(), 'timer', 10, ${'a'.repeat(64)}, ${randomUUID()}, 'ab', '{}', 107, '{}')`);
    expect(await backupsOf(q)).toMatchObject([{ id: backup, reason: 'timer' }]);
  });

  it('reads a database plan 7 kept', async () => {
    const sides = await twoSides();
    await company(sides.leader.db);
    const fork = await sides.fork();
    await asPlan7(fork.client);
    const asked: string[] = [];
    const plain = queryOf(fork);
    const q: Query = (text, params) => {
      asked.push(text);
      return plain(text, params);
    };
    const tables = await netTables(q);
    expect([tables.has('journal'), tables.has('backups'), tables.has('merges')]).toEqual([true, true, false]);
    expect(await horizonOf(q)).toBeNull();
    expect([await restoresOf(q), await consumedIds(q, [randomUUID()]), await openConflicts(q)]).toEqual([[], new Set(), []]);
    /* One look at what is there, and no query of a table that is not. */
    expect(asked).toHaveLength(1);
    expect(asked.some(text => /net\.(horizon|restores|merge_)/.test(text))).toBe(false);
  });

  it('points at the kept database, not the live one', () => {
    expect(sourceUrl('postgres://u:p@db:5432/hornhoof?options=-c%20x%3Dy&sslmode=disable&application_name=a', 'hornhoof_before_t1')).toBe('postgres://u:p@db:5432/hornhoof_before_t1?sslmode=disable');
    expect(['hornhoof_before_20261110_090000', 'hornhoof_before_t1'].map(name => KEPT_NAME.test(name))).toEqual([true, true]);
    expect(['hornhoof', 'hornhoof_restore', 'hornhoof_before_', 'hornhoof_before_a-b', `hornhoof_before_${'a'.repeat(48)}`, 'hornhoof_before_x"; DROP'].map(name => KEPT_NAME.test(name))).toEqual([false, false, false, false, false, false]);
  });

  it('refuses a database that is not kept', async () => {
    /* Nothing listens there: a refusal that came from a connection would say so. */
    const config = loadConfig({ HORNHOOF_SECRET: TEST_SECRET, DATABASE_URL: 'postgres://u:p@127.0.0.1:9/hornhoof' });
    for (const name of ['hornhoof', 'hornhoof_restore']) await expect(keptSource(config, name, 'a database')).rejects.toThrow('The merge source is not the kept database.');
    await expect(keptSource(loadConfig({ HORNHOOF_SECRET: TEST_SECRET }), 'hornhoof_before_t1', 'a database')).rejects.toThrow('no database address');
  });

  it('finds non-empty tables and re-reads outside the transaction when the leader shifts before locking', async () => {
    const sides = await twoSides();
    const c = await company(sides.leader.db);
    const { db, client } = sides.leader;
    const q = queryOf(sides.leader);
    expect(await nonEmptyTables(q, [])).toEqual(new Set());
    expect(await nonEmptyTables(q, ['tasks', 'teams'])).toEqual(new Set(['tasks']));

    const [plan] = await db.insert(subscriptions).values({ companyId: c.acme.id, provider: 'claude', kind: 'personal', label: 'Plan', ownerPersonId: c.owner.id, status: 'ready' }).returning();
    const [ana] = await db.insert(agents).values({ companyId: c.acme.id, subscriptionId: plan!.id, model: '', kind: 'worker', name: 'Ana', departmentId: c.sales.id }).returning();
    const [picture] = await db.insert(attachments).values({ companyId: c.acme.id, agentId: ana!.id, mediaType: 'image/png', sha256: await stored(db, 'diagram'), size: 7 }).returning();
    const fork = await sides.fork();
    await fork.db.update(tasks).set({ title: 'From fork' }).where(eq(tasks.id, c.one.id));

    const made = (await db.execute(sql`INSERT INTO net.merges (source, label) VALUES ('machine:shift', 'the fork') RETURNING id`)) as unknown as { rows: { id: string }[] };
    const raw = await fork.source();
    let codeReads = 0;
    let readsInTx = 0;
    const source = {
      ...raw,
      query: async <T = Record<string, unknown>>(text: string, params?: unknown[]) => {
        if (client.isInTransaction()) readsInTx += 1;
        const rows = await raw.query<T>(text, params);
        if (text.includes('FROM public.jobs j') && text.includes('JOIN public.tasks t')) {
          codeReads += 1;
          if (codeReads === 1) {
            await db.execute(sql`INSERT INTO net.restores (attempt, backup, dumped_at, at) VALUES (${randomUUID()}, ${randomUUID()}, now(), now())`);
          } else if (codeReads === 2) {
            await db.delete(attachments).where(eq(attachments.id, picture!.id));
          }
        }
        return rows;
      },
    };
    try {
      const result = await runMerge(db, { id: made.rows[0]!.id, label: 'the fork', kept: false, companyId: c.acme.id }, source, { log: () => undefined });
      expect(result.path).toBe('compare');
      expect([codeReads, readsInTx]).toEqual([3, 0]);
      const [restored] = await db.select().from(attachments).where(eq(attachments.id, picture!.id));
      expect(restored!.sha256).toBe(sha256Of('diagram'));
    } finally {
      await raw.close();
    }
  });

  it('streams compare pages of 500 rows for kept and uploaded databases without growing buffered rows with source size', async () => {
    const sides = await twoSides();
    const c = await company(sides.leader.db);
    const { db, client } = sides.leader;
    const [plan] = await db.insert(subscriptions).values({ companyId: c.acme.id, provider: 'claude', kind: 'personal', label: 'Plan', ownerPersonId: c.owner.id, status: 'ready' }).returning();
    const [ana] = await db.insert(agents).values({ companyId: c.acme.id, subscriptionId: plan!.id, model: '', kind: 'worker', name: 'Ana', departmentId: c.sales.id }).returning();

    const PAGE_ROWS = 500;
    const insertEvents = async (count: number) => {
      const batch = Array.from({ length: count }, (_, i) => ({ companyId: c.acme.id, agentId: ana!.id, kind: 'text' as const, data: { n: i } }));
      for (let from = 0; from < batch.length; from += 400) await db.insert(agentEvents).values(batch.slice(from, from + 400));
    };

    const measurePeakBufferedRows = async (sourceName: string, kept: boolean): Promise<{ peak: number; path: string; equal: number }> => {
      const fork = await sides.fork();
      await fork.db.insert(tasks).values({ companyId: c.acme.id, number: kept ? 10 : 11, title: kept ? 'Kept task' : 'Uploaded task', departmentId: c.sales.id });
      if (!kept) await db.execute(sql`INSERT INTO net.restores (attempt, backup, dumped_at, at) VALUES (${randomUUID()}, ${randomUUID()}, now(), now())`);
      const made = (await db.execute(sql`INSERT INTO net.merges (source, label) VALUES (${sourceName}, 'local source') RETURNING id`)) as unknown as { rows: { id: string }[] };

      let bufferedEventRows = 0;
      let peakBufferedEventRows = 0;
      const noteCompared = (text: string, params?: unknown[]) => {
        if (text.includes('FROM public."agent_events" t JOIN jsonb_to_recordset')) {
          const keys = JSON.parse(String(params?.[0] ?? '[]')) as unknown[];
          bufferedEventRows = Math.max(0, bufferedEventRows - keys.length);
        }
      };
      const origQuery = client.query.bind(client);
      const origTx = client.transaction.bind(client);
      client.query = (async (text: string, params?: unknown[]) => {
        const res = await origQuery(text, params);
        noteCompared(text, params);
        return res;
      }) as typeof client.query;
      client.transaction = (async <T>(cb: Parameters<typeof origTx>[0]) =>
        origTx(async tx => {
          const origTxQuery = tx.query.bind(tx);
          tx.query = (async (text: string, params?: unknown[]) => {
            const res = await origTxQuery(text, params);
            noteCompared(text, params);
            return res;
          }) as typeof tx.query;
          return cb(tx) as Promise<T>;
        })) as typeof client.transaction;

      const raw = await fork.source();
      const source = {
        ...raw,
        query: async <T = Record<string, unknown>>(text: string, params?: unknown[]) => {
          const rows = await raw.query<T>(text, params);
          if (text.includes('FROM public."agent_events" t') && text.includes('LIMIT $1')) {
            bufferedEventRows += rows.length;
            peakBufferedEventRows = Math.max(peakBufferedEventRows, bufferedEventRows);
          }
          return rows;
        },
      };
      try {
        const result = await runMerge(db, { id: made.rows[0]!.id, label: 'local source', kept, companyId: c.acme.id }, source, { log: () => undefined });
        return { peak: peakBufferedEventRows, path: result.path, equal: result.counts.equal };
      } finally {
        client.query = origQuery;
        client.transaction = origTx;
        await raw.close();
      }
    };

    await insertEvents(650);
    const small = await measurePeakBufferedRows('kept:hornhoof_before_t_mem1', true);
    expect(small.path).toBe('compare');
    expect(small.equal).toBeGreaterThanOrEqual(650);
    expect(small.peak).toBe(PAGE_ROWS);

    await insertEvents(650);
    const doubled = await measurePeakBufferedRows('upload:hornhoof_upload_99bb2233aabbccdd_20261114t040000', false);
    expect(doubled.path).toBe('compare');
    expect(doubled.equal).toBeGreaterThanOrEqual(1300);
    expect(doubled.peak).toBe(PAGE_ROWS);
  });

  it('resets the forced compare flag between peer retries so journal fallback does not spin without progress', async () => {
    const sides = await twoSides();
    const c = await company(sides.leader.db);
    const { db } = sides.leader;
    const fork = await sides.fork();
    await fork.db.update(tasks).set({ title: 'From peer' }).where(eq(tasks.id, c.one.id));

    const attemptId = randomUUID();
    const made = (await db.execute(sql`INSERT INTO net.merges (source, label) VALUES ('machine:reset-compare', 'peer fork') RETURNING id`)) as unknown as { rows: { id: string }[] };
    const raw = await fork.source();
    let codeReads = 0;
    const source = {
      ...raw,
      query: async <T = Record<string, unknown>>(text: string, params?: unknown[]) => {
        const rows = await raw.query<T>(text, params);
        if (text.includes('FROM public.jobs j') && text.includes('JOIN public.tasks t')) {
          codeReads += 1;
          if (codeReads === 1) {
            await db.execute(sql`INSERT INTO net.restores (attempt, backup, dumped_at, at) VALUES (${attemptId}, ${randomUUID()}, now(), now())`);
          } else if (codeReads === 2) {
            await db.execute(sql`DELETE FROM net.restores WHERE attempt = ${attemptId}::uuid`);
          }
        }
        return rows;
      },
    };
    try {
      const result = await runMerge(db, { id: made.rows[0]!.id, label: 'peer fork', kept: false, companyId: c.acme.id }, source, { log: () => undefined });
      expect(result.path).toBe('journal');
      expect(codeReads).toBe(3);
    } finally {
      await raw.close();
    }
  });
});
