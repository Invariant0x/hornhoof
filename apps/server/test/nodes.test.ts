import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { agents, departments, companies, nodeCodes, people, subscriptions } from '../src/db/schema.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';

const MACHINE = { machineId: 'mac-0001-abcd', hostname: 'ivan-mac', os: 'darwin', arch: 'arm64' };

const codeOf = (command: string) => command.split('--join ')[1]!;
const join = (app: FastifyInstance, code: string, extra: object = {}, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, ...MACHINE, ...extra }, headers });

async function connected(providers: string[]) {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const res = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers }, ...as(ceo) });
  return { app, db, ceo, code: codeOf(res.json().command), ids: res.json().subscriptions.map((s: { id: string }) => s.id) as string[] };
}

const machinesOf = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/machines', ...as(token) })).json().machines;

describe('POST /api/nodes/join', () => {
  it('gives every subscription of the code its own key and one machine', async () => {
    const { app, db, ceo, code, ids } = await connected(['claude', 'codex']);
    const res = await join(app, code);
    expect(res.statusCode).toBe(200);
    const { machine, nodes } = res.json();
    expect(nodes.map((n: { subscriptionId: string }) => n.subscriptionId).sort()).toEqual([...ids].sort());
    expect(new Set(nodes.map((n: { key: string }) => n.key)).size).toBe(2);
    for (const id of ids) {
      const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
      expect(row).toMatchObject({ status: 'needs_login', machineId: machine.id });
      expect(row!.nodeKeyHash).toMatch(/^[0-9a-f]{64}$/);
    }
    const list = await machinesOf(app, ceo);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: machine.id, hostname: 'ivan-mac', os: 'darwin', arch: 'arm64', owner: { name: 'Ivan' }, online: false, subscriptions: 2 });
    expect(JSON.stringify(await app.inject({ url: '/api/subscriptions', ...as(ceo) }).then(r => r.json()))).not.toContain(nodes[0].key);
  });

  it('answers plain lines for the installer', async () => {
    const { app, code } = await connected(['claude', 'codex']);
    const res = await join(app, code, {}, { accept: 'text/plain' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    const lines = res.body.trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(/^[0-9a-f-]{36} (claude|codex) [A-Za-z0-9_-]{43}$/);
  });

  it('refuses a used, an expired and an unknown code', async () => {
    const { app, db, code } = await connected(['claude']);
    expect((await join(app, code)).statusCode).toBe(200);
    const again = await join(app, code);
    expect(again.statusCode).toBe(410);
    expect(again.json().error.reason).toBe('code_used');

    const fresh = await connected(['kimi']);
    await fresh.db.update(nodeCodes).set({ expiresAt: new Date(Date.now() - 1000) });
    const expired = await join(fresh.app, fresh.code);
    expect(expired.statusCode).toBe(410);
    expect(expired.json().error.reason).toBe('code_used');

    const unknown = await join(app, 'A'.repeat(43));
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.reason).toBe('code_unknown');
    void db;
  });

  it('checks the machine details', async () => {
    const { app, code } = await connected(['claude']);
    for (const bad of [{ machineId: 'x' }, { os: 'windows' }, { arch: 'ppc' }, { hostname: '' }]) {
      expect((await join(app, code, bad)).statusCode).toBe(400);
    }
  });

  it('reuses the machine for a second code from the same computer', async () => {
    const { app, ceo, code } = await connected(['claude']);
    await join(app, code);
    const second = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['glm'] }, ...as(ceo) });
    expect((await join(app, codeOf(second.json().command))).statusCode).toBe(200);
    const list = await machinesOf(app, ceo);
    expect(list).toHaveLength(1);
    expect(list[0].subscriptions).toBe(2);
  });

  it('skips subscriptions that already joined a machine, and says the code is used when nothing is left', async () => {
    const { app, ceo, code, ids } = await connected(['claude']);
    const extra = await app.inject({ method: 'POST', url: `/api/subscriptions/${ids[0]}/command`, ...as(ceo) });
    await join(app, code);
    const late = await join(app, codeOf(extra.json().command), { machineId: 'other-machine-01' });
    expect(late.statusCode).toBe(410);
    expect(late.json().error.reason).toBe('code_used');
  });
});

describe('POST /api/machines/:id/disconnect', () => {
  it('sends the subscriptions back to waiting and hides the machine', async () => {
    const { app, db, ceo, code, ids } = await connected(['claude', 'codex']);
    const { machine } = (await join(app, code)).json();
    const [company] = await db.select().from(companies);
    const [dept] = await db.insert(departments).values({ companyId: company!.id, name: 'Sales', roleCode: 'CSO' }).returning();
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [dept!.id] } });

    const refused = await app.inject({ method: 'POST', url: `/api/machines/${machine.id}/disconnect`, ...as(maria) });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.reason).toBe('not_owner');
    expect(await machinesOf(app, maria)).toEqual([]);

    const res = await app.inject({ method: 'POST', url: `/api/machines/${machine.id}/disconnect`, ...as(ceo) });
    expect(res.statusCode).toBe(204);
    for (const id of ids) {
      const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
      expect(row).toMatchObject({ status: 'waiting_machine', machineId: null, nodeKeyHash: null });
    }
    expect(await machinesOf(app, ceo)).toEqual([]);
  });

  it("disconnects a disabled person's machines, frees the orchestrator and refuses their unused code", async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const oleg = await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { whole: true } });
    const connect = (providers: string[]) => app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers }, ...as(oleg) });
    const first = (await connect(['claude'])).json();
    const subId = first.subscriptions[0].id;
    expect((await join(app, codeOf(first.command))).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/subscriptions/${subId}/orchestrator`, ...as(ceo) })).statusCode).toBe(200);
    const spare = codeOf((await connect(['codex'])).json().command);

    const [person] = await db.select().from(people).where(eq(people.email, 'oleg@acme.com'));
    expect((await app.inject({ method: 'PATCH', url: `/api/people/${person!.id}`, payload: { status: 'disabled' }, ...as(ceo) })).statusCode).toBe(200);

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, subId));
    expect(row).toMatchObject({ status: 'waiting_machine', machineId: null, nodeKeyHash: null });
    expect(await machinesOf(app, ceo)).toEqual([]);
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    expect(orchestrator!.subscriptionId).toBeNull();
    expect((await join(app, spare, { machineId: 'mac-0002-abcd' })).statusCode).toBe(410);
  });

  it('says when the machine does not exist', async () => {
    const { app, ceo } = await connected(['claude']);
    const res = await app.inject({ method: 'POST', url: '/api/machines/00000000-0000-4000-8000-000000000000/disconnect', ...as(ceo) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.reason).toBe('machine_unknown');
  });
});

describe('GET /install.sh', () => {
  it('serves the installer with this server address filled in', async () => {
    const { app } = await testApp();
    const res = await app.inject({ url: '/install.sh' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toContain('http://localhost:8080');
    expect(res.body).not.toContain('__HORNHOOF_SERVER__');
  });
});

describe('node config', () => {
  it('refuses a short NODE_KEY and reads the ping interval', async () => {
    await expect(testApp({ NODE_KEY: 'short' })).rejects.toThrow(/NODE_KEY/);
    const { config } = await testApp({ NODE_KEY: 'k'.repeat(32), NODE_PING_MS: '500' });
    expect(config.nodeKey).toBe('k'.repeat(32));
    expect(config.nodePingMs).toBe(500);
  });
});
