import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { agents, companies, departments, jobs, nodeCodes, nodes, subscriptions, tasks, teams, testParts, testRuns } from '../src/db/schema.js';
import { as, invitePerson, SETUP, setUpCompany, TEST_API_KEY, testApp } from './helpers.js';

const COMMAND = /^curl -fsSL http:\/\/localhost:8080\/install\.sh \| bash -s -- --join ([A-Za-z0-9_-]{43})$/;
const WHOLE = { kind: 'company', id: null, name: 'Whole company' };

const post = (app: FastifyInstance, token: string, url: string, payload?: object) => app.inject({ method: 'POST', url, payload, ...as(token) });
const connect = (app: FastifyInstance, token: string, providers: string[]) => post(app, token, '/api/subscriptions/connect', { providers });
const list = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/subscriptions', ...as(token) })).json().subscriptions;
const addKey = (app: FastifyInstance, token: string, payload: object) => post(app, token, '/api/subscriptions', payload);

/* Marketing, and Development with a Backend team. */
async function places(db: Db) {
  const [company] = await db.select().from(companies);
  const [marketing] = await db.insert(departments).values({ companyId: company!.id, name: 'Marketing', roleCode: 'CMO' }).returning();
  const [development] = await db.insert(departments).values({ companyId: company!.id, name: 'Development', roleCode: 'CTO' }).returning();
  const [backend] = await db.insert(teams).values({ companyId: company!.id, departmentId: development!.id, name: 'Backend' }).returning();
  return { marketing: marketing!, development: development!, backend: backend! };
}

async function companyWithMaria() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const where = await places(db);
  const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [where.marketing.id] } });
  return { app, db, ceo, maria, ...where };
}

