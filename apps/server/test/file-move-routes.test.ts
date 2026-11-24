import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { agents, people } from '../src/db/schema.js';
import { as, invitePerson, ownDatabases, setUpCompany, testApp } from './helpers.js';

ownDatabases();

/* The CEO's yes to the clearing of the bytes the store keeps now: he, or the orchestrator for him, reads the
   reconciliations of the move and says yes to the digest of one. Synthetic numbers only. */

const DIGEST = 'ab'.repeat(32);
const rowsOf = <T>(answer: unknown): T[] => (answer as { rows: T[] }).rows;

describe("the CEO's yes to clearing the moved files", () => {
  it('shows the reconciliations to the CEO and to the orchestrator for him alone, and takes a yes only to the digest of one, once', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const zed = await invitePerson(app, ceo, { name: 'Zed', email: 'zed@acme.com', access: { whole: true } });
    await db.execute(sql`INSERT INTO net.file_moves (digest, files, contents, bytes, not_here, database_bytes) VALUES (${DIGEST}, 3, 2, 100, 1, 5000)`);
    await db.execute(sql`INSERT INTO net.file_move_rows (id, sha256, size, disk, digest) VALUES (gen_random_uuid(), ${'cd'.repeat(32)}, 100, false, ${DIGEST})`);
    const read = (who: object) => app.inject({ url: '/api/files/move', ...who });
    const approve = (digest: string, who: object) => app.inject({ method: 'POST', url: '/api/files/move/approve', payload: { digest }, ...who });
    const inside = { headers: orchestratorHeaders(owner!.id, orchestrator!.id) };

    /* A person of the whole company, and nobody at all. */
    for (const [who, status] of [[as(zed), 403], [{}, 401]] as const) {
      expect([(await read(who)).statusCode, (await approve(DIGEST, who)).statusCode]).toEqual([status, status]);
    }
    const shown = await read(as(ceo));
    expect([shown.statusCode, shown.json()]).toEqual([200, {
      column: false,
      unnamed: 0,
      moves: [{ digest: DIGEST, files: 3, contents: 2, bytes: 100, notHere: 1, databaseBytes: 5000, madeAt: expect.any(String), approvedAt: null, approvedBy: null, clearedAt: null, databaseBytesAfter: null, left: 1 }],
    }]);
    expect((await read(inside)).json()).toEqual(shown.json());

    expect((await approve('nope', inside)).statusCode).toBe(400);
    expect((await approve('ef'.repeat(32), inside)).statusCode).toBe(404);
    expect(rowsOf<{ approved_at: string | null }>(await db.execute(sql`SELECT approved_at FROM net.file_moves`))).toEqual([{ approved_at: null }]);
    const yes = await approve(DIGEST, inside);
    expect([yes.statusCode, yes.json()]).toEqual([200, { approved: DIGEST }]);
    expect(rowsOf(await db.execute(sql`SELECT approved_by FROM net.file_moves`))).toEqual([{ approved_by: `orchestrator:${orchestrator!.id}` }]);
    expect((await approve(DIGEST, as(ceo))).statusCode).toBe(409);
  });
});
