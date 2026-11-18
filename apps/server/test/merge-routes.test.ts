import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { departments, machineAccess, machines, people, tasks } from '../src/db/schema.js';
import type { ConflictView } from '../src/modules/merge/picks.js';
import { as, invitePerson, ownDatabases } from './helpers.js';
import { mergeApp, rowsOf } from './merge-app-fixture.js';

/* Each test forks its database, which a shared one would not survive. */
ownDatabases();

type Decisions = { merges: { id: string; label: string; after: string | null; open: number; ownerPersonId: string }[]; counts: { total: number; byPerson: Record<string, number>; byAgent: Record<string, number> } };

/* A merge that left a conflict of each kind: about a person, about a machine's access, and about a task. */
async function stand() {
  const s = await mergeApp();
  const [maria] = await s.db.insert(people).values({ ...s.on, name: 'Maria', email: 'maria@acme.test', status: 'active', scopeKind: 'company', passwordHash: 'hash-here' }).returning();
  const [machine] = await s.db.insert(machines).values({ ...s.on, personId: s.owner.id, machineKey: 'm1', hostname: 'marat-mac' }).returning();
  await s.db.insert(machineAccess).values({ ...s.on, machineId: machine!.id });
  const fork = await s.fork();
  await fork.db.update(people).set({ name: 'Maria There', passwordHash: 'hash-there' }).where(eq(people.id, maria!.id));
  await s.db.update(people).set({ name: 'Maria Here', passwordHash: 'hash-here-2' }).where(eq(people.id, maria!.id));
  await fork.db.update(machineAccess).set({ until: new Date(Date.now() + 3_600_000), openedBy: s.owner.id, openedAt: new Date(), grant: { payload: 'p', signature: 's' } }).where(eq(machineAccess.machineId, machine!.id));
  await fork.db.update(tasks).set({ title: 'There' }).where(eq(tasks.id, s.one.id));
  await s.db.update(tasks).set({ title: 'Here' }).where(eq(tasks.id, s.one.id));
  await s.db.execute(sql`INSERT INTO net.restores (attempt, backup, dumped_at, kept) VALUES (gen_random_uuid(), gen_random_uuid(), '2026-11-10T08:00:00Z', 'hornhoof_before_t1')`);
  const { id } = await s.merge(fork, { kept: true, label: 'the database from before the restore of 10 Nov 08:00 UTC' });
  const conflictsOf = (who: object, query = '') => s.app.inject({ url: `/api/merges/${id}/conflicts${query}`, ...who });
  const pick = (payload: object, who: object = as(s.ceo)) => s.app.inject({ method: 'POST', url: '/api/merges/pick', payload, ...who });
  return { ...s, maria: maria!, machine: machine!, id, conflictsOf, pick };
}

