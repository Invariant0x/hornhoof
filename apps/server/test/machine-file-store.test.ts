import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { agents, departments, machines, people } from '../src/db/schema.js';
import { DEFAULT_AREA_BYTES } from '../src/modules/files/area.js';
import { as, invitePerson } from './helpers.js';
import { backupCompany, GIB, MACHINE_ID } from './helpers-backups.js';

/* The area of each machine's disk that the company's files may take, as the Machines screen shows it and its owner sets
   it. Synthetic machines only. */

type Store = { id: string; limitBytes: number | null; areaBytes: number; usedBytes: number; diskFree: number | null } | null;
type Listed = { machines: { id: string; fileStore: Store }[]; builtin: { fileStore?: Store } | null };

async function stand() {
  const c = await backupCompany();
  const [own] = await c.db.select().from(machines).where(eq(machines.networkId, MACHINE_ID));
  const eli = await invitePerson(c.app, c.ceo, { name: 'Eli', email: 'eli@acme.com', access: { whole: true } });
  const [eliRow] = await c.db.select({ id: people.id }).from(people).where(eq(people.name, 'Eli'));
  const list = async (who = c.ceo) => (await c.app.inject({ url: '/api/machines', ...as(who) })).json() as Listed;
  const set = (id: string, payload: object, who: object = as(c.ceo)) => c.app.inject({ method: 'PATCH', url: `/api/machines/${id}`, payload, ...who });
  const limitOf = async (id: string) => (await c.db.select().from(machines).where(eq(machines.id, id)))[0]!.fileStoreLimitBytes;
  return { ...c, own: own!, eli, eliId: eliRow!.id, list, set, limitOf };
}

describe("the area each machine gives the company's files", () => {
  it('shows what each machine with a keeper gives the files, what they take and what its disk has free, and none for one without', async () => {
    const s = await stand();
    const two = await s.worker('two', { fileStoreLimitBytes: 5 * GIB, fileStoreUsedBytes: GIB, filesDiskFree: 40 * GIB });
    const plain = await s.worker('plain', { networkId: null, role: null });
    const listed = await s.list();
    const card = (id: string) => listed.machines.find(m => m.id === id)!;
    expect(card(two).fileStore).toEqual({ id: two, limitBytes: 5 * GIB, areaBytes: 5 * GIB, usedBytes: GIB, diskFree: 40 * GIB });
    expect(card(plain).fileStore).toBeNull();
    /* The server's own row, which no card shows, is the built-in card's: its keeper's disk where it said no other. */
    expect(listed.builtin!.fileStore).toMatchObject({ id: s.own.id, limitBytes: null, areaBytes: DEFAULT_AREA_BYTES });
  });

  it("takes a machine's area from its owner: a number of bytes, none, or the default again", async () => {
    const s = await stand();
    const two = await s.worker('two');
    expect((await s.set(two, { fileStoreLimitBytes: 5 * GIB })).statusCode).toBe(200);
    expect(await s.limitOf(two)).toBe(5 * GIB);
    expect((await s.set(two, { fileStoreLimitBytes: 0 })).statusCode).toBe(200);
    expect(await s.limitOf(two)).toBe(0);
    expect((await s.set(two, { fileStoreLimitBytes: null })).statusCode).toBe(200);
    expect(await s.limitOf(two)).toBeNull();
    /* With the ticks in one word. */
    expect((await s.set(two, { fileStoreLimitBytes: GIB, lendsTests: false })).json()).toMatchObject({ lendsTests: false, fileStoreLimitBytes: GIB });
    for (const wrong of [-1, 1.5, 2 ** 53, '5'])
      expect((await s.set(two, { fileStoreLimitBytes: wrong })).statusCode, String(wrong)).toBe(400);
    expect(await s.limitOf(two)).toBe(GIB);
  });

  it('gives no area to a machine without a keeper, which keeps no files', async () => {
    const s = await stand();
    const plain = await s.worker('plain', { networkId: null, role: null });
    expect((await s.set(plain, { fileStoreLimitBytes: GIB })).statusCode).toBe(400);
    expect(await s.limitOf(plain)).toBeNull();
  });

  it("lets only the CEO give another person's machine more, while its owner sets their own and anyone who sees the company gives less", async () => {
    const s = await stand();
    const ceos = await s.worker('ceos', { fileStoreLimitBytes: 5 * GIB });
    const elis = await s.worker('elis', { personId: s.eliId, fileStoreLimitBytes: 5 * GIB });
    /* Eli sees the whole company: less on the CEO's machine, never more, and the default is more than 5 GiB. */
    expect((await s.set(ceos, { fileStoreLimitBytes: 2 * GIB }, as(s.eli))).statusCode).toBe(200);
    for (const more of [3 * GIB, null]) {
      const refused = await s.set(ceos, { fileStoreLimitBytes: more }, as(s.eli));
      expect([refused.statusCode, (refused.json() as { error: { reason: string } }).error.reason], String(more)).toEqual([403, 'not_owner_session']);
    }
    expect(await s.limitOf(ceos)).toBe(2 * GIB);
    /* Their own machine, more as well; and the CEO, on anyone's. */
    expect((await s.set(elis, { fileStoreLimitBytes: 50 * GIB }, as(s.eli))).statusCode).toBe(200);
    expect((await s.set(elis, { fileStoreLimitBytes: 80 * GIB })).statusCode).toBe(200);
    expect(await s.limitOf(elis)).toBe(80 * GIB);
  });

  it("lets the CEO, or the orchestrator for him, set the server's own area, and no head acting for anyone set any", async () => {
    const s = await stand();
    expect((await s.set(s.own.id, { fileStoreLimitBytes: 20 * GIB })).statusCode).toBe(200);
    expect(await s.limitOf(s.own.id)).toBe(20 * GIB);
    const [orchestrator] = await s.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    expect((await s.set(s.own.id, { fileStoreLimitBytes: 30 * GIB }, { headers: orchestratorHeaders(s.owner.id, orchestrator!.id) })).statusCode).toBe(200);
    expect(await s.limitOf(s.own.id)).toBe(30 * GIB);
    /* Only the area: the server's own row has no ticks of a card, and nobody else changes it. */
    expect((await s.set(s.own.id, { lendsTests: true })).statusCode).toBe(404);
    expect((await s.set(s.own.id, { fileStoreLimitBytes: GIB, lendsTests: true })).statusCode).toBe(404);
    expect((await s.set(s.own.id, { fileStoreLimitBytes: GIB }, as(s.eli))).statusCode).toBe(403);
    /* A head carries out a person's decision, and this one is not theirs to make, on any machine. */
    const [sales] = await s.db.insert(departments).values({ companyId: s.acme.id, name: 'Sales', roleCode: 'SAL' }).returning();
    const [head] = await s.db.insert(agents).values({ companyId: s.acme.id, departmentId: sales!.id, kind: 'head', name: 'Sales head', model: 'claude-opus-5-5' }).returning();
    const two = await s.worker('two');
    for (const id of [s.own.id, two]) expect((await s.set(id, { fileStoreLimitBytes: GIB }, { headers: orchestratorHeaders(s.owner.id, head!.id) })).statusCode).toBe(403);
    expect([await s.limitOf(s.own.id), await s.limitOf(two)]).toEqual([30 * GIB, null]);
  });
});
