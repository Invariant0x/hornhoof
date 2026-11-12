import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { nodeCodes, subscriptions } from '../src/db/schema.js';
import { as, invitePerson, sessionFrom, SETUP, setUpCompany, testApp } from './helpers.js';

const MACHINE = { machineId: 'command-test-mac', hostname: 'demo-mac', os: 'darwin', arch: 'arm64' };
const codeOf = (command: string) => command.split('--join ')[1]!;

describe('one active install command per place', () => {
  it('rejects a second plan command and overlapping connect without hiding or changing the first', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const first = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude', 'codex'] }, ...as(ceo) })).json();
    for (const url of first.subscriptions.map((s: { id: string }) => `/api/subscriptions/${s.id}/command`)) {
      const res = await app.inject({ method: 'POST', url, ...as(ceo) });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.reason).toBe('command_active');
    }
    const overlap = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['codex', 'kimi'] }, ...as(ceo) });
    expect(overlap.statusCode).toBe(409);
    const list = (await app.inject({ url: '/api/nodes/commands', ...as(ceo) })).json().commands;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: first.id, command: first.command, plans: ['Claude', 'Codex'], subscriptionIds: first.subscriptions.map((s: { id: string }) => s.id) });
    expect(await db.select().from(nodeCodes)).toHaveLength(1);
    const other = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['glm'] }, ...as(ceo) });
    expect(other.statusCode).toBe(201);
  });

  it('Done hides one plan block at a time, leaves the code sealed and usable, and join removes the command', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const first = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude', 'codex'] }, ...as(ceo) })).json();
    const malformed = await app.inject({ method: 'POST', url: `/api/nodes/commands/${first.id}/hide`, payload: 'false', headers: { 'content-type': 'application/json' }, ...as(ceo) });
    expect(malformed.statusCode).toBe(400);
    const hide = await app.inject({ method: 'POST', url: `/api/nodes/commands/${first.id}/hide`, payload: { subscriptionId: first.subscriptions[0].id }, ...as(ceo) });
    expect(hide.statusCode).toBe(204);
    const [stored] = await db.select().from(nodeCodes).where(eq(nodeCodes.codeHash, first.id));
    expect(stored!.usedAt).toBeNull();
    expect(stored!.commandEnc).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain(first.command);
    const commands = (await app.inject({ url: '/api/nodes/commands', ...as(ceo) })).json().commands;
    expect(commands[0]).toMatchObject({ command: first.command, dismissedSubscriptionIds: [first.subscriptions[0].id] });
    expect((await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: codeOf(first.command), ...MACHINE } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/nodes/commands', ...as(ceo) })).json().commands).toEqual([]);
  });

  it('keeps another person from seeing or dismissing a command', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.test', access: { whole: true } });
    const first = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) })).json();
    expect((await app.inject({ url: '/api/nodes/commands', ...as(maria) })).json().commands).toEqual([]);
    expect((await app.inject({ method: 'POST', url: `/api/nodes/commands/${first.id}/hide`, ...as(maria) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(maria) })).statusCode).toBe(201);
  });

  it('allows replacement after expiry but not after Done', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const first = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['kimi'] }, ...as(ceo) })).json();
    const url = `/api/subscriptions/${first.subscriptions[0].id}/command`;
    await app.inject({ method: 'POST', url: `/api/nodes/commands/${first.id}/hide`, ...as(ceo) });
    expect((await app.inject({ method: 'POST', url, ...as(ceo) })).statusCode).toBe(409);
    await db.update(nodeCodes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(nodeCodes.codeHash, first.id));
    expect((await app.inject({ method: 'POST', url, ...as(ceo) })).statusCode).toBe(201);
  });

  it('ends the command of a removed plan, so the plan connects again with a new one', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const first = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) })).json();
    expect((await app.inject({ method: 'DELETE', url: `/api/subscriptions/${first.subscriptions[0].id}`, ...as(ceo) })).statusCode).toBe(204);
    const again = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) });
    expect(again.statusCode).toBe(201);
    expect((await app.inject({ url: '/api/nodes/commands', ...as(ceo) })).json().commands.map((c: { command: string }) => c.command)).toEqual([again.json().command]);
    expect((await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: codeOf(first.command), ...MACHINE } })).statusCode).toBe(410);
  });

  it('ends the waiting command of a plan removed before its commands went with it, when the plan connects again', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const first = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) })).json();
    await db.update(subscriptions).set({ removedAt: new Date() }).where(eq(subscriptions.id, first.subscriptions[0].id));
    const again = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) });
    expect(again.statusCode).toBe(201);
    expect((await app.inject({ url: '/api/nodes/commands', ...as(ceo) })).json().commands.map((c: { command: string }) => c.command)).toEqual([again.json().command]);
  });

  it('blocks a second standalone machine command until Cancel, then rejects join by the cancelled code', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const first = (await app.inject({ method: 'POST', url: '/api/machines/command', ...as(ceo) })).json();
    const again = await app.inject({ method: 'POST', url: '/api/machines/command', ...as(ceo) });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.reason).toBe('command_active');
    expect((await app.inject({ url: '/api/nodes/commands', ...as(ceo) })).json().commands[0].command).toBe(first.command);
    await app.inject({ method: 'POST', url: `/api/nodes/commands/${first.id}/hide`, ...as(ceo) });
    expect((await app.inject({ method: 'POST', url: '/api/machines/command', ...as(ceo) })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: codeOf(first.command), ...MACHINE } })).statusCode).toBe(410);
  });

  it('blocks add-plan commands per machine, independent of standalone and plan commands, and permits replacement after Cancel', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const machineCmd = (await app.inject({ method: 'POST', url: '/api/machines/command', ...as(ceo) })).json();
    const joined = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: codeOf(machineCmd.command), ...MACHINE } })).json();
    const plans = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude', 'codex'] }, ...as(ceo) })).json().subscriptions;
    const url = `/api/machines/${joined.machine.id}/plans`;
    const first = (await app.inject({ method: 'POST', url, payload: { subscription: plans[0].id }, ...as(ceo) })).json();
    const again = await app.inject({ method: 'POST', url, payload: { subscription: plans[1].id }, ...as(ceo) });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.reason).toBe('command_active');
    expect((await app.inject({ url: '/api/nodes/commands', ...as(ceo) })).json().commands.map((c: { id: string }) => c.id)).toContain(first.id);
    await app.inject({ method: 'POST', url: `/api/nodes/commands/${first.id}/hide`, ...as(ceo) });
    expect((await app.inject({ method: 'POST', url, payload: { subscription: plans[1].id }, ...as(ceo) })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: codeOf(first.command), ...MACHINE } })).statusCode).toBe(410);
  });
});

