import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { GateBusy, WriteGate, writeGate } from '../src/db/gate.js';
import { companies, departments, teams } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { agentSqlOn } from './helpers.js';
import { openTestDb } from './helpers-db.js';

/* A promise the test settles when it says so. */
function held<T = void>(): { promise: Promise<T>; free: (value: T) => void } {
  let free!: (value: T) => void;
  const promise = new Promise<T>(resolve => (free = resolve));
  return { promise, free };
}
/* A few turns of the event loop: what could run by now has run. */
const settle = async (): Promise<void> => {
  for (let n = 0; n < 5; n += 1) await new Promise(resolve => setImmediate(resolve));
};

describe("the gate of the app's writes", () => {
  it('lets writers in together and the merge alone', async () => {
    const gate = new WriteGate();
    const [first, second] = await Promise.all([gate.enter(), gate.enter()]);
    expect(gate.inside()).toBe(2);
    const order: string[] = [];
    const work = held();
    const merge = gate.exclusive(async () => {
      order.push('merge begins');
      /* The merge's own work is inside already. */
      (await gate.enter())();
      order.push('merge writes');
      await work.promise;
      order.push('merge ends');
    });
    await settle();
    expect(order).toEqual([]);
    first();
    await settle();
    expect(order).toEqual([]);
    second();
    /* Leaving twice counts once. */
    second();
    await settle();
    expect([order, gate.inside()]).toEqual([['merge begins', 'merge writes'], 0]);
    const late = gate.enter().then(leave => {
      order.push('writer in');
      leave();
    });
    await settle();
    expect(order).toEqual(['merge begins', 'merge writes']);
    work.free();
    await Promise.all([merge, late]);
    expect(order).toEqual(['merge begins', 'merge writes', 'merge ends', 'writer in']);
    /* Two merges go one after the other. */
    const turns: string[] = [];
    const slow = held();
    const one = gate.exclusive(async () => {
      turns.push('one begins');
      await slow.promise;
      turns.push('one ends');
    });
    const two = gate.exclusive(async () => void turns.push('two'));
    await settle();
    expect(turns).toEqual(['one begins']);
    slow.free();
    await Promise.all([one, two]);
    expect(turns).toEqual(['one begins', 'one ends', 'two']);
    /* A merge that throws opens the gate all the same. */
    await expect(gate.exclusive(async () => Promise.reject(new Error('broke')))).rejects.toThrow('broke');
    (await gate.enter())();
  });

  it('gives up when writers do not leave', async () => {
    const gate = new WriteGate();
    const stays = await gate.enter();
    let ran = false;
    const merge = gate.exclusive(async () => void (ran = true), 100);
    let waiting = false;
    const waited = gate.enter().then(leave => {
      waiting = true;
      return leave;
    });
    await settle();
    expect(waiting).toBe(false);
    await expect(merge).rejects.toBeInstanceOf(GateBusy);
    await expect(merge).rejects.toThrow("The app's writes did not stop within 30 s.");
    expect(ran).toBe(false);
    /* Who waited at the gate goes in. */
    (await waited)();
    stays();
    expect(gate.inside()).toBe(0);
  });

  it("lets a writer's own nested write through", async () => {
    const gate = new WriteGate();
    const inside = held();
    const nested = held<string>();
    const writer = gate.through(async () => {
      await inside.promise;
      /* The merge waits for this writer by now: a write of its own does not wait for the merge. */
      await gate.through(async () => nested.free('nested ran'));
    });
    await settle();
    const merge = gate.exclusive(async () => 'merged');
    await settle();
    inside.free();
    expect(await nested.promise).toBe('nested ran');
    await writer;
    expect(await merge).toBe('merged');
    /* What a writer started and left behind is no part of it any more. */
    let left!: () => Promise<string>;
    await gate.through(async () => {
      left = () => gate.through(async () => 'later');
    });
    const closed = held();
    const second = gate.exclusive(() => closed.promise);
    await settle();
    let passed = false;
    const later = left().then(said => {
      passed = true;
      return said;
    });
    await settle();
    expect(passed).toBe(false);
    closed.free();
    await second;
    expect(await later).toBe('later');
  });

  it("gates the app's writes", async () => {
    const { client, db } = await openTestDb();
    const [company] = await db.insert(companies).values({ name: 'Acme' }).returning();
    const [sales] = await db.insert(departments).values({ companyId: company!.id, name: 'Sales', roleCode: 'SALES' }).returning();
    const team = (name: string) => ({ companyId: company!.id, departmentId: sales!.id, name });
    const names = async () => (await db.select(only(teams, 'name')).from(teams).orderBy(teams.name)).map(row => row.name);
    const agents = agentSqlOn(client);
    /* The roles are made before the gate closes, which is no write of the app's. */
    await agents.run('SELECT 1', 'read');
    const work = held();
    const merge = writeGate.exclusive(() => work.promise);
    await settle();
    const inTransaction = db.transaction(tx => tx.insert(teams).values(team('In a transaction')));
    const alone = db.insert(teams).values(team('Alone'));
    const run = Promise.resolve(alone);
    const byAgent = agents.run(`UPDATE departments SET name = 'Renamed' WHERE id = '${sales!.id}'`, 'write');
    await settle();
    /* Reads go on meanwhile. */
    expect(await names()).toEqual([]);
    expect(await db.transaction(tx => tx.select(only(departments, 'name')).from(departments), { accessMode: 'read only' })).toEqual([{ name: 'Sales' }]);
    expect((await agents.run('SELECT name FROM departments', 'read'))[0]!.rows).toEqual([{ name: 'Sales' }]);
    expect(writeGate.inside()).toBe(0);
    work.free();
    await Promise.all([merge, inTransaction, run, byAgent]);
    expect(await names()).toEqual(['Alone', 'In a transaction']);
    expect(await db.select(only(departments, 'name')).from(departments).where(eq(departments.id, sales!.id))).toEqual([{ name: 'Renamed' }]);
  });
});
