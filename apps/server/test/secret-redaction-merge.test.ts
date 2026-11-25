import { eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { agents, attachments, companies, people, secretRedactions, tasks } from '../src/db/schema.js';
import type { Db } from '../src/db/client.js';
import { runMerge } from '../src/modules/merge/apply.js';
import { fingerprintOf, hideSecretIn } from '../src/modules/tasks/hide-secret.js';
import { ownDatabases } from './helpers-db.js';
import { pgliteSource, twoSides, type Side } from './merge-fixture.js';
import { looseFiles, sha256Of, stored } from './files-fixture.js';

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
  /* Hidden on the leader as the action does it; the copy goes on writing the value meanwhile. */
  await leader.db.transaction(tx => hideSecretIn(tx as unknown as Db, companyId, person!.id, marker));
  await withoutMarker(leader, marker);
  await offline.db.update(tasks).set({ body: `offline ${marker}` }).where(eq(tasks.id, original!.id));
  const [only] = await offline.db.insert(tasks).values({ companyId, number: 2, title: 'Offline copy', body: marker }).returning();
  const [target, incoming] = receiver === 'leader' ? [leader, offline] : [offline, leader];
  const merge = await target.client.query<{ id: string }>("insert into net.merges (source, label) values ('machine:other', 'other') returning id");
  const source = await pgliteSource(incoming.client, 'other');
  try {
    await runMerge(target.db, { id: merge.rows[0]!.id, label: 'other', kept: false, companyId }, source, { log: () => {}, clock: () => 0 });
  } finally {
    await source.close();
  }
  await withoutMarker(target, marker);
  /* The row only the copy had is hidden the moment either side holds both the row and the fingerprint. */
  expect((await target.db.select().from(tasks).where(eq(tasks.id, only!.id)))[0]!.body).toBe('[hidden]');
  expect(await target.db.select().from(secretRedactions)).toHaveLength(1);
});

it.each(['leader', 'offline'] as const)('keeps another company unchanged when the %s receives a suppression', async receiver => {
  const { leader, fork } = await twoSides();
  const [company] = await leader.db.insert(companies).values({ name: 'Acme' }).returning();
  const [person] = await leader.db.insert(people).values({ companyId: company!.id, name: 'Ivan', email: 'ivan@acme.test', status: 'active', scopeKind: 'company', isOwner: true }).returning();
  const marker = 'forkCompanyBoundary1077!';
  const [mine] = await leader.db.insert(tasks).values({ companyId: company!.id, number: 1, title: 'Mine', body: marker }).returning();
  const offline = await fork();
  const [target, incoming] = receiver === 'leader' ? [leader, offline] : [offline, leader];
  /* Another company where the suppression arrives, as only a test makes one: a merge's source holds the company it
     merges alone (#1967). */
  const [other] = await target.db.insert(companies).values({ name: 'Other', singleton: false }).returning();
  const [theirs] = await target.db.insert(tasks).values({ companyId: other!.id, number: 1, title: 'Theirs', body: marker }).returning();
  const { fingerprint, characters, window_hash: windowHash } = fingerprintOf(marker);
  await leader.db.insert(secretRedactions).values({ companyId: company!.id, personId: person!.id, fingerprint, characters, windowHash });
  await offline.db.update(tasks).set({ body: `${marker} copy` }).where(eq(tasks.id, mine!.id));
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

it('masks the text files the receiving side keeps when a value hidden on the other arrives', async () => {
  const { leader, fork } = await twoSides();
  const [company] = await leader.db.insert(companies).values({ name: 'Acme' }).returning();
  const companyId = company!.id;
  const [person] = await leader.db.insert(people).values({ companyId, name: 'Ivan', email: 'ivan@acme.test', status: 'active', scopeKind: 'company', isOwner: true }).returning();
  const [agent] = await leader.db.insert(agents).values({ companyId, kind: 'worker', name: 'Developer', model: '' }).returning();
  const [task] = await leader.db.insert(tasks).values({ companyId, number: 1, title: 'Notes', body: 'plain' }).returning();
  const marker = 'storedForkMarker2102!';
  const offline = await fork();
  /* The leader keeps a text file with the value while the copy is away, and the copy hides the value. */
  const text = `notes ${marker}`;
  await leader.db.insert(attachments).values({ companyId, taskId: task!.id, agentId: agent!.id, name: 'notes.txt', mediaType: 'text/plain', sha256: await stored(leader.db, text), size: Buffer.byteLength(text) });
  await offline.db.transaction(tx => hideSecretIn(tx as unknown as Db, companyId, person!.id, marker));
  const merge = await leader.client.query<{ id: string }>("insert into net.merges (source, label) values ('machine:other', 'other') returning id");
  const source = await pgliteSource(offline.client, 'other');
  try {
    await runMerge(leader.db, { id: merge.rows[0]!.id, label: 'other', kept: false, companyId }, source, { log: () => {}, clock: () => 0, files: looseFiles() });
  } finally {
    await source.close();
  }
  const [file] = await leader.db.select().from(attachments);
  expect([file!.sha256, file!.size]).toEqual([sha256Of('notes [hidden]'), 14]);
  expect((await looseFiles().bytes(leader.db, file!.sha256!)).toString()).toBe('notes [hidden]');
});