it('serializes concurrent connects for one owner and leaves exactly one visible command and one plan', async () => {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const post = () => app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) });
  const result = await Promise.all([post(), post()]);
  expect(result.map(r => r.statusCode).sort()).toEqual([201, 409]);
  expect((await app.inject({ url: '/api/subscriptions', ...as(ceo) })).json().subscriptions.filter((s: { provider: string }) => s.provider === 'claude')).toHaveLength(1);
  expect((await app.inject({ url: '/api/nodes/commands', ...as(ceo) })).json().commands).toHaveLength(1);
  expect(await db.select().from(nodeCodes)).toHaveLength(1);
});

it.each(['plans', 'machine', 'add'])('replaces only the author\'s invisible legacy command in the same %s place', async place => {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@example.test', access: { whole: true } });
  const otherPerson = (await app.inject({ method: 'POST', url: '/api/machines/command', ...as(maria) })).json();
  const otherPlace = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['codex'] }, ...as(ceo) })).json();
  let url = '/api/machines/command';
  let payload: object | undefined;
  let first;
  if (place === 'plans') {
    first = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) })).json();
    url = `/api/subscriptions/${first.subscriptions[0].id}/command`;
  } else if (place === 'add') {
    const machineCommand = (await app.inject({ method: 'POST', url, ...as(ceo) })).json();
    const joined = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: codeOf(machineCommand.command), ...MACHINE } })).json();
    url = `/api/machines/${joined.machine.id}/plans`;
    payload = { subscription: otherPlace.subscriptions[0].id };
  }
  first ??= (await app.inject({ method: 'POST', url, payload, ...as(ceo) })).json();
  await db.update(nodeCodes).set({ commandEnc: null }).where(eq(nodeCodes.codeHash, first.id));
  const next = await app.inject({ method: 'POST', url, payload, ...as(ceo) });
  expect(next.statusCode).toBe(201);
  expect((await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: codeOf(first.command), ...MACHINE } })).statusCode).toBe(410);
  const active = (await app.inject({ url: '/api/nodes/commands', ...as(ceo) })).json().commands;
  expect(active.map((c: { id: string }) => c.id).sort()).toEqual([otherPlace.id, next.json().id].sort());
  for (const id of [otherPlace.id, otherPerson.id]) {
    expect((await db.select().from(nodeCodes).where(eq(nodeCodes.codeHash, id)))[0]!.usedAt).toBeNull();
  }
});


it('replaces an invisible personal setup command only when that same plan is renewed', async () => {
  const { app, db } = await testApp();
  const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, orchestrator: { mode: 'personal', provider: 'claude' } } });
  expect(setup.statusCode).toBe(201);
  const ceo = sessionFrom(setup);
  const first = setup.json().command;
  const [stored] = await db.select().from(nodeCodes);
  expect(stored!.commandEnc).toBeNull();
  const next = await app.inject({ method: 'POST', url: `/api/subscriptions/${stored!.subscriptionIds[0]}/command`, ...as(ceo) });
  expect(next.statusCode).toBe(201);
  expect((await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: codeOf(first), ...MACHINE } })).statusCode).toBe(410);
  expect((await app.inject({ url: '/api/nodes/commands', ...as(ceo) })).json().commands[0].command).toBe(next.json().command);
});