describe('POST /api/subscriptions/connect', () => {
  it('lets the CEO connect two plans with one command', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const res = await connect(app, ceo, ['claude', 'codex']);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.command).toMatch(COMMAND);
    expect(body.subscriptions).toHaveLength(2);
    for (const [i, label] of ['Claude', 'Codex'].entries()) {
      expect(body.subscriptions[i]).toMatchObject({ label, kind: 'personal', status: 'waiting_machine', online: false, owner: { name: 'Ivan' }, place: WHOLE, machines: [], limits: null, isOrchestrator: false });
    }
    const [code] = await db.select().from(nodeCodes);
    expect(code!.subscriptionIds.sort()).toEqual(body.subscriptions.map((s: { id: string }) => s.id).sort());
  });

  it('connects a Google AI plan, which Antigravity CLI runs, with the other four in one command', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const res = await connect(app, ceo, ['claude', 'codex', 'kimi', 'glm', 'antigravity']);
    expect(res.statusCode).toBe(201);
    expect(res.json().subscriptions.map((s: { label: string }) => s.label)).toEqual(['Claude', 'Codex', 'Kimi', 'GLM', 'Antigravity']);
  });

  it('places a person plan in their department and follows them when they move', async () => {
    const { app, ceo, maria, marketing, development, backend } = await companyWithMaria();
    const res = await connect(app, maria, ['claude']);
    expect(res.statusCode).toBe(201);
    const [sub] = res.json().subscriptions;
    expect(sub.place).toEqual({ kind: 'department', id: marketing.id, name: 'Marketing' });

    const person = (await list(app, ceo)).find((s: { id: string }) => s.id === sub.id).owner;
    const moved = await app.inject({ method: 'PATCH', url: `/api/people/${person.id}`, payload: { access: { teams: [backend.id] } }, ...as(ceo) });
    expect(moved.statusCode).toBe(200);
    const after = (await list(app, ceo)).find((s: { id: string }) => s.id === sub.id);
    expect(after).toEqual({ ...sub, agents: [], place: { kind: 'department', id: development.id, name: 'Development' } });
  });

  it('reuses a plan still waiting for its machine instead of making a second one', async () => {
    const { app, ceo } = await companyWithMaria();
    const first = (await connect(app, ceo, ['claude'])).json().subscriptions[0];
    const again = await connect(app, ceo, ['claude', 'codex']);
    expect(again.statusCode).toBe(201);
    expect(again.json().subscriptions.map((s: { id: string }) => s.id)).toContain(first.id);
    expect((await list(app, ceo)).filter((s: { label: string }) => s.label === 'Claude')).toHaveLength(1);
  });

  it('finishes or cleans up an unfinished plan and its node on a second connection so two connections leave one subscription and one node', async () => {
    const { app, db, ceo } = await companyWithMaria();
    const joinNode = (command: string, machineId: string, hostname: string) =>
      app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: command.split('--join ')[1], machineId, hostname, os: 'darwin', arch: 'arm64' } });

    const first = (await connect(app, ceo, ['codex'])).json();
    expect((await joinNode(first.command, 'mac-0001-abcd', 'ivan-mac')).statusCode).toBe(200);

    const second = await connect(app, ceo, ['codex']);
    expect(second.statusCode).toBe(201);
    expect((await joinNode(second.json().command, 'mac-0002-efgh', 'ivan-laptop')).statusCode).toBe(200);

    expect(await db.select().from(subscriptions).where(eq(subscriptions.provider, 'codex'))).toHaveLength(1);
    expect(await db.select().from(nodes)).toHaveLength(1);

    const subId = second.json().subscriptions[0].id as string;
    expect((await app.inject({ method: 'DELETE', url: `/api/subscriptions/${subId}`, ...as(ceo) })).statusCode).toBe(204);
    const third = await connect(app, ceo, ['codex']);
    expect(third.statusCode).toBe(201);
    expect((await joinNode(third.json().command, 'mac-0001-abcd', 'ivan-mac')).statusCode).toBe(200);

    expect(await db.select().from(subscriptions).where(eq(subscriptions.provider, 'codex'))).toHaveLength(1);
    expect(await db.select().from(nodes)).toHaveLength(1);
  });

  it('refuses a ready plan or a plan with agents on a second connection and never touches its row or node', async () => {
    const { app, db, ceo, development } = await companyWithMaria();
    const joinNode = (command: string, machineId: string) =>
      app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: command.split('--join ')[1], machineId, hostname: 'ivan-mac', os: 'darwin', arch: 'arm64' } });

    const claude = (await connect(app, ceo, ['claude'])).json();
    const claudeId = claude.subscriptions[0].id as string;
    await joinNode(claude.command, 'mac-0001-abcd');
    await db.update(nodes).set({ status: 'ready' }).where(eq(nodes.subscriptionId, claudeId));
    await db.update(subscriptions).set({ status: 'ready' }).where(eq(subscriptions.id, claudeId));

    const refusedReady = await connect(app, ceo, ['claude']);
    expect(refusedReady.statusCode).toBe(409);
    expect(refusedReady.json().error.reason).toBe('already_connected');
    expect((await db.select().from(subscriptions).where(eq(subscriptions.id, claudeId)))[0]).toMatchObject({ status: 'ready', removedAt: null });
    expect((await db.select().from(nodes).where(eq(nodes.subscriptionId, claudeId)))[0]).toMatchObject({ status: 'ready' });

    const codex = (await connect(app, ceo, ['codex'])).json();
    const codexId = codex.subscriptions[0].id as string;
    expect((await joinNode(codex.command, 'mac-0002-efgh')).statusCode).toBe(200);
    await db.insert(agents).values({ companyId: development.companyId, kind: 'worker', name: 'Bruno', departmentId: development.id, roleKey: 'DEV-BE', model: '', subscriptionId: codexId });

    const refusedWithAgents = await connect(app, ceo, ['codex']);
    expect(refusedWithAgents.statusCode).toBe(409);
    expect(refusedWithAgents.json().error.reason).toBe('already_connected');
    expect((await db.select().from(subscriptions).where(eq(subscriptions.id, codexId)))[0]).toMatchObject({ status: 'needs_login', removedAt: null });
    expect(await db.select().from(nodes).where(eq(nodes.subscriptionId, codexId))).toHaveLength(1);

    const [claudeNode] = await db.select().from(nodes).where(eq(nodes.subscriptionId, claudeId));
    const [bruno] = await db.select().from(agents).where(eq(agents.subscriptionId, codexId));
    const [task] = await db.insert(tasks).values({ companyId: development.companyId, number: 1, title: 'Check test runs' }).returning();
    const [job] = await db.insert(jobs).values({ companyId: development.companyId, subscriptionId: claudeId, agentId: bruno!.id, prompt: 'Run', timeoutMs: 1000, status: 'done', kind: 'conversation' }).returning();
    const [run] = await db.insert(testRuns).values({ companyId: development.companyId, number: 1, taskId: task!.id, agentId: bruno!.id, jobId: job!.id, command: 'npm test', parts: 2, timeoutMs: 1000, status: 'passed' }).returning();
    await db.insert(testParts).values({ companyId: development.companyId, runId: run!.id, part: 1, status: 'passed', nodeId: claudeNode!.id, machineId: claudeNode!.machineId });

    const kimi = (await connect(app, ceo, ['kimi'])).json();
    const kimiId = kimi.subscriptions[0].id as string;
    expect((await joinNode(kimi.command, 'mac-0003-ijkl')).statusCode).toBe(200);
    await db.update(nodes).set({ machineId: claudeNode!.machineId }).where(eq(nodes.subscriptionId, kimiId));
    expect((await connect(app, ceo, ['kimi'])).statusCode).toBe(201);

    expect((await joinNode((await connect(app, ceo, ['kimi'])).json().command, 'mac-0003-ijkl')).statusCode).toBe(200);
    const [kimiNode] = await db.select().from(nodes).where(eq(nodes.subscriptionId, kimiId));
    await db.insert(testParts).values({ companyId: development.companyId, runId: run!.id, part: 2, status: 'passed', nodeId: kimiNode!.id, machineId: kimiNode!.machineId });

    const refusedWithNodeRun = await connect(app, ceo, ['kimi']);
    expect(refusedWithNodeRun.statusCode).toBe(409);
    expect(refusedWithNodeRun.json().error.reason).toBe('already_connected');
    expect(await db.select().from(nodes).where(eq(nodes.subscriptionId, kimiId))).toHaveLength(1);
  });

  it('refuses an empty list, repeats and API key providers', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    for (const providers of [[], ['anthropic_api'], ['claude', 'claude']]) {
      expect((await connect(app, ceo, providers)).statusCode).toBe(400);
    }
  });
});

