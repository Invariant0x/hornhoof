import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { agents, departments, jobs, tasks } from '../src/db/schema.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';

it('lists canOpen with the same product and orchestrator access as the agent API', async () => {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const companyId = orchestrator!.companyId;
  const [department] = await db.insert(departments).values({ companyId, name: 'Development', roleCode: 'DEV' }).returning();
  const [product] = await db.insert(departments).values({ companyId, parentId: department!.id, name: 'Checkout', roleCode: 'CHECKOUT' }).returning();
  const viewer = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [product!.id] } });
  const connected = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['codex'] }, ...as(viewer) })).json();
  const subscriptionId = connected.subscriptions[0].id as string;
  const [own, outside] = await db.insert(agents).values([
    { companyId, kind: 'worker', name: 'Product agent', departmentId: department!.id, productId: product!.id, model: '', subscriptionId },
    { companyId, kind: 'worker', name: 'Department agent', departmentId: department!.id, model: '', subscriptionId },
  ]).returning();
  await db.update(agents).set({ subscriptionId }).where(eq(agents.id, orchestrator!.id));
  const [current] = await db.insert(tasks).values({ companyId, departmentId: department!.id, productId: product!.id, number: 12, title: 'Product work' }).returning();
  const [privateTask] = await db.insert(tasks).values({ companyId, departmentId: department!.id, number: 13, title: 'Private work' }).returning();
  await db.insert(jobs).values([
    { companyId, subscriptionId, agentId: own!.id, taskId: current!.id, prompt: 'work', status: 'running', timeoutMs: 1000, startedAt: new Date('2026-11-04T04:00:00Z'), answersCeo: true },
    { companyId, subscriptionId, agentId: outside!.id, taskId: privateTask!.id, prompt: 'work', status: 'running', timeoutMs: 1000 },
  ]);
  const shown = (await app.inject({ url: '/api/subscriptions', ...as(viewer) })).json().subscriptions[0].agents;
  const byName = Object.fromEntries(shown.map((a: { name: string }) => [a.name, a]));
  expect(byName['Product agent']).toMatchObject({ canOpen: true, busy: true, since: '2026-11-04T04:00:00.000Z', withCeo: true, task: { number: 12, title: 'Product work' } });
  expect(byName['Department agent']).toMatchObject({ canOpen: false, task: null });
  expect(byName.Orchestrator).toMatchObject({ canOpen: false, busy: false, since: null, withCeo: false, task: null });
  for (const [id, status] of [[own!.id, 200], [outside!.id, 403], [orchestrator!.id, 403]] as const) {
    expect((await app.inject({ url: `/api/agents/${id}`, ...as(viewer) })).statusCode).toBe(status);
  }
  const whole = (await app.inject({ url: '/api/subscriptions', ...as(ceo) })).json().subscriptions.find((s: { id: string }) => s.id === subscriptionId).agents;
  expect(whole.every((a: { canOpen: boolean }) => a.canOpen)).toBe(true);
  const joined = await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: connected.command.split('--join ')[1], machineId: 'maria-machine-1234', hostname: 'maria-machine', os: 'linux', arch: 'arm64' } });
  expect(joined.statusCode).toBe(200);
  const nodeId = joined.json().nodes[0].nodeId as string;
  for (const id of [own!.id, outside!.id, orchestrator!.id]) await db.update(agents).set({ nodeId }).where(eq(agents.id, id));
  const machine = (await app.inject({ url: '/api/machines', ...as(viewer) })).json().machines.find((m: { hostname: string }) => m.hostname === 'maria-machine');
  expect(machine.running.agents.map((a: { id: string; canOpen: boolean }) => [a.id, a.canOpen])).toEqual([[orchestrator!.id, false], [outside!.id, false], [own!.id, true]]);
});
