import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { companies, departments } from '../src/db/schema.js';
import { as, connectNode, invitePerson, listen, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'builtin-node-key-0123456789abcdef';
const GIB = 1024 ** 3;

/* A company with one machine of the CEO that carries two subscriptions, each its own node. */
async function liveCompany(env: NodeJS.ProcessEnv = {}) {
  const { app, db } = await testApp({ NODE_PING_MS: '50', NODE_KEY, ...env });
  const url = await listen(app);
  onTestFinished(() => app.close());
  const ceo = await setUpCompany(app);
  const connected = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude', 'codex'] }, ...as(ceo) });
  const code = connected.json().command.split('--join ')[1];
  const joined = await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'mac-0001-abcd', hostname: 'ivan-mac', os: 'darwin', arch: 'arm64' } });
  const { machine, nodes } = joined.json();
  return { app, db, url, ceo, machineId: machine.id as string, keys: nodes.map((n: { key: string }) => n.key) as string[] };
}

const machinesOf = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/machines', ...as(token) })).json();
const load = (over: object = {}) => ({ cpus: 8, load: 2, memFree: 6 * GIB, memTotal: 16 * GIB, tests: 0, jobs: 0, ...over });

describe("a machine's load", () => {
  it('is what its nodes said last, with the test runs and agent jobs of all its nodes together', async () => {
    const { app, url, ceo, keys } = await liveCompany();
    const [claude, codex] = await Promise.all(keys.map(k => connectNode(url, k)));
    claude!.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: load({ jobs: 1 }) });
    codex!.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [] });
    await until(async () => (await machinesOf(app, ceo)).machines[0].load !== null);
    expect((await machinesOf(app, ceo)).machines[0].load).toEqual(load({ jobs: 1 }));
    codex!.send({ type: 'load', ...load({ load: 3.5, memFree: 4 * GIB, tests: 1, jobs: 2 }) });
    await until(async () => (await machinesOf(app, ceo)).machines[0].load.tests === 1);
    expect((await machinesOf(app, ceo)).machines[0].load).toEqual(load({ load: 3.5, memFree: 4 * GIB, tests: 1, jobs: 3 }));
    claude!.close();
    codex!.close();
    await until(async () => (await machinesOf(app, ceo)).machines[0].load === null);
  });

  it('is shown for the built-in node to those who see the whole company', async () => {
    const { app, db, url, ceo } = await liveCompany();
    expect((await machinesOf(app, ceo)).builtin).toMatchObject({ online: false, load: null, running: { parts: [] } });
    const builtin = await connectNode(url, NODE_KEY);
    builtin.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: load({ cpus: 4 }) });
    await until(async () => (await machinesOf(app, ceo)).builtin.load !== null);
    expect((await machinesOf(app, ceo)).builtin).toMatchObject({ online: true, load: load({ cpus: 4 }) });
    const [acme] = await db.select().from(companies);
    const [sales] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'sales', roleCode: 'SAL' }).returning();
    const ann = await invitePerson(app, ceo, { name: 'Ann', email: 'ann@acme.com', access: { departments: [sales!.id] } });
    expect((await machinesOf(app, ann)).builtin).toBeNull();
  });

  it('names the machine the built-in node runs on, when the server was installed on a machine that joined', async () => {
    const hostId = (key: string) => createHash('sha256').update(`hornhoof-host:${key}`).digest('hex');
    const { app, ceo, machineId } = await liveCompany({ HORNHOOF_HOST_ID: hostId('mac-0001-abcd') });
    const shown = await machinesOf(app, ceo);
    expect(shown.builtin.machine).toEqual({ id: machineId, hostname: 'ivan-mac' });
    expect(JSON.stringify(shown)).not.toContain('mac-0001-abcd');
    const pool = (await app.inject({ url: '/api/pool', ...as(ceo) })).json();
    expect(pool.builtin.machine).toEqual({ id: machineId, name: 'ivan-mac' });
    await app.inject({ method: 'POST', url: `/api/machines/${machineId}/disconnect`, ...as(ceo) });
    expect((await machinesOf(app, ceo)).builtin.machine).toBeNull();

    const other = await liveCompany({ HORNHOOF_HOST_ID: hostId('tower-0003-abcd') });
    expect((await machinesOf(other.app, other.ceo)).builtin.machine).toBeNull();
    const before = await liveCompany();
    expect((await machinesOf(before.app, before.ceo)).builtin.machine).toBeNull();
    expect((await before.app.inject({ url: '/api/pool', ...as(before.ceo) })).json().builtin.machine).toBeNull();
  });

  it('is lent to test runs by default, and its owner or someone who sees the whole company takes it back', async () => {
    const { app, db, ceo, machineId } = await liveCompany();
    const lend = (token: string, lendsTests: unknown) => app.inject({ method: 'PATCH', url: `/api/machines/${machineId}`, payload: { lendsTests }, ...as(token) });
    expect((await machinesOf(app, ceo)).machines[0].lendsTests).toBe(true);
    const [acme] = await db.select().from(companies);
    const [sales] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'sales', roleCode: 'SAL' }).returning();
    const ann = await invitePerson(app, ceo, { name: 'Ann', email: 'ann@acme.com', access: { departments: [sales!.id] } });
    expect((await lend(ann, false)).json().error.reason).toBe('not_owner');
    expect((await lend(ceo, 'no')).statusCode).toBe(400);
    const off = await lend(ceo, false);
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ lendsTests: false });
    expect((await machinesOf(app, ceo)).machines[0].lendsTests).toBe(false);
    expect((await app.inject({ method: 'PATCH', url: '/api/machines/00000000-0000-4000-8000-000000000000', payload: { lendsTests: true }, ...as(ceo) })).statusCode).toBe(404);
  });
});
