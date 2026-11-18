import { createHash } from 'node:crypto';
import type { ProgramInfo } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { agents, companies, departments, people } from '../src/db/schema.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { BUILTIN } from './builtin.js';
import { as, connectNode, invitePerson, listen, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'builtin-program-key-0123456789abcdef';
const MACHINE_KEY = 'program-host-0001';
const hostId = (key: string) => createHash('sha256').update(`hornhoof-host:${key}`).digest('hex');
const hello = { type: 'hello' as const, version: '0.5.0', loggedIn: true, running: [] };
const claude = { id: 'claude' as const, version: '1.0.0', updating: false, failed: false };
const codex = { id: 'codex' as const, version: '2.0.0', updating: false, failed: false };

async function liveCompany(onHost = false) {
  const { app, db } = await testApp({ NODE_KEY, ...(onHost ? { HORNHOOF_HOST_ID: hostId(MACHINE_KEY) } : {}) });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const [company] = await db.select().from(companies);
  const [dept] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'sales', roleCode: 'SAL' }).returning();
  const owner = await invitePerson(app, ceo, { name: 'Owner', email: 'owner@acme.com', access: { departments: [dept!.id] } });
  const stranger = await invitePerson(app, ceo, { name: 'Stranger', email: 'stranger@acme.com', access: { departments: [dept!.id] } });
  const [person] = await db.select().from(people).where(eq(people.email, 'owner@acme.com'));
  const join = async (key: string, providers = ['claude', 'codex']) => {
    const command = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers }, ...as(owner) });
    const joined = await app.inject({ method: 'POST', url: '/api/nodes/join', payload: {
      code: command.json().command.split('--join ')[1], machineId: key, hostname: key, os: 'linux', arch: 'x86_64',
    } });
    expect(joined.statusCode).toBe(200);
    return joined.json() as { machine: { id: string }; nodes: { nodeId: string; key: string; provider: string }[] };
  };
  const machine = await join(MACHINE_KEY);
  const connect = async (key: string, programs?: ProgramInfo[]) => {
    const node = await connectNode(url, key);
    onTestFinished(() => node.close());
    node.send({ ...hello, ...(programs ? { programs } : {}) });
    return node;
  };
  const machineView = async (token = owner) => {
    const response = await app.inject({ url: '/api/machines', ...as(token) });
    return response.json();
  };
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  return { app, owner, stranger, ceo, ownerId: person!.id, orchestratorId: orchestrator!.id, machine, join, connect, machineView };
}

