import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, jobs, people, subscriptions, testParts, testRuns } from '../src/db/schema.js';
import { nameBuiltinWork } from '../src/modules/nodes/builtin.js';
import { setUpCompany, testApp } from './helpers.js';

const MACHINE = 'a1b2c3d4'.repeat(4);

describe('work of the built-in node from before each machine had its own', () => {
  it("gives old built-in work the leader's machine", async () => {
    const { app, db } = await testApp({ HORNHOOF_MACHINE_ID: MACHINE });
    await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const [key] = await db.insert(subscriptions).values({ companyId: acme!.id, provider: 'anthropic_api', kind: 'api_key', label: 'Key', status: 'ready', ownerPersonId: owner!.id }).returning();
    const [plan] = await db.insert(subscriptions).values({ companyId: acme!.id, provider: 'claude', kind: 'personal', label: 'Plan', status: 'ready', ownerPersonId: owner!.id }).returning();
    const agent = async (name: string, subscriptionId: string) => (await db.insert(agents).values({ companyId: acme!.id, kind: 'worker', name, model: '', subscriptionId }).returning())[0]!;
    const [ran, never, planned] = [await agent('Ran', key!.id), await agent('Never', key!.id), await agent('Planned', plan!.id)];
    const job = async (over: Partial<typeof jobs.$inferInsert>) => (await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: key!.id, prompt: 'x', timeoutMs: 60_000, ...over }).returning())[0]!;
    /* A turn that runs on the one built-in node there was, one that waits, one that ended, and a plan's. */
    const running = await job({ agentId: ran.id, kind: 'conversation', status: 'running', startedAt: new Date() });
    const queued = await job({ agentId: never.id, kind: 'conversation', status: 'queued' });
    const done = await job({ agentId: ran.id, kind: 'conversation', status: 'done', startedAt: new Date(), finishedAt: new Date() });
    const theirs = await job({ subscriptionId: plan!.id, agentId: planned.id, kind: 'conversation', status: 'queued' });
    /* A test run stands on a task, which these rows do without: the check of that is told to let it pass. */
    await db.execute(sql`SET session_replication_role = replica`);
    const [run] = await db.insert(testRuns).values({ companyId: acme!.id, number: 1, taskId: randomUUID(), agentId: ran.id, jobId: running.id, command: 'npm test', timeoutMs: 60_000 }).returning();
    await db.execute(sql`SET session_replication_role = origin`);
    const part = async (over: Partial<typeof testParts.$inferInsert>) => (await db.insert(testParts).values({ companyId: acme!.id, runId: run!.id, part: 1, ...over }).returning())[0]!;
    const here = await part({ part: 1, status: 'running', builtin: true });
    const over = await part({ part: 2, status: 'passed', builtin: true });

    await nameBuiltinWork(app.ctx);
    const machineOf = async (table: typeof jobs | typeof agents | typeof testParts, id: string) => ((await db.select().from(table).where(eq(table.id, id)))[0] as { builtinMachine: string | null }).builtinMachine;
    /* What is open on that node is this machine's from now on, wherever the server moves; what ended names none. */
    expect([await machineOf(jobs, running.id), await machineOf(jobs, queued.id), await machineOf(jobs, done.id), await machineOf(jobs, theirs.id)]).toEqual([MACHINE, MACHINE, null, null]);
    /* The agent whose program is there; one that never ran, and a plan's, have none. */
    expect([await machineOf(agents, ran.id), await machineOf(agents, never.id), await machineOf(agents, planned.id)]).toEqual([MACHINE, null, null]);
    expect([await machineOf(testParts, here.id), await machineOf(testParts, over.id)]).toEqual([MACHINE, null]);
    /* Once more changes nothing, and what was given a machine since keeps it. */
    const other = 'f'.repeat(32);
    await db.update(jobs).set({ builtinMachine: other }).where(eq(jobs.id, queued.id));
    await nameBuiltinWork(app.ctx);
    expect(await machineOf(jobs, queued.id)).toBe(other);
  });

  it('leaves an install with no machine id as it is', async () => {
    const { app, db } = await testApp({});
    await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const [key] = await db.insert(subscriptions).values({ companyId: acme!.id, provider: 'anthropic_api', kind: 'api_key', label: 'Key', status: 'ready', ownerPersonId: owner!.id }).returning();
    const [running] = await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: key!.id, prompt: 'x', timeoutMs: 60_000, status: 'running', startedAt: new Date() }).returning();
    await nameBuiltinWork(app.ctx);
    expect((await db.select().from(jobs).where(eq(jobs.id, running!.id)))[0]!.builtinMachine).toBeNull();
  });
});
