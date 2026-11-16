import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { companies, people, secretRedactions, tasks } from '../src/db/schema.js';
import { runMerge } from '../src/modules/merge/apply.js';
import { ownDatabases } from './helpers-db.js';
import { pgliteSource, twoSides } from './merge-fixture.js';

ownDatabases();

it('keeps a secret suppressed when an offline copy contributes an old value and a new copy', async () => {
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
  const merge = await leader.client.query<{ id: string }>("insert into net.merges (source, label) values ('machine:offline', 'offline') returning id");
  const source = await offline.source();
  try {
    await runMerge(leader.db, { id: merge.rows[0]!.id, label: 'offline', kept: false, companyId }, source, { log: () => {}, clock: () => 0 });
  } finally {
    await source.close();
  }
  expect((await leader.db.select().from(tasks)).every(t => !t.body.includes(marker))).toBe(true);
  const tables = await leader.client.query<{ name: string }>("select format('%I.%I', schemaname, tablename) as name from pg_tables where schemaname in ('public', 'net') order by 1");
  for (const { name } of tables.rows) {
    const rows = await leader.db.execute(sql.raw(`select to_jsonb(t) as row from ${name} t`));
    expect(JSON.stringify(rows), name).not.toContain(marker);
  }
  /* The disconnected database receives the suppression through the same ordinary merge route. */
  const receiving = await offline.client.query<{ id: string }>("insert into net.merges (source, label) values ('machine:leader', 'leader') returning id");
  const incoming = await pgliteSource(leader.client, 'leader');
  try {
    await runMerge(offline.db, { id: receiving.rows[0]!.id, label: 'leader', kept: false, companyId }, incoming, { log: () => {}, clock: () => 0 });
  } finally {
    await incoming.close();
  }
  for (const { name } of tables.rows) {
    const rows = await offline.db.execute(sql.raw(`select to_jsonb(t) as row from ${name} t`));
    expect(JSON.stringify(rows), name).not.toContain(marker);
  }
});