describe('POST /api/subscriptions/:id/command', () => {
  it('gives the owner a fresh command until the machine joins', async () => {
    const { app, db, ceo, maria } = await companyWithMaria();
    const first = (await connect(app, ceo, ['claude'])).json();
    const id = first.subscriptions[0].id;
    const again = await post(app, ceo, `/api/subscriptions/${id}/command`);
    expect(again.statusCode).toBe(201);
    expect(again.json().command).toMatch(COMMAND);
    expect(again.json().command).not.toBe(first.command);

    const other = await post(app, maria, `/api/subscriptions/${id}/command`);
    expect(other.statusCode).toBe(403);
    expect(other.json().error.reason).toBe('not_owner');

    await db.update(subscriptions).set({ status: 'needs_login' }).where(eq(subscriptions.id, id));
    const joined = await post(app, ceo, `/api/subscriptions/${id}/command`);
    expect(joined.statusCode).toBe(409);
    expect(joined.json().error.reason).toBe('already_connected');
  });

  it('says when the subscription does not exist', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const res = await post(app, ceo, '/api/subscriptions/00000000-0000-4000-8000-000000000000/command');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.reason).toBe('subscription_unknown');
  });
});

describe('POST /api/subscriptions/:id/orchestrator', () => {
  it('moves the orchestrator to a company-level personal subscription', async () => {
    const { app, ceo } = await companyWithMaria();
    const id = (await connect(app, ceo, ['claude'])).json().subscriptions[0].id;
    const res = await post(app, ceo, `/api/subscriptions/${id}/orchestrator`);
    expect(res.statusCode).toBe(200);
    expect(res.json().subscription).toMatchObject({ id, isOrchestrator: true });
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.orchestrator.subscription.id).toBe(id);
    expect((await list(app, ceo)).filter((s: { isOrchestrator: boolean }) => s.isOrchestrator).map((s: { id: string }) => s.id)).toEqual([id]);
  });

  it("keeps the orchestrator's effort on the same provider and starts another provider at its default, as his card does", async () => {
    const { app, db, ceo } = await companyWithMaria();
    const effort = async () => (await db.select().from(agents).where(eq(agents.kind, 'orchestrator')))[0]!.effort;
    expect((await app.inject({ method: 'PATCH', url: '/api/agents/orchestrator', payload: { effort: 'high' }, ...as(ceo) })).statusCode).toBe(200);
    const sameKey = await addKey(app, ceo, { kind: 'api_key', provider: 'anthropic_api', label: 'Second key', apiKey: TEST_API_KEY, target: { kind: 'orchestrator' } });
    expect(sameKey.statusCode).toBe(201);
    expect(await effort()).toBe('high');
    const claude = (await connect(app, ceo, ['claude'])).json().subscriptions[0].id;
    expect((await post(app, ceo, `/api/subscriptions/${claude}/orchestrator`)).statusCode).toBe(200);
    expect(await effort()).toBeNull();
    await db.update(agents).set({ effort: 'low' }).where(eq(agents.kind, 'orchestrator'));
    await addKey(app, ceo, { kind: 'api_key', provider: 'openai_api', label: 'OpenAI', apiKey: 'sk-proj-test-key-4321', target: { kind: 'orchestrator' } });
    expect(await effort()).toBeNull();
  });

  it('no longer answers at the old chief address', async () => {
    const { app, ceo } = await companyWithMaria();
    const id = (await connect(app, ceo, ['claude'])).json().subscriptions[0].id;
    expect((await post(app, ceo, `/api/subscriptions/${id}/chief`)).statusCode).toBe(404);
  });

  it('refuses an API key that serves only a department', async () => {
    const { app, ceo, marketing } = await companyWithMaria();
    const key = await addKey(app, ceo, { kind: 'api_key', provider: 'anthropic_api', label: 'Marketing key', apiKey: TEST_API_KEY, target: { kind: 'department', id: marketing.id } });
    const res = await post(app, ceo, `/api/subscriptions/${key.json().subscription.id}/orchestrator`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.reason).toBe('not_company_level');
  });

  it('frees the orchestrator when its owner leaves company scope', async () => {
    const { app, db, ceo, marketing } = await companyWithMaria();
    const deputy = await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { whole: true } });
    const id = (await connect(app, deputy, ['claude'])).json().subscriptions[0].id;
    expect((await post(app, ceo, `/api/subscriptions/${id}/orchestrator`)).statusCode).toBe(200);
    const owner = (await list(app, ceo)).find((s: { id: string }) => s.id === id).owner;
    const moved = await app.inject({ method: 'PATCH', url: `/api/people/${owner.id}`, payload: { access: { departments: [marketing.id] } }, ...as(ceo) });
    expect(moved.statusCode).toBe(200);
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    expect(orchestrator!.subscriptionId).toBeNull();
  });

  it('refuses a department plan and a person without company scope', async () => {
    const { app, ceo, maria } = await companyWithMaria();
    const theirs = (await connect(app, maria, ['claude'])).json().subscriptions[0].id;
    const res = await post(app, ceo, `/api/subscriptions/${theirs}/orchestrator`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.reason).toBe('not_company_level');

    const mine = (await connect(app, ceo, ['codex'])).json().subscriptions[0].id;
    const notAllowed = await post(app, maria, `/api/subscriptions/${mine}/orchestrator`);
    expect(notAllowed.statusCode).toBe(403);
    expect(notAllowed.json().error.reason).toBe('company_scope_only');
  });
});

