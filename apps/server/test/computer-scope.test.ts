import { generateKeyPairSync, sign } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, companies, computerRuns, departments, jobs, machineAccess, machines, people, personKeys, subscriptions } from '../src/db/schema.js';
import { Computers } from '../src/modules/computer/access.js';
import { keyPrint } from '../src/modules/computer/owner-key.js';
import { decisionPrincipal, machinePrincipal } from '../src/modules/conversation/decision-context.js';
import { as, invitePerson, listen, mcp, setUpCompany, testApp } from './helpers.js';
import { SERVER_MACHINE_ENV, serverMachine } from './helpers-computer.js';

const AT = new Date('2026-11-17T12:00:00.000Z');
const DURATIONS = [['1h', 3600], ['8h', 28800], ['24h', 86400]] as const;

async function company() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AT);
  onTestFinished(() => { vi.useRealTimers(); });
  const { app, db } = await testApp(SERVER_MACHINE_ENV);
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [plan] = await db.select().from(subscriptions);
  const [dept] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (kind: 'worker' | 'head' | 'assistant') => (await db.insert(agents).values({ companyId: acme!.id, kind, name: kind, roleKey: 'DEV-BE', departmentId: dept!.id, subscriptionId: plan!.id, model: '' }).returning())[0]!;
  const worker = await hire('worker');
  const head = await hire('head');
  const assistant = await hire('assistant');
  app.ctx.computer = new Computers(app.ctx, { waitMs: 0 });
  app.ctx.computer.moveLegacy(app.ctx.config.controlDir);
  const machine = await serverMachine(app);
  const run = async (agent = worker) => {
    const token = `scope-${agent.id}-0123456789abcdef`;
    const [row] = await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: plan!.id, agentId: agent.id, kind: 'conversation', prompt: 'Inspect a recorded sample.', status: 'running', timeoutMs: 1000, createdBy: owner!.id, toolTokenHash: hashToken(token) }).returning();
    return { id: row!.id, companyId: acme!.id, agentId: agent.id, token };
  };
  const open = (body: object = {}, token = ceo, id = machine) => app.inject({ method: 'POST', url: `/api/machines/${id}/access/open`, payload: body, ...as(token) });
  return { app, db, ceo, acme: acme!, owner: owner!, orchestrator: orchestrator!, worker, head, assistant, machine, open, run };
}

