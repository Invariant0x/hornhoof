import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { companies, people, secretRedactions, tasks } from '../src/db/schema.js';
import { runMerge } from '../src/modules/merge/apply.js';
import { ownDatabases } from './helpers-db.js';
import { pgliteSource, twoSides, type Side } from './merge-fixture.js';

ownDatabases();

async function withoutMarker(side: Side, marker: string) {
  expect((await side.db.select().from(tasks)).every(t => !t.body.includes(marker))).toBe(true);
  const tables = await side.client.query<{ name: string }>("select format('%I.%I', schemaname, tablename) as name from pg_tables where schemaname in ('public', 'net') order by 1");
  for (const { name } of tables.rows) {
    const rows = await side.db.execute(sql.raw(`select to_jsonb(t) as row from ${name} t`));
    expect(JSON.stringify(rows), name).not.toContain(marker);
  }
}

/* Each direction is an independent merge with a full scan for the secret, rather than two merges in one test. */
it.each(['leader', 'offline'] as const)('keeps a secret suppressed when the %s receives a merge', async receiver => {
  const { leader, fork } = await twoSides();
  const [company] = await leader.db.insert(companies).values({ name: 'Acme' }).returning();
  const companyId = company!.id;
  const [person] = await leader.db.insert(people).values({ companyId, name: 'Ivan', email: 'ivan@acme.test', status: 'active', scopeKind: 'company', isOwner: true }).returning();
  const marker = 'oldForkMarker1077!';
  const [original] = await leader.db.insert(tasks).values({ companyId, number: 1, title: 'Original', body: marker }).returning();
  const offline = await fork();
  await leader.db.insert(secretRedactions).values({ companyId, personId: person!.id, fingerprint: createHash('sha256').update(marker).digest('hex'), characters: marker.length });
  await offline.db.update(tasks).set({ body: `offline ${marker}` }).where(eq(tasks.id, original!.id));
  await offline.db.insert(tasks).values({ companyId, number: 2, title: 'Offline copy', body: marker });
  const [target, incoming] = receiver === 'leader' ? [leader, offline] : [offline, leader];
  const merge = await target.client.query<{ id: string }>("insert into net.merges (source, label) values ('machine:other', 'other') returning id");
  const source = await pgliteSource(incoming.client, 'other');
  try {
    await runMerge(target.db, { id: merge.rows[0]!.id, label: 'other', kept: false, companyId }, source, { log: () => {}, clock: () => 0 });
  } finally {
    await source.close();
  }
  await withoutMarker(target, marker);
});

it.each(['leader', 'offline'] as const)('keeps another company unchanged when the %s receives a suppression', async receiver => {
  const { leader, fork } = await twoSides();
  const [company, other] = await leader.db.insert(companies).values([{ name: 'Acme' }, { name: 'Other', singleton: false }]).returning();
  const [person] = await leader.db.insert(people).values({ companyId: company!.id, name: 'Ivan', email: 'ivan@acme.test', status: 'active', scopeKind: 'company', isOwner: true }).returning();
  const marker = 'forkCompanyBoundary1077!';
  const [mine, theirs] = await leader.db.insert(tasks).values([
    { companyId: company!.id, number: 1, title: 'Mine', body: marker },
    { companyId: other!.id, number: 1, title: 'Theirs', body: marker },
  ]).returning();
  const offline = await fork();
  await leader.db.insert(secretRedactions).values({ companyId: company!.id, personId: person!.id, fingerprint: createHash('sha256').update(marker).digest('hex'), characters: marker.length });
  await offline.db.update(tasks).set({ body: `${marker} copy` }).where(eq(tasks.id, mine!.id));
  const [target, incoming] = receiver === 'leader' ? [leader, offline] : [offline, leader];
  const merge = await target.client.query<{ id: string }>("insert into net.merges (source, label) values ('machine:other', 'other') returning id");
  const source = await pgliteSource(incoming.client, 'other');
  try {
    await runMerge(target.db, { id: merge.rows[0]!.id, label: 'other', kept: false, companyId: company!.id }, source, { log: () => {}, clock: () => 0 });
  } finally {
    await source.close();
  }
  expect((await target.db.select().from(tasks).where(eq(tasks.id, mine!.id)))[0]!.body).not.toContain(marker);
  expect((await target.db.select().from(tasks).where(eq(tasks.id, theirs!.id)))[0]!.body).toBe(marker);
});