describe('DELETE /api/subscriptions/:id', () => {
  it('lets the owner remove a plan', async () => {
    const { app, maria } = await companyWithMaria();
    const id = (await connect(app, maria, ['kimi'])).json().subscriptions[0].id;
    const res = await app.inject({ method: 'DELETE', url: `/api/subscriptions/${id}`, ...as(maria) });
    expect(res.statusCode).toBe(204);
    expect(await list(app, maria)).toEqual([]);
  });

  it('leaves the orchestrator without a subscription when its one is removed, and forgets the key', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [orchestrator] = await db.select().from(agents);
    const res = await app.inject({ method: 'DELETE', url: `/api/subscriptions/${orchestrator!.subscriptionId}`, ...as(ceo) });
    expect(res.statusCode).toBe(204);
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.orchestrator.subscription).toBeNull();
    const [row] = await db.select().from(subscriptions);
    expect(row!.secretEnc).toBeNull();
    expect(row!.removedAt).not.toBeNull();
  });

  it('refuses a person who neither owns it nor has company scope', async () => {
    const { app, ceo, maria } = await companyWithMaria();
    const id = (await connect(app, ceo, ['claude'])).json().subscriptions[0].id;
    const res = await app.inject({ method: 'DELETE', url: `/api/subscriptions/${id}`, ...as(maria) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.reason).toBe('not_owner');
  });
});

