import { describe, expect, it, onTestFinished } from 'vitest';
import { companies, departments } from '../src/db/schema.js';
import { as, connectNode, invitePerson, listen, setUpCompany, TEST_API_KEY, testApp, until } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);

async function liveCompany(env: NodeJS.ProcessEnv = {}) {
  const { app, db } = await testApp({ NODE_PING_MS: '1000', ...env });
  const url = await listen(app);
  onTestFinished(() => app.close());
  const ceo = await setUpCompany(app);
  return { app, db, url, ceo };
}

async function joinedClaude(app: Awaited<ReturnType<typeof liveCompany>>['app'], ceo: string) {
  const connected = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) });
  const code = connected.json().command.split('--join ')[1];
  const joined = await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'mac-0001-abcd', hostname: 'ivan-mac', os: 'darwin', arch: 'arm64' } });
  return joined.json().nodes[0] as { subscriptionId: string; key: string };
}

const statusOf = async (app: Awaited<ReturnType<typeof liveCompany>>['app'], token: string, id: string) =>
  (await app.inject({ url: '/api/subscriptions', ...as(token) })).json().subscriptions.find((s: { id: string }) => s.id === id)?.status;

const getJob = (app: Awaited<ReturnType<typeof liveCompany>>['app'], token: string, id: string) => app.inject({ url: `/api/jobs/${id}`, ...as(token) });

describe('POST /api/subscriptions/:id/test', () => {
  it('sends the test prompt to the node and stores its answer', async () => {
    const { app, url, ceo } = await liveCompany();
    const { subscriptionId, key } = await joinedClaude(app, ceo);
    const node = await connectNode(url, key);
    node.send({ type: 'hello', version: '0.2.0', loggedIn: true, running: [] });
    await until(async () => (await statusOf(app, ceo, subscriptionId)) === 'ready');

    const res = await app.inject({ method: 'POST', url: `/api/subscriptions/${subscriptionId}/test`, ...as(ceo) });
    expect(res.statusCode).toBe(201);
    const { job } = res.json();
    expect(job).toMatchObject({ status: 'queued', result: null, machine: 'ivan-mac' });
    const run = await node.next();
    expect(run).toMatchObject({ type: 'job.run', jobId: job.id, subscriptionId, provider: 'claude', prompt: 'Reply with one word: ready', timeoutMs: 120000, secret: null, sessionId: null });

    node.send({ type: 'job.started', jobId: job.id });
    node.send({ type: 'job.done', jobId: job.id, ok: true, sessionId: 's-1', result: 'ready', tail: '', error: null });
    await until(async () => (await getJob(app, ceo, job.id)).json().job.status === 'done');
    const done = (await getJob(app, ceo, job.id)).json().job;
    expect(done).toMatchObject({ status: 'done', result: 'ready', error: null, machine: 'ivan-mac' });
    expect(done.startedAt).not.toBeNull();
    expect(done.finishedAt).not.toBeNull();
    node.close();
  });

  it('ends the open jobs of a subscription when it is removed', async () => {
    const { app, url, ceo } = await liveCompany();
    const { subscriptionId, key } = await joinedClaude(app, ceo);
    const node = await connectNode(url, key);
    node.send({ type: 'hello', version: '0.2.0', loggedIn: true, running: [] });
    await until(async () => (await statusOf(app, ceo, subscriptionId)) === 'ready');
    const { job } = (await app.inject({ method: 'POST', url: `/api/subscriptions/${subscriptionId}/test`, ...as(ceo) })).json();
    await node.next();
    node.send({ type: 'job.started', jobId: job.id });
    await until(async () => (await getJob(app, ceo, job.id)).json().job.status === 'running');

    expect((await app.inject({ method: 'DELETE', url: `/api/subscriptions/${subscriptionId}`, ...as(ceo) })).statusCode).toBe(204);
    const ended = (await getJob(app, ceo, job.id)).json().job;
    expect(ended).toMatchObject({ status: 'failed', error: 'subscription_removed' });
    expect(ended.finishedAt).not.toBeNull();
    node.close();
  });

  it('runs an API key on the built-in node with the decrypted key', async () => {
    const { app, url, ceo } = await liveCompany({ NODE_KEY });
    const orchestrator = (await app.inject({ url: '/api/org', ...as(ceo) })).json().orchestrator.subscription;
    const builtin = await connectNode(url, NODE_KEY);
    builtin.send({ type: 'hello', version: '0.2.0', loggedIn: true, running: [] });
    await until(async () => (await app.inject({ url: '/api/org', ...as(ceo) })).json().orchestrator.subscription.online === true);
    const res = await app.inject({ method: 'POST', url: `/api/subscriptions/${orchestrator.id}/test`, ...as(ceo) });
    expect(res.statusCode).toBe(201);
    expect(await builtin.next()).toMatchObject({ type: 'job.run', provider: 'anthropic_api', secret: TEST_API_KEY, subscriptionId: orchestrator.id });
    builtin.close();
  });

  it('says when the machine is offline or still waits for a login', async () => {
    const { app, url, ceo } = await liveCompany();
    const { subscriptionId, key } = await joinedClaude(app, ceo);
    const offline = await app.inject({ method: 'POST', url: `/api/subscriptions/${subscriptionId}/test`, ...as(ceo) });
    expect(offline.statusCode).toBe(409);
    expect(offline.json().error.reason).toBe('machine_offline');

    const node = await connectNode(url, key);
    node.send({ type: 'hello', version: '0.2.0', loggedIn: false, running: [] });
    await until(async () => (await app.inject({ url: '/api/subscriptions', ...as(ceo) })).json().subscriptions.some((s: { online: boolean }) => s.online));
    const notSignedIn = await app.inject({ method: 'POST', url: `/api/subscriptions/${subscriptionId}/test`, ...as(ceo) });
    expect(notSignedIn.statusCode).toBe(409);
    expect(notSignedIn.json().error.reason).toBe('needs_login');
    node.close();
  });
});

describe('GET /api/jobs/:id', () => {
  it('shows a job to its creator and company scope, not to another department', async () => {
    const { app, db, url, ceo } = await liveCompany();
    const { subscriptionId, key } = await joinedClaude(app, ceo);
    const node = await connectNode(url, key);
    node.send({ type: 'hello', version: '0.2.0', loggedIn: true, running: [] });
    await until(async () => (await statusOf(app, ceo, subscriptionId)) === 'ready');
    const { job } = (await app.inject({ method: 'POST', url: `/api/subscriptions/${subscriptionId}/test`, ...as(ceo) })).json();

    const [company] = await db.select().from(companies);
    const [sales] = await db.insert(departments).values({ companyId: company!.id, name: 'Sales', roleCode: 'CSO' }).returning();
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', scope: { kind: 'department', id: sales!.id } });
    expect((await getJob(app, ceo, job.id)).statusCode).toBe(200);
    expect((await getJob(app, maria, job.id)).statusCode).toBe(403);
    const missing = await getJob(app, ceo, '00000000-0000-4000-8000-000000000000');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.reason).toBe('job_unknown');
    node.close();
  });
});
