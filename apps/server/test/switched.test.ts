import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client.js';
import { agents, companies, jobs, machines, people } from '../src/db/schema.js';
import { thisMachine } from '../src/modules/network/store.js';
import { noteSwitch } from '../src/modules/network/switched.js';
import { as, setUpCompany, testApp } from './helpers.js';

const HOUR = 3_600_000;
const rowsOf = async <T>(db: Db, query: ReturnType<typeof sql>): Promise<T[]> => ((await db.execute(query)) as unknown as { rows: T[] }).rows;

/* A company on the machine that leads now, with the machine that led before. */
async function stand() {
  const { app, db, config } = await testApp({ HORNHOOF_MACHINE_ID: 'b1c2d3e4'.repeat(4) });
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const here = await thisMachine(db, config, acme!.id);
  await db.update(machines).set({ hostname: 'mac' }).where(eq(machines.id, here.id));
  const [old] = await db.insert(machines).values({ companyId: acme!.id, personId: owner!.id, machineKey: 'old-leader', hostname: 'deb', kind: 'computer', role: 'data', networkId: 'a'.repeat(64) }).returning();
  const handed = async (kind: 'planned' | 'takeover' | 'ceo', ago: number, over: { reason?: string; to?: string; from?: string } = {}) => {
    const at = new Date(Date.now() - ago);
    const [row] = await rowsOf<{ id: string }>(db, sql`INSERT INTO net.handovers (id, from_machine_id, term_number, term_machine, applied, to_machine_id, at, kind, heard_at, reach, reason)
      VALUES (gen_random_uuid(), ${over.from ?? old!.id}, 7, 'a', '0/1', ${over.to ?? here.id}, ${at.toISOString()}::timestamptz, ${kind},
        ${kind === 'planned' ? null : new Date(at.getTime() - 120_000).toISOString()}::timestamptz, ${kind === 'planned' ? null : new Date(at.getTime() - 150_000).toISOString()}::timestamptz, ${over.reason ?? null})
      RETURNING id::text AS id`);
    return { id: row!.id, at };
  };
  const switched = async (who: object = as(ceo)) => app.inject({ url: '/api/network/switched', ...who });
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  vi.spyOn(app.ctx.hub, 'isReady').mockReturnValue(false);
  const turns = async () => (await db.select().from(jobs).where(eq(jobs.agentId, orchestrator!.id))).filter(job => job.prompt.includes('Hornhoof runs on'));
  const noted = async (id: string) => (await rowsOf<{ noted: string | null }>(db, sql`SELECT noted_at AS noted FROM net.handovers WHERE id = ${id}::uuid`))[0]!.noted;
  return { app, db, here, old: old!, handed, switched, turns, noted, who: async () => as(ceo) };
}

describe('where the company runs after the server moved', () => {
  it('says where the company runs now', async () => {
    const s = await stand();
    expect((await s.switched()).json()).toEqual({ switched: null });
    expect((await s.switched({})).statusCode).toBe(401);
    await s.handed('takeover', 25 * HOUR);
    expect((await s.switched()).json()).toEqual({ switched: null });
    const { id, at } = await s.handed('takeover', HOUR, { reason: 'disk_full' });
    expect((await s.switched()).json()).toEqual({
      switched: { id, kind: 'takeover', reason: 'disk_full', from: 'deb', to: 'mac', heard: new Date(at.getTime() - 120_000).toISOString(), reach: new Date(at.getTime() - 150_000).toISOString(), at: at.toISOString() },
    });
    /* Only the newest move is said. */
    const planned = await s.handed('planned', 60_000, { from: s.here.id, to: s.old.id });
    expect((await s.switched()).json().switched).toMatchObject({ id: planned.id, kind: 'planned', reason: null, from: 'mac', to: 'deb', heard: null, reach: null });
  });

  it('says that nothing moves where no keeper answers for the app', async () => {
    const s = await stand();
    const asked = await s.app.inject({ url: '/api/network/switch', ...(await s.who()) });
    expect([asked.statusCode, asked.json()]).toEqual([200, { self: null, moving: false, from: null, to: null, since: null, cut: false, question: false }]);
    expect((await s.app.inject({ url: '/api/network/switch' })).statusCode).toBe(401);
  });

  it('tells the orchestrator once', async () => {
    const s = await stand();
    /* A planned switch says nothing to anyone. */
    const planned = await s.handed('planned', 2 * HOUR);
    await noteSwitch(s.app.ctx);
    expect([await s.turns(), await s.noted(planned.id)]).toEqual([[], null]);
    const { id, at } = await s.handed('takeover', HOUR);
    await noteSwitch(s.app.ctx);
    const [turn, ...more] = await s.turns();
    expect(more).toEqual([]);
    expect(turn).toMatchObject({ answersCeo: true });
    const heard = `${new Date(at.getTime() - 120_000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    expect(turn!.prompt).toContain(`Hornhoof runs on mac now: deb stopped answering at ${heard}, and mac had every change it confirmed.`);
    expect(turn!.prompt).toContain('their results arrive once deb is back and merged.');
    expect(await s.noted(id)).not.toBeNull();
    /* A second start says nothing again. */
    await noteSwitch(s.app.ctx);
    expect(await s.turns()).toHaveLength(1);
  });

  it("tells of the CEO's choice in its own words, and nothing of a move to another machine or an old one", async () => {
    const s = await stand();
    const away = await s.handed('takeover', HOUR, { from: s.here.id, to: s.old.id });
    await noteSwitch(s.app.ctx);
    expect([await s.turns(), await s.noted(away.id)]).toEqual([[], null]);
    const old = await stand();
    const long = await old.handed('ceo', 25 * HOUR);
    await noteSwitch(old.app.ctx);
    expect([await old.turns(), await old.noted(long.id)]).toEqual([[], null]);
    const { at } = await old.handed('ceo', HOUR);
    await noteSwitch(old.app.ctx);
    const reach = `${new Date(at.getTime() - 150_000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    expect((await old.turns())[0]!.prompt).toContain(`Hornhoof runs on mac now, from what it had at ${reach}, as the CEO chose after deb stopped answering at`);
  });
});
