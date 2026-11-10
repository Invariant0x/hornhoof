import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, teams, turns } from '../src/db/schema.js';
import { invitePerson } from './helpers.js';
import { call, company, text, work } from './turns-company.js';

/* The company of the turn tests with Bruno in a sub-unit of Development marked turnkey. */
async function withTurnkeyTeam() {
  const c = await company();
  const [team] = await c.db.insert(teams).values({ companyId: c.companyId, departmentId: c.dev.id, name: 'Lane', turnkey: true }).returning();
  await c.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, c.bruno.id));
  return c;
}

const modes = async (c: Awaited<ReturnType<typeof company>>) => (await c.db.select({ n: turns.number, mode: turns.mode, status: turns.status }).from(turns).orderBy(asc(turns.number))).map(t => [t.n, t.mode, t.status]);

describe('a turn runs in the mode it was started in', () => {
  it('starts a turn in the mode the orchestrator names, and never without one', async () => {
    const c = await company();
    const boss = await c.tools(c.orchestrator);
    expect((await call(boss, 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(c.dev.id, 'Checkout')] })).isError).toBe(true);
    expect((await call(boss, 'plan_turn', { title: 'Payments', goal: 'Card payments.', mode: 'echelons', tasks: [work(c.dev.id, 'Checkout')] })).isError).toBeFalsy();
    expect(await modes(c)).toEqual([[1, 'echelons', 'open']]);
  });

  it('refuses a turnkey turn while the company has no turnkey team, and says why', async () => {
    const c = await company();
    const boss = await c.tools(c.orchestrator);
    const refused = await call(boss, 'plan_turn', { title: 'Payments', goal: 'Card payments.', mode: 'turnkey', tasks: [work(c.dev.id, 'Checkout')] });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/no turnkey team/);
    expect(await modes(c)).toEqual([]);

    const [team] = await c.db.insert(teams).values({ companyId: c.companyId, departmentId: c.dev.id, name: 'Lane', turnkey: true }).returning();
    await c.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, c.bruno.id));
    expect((await call(boss, 'plan_turn', { title: 'Payments', goal: 'Card payments.', mode: 'turnkey', tasks: [work(c.dev.id, 'Checkout')] })).isError).toBeFalsy();
    expect(await modes(c)).toEqual([[1, 'turnkey', 'open']]);
  });

  it('changes the mode only while the turn is planned, by the orchestrator or a person', async () => {
    const c = await withTurnkeyTeam();
    const boss = await c.tools(c.orchestrator);
    await call(boss, 'plan_turn', { title: 'Payments', goal: 'Card payments.', mode: 'echelons', tasks: [work(c.dev.id, 'Checkout')] });
    await call(boss, 'plan_turn', { title: 'Refunds', goal: 'Money goes back.', mode: 'echelons', tasks: [work(c.dev.id, 'Refund button')] });

    expect((await call(boss, 'edit_turn', { turn: 2, mode: 'turnkey' })).isError).toBeFalsy();
    const fixed = await call(boss, 'edit_turn', { turn: 1, mode: 'turnkey' });
    expect(fixed.isError).toBe(true);
    expect(text(fixed)).toMatch(/started/);

    const patch = (number: number, mode: string, token = c.ceoToken) => c.app.inject({ method: 'PATCH', url: `/api/turns/${number}`, payload: { mode }, headers: { cookie: `hh_session=${token}` } });
    const dora = await invitePerson(c.app, c.ceoToken, { name: 'Dora', email: 'dora@acme.com', access: { departments: [c.dev.id] } });
    expect((await patch(2, 'echelons', dora)).statusCode).toBe(403);
    expect((await patch(2, 'echelons')).statusCode).toBe(200);
    const refused = await patch(1, 'turnkey');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toMatch(/started/);
    expect(await modes(c)).toEqual([[1, 'echelons', 'open'], [2, 'echelons', 'planned']]);
    expect((await c.get(c.ceoToken, '/api/turns')).json().turns.map((t: { number: number; mode: string }) => [t.number, t.mode])).toEqual([[1, 'echelons'], [2, 'echelons']]);
  });

  it('never merges turns of different modes, so no turn runs half in each', async () => {
    const c = await withTurnkeyTeam();
    const boss = await c.tools(c.orchestrator);
    await call(boss, 'plan_turn', { title: 'Payments', goal: 'Card payments.', mode: 'echelons', tasks: [work(c.dev.id, 'Checkout')] });
    await call(boss, 'plan_turn', { title: 'Refunds', goal: 'Money goes back.', mode: 'turnkey', tasks: [work(c.dev.id, 'Refund button')] });
    const merged = await call(boss, 'merge_turn', { source: 2, target: 1 });
    expect(merged.isError).toBe(true);
    expect(text(merged)).toMatch(/mode/);
    expect(await modes(c)).toEqual([[1, 'echelons', 'open'], [2, 'turnkey', 'planned']]);
  });
});