describe('updating the programs on a machine', () => {
  it.each(['owner', 'company', 'delegated'] as const)('lets the %s update all capable nodes on that machine only', async actor => {
    const f = await liveCompany();
    const other = await f.join('program-host-0002', ['kimi']);
    const first = await f.connect(f.machine.nodes[0]!.key, [claude]);
    const second = await f.connect(f.machine.nodes[1]!.key, [codex]);
    await f.connect(other.nodes[0]!.key, [{ ...claude, id: 'kimi' }]);
    for (const row of [...f.machine.nodes, other.nodes[0]!]) await until(() => f.app.ctx.hub.isReady(nodeIdentity(row.nodeId)));
    const send = vi.spyOn(f.app.ctx.hub, 'send');
    onTestFinished(() => send.mockRestore());
    const auth = actor === 'delegated' ? { headers: orchestratorHeaders(f.ownerId, f.orchestratorId) } : as(f[actor === 'owner' ? 'owner' : 'ceo']);
    const request = () => f.app.inject({ method: 'POST', url: `/api/machines/${f.machine.machine.id}/programs/update`, ...auth });
    const accepted = await request();
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ updating: true });
    expect(await first.next()).toEqual({ type: 'programs.update' });
    let message = await second.next();
    while (message.type !== 'programs.update') message = await second.next();
    const calls = () => send.mock.calls.filter(([, m]) => m.type === 'programs.update');
    expect(calls().map(([id]) => id)).toEqual(f.machine.nodes.map(n => nodeIdentity(n.nodeId)));
    const state = (await f.machineView()).machines.find((m: { id: string }) => m.id === f.machine.machine.id);
    expect(state.programs).toEqual([{ ...claude, updating: true }, { ...codex, updating: true }]);
    expect((await request()).statusCode).toBe(202);
    expect(calls()).toHaveLength(2);
  });

  it('refuses strangers, signed-out requests and an unknown machine', async () => {
    const f = await liveCompany();
    const url = `/api/machines/${f.machine.machine.id}/programs/update`;
    expect((await f.app.inject({ method: 'POST', url })).statusCode).toBe(401);
    expect((await f.app.inject({ method: 'POST', url, ...as(f.stranger) })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url: '/api/machines/00000000-0000-4000-8000-000000000000/programs/update', ...as(f.ceo) })).statusCode).toBe(404);
  });

  it.each(['offline', 'older', 'empty'] as const)('refuses an %s node without programs to update', async kind => {
    const f = await liveCompany();
    if (kind !== 'offline') {
      await f.connect(f.machine.nodes[0]!.key, kind === 'empty' ? [] : undefined);
      await until(() => f.app.ctx.hub.isReady(nodeIdentity(f.machine.nodes[0]!.nodeId)));
    }
    const programs = (await f.machineView()).machines[0].programs;
    expect(programs).toEqual(kind === 'empty' ? [] : null);
    const result = await f.app.inject({ method: 'POST', url: `/api/machines/${f.machine.machine.id}/programs/update`, ...as(f.owner) });
    expect(result.statusCode).toBe(409);
  });

  it('merges matching versions while preserving different versions and partial failures', async () => {
    const f = await liveCompany();
    const olderCodex = { ...codex, version: '0.5.0' };
    const newerCodex = { ...codex, version: '0.6.0' };
    await f.connect(f.machine.nodes[0]!.key, [newerCodex, claude]);
    await f.connect(f.machine.nodes[1]!.key, [olderCodex, { ...claude, failed: true }]);
    for (const row of f.machine.nodes) await until(() => f.app.ctx.hub.isReady(nodeIdentity(row.nodeId)));
    expect((await f.machineView()).machines[0].programs).toEqual([
      { ...claude, failed: true }, olderCodex, newerCodex,
    ]);
  });

  it('updates the virtual built-in node only for company-scoped people', async () => {
    const f = await liveCompany();
    const builtin = await f.connect(NODE_KEY, [claude, codex]);
    await until(() => f.app.ctx.hub.isReady(BUILTIN));
    expect((await f.machineView(f.ceo)).builtin.programs).toEqual([claude, codex]);
    expect((await f.machineView()).builtin).toBeNull();
    const url = '/api/machines/builtin/programs/update';
    expect((await f.app.inject({ method: 'POST', url, ...as(f.owner) })).statusCode).toBe(403);
    const send = vi.spyOn(f.app.ctx.hub, 'send');
    onTestFinished(() => send.mockRestore());
    expect((await f.app.inject({ method: 'POST', url, ...as(f.ceo) })).statusCode).toBe(202);
    expect(send.mock.calls.filter(([, m]) => m.type === 'programs.update')).toEqual([[BUILTIN, { type: 'programs.update' }]]);
    builtin.close();
    await builtin.closed;
    await until(() => !f.app.ctx.hub.isOnline(BUILTIN));
    expect((await f.machineView(f.ceo)).builtin.programs).toBeNull();
  });

  it('includes the built-in node on its registered physical machine, without duplicate rows', async () => {
    const f = await liveCompany(true);
    await f.connect(f.machine.nodes[0]!.key, [claude]);
    await f.connect(f.machine.nodes[1]!.key, [codex]);
    await f.connect(NODE_KEY, [claude, codex]);
    for (const id of [...f.machine.nodes.map(n => nodeIdentity(n.nodeId)), BUILTIN]) await until(() => f.app.ctx.hub.isReady(id));
    expect((await f.machineView()).machines[0].programs).toEqual([claude, codex]);
    const send = vi.spyOn(f.app.ctx.hub, 'send');
    onTestFinished(() => send.mockRestore());
    expect((await f.app.inject({ method: 'POST', url: `/api/machines/${f.machine.machine.id}/programs/update`, ...as(f.owner) })).statusCode).toBe(202);
    expect(send.mock.calls.filter(([, m]) => m.type === 'programs.update').map(([id]) => id)).toEqual([
      ...f.machine.nodes.map(n => nodeIdentity(n.nodeId)), BUILTIN,
    ]);
  });

  it('keeps the owned physical server online when only its built-in node is connected', async () => {
    const f = await liveCompany(true);
    await f.connect(NODE_KEY, [claude, codex]);
    await until(() => f.app.ctx.hub.isReady(BUILTIN));
    const view = await f.machineView();
    expect(view.builtin).toBeNull();
    expect(view.machines[0]).toMatchObject({ online: true, programs: [claude, codex] });
    expect((await f.app.inject({ method: 'POST', url: `/api/machines/${f.machine.machine.id}/programs/update`, ...as(f.owner) })).statusCode).toBe(202);
  });
});
