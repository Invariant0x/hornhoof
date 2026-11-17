import { eq } from 'drizzle-orm';
import { expect, it, onTestFinished, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, companies, computerRuns, jobs, machineAccess, people, subscriptions } from '../src/db/schema.js';
import { decisionPrincipal, enterPressed, machinePrincipal, standingPrincipal, turnStarted, typedWentIn } from '../src/modules/conversation/decision-context.js';
import { BUILTIN } from './builtin.js';
import { listen, mcp, setUpCompany, testApp } from './helpers.js';
import { companyRows, SERVER_MACHINE_ENV, serverMachine, testComputers } from './helpers-computer.js';
import { prepareSharedDatabase } from './helpers-db.js';

await prepareSharedDatabase();

const AT = new Date('2026-11-17T12:00:00Z');

async function company() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AT);
  onTestFinished(() => { vi.useRealTimers(); });
  const { app, db } = await testApp(SERVER_MACHINE_ENV);
  /* The company, its worker and Other, made once for the file at the frozen time. */
  const { worker, other } = await companyRows(app, 'computer-scope-input company', async () => {
    await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [plan] = await db.select().from(subscriptions);
    const [worker] = await db.insert(agents).values({ companyId: company!.id, kind: 'worker', name: 'Worker', roleKey: 'DEV-BE', subscriptionId: plan!.id, model: '' }).returning();
    const [other] = await db.insert(people).values({ companyId: company!.id, name: 'Other', email: 'other@root.example', status: 'active', scopeKind: 'company' }).returning();
    /* Other owns this worker's plan and may see its terminal, but owns no machine. */
    await db.update(subscriptions).set({ ownerPersonId: other!.id }).where(eq(subscriptions.id, plan!.id));
    return { worker, other };
  }, AT);
  await listen(app);
  const [company] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const [plan] = await db.select().from(subscriptions);
  testComputers(app, { waitMs: 0 });
  const machine = await serverMachine(app);
  await db.insert(machineAccess).values({ machineId: machine, companyId: company!.id, scope: 'all_agents', until: new Date('2026-11-17T13:00:00Z') });
  let next = 0;
  const run = async () => {
    const token = `scope-input-${++next}-0123456789abcdef`;
    const [job] = await db.insert(jobs).values({ companyId: company!.id, agentId: worker!.id, subscriptionId: plan!.id, kind: 'conversation', prompt: 'Check a recorded sample.', status: 'running', timeoutMs: 1000, createdBy: owner!.id, toolTokenHash: hashToken(token) }).returning();
    return { job: job!, client: await mcp(app, token) };
  };
  const principal = (jobId: string) => machinePrincipal(db, jobId, owner!.id, machine);
  return { app, db, owner: owner!, other: other!, worker: worker!, machine, run, principal };
}

it('refuses root after another person presses Enter in the worker terminal, and grants no management decision', async () => {
  const c = await company();
  const { job, client } = await c.run();
  expect(await c.principal(job.id)).toBe(c.owner.id);
  await enterPressed(c.app.ctx, c.worker.id, c.other.id, BUILTIN);
  expect(await c.principal(job.id)).toBeNull();
  expect((await client.callTool({ name: 'computer', arguments: { command: 'recorded sample' } })).isError).toBe(true);
  expect(await c.db.select().from(computerRuns)).toEqual([]);
  expect(await decisionPrincipal(c.db, job.id)).toBeNull();
  expect(await standingPrincipal(c.db, job.id)).toBeNull();
  await enterPressed(c.app.ctx, c.worker.id, c.owner.id, BUILTIN);
  expect(await c.principal(job.id)).toBe(c.owner.id);
  expect((await client.callTool({ name: 'computer', arguments: { command: 'recorded sample' } })).isError).not.toBe(true);
  expect(await c.db.select().from(computerRuns)).toHaveLength(1);
  expect(await decisionPrincipal(c.db, job.id)).toBeNull();
  expect(await standingPrincipal(c.db, job.id)).toBeNull();
});

it('records an Enter crossing into a new worker turn with personId null and refuses root', async () => {
  const c = await company();
  const first = await c.run();
  await c.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, first.job.id));
  expect(await enterPressed(c.app.ctx, c.worker.id, c.other.id, BUILTIN)).toBeNull();
  const second = await c.run();
  await turnStarted(c.app.ctx, c.worker.id, second.job.id);
  expect((await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, second.job.id))).filter(event => event.kind === 'typed')).toMatchObject([{ personId: null }]);
  expect(await c.principal(second.job.id)).toBeNull();
  expect((await second.client.callTool({ name: 'computer', arguments: { command: 'recorded sample' } })).isError).toBe(true);
  expect(await c.db.select().from(computerRuns)).toEqual([]);
  expect(await decisionPrincipal(c.db, second.job.id)).toBeNull();
  expect(await standingPrincipal(c.db, second.job.id)).toBeNull();
  await typedWentIn(c.app.ctx, c.worker.id, c.owner.id);
  expect(await c.principal(second.job.id)).toBe(c.owner.id);
  expect(await decisionPrincipal(c.db, second.job.id)).toBeNull();
  expect(await standingPrincipal(c.db, second.job.id)).toBeNull();
});