describe("the CEO's conflicts of a merge", () => {
  it("shows all conflicts to the orchestrator and the CEO's cards on the owner's screen", async () => {
    const s = await stand();
    const zed = await invitePerson(s.app, s.ceo, { name: 'Zed', email: 'zed@acme.com', access: { whole: true } });
    const inside = { headers: orchestratorHeaders(s.owner.id, s.orchestrator.id) };
    expect(((await s.conflictsOf(inside)).json() as { conflicts: ConflictView[] }).conflicts.map(row => row.table).sort()).toEqual(['machine_access', 'people', 'tasks']);
    /* A person of the whole company, and nobody at all. */
    for (const [who, status] of [[as(zed), 403], [{}, 401]] as const) {
      const [read, write] = [await s.conflictsOf(who), await s.pick({ merge: s.id, take: 'here' }, who)];
      expect([read.statusCode, write.statusCode]).toEqual([status, status]);
    }
    expect((await rowsOf<{ n: number }>(s.db, sql`SELECT count(*)::int AS n FROM net.merge_conflicts WHERE picked IS NOT NULL`))[0]!.n).toBe(0);
    const listed = (await s.conflictsOf(as(s.ceo))).json() as { conflicts: ConflictView[] };
    /* His own, and not the orchestrator's: those are in the orchestrator's task. */
    expect(listed.conflicts.map(conflict => [conflict.table, conflict.whose]).sort()).toEqual([['machine_access', 'ceo'], ['people', 'ceo']]);
    const person = listed.conflicts.find(conflict => conflict.table === 'people')!;
    expect(person).toMatchObject({ what: 'Maria Here (maria@acme.test)', kind: 'differs', here: { name: '"Maria Here"', password_hash: '(hidden)' }, there: { name: '"Maria There"', password_hash: '(hidden)' } });
    expect(JSON.stringify(listed)).not.toContain('hash-');
    const took = await s.pick({ ids: [person.id], take: 'there' });
    expect([took.statusCode, took.json()]).toEqual([200, { settled: 1, here: 0, there: 1, refused: [], tasks: [] }]);
    expect((await s.db.select().from(people).where(eq(people.id, s.maria.id)))[0]).toMatchObject({ name: 'Maria There', passwordHash: 'hash-there' });
    expect(await rowsOf(s.db, sql`SELECT picked, picked_by FROM net.merge_conflicts WHERE id = ${person.id}`)).toEqual([{ picked: 'there', picked_by: `person:${s.owner.id}` }]);
    expect(((await s.conflictsOf(as(s.ceo), '?settled=1')).json() as { conflicts: ConflictView[] }).conflicts.map(conflict => conflict.id)).toEqual([person.id]);
    /* Computer access is its owner's to open, on the machine's card: no pick opens it, the CEO's neither. */
    const access = listed.conflicts.find(conflict => conflict.table === 'machine_access')!;
    const refused = await s.pick({ ids: [access.id], take: 'there' });
    expect(refused.json()).toMatchObject({ settled: 0, refused: [{ id: access.id, why: "Only the machine's owner opens computer access, on its card." }] });
    expect((await s.db.select().from(machineAccess))[0]).toMatchObject({ until: null, grant: null });
    expect((await s.pick({ merge: s.id, table: 'machine_access', take: 'here' })).json()).toMatchObject({ settled: 1, here: 1 });
    /* Nothing is settled without saying which, and no other word is taken. */
    expect((await s.pick({ take: 'here' })).statusCode).toBe(400);
    expect((await s.pick({ merge: s.id, take: 'both' })).statusCode).toBe(400);
  });

  it("gives a merge's conflicts to the CEO", async () => {
    const s = await stand();
    const decisions = async (who: object) => (await s.app.inject({ url: '/api/requests', ...who })).json() as Decisions;
    const mine = await decisions(as(s.ceo));
    /* One card for the merge, however many conflicts it holds, with the time of the backup the restore went back to. */
    expect(mine.merges).toEqual([{ id: s.id, label: 'the database from before the restore of 10 Nov 08:00 UTC', after: '2026-11-10T08:00:00.000Z', open: 2, ownerPersonId: s.owner.id }]);
    /* Listed for one person, it shows only for its owner. */
    expect((await decisions({ ...as(s.ceo), query: { person: s.maria.id } } as object)).merges).toEqual([]);
    expect([mine.counts.total, mine.counts.byPerson[s.owner.id], mine.counts.byAgent[s.orchestrator.id]]).toEqual([1, 1, 1]);
    /* The orchestrator acting for the CEO is shown it too, and nobody else: not a person of the whole company, not a
       department's own. */
    expect((await decisions({ headers: orchestratorHeaders(s.owner.id, s.orchestrator.id) })).merges).toEqual(mine.merges);
    const [sales] = await s.db.insert(departments).values({ ...s.on, name: 'Sales', roleCode: 'SALES' }).returning();
    const zed = await invitePerson(s.app, s.ceo, { name: 'Zed', email: 'zed@acme.com', access: { whole: true } });
    const dan = await invitePerson(s.app, s.ceo, { name: 'Dan', email: 'dan@acme.com', access: { departments: [sales!.id] } });
    for (const who of [as(zed), as(dan)]) {
      const theirs = await decisions(who);
      expect([theirs.merges, theirs.counts.total]).toEqual([[], 0]);
    }
    /* Settled, it is gone. */
    await s.pick({ merge: s.id, table: 'people', take: 'here' });
    expect((await decisions(as(s.ceo))).merges).toMatchObject([{ open: 1 }]);
    await s.pick({ merge: s.id, table: 'machine_access', take: 'here' });
    const after = await decisions(as(s.ceo));
    expect([after.merges, after.counts.total]).toEqual([[], 0]);
  });
});
