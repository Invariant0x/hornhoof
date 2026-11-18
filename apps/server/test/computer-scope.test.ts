import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, computerRuns, departments, jobs, people, subscriptions } from '../src/db/schema.js';
import { decisionPrincipal } from '../src/modules/conversation/decision-context.js';
import { as, invitePerson, listen, mcp, setUpCompany, testApp } from './helpers.js';
import { companyRows, SERVER_MACHINE_ENV, serverMachine, testComputers } from './helpers-computer.js';
import { prepareSharedDatabase } from './helpers-db.js';

await prepareSharedDatabase();

const AT = new Date('2026-11-17T12:00:00.000Z');

async function company() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AT);
  onTestFinished(() => { vi.useRealTimers(); });
  const { app, db } = await testApp(SERVER_MACHINE_ENV);
  /* The company and its agents, made once for the file at the frozen time. */
  const { ceo, worker, head, assistant } = await companyRows(app, 'computer-scope company', async () => {
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [subscription] = await db.select().from(subscriptions);
    const [dept] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
    const hire = async (kind: 'worker' | 'head' | 'assistant') => (await db.insert(agents).values({ companyId: company!.id, kind, name: kind, roleKey: 'DEV-BE', departmentId: dept!.id, subscriptionId: subscription!.id, model: '' }).returning())[0]!;
    return { ceo, worker: await hire('worker'), head: await hire('head'), assistant: await hire('assistant') };
  }, AT);
  const [acme] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [plan] = await db.select().from(subscriptions);
  testComputers(app, { waitMs: 0 });
  const machine = await serverMachine(app);
  const run = async (agent = worker) => {
    const token = `scope-${agent.id}-0123456789abcdef`;
    const [row] = await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: plan!.id, agentId: agent.id, kind: 'conversation', prompt: 'Inspect a recorded sample.', status: 'running', timeoutMs: 1000, createdBy: owner!.id, toolTokenHash: hashToken(token) }).returning();
    return { id: row!.id, companyId: acme!.id, agentId: agent.id, token };
  };
  return { app, db, ceo, acme: acme!, owner: owner!, orchestrator: orchestrator!, worker, head, assistant, machine, run };
}

describe('machine access scope', () => {
  it('runs on a connected machine for the orchestrator after another person writes or while their input is pending', async () => {
    const c = await company();
    const token = await invitePerson(c.app, c.ceo, { name: 'Other', email: 'other@example.test', access: { whole: true } });
    const { id: personId } = (await c.app.inject({ url: '/api/me', ...as(token) })).json().person;
    const job = await c.run(c.orchestrator);
    await c.db.update(jobs).set({ createdBy: personId, decisionInputPending: true }).where(eq(jobs.id, job.id));
    await listen(c.app);
    const client = await mcp(c.app, job.token);
    const result = await client.callTool({ name: 'computer', arguments: { command: 'recorded sample' } });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(await c.db.select().from(computerRuns)).toMatchObject([{ jobId: job.id, machineId: c.machine }]);
  });

  it('admits workers and heads with all-company access, never assistants or another company', async () => {
    const c = await company();
    const worker = await c.run();
    const head = await c.run(c.head);
    const assistant = await c.run(c.assistant);
    expect(await c.app.ctx.computer.start(worker, c.machine, 'sample', 1)).toBe('not_granted');
    await c.app.ctx.computer.delegate(await c.run(c.orchestrator), c.machine, { allAgents: true }, false);
    expect(await decisionPrincipal(c.db, worker.id)).toBeNull();
    expect(await c.app.ctx.computer.start(worker, c.machine, 'sample', 1)).toHaveProperty('id');
    expect(await c.app.ctx.computer.start(head, c.machine, 'sample', 1)).toHaveProperty('id');
    expect(await c.app.ctx.computer.start(assistant, c.machine, 'sample', 1)).toBe('not_granted');
    const [foreign] = await c.db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    await c.db.update(agents).set({ companyId: foreign!.id }).where(eq(agents.id, c.worker.id));
    expect(await c.app.ctx.computer.start(worker, c.machine, 'sample', 1)).toBe('not_granted');
    expect(await c.app.ctx.computer.start({ ...worker, companyId: foreign!.id }, c.machine, 'sample', 1)).toBe('none');
  });

  it('keeps command results and their machine private to the starting agent', async () => {
    const c = await company();
    const run = await c.app.ctx.computer.start(await c.run(c.orchestrator), c.machine, 'sample', 1);
    if (typeof run === 'string') throw new Error('The orchestrator did not start its sample');
    await c.app.ctx.computer.take(c.machine, []);
    await c.app.ctx.computer.answer(c.machine, run.id, { exit: 0, output: 'recorded sample' });
    expect(await c.app.ctx.computer.wait(run.id, c.acme.id, c.worker.id)).toBe('gone');
    expect(await c.app.ctx.computer.machineOfRun(run.id, c.acme.id, c.worker.id)).toBeNull();
    expect(await c.app.ctx.computer.wait(run.id, c.acme.id, c.orchestrator.id)).toEqual({ exit: 0, output: 'recorded sample' });
  });

  it('offers heads and workers the command tools but keeps delegation with the orchestrator', async () => {
    const c = await company();
    await listen(c.app);
    for (const agent of [c.worker, c.head]) {
      const client = await mcp(c.app, (await c.run(agent)).token);
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).toEqual(expect.arrayContaining(['machines', 'computer', 'computer_result']));
      expect(names).not.toContain('open_computer_access');
      expect(await client.callTool({ name: 'computer', arguments: { command: 'recorded sample' } })).toHaveProperty('isError', true);
    }
  });
});