describe('PATCH /api/subscriptions/:id', () => {
  const patch = (app: FastifyInstance, token: string, id: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/subscriptions/${id}`, payload, ...as(token) });

  it("lets the owner set the share of the plan's limits that tasks may use, and take it off", async () => {
    const { app, maria } = await companyWithMaria();
    const id = (await connect(app, maria, ['kimi'])).json().subscriptions[0].id;
    expect((await list(app, maria))[0].budget).toBeNull();
    const set = await patch(app, maria, id, { budget: 80 });
    expect(set.statusCode).toBe(200);
    expect(set.json().subscription.budget).toBe(80);
    expect((await list(app, maria))[0].budget).toBe(80);
    expect((await patch(app, maria, id, { budget: null })).json().subscription.budget).toBeNull();
  });

  it('refuses a share outside 10 to 100 percent', async () => {
    const { app, maria } = await companyWithMaria();
    const id = (await connect(app, maria, ['kimi'])).json().subscriptions[0].id;
    expect((await patch(app, maria, id, { budget: 5 })).statusCode).toBe(400);
    expect((await patch(app, maria, id, { budget: 101 })).statusCode).toBe(400);
  });

  it('refuses a person who neither owns it nor has company scope', async () => {
    const { app, ceo, maria } = await companyWithMaria();
    const id = (await connect(app, ceo, ['claude'])).json().subscriptions[0].id;
    const res = await patch(app, maria, id, { budget: 50 });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.reason).toBe('not_owner');
  });
});

describe('GET /api/subscriptions', () => {
  it('lists the agents of a plan in map order, with work and only the tasks the viewer reaches', async () => {
    const { app, db, ceo, maria, marketing, development } = await companyWithMaria();
    const sub = (await connect(app, maria, ['claude'])).json().subscriptions[0];
    await db.update(departments).set({ position: 1 }).where(eq(departments.id, marketing.id));
    const hire = async (name: string, departmentId: string) =>
      (await db.insert(agents).values({ companyId: development.companyId, kind: 'worker', name, departmentId, roleKey: 'DEV-BE', model: '', subscriptionId: sub.id }).returning())[0]!;
    const vera = await hire('Vera', marketing.id);
    const bruno = await hire('Bruno', development.id);
    const [task] = await db.insert(tasks).values({ companyId: development.companyId, departmentId: development.id, number: 12, title: 'Checkout API' }).returning();
    const since = new Date('2026-11-01T10:00:00Z');
    await db.insert(jobs).values({ companyId: development.companyId, subscriptionId: sub.id, agentId: bruno.id, taskId: task!.id, prompt: 'work', status: 'running', timeoutMs: 1000, startedAt: since, answersCeo: true });
    /* A finished turn leaves its agent on the plan, without the old task or start time. */
    await db.insert(jobs).values({ companyId: development.companyId, subscriptionId: sub.id, agentId: vera.id, taskId: task!.id, prompt: 'review', status: 'done', timeoutMs: 1000, startedAt: since, finishedAt: new Date('2026-11-01T10:05:00Z'), answersCeo: true });
    const shown = (await list(app, ceo)).find((s: { id: string }) => s.id === sub.id);
    expect(shown.agents).toEqual([
      { id: bruno.id, name: 'Bruno', busy: true, title: { en: 'Backend engineer', ru: 'Бэкенд-разработчик' }, department: { id: development.id, name: 'Development' }, provider: 'claude', since: since.toISOString(), task: { number: 12, title: 'Checkout API' }, withCeo: true },
      { id: vera.id, name: 'Vera', busy: false, title: { en: 'Backend engineer', ru: 'Бэкенд-разработчик' }, department: { id: marketing.id, name: 'Marketing' }, provider: 'claude', since: null, task: null, withCeo: false },
    ]);
    expect((await list(app, maria))[0].agents[0].task).toBeNull();
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.orchestrator.subscription).not.toHaveProperty('agents');
  });

  it('shows company scope everything and everyone else only their own', async () => {
    const { app, ceo, maria } = await companyWithMaria();
    await connect(app, maria, ['claude']);
    expect((await list(app, ceo)).map((s: { label: string }) => s.label)).toEqual(['Orchestrator', 'Claude']);
    expect((await list(app, maria)).map((s: { owner: { name: string } }) => s.owner.name)).toEqual(['Maria']);
  });

  it('never returns the key or its ciphertext', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    await addKey(app, ceo, { provider: 'openai_api', kind: 'api_key', label: 'Company OpenAI', apiKey: 'sk-proj-another-key-7777', target: { kind: 'any' } });
    for (const url of ['/api/org', '/api/subscriptions']) {
      const body = (await app.inject({ url, ...as(ceo) })).body;
      expect(body).not.toContain(TEST_API_KEY);
      expect(body).not.toContain('sk-proj-another-key');
      expect(body).not.toContain('secretEnc');
      expect(body).not.toContain('v1.');
    }
    expect((await list(app, ceo)).map((s: { label: string; place: { name: string }; isOrchestrator: boolean }) => [s.label, s.place.name, s.isOrchestrator])).toEqual([
      ['Orchestrator', 'Whole company', true],
      ['Company OpenAI', 'Whole company', false],
    ]);
  });
});

describe('POST /api/subscriptions', () => {
  it('takes only API keys, personal subscriptions connect through a machine', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const res = await addKey(app, ceo, { provider: 'claude', kind: 'personal', label: 'Ivan Max', target: { kind: 'orchestrator' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
  });

  it('refuses a provider that does not match the kind and a target that does not exist', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const wrongKind = await addKey(app, ceo, { provider: 'claude', kind: 'api_key', label: 'x', apiKey: 'sk-ant-12345678', target: { kind: 'any' } });
    expect(wrongKind.statusCode).toBe(400);
    const noTeam = await addKey(app, ceo, { provider: 'anthropic_api', kind: 'api_key', label: 'x', apiKey: 'sk-ant-12345678', target: { kind: 'team', id: '00000000-0000-4000-8000-000000000000' } });
    expect(noTeam.statusCode).toBe(400);
    expect(noTeam.json().error.reason).toBe('unknown_place');
  });

  it('places a department key in its department', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const { development, backend } = await places(db);
    const res = await addKey(app, ceo, { provider: 'anthropic_api', kind: 'api_key', label: 'Backend key', apiKey: 'sk-ant-api03-team-key-5555', target: { kind: 'team', id: backend.id } });
    expect(res.json().subscription.place).toEqual({ kind: 'department', id: development.id, name: 'Development' });
  });

  it('connects a orchestrator that waited for a subscription', async () => {
    const { app, db } = await testApp();
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, orchestrator: { mode: 'later' } } });
    const ceo = setup.cookies[0]!.value;
    const res = await addKey(app, ceo, { provider: 'anthropic_api', kind: 'api_key', label: 'Orchestrator key', apiKey: 'sk-ant-api03-late-key-1234', target: { kind: 'orchestrator' } });
    expect(res.statusCode).toBe(201);
    const [orchestrator] = await db.select().from(agents);
    expect(orchestrator!.subscriptionId).toBe(res.json().subscription.id);
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.orchestrator.subscription).toMatchObject({ label: 'Orchestrator key', last4: '1234', isOrchestrator: true });
  });
});