async function remote(c: Awaited<ReturnType<typeof company>>, owner = c.owner.id) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  await c.db.insert(personKeys).values({ companyId: c.acme.id, personId: owner, publicKey, wrapped: 'w', salt: 's', iv: 'i', iterations: 600000 });
  const [machine] = await c.db.insert(machines).values({ companyId: c.acme.id, personId: owner, machineKey: 'scope-remote', hostname: 'Scope remote', networkId: 'd'.repeat(64), ownerPin: keyPrint(publicKey) }).returning();
  c.app.ctx.computer.seen(machine!.id, true);
  const grant = (span: number) => {
    const at = AT.getTime() / 1000;
    const payload = JSON.stringify({ v: 1, machine: machine!.networkId, at, until: at + span, nonce: 'a'.repeat(22) });
    return { payload, signature: sign('sha256', Buffer.from(payload), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') };
  };
  return { machine: machine!.id, grant };
}

describe('machine access scope', () => {
  it.each(DURATIONS)('opens for %s and names its opener', async (duration, seconds) => {
    const c = await company();
    const opened = await c.open({ duration, scope: 'all_agents', confirm: true });
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ scope: 'all_agents', openedBy: { id: c.owner.id, name: c.owner.name }, openedAt: AT.toISOString(), until: new Date(AT.getTime() + seconds * 1000).toISOString() });
    expect((await c.app.inject({ url: '/api/machines/access', ...as(c.ceo) })).json()).not.toHaveProperty('durations');
  });

  it('requires confirmation, validates durations and defaults to one hour for the orchestrator', async () => {
    const c = await company();
    for (const body of [{ scope: 'all_agents' }, { scope: 'all_agents', confirm: false }]) {
      const refused = await c.open(body);
      expect([refused.statusCode, refused.json().error?.reason]).toEqual([400, 'confirm_needed']);
    }
    for (const duration of ['2h', 8, null]) expect((await c.open({ duration })).statusCode).toBe(400);
    expect((await c.open()).json()).toMatchObject({ scope: 'orchestrator', until: new Date(AT.getTime() + 3600_000).toISOString() });
  });

  it.each(DURATIONS)('checks the chosen %s span of the signature', async (duration, seconds) => {
    const c = await company();
    const r = await remote(c);
    const bad = await c.open({ duration, grant: r.grant(seconds - 1) }, c.ceo, r.machine);
    expect([bad.statusCode, bad.json().error?.reason]).toEqual([400, 'bad_grant']);
    expect((await c.open({ duration, grant: r.grant(seconds) }, c.ceo, r.machine)).statusCode).toBe(200);
  });

  it('admits workers and heads only with all_agents, never assistants or another company', async () => {
    const c = await company();
    const worker = await c.run();
    const head = await c.run(c.head);
    const assistant = await c.run(c.assistant);
    await c.open();
    expect(await c.app.ctx.computer.start(worker, c.machine, 'sample', 1)).toBe('closed');
    expect(await c.app.ctx.computer.start(head, c.machine, 'sample', 1)).toBe('closed');
    expect(await machinePrincipal(c.db, worker.id, c.owner.id, c.machine)).toBeNull();
    await c.open({ scope: 'all_agents', confirm: true });
    expect(await machinePrincipal(c.db, worker.id, c.owner.id, c.machine)).toBe(c.owner.id);
    expect(await decisionPrincipal(c.db, worker.id)).toBeNull();
    expect(await c.app.ctx.computer.start(worker, c.machine, 'sample', 1)).toHaveProperty('id');
    expect(await c.app.ctx.computer.start(head, c.machine, 'sample', 1)).toHaveProperty('id');
    expect(await c.app.ctx.computer.start(assistant, c.machine, 'sample', 1)).toBe('closed');
    const [foreign] = await c.db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    await c.db.update(agents).set({ companyId: foreign!.id }).where(eq(agents.id, c.worker.id));
    expect(await machinePrincipal(c.db, worker.id, c.owner.id, c.machine)).toBeNull();
    expect(await c.app.ctx.computer.start(worker, c.machine, 'sample', 1)).toBe('closed');
    expect(await c.app.ctx.computer.start({ ...worker, companyId: foreign!.id }, c.machine, 'sample', 1)).toBe('none');
  });

  it.each([false, true])('closes the old waiting queue before a new opening, expired: %s', async expired => {
    const c = await company();
    await c.open({ scope: 'all_agents', confirm: true });
    if (expired) vi.setSystemTime(new Date(AT.getTime() + 3599_000));
    c.app.ctx.computer.seen(c.machine, true);
    const worker = await c.run();
    const run = await c.app.ctx.computer.start(worker, c.machine, 'old sample', 1);
    if (typeof run === 'string') throw new Error('The worker did not queue its sample');
    if (expired) vi.setSystemTime(new Date(AT.getTime() + 3600_000));
    c.app.ctx.computer.seen(c.machine, true);
    expect((await c.open({ scope: 'orchestrator' })).statusCode).toBe(200);
    expect((await c.app.ctx.computer.take(c.machine, [])).runs).toEqual([]);
    expect(await c.app.ctx.computer.wait(run.id, c.acme.id, c.worker.id)).toMatchObject({ exit: 126 });
  });

  it('keeps the state of a command already taken by the keeper when opening again', async () => {
    const c = await company();
    await c.open({ scope: 'all_agents', confirm: true });
    const run = await c.app.ctx.computer.start(await c.run(), c.machine, 'taken sample', 1);
    if (typeof run === 'string') throw new Error('The worker did not start its sample');
    expect((await c.app.ctx.computer.take(c.machine, [])).runs).toHaveLength(1);
    await c.open();
    expect(await c.app.ctx.computer.wait(run.id, c.acme.id, c.worker.id)).toBe('running');
    expect((await c.db.select().from(computerRuns))[0]!.state).toBe('sent');
  });

  it('keeps command results and their machine private to the starting agent', async () => {
    const c = await company();
    await c.open();
    const run = await c.app.ctx.computer.start(await c.run(c.orchestrator), c.machine, 'sample', 1);
    if (typeof run === 'string') throw new Error('The orchestrator did not start its sample');
    await c.app.ctx.computer.take(c.machine, []);
    await c.app.ctx.computer.answer(c.machine, run.id, { exit: 0, output: 'recorded sample' });
    expect(await c.app.ctx.computer.wait(run.id, c.acme.id, c.worker.id)).toBe('gone');
    expect(await c.app.ctx.computer.machineOfRun(run.id, c.acme.id, c.worker.id)).toBeNull();
    expect(await c.app.ctx.computer.wait(run.id, c.acme.id, c.orchestrator.id)).toEqual({ exit: 0, output: 'recorded sample' });
  });

  it('expires once at the deadline, ends queued commands and publishes the change', async () => {
    const c = await company();
    await c.open({ duration: '1h', scope: 'all_agents', confirm: true });
    const run = await c.app.ctx.computer.start(await c.run(c.orchestrator), c.machine, 'sample', 1);
    const messages: { type: string }[] = [];
    onTestFinished(c.app.ctx.bus.subscribe(c.acme.id, message => messages.push(message)));
    vi.setSystemTime(new Date(AT.getTime() + 3600_000));
    const { expireAccess } = await import('../src/modules/computer/expiry.js');
    await expireAccess(c.app.ctx);
    await expireAccess(c.app.ctx);
    expect(await c.app.ctx.computer.view(c.owner, c.machine)).toMatchObject({ until: null, scope: null, openedBy: null, openedAt: null });
    expect((await c.db.select().from(machineAccess))[0]).toMatchObject({ until: null, grant: null });
    const events = await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.orchestrator.id), eq(agentEvents.kind, 'computer')));
    expect(events.filter(row => (row.data as { state?: string }).state === 'expired')).toHaveLength(1);
    expect(messages.filter(message => message.type === 'computer')).toEqual([{ type: 'computer' }]);
    expect((await c.db.select().from(computerRuns)).find(row => typeof run !== 'string' && row.id === run.id)).toMatchObject({ state: 'done', exit: 126 });
  });

  it('keeps owner-only opening and permits the owner, CEO and delegate to close', async () => {
    const c = await company();
    const owner = await invitePerson(c.app, c.ceo, { name: 'Owner', email: 'owner@scope.test', access: { whole: true } });
    const [person] = await c.db.select().from(people).where(eq(people.email, 'owner@scope.test'));
    const r = await remote(c, person!.id);
    expect((await c.open({ scope: 'all_agents', confirm: true }, c.ceo, r.machine)).statusCode).toBe(403);
    const delegate = await invitePerson(c.app, c.ceo, { name: 'Delegate', email: 'delegate@scope.test', access: { whole: true } });
    await c.db.update(people).set({ isCeoDelegate: true }).where(eq(people.email, 'delegate@scope.test'));
    for (const token of [owner, c.ceo, delegate]) {
      expect((await c.open({ scope: 'all_agents', confirm: true, grant: r.grant(3600) }, owner, r.machine)).statusCode).toBe(200);
      const closed = await c.app.inject({ method: 'POST', url: `/api/machines/${r.machine}/access/close`, ...as(token) });
      expect(closed.statusCode).toBe(200);
      expect(closed.json()).toMatchObject({ until: null, scope: null, openedBy: null, openedAt: null });
    }
  });

  it('offers heads and workers command tools without asking for access', async () => {
    const c = await company();
    await listen(c.app);
    for (const agent of [c.worker, c.head]) {
      const client = await mcp(c.app, (await c.run(agent)).token);
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).toEqual(expect.arrayContaining(['machines', 'computer', 'computer_result']));
      expect(names).not.toContain('ask_computer_access');
      await c.open();
      const refused = await client.callTool({ name: 'computer', arguments: { command: 'recorded sample' } });
      expect(refused.isError).toBe(true);
      expect(await c.db.select().from(computerRuns).where(eq(computerRuns.agentId, agent.id))).toEqual([]);
      await c.open({ scope: 'all_agents', confirm: true });
      const started = await client.callTool({ name: 'computer', arguments: { command: 'recorded sample' } });
      expect(started.isError).not.toBe(true);
      const [run] = await c.db.select().from(computerRuns).where(eq(computerRuns.agentId, agent.id));
      expect((await c.app.ctx.computer.take(c.machine, [])).runs).toEqual([{ id: run!.id, command: 'recorded sample', timeout: 300 }]);
      await c.app.ctx.computer.answer(c.machine, run!.id, { exit: 0, output: 'safe recorded output' });
      const result = await client.callTool({ name: 'computer_result', arguments: { id: run!.id } });
      expect(result).toMatchObject({ content: [{ type: 'text', text: 'Exit code 0.\nsafe recorded output' }] });

    }
  });
});
