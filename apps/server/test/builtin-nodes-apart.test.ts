import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { agents, companies, departments, jobs, subscriptions, tasks, testParts, testRuns, type TestEnvironmentRequest } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { routeCheckMessage } from '../src/modules/nodes/check-slots.js';
import { builtinOf, ownMachine } from '../src/modules/nodes/hub.js';
import { interruptionOf, rememberBuiltinStop } from '../src/modules/nodes/restarts.js';
import { cancelDescription } from '../src/modules/testruns/describe.js';
import { noteTestCapabilities, testCapabilities } from '../src/modules/testruns/load.js';
import { setUpCompany, testApp } from './helpers.js';

/* Each machine that holds the company's data runs a built-in node of its own. What the server keeps of one of them is
   never taken for another's. */
const OWN = 'a0'.repeat(16);
const COPY = 'b0'.repeat(16);
const boot = (startedAt: string, container: string) => ({ startedAt, machineUpAt: '2026-11-01T08:00:00.000Z', container });

async function company() {
  const { app, db } = await testApp({ HORNHOOF_MACHINE_ID: OWN });
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  return { app, db, ctx: app.ctx, companyId: acme!.id };
}

describe("the built-in nodes of several machines", () => {
  it("keeps what each said of its tests apart", async () => {
    const { ctx } = await company();
    expect(ownMachine(ctx.config)).toBe(OWN);
    noteTestCapabilities(ctx, builtinOf(OWN), { testHarness: 1 });
    noteTestCapabilities(ctx, builtinOf(COPY), { testEnvironmentVersion: 1 });
    expect([testCapabilities(ctx, builtinOf(OWN)), testCapabilities(ctx, builtinOf(COPY))]).toEqual([{ testHarness: 1 }, { testEnvironmentVersion: 1 }]);
  });

  it("tells each one's restarts by its own last hello", async () => {
    const { ctx } = await company();
    const at = new Date('2026-11-11T12:00:00Z');
    const hello = (startedAt: string, container: string) => ({ version: '0.19.0', boot: boot(startedAt, container) }) as Parameters<typeof interruptionOf>[2];
    const node = (machine: string) => ({ id: null, builtin: machine, name: 'the built-in node', said: null, machine: { id: null, name: null } });
    /* Each one's first hello follows the server's start; neither is compared with the other's. */
    expect(interruptionOf(ctx, node(OWN), hello('2026-11-11T11:00:00.000Z', 'c0ffee000001'), at).cause).toBe('server');
    expect(interruptionOf(ctx, node(COPY), hello('2026-11-11T11:30:00.000Z', 'c0ffee000002'), at).cause).toBe('server');
    /* Its own next hello is compared with its own last one. */
    expect(interruptionOf(ctx, node(OWN), hello('2026-11-11T11:00:00.000Z', 'c0ffee000001'), at).cause).toBe('connection');
    expect(interruptionOf(ctx, node(COPY), hello('2026-11-11T11:45:00.000Z', 'c0ffee000002'), at).cause).toBe('program');
    /* A stop one of them reports is noted for that one alone. */
    rememberBuiltinStop(ctx, COPY, '2026-11-11T11:45:00.000Z', { kind: 'planned', reason: 'stopped', startedAt: '2026-11-11T11:45:00.000Z', at: null, log: '' });
    expect(interruptionOf(ctx, node(OWN), hello('2026-11-11T11:00:00.000Z', 'c0ffee000001'), at).cause).toBe('connection');
  });

  it("lets only the node a part runs on say that it waits", async () => {
    const { ctx, db, companyId } = await company();
    const [sub] = await db.select().from(subscriptions);
    const [agent] = await db.select().from(agents);
    const [dept] = await db.insert(departments).values({ companyId, name: 'Dev', roleCode: 'DEV' }).returning();
    const [task] = await db.insert(tasks).values({ companyId, number: 901, title: 'Run the tests', departmentId: dept!.id }).returning();
    const [job] = await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: agent!.id, taskId: task!.id, kind: 'conversation', prompt: 'x', timeoutMs: 1000, status: 'running', startedAt: new Date() }).returning();
    const [run] = await db.insert(testRuns).values({ companyId, number: 1, kind: 'tests', departmentId: dept!.id, taskId: task!.id, agentId: agent!.id, jobId: job!.id, branch: 'main', command: 'echo ok', parts: 2, timeoutMs: 60_000, status: 'running' }).returning();
    const part = async (n: number, builtinMachine: string | null) =>
      (await db.insert(testParts).values({ companyId, runId: run!.id, part: n, status: 'running', builtin: true, builtinMachine, startedAt: new Date() }).returning())[0]!;
    const [mine, theirs] = [await part(1, null), await part(2, COPY)];
    const tailOf = async (id: string) => (await db.select(only(testParts, 'tail')).from(testParts).where(eq(testParts.id, id)))[0]!.tail;
    const waits = (machine: string, partId: string) => routeCheckMessage(ctx, builtinOf(machine), { type: 'tests.waiting', partId, position: 2 }, sql`true`);
    /* A word about a part of another machine's built-in node changes nothing. */
    await waits(OWN, theirs.id);
    await waits(COPY, mine.id);
    expect([await tailOf(mine.id), await tailOf(theirs.id)]).toEqual(['', '']);
    await waits(OWN, mine.id);
    await waits(COPY, theirs.id);
    expect([await tailOf(mine.id), await tailOf(theirs.id)]).toEqual(['Waiting for a machine check slot. Position 2.', 'Waiting for a machine check slot. Position 2.']);
  });

  it("asks the node that was given a description to drop it", async () => {
    const { ctx, companyId } = await company();
    const send = vi.spyOn(ctx.hub, 'send').mockReturnValue(true);
    const request = (more: Partial<TestEnvironmentRequest>): TestEnvironmentRequest => ({
      version: 1, repositoryScope: { companyId, repositoryOwnerId: randomUUID(), repoUrlHash: 'h' }, requestId: randomUUID(), nodeId: null, builtin: true, sentAt: null, attempts: 1, problem: null, ...more,
    });
    cancelDescription(ctx, request({ builtinMachine: COPY }));
    /* One stored before machines had built-in nodes of their own names none: it was this server's. */
    cancelDescription(ctx, request({}));
    expect(send.mock.calls.map(call => call[0])).toEqual([builtinOf(COPY), builtinOf(OWN)]);
  });
});
