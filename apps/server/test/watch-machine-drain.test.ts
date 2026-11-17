import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, companies, departments, jobs, subscriptions } from '../src/db/schema.js';
import { agentState } from '../src/modules/conversation/queue.js';
import { SILENT_TURN_MS, checkSilentTurns } from '../src/modules/tasks/silent.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { connectNode, listen, mcp, setUpCompany, testApp, until } from './helpers.js';
import { BUILTIN } from './builtin.js';

const NODE_KEY = 'builtin-watch-drain-key-0123456789abcdef';
const TOKEN = 'tool-token-watch-drain-0123456789abcdef';
const headers = { authorization: `Bearer ${NODE_KEY}` };
type Row = { name: string; ready: boolean; reason: string | null; machineDrain: { state: string; turnsLeft?: number; until?: string } | null };
type Result = { content: { text: string }[]; isError?: boolean };

/* Operations with Wendy, the watchdog on her round, and its head Odin; Development with Hana and Bruno, who holds a task.
   Everyone is on the company key, so on the built-in node. */
async function company() {
  const { app, db } = await testApp({ NODE_KEY, HORNHOOF_CONTROL_DIR: mkdtempSync(join(tmpdir(), 'hh-watch-drain-')) });
  const url = await listen(app);
  await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  onTestFinished(() => builtin.close());
  builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [], terminals: true });
  const [acme] = await db.select().from(companies);
  const [sub] = await db.select().from(subscriptions);
  const [ops] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'operations', roleCode: 'OPS' }).returning();
  const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId: string, skills: string[] = []) =>
    (await db.insert(agents).values({ companyId: acme!.id, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id, skills }).returning())[0]!;
  const wendy = await hire('Wendy', 'worker', 'OPS-WATCH', ops!.id, ['ops-task-watch']);
  const odin = await hire('Odin', 'head', 'OPS-HEAD', ops!.id);
  const hana = await hire('Hana', 'head', 'DEV-HEAD', dev!.id);
  const bruno = await hire('Bruno', 'worker', 'DEV-BE', dev!.id);
  await until(async () => (await agentState(app.ctx, bruno.id)).ready);
  const [round] = await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: wendy.id, kind: 'conversation', prompt: 'round', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(TOKEN) }).returning();
  await createTask(app.ctx, { agentId: hana.id }, { title: 'Checkout API', brief: '', body: 'POST /checkout.', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true });
  const waitForUpdate = async () => (await app.inject({ method: 'POST', url: '/api/nodes/update', headers, payload: {} })).json() as { drain: { state: string } };
  return { app, db, builtin, acme: acme!, sub: sub!, wendy, odin, bruno, round: round!, waitForUpdate };
}

const agentsSeen = async (client: Client) => JSON.parse(((await client.callTool({ name: 'agents', arguments: {} })) as Result).content[0]!.text) as Row[];

describe('the Task watchdog and a machine waiting for an update', () => {
  it('sees that the machine waits, since when, and the agent as ready rather than lost', async () => {
    const f = await company();
    await f.waitForUpdate();
    const bruno = (await agentsSeen(await mcp(f.app, TOKEN))).find(a => a.name === 'Bruno')!;
    expect(bruno).toMatchObject({ ready: true, reason: null, machineDrain: { state: 'waiting', turnsLeft: 1, since: expect.any(String) } });
  });

  it('sees no wait on an agent of a machine that does not wait', async () => {
    const f = await company();
    const bruno = (await agentsSeen(await mcp(f.app, TOKEN))).find(a => a.name === 'Bruno')!;
    expect(bruno).toMatchObject({ ready: true, reason: null, machineDrain: null });
  });

  it('can still write to such an agent, whose turn then waits in line instead of being refused', async () => {
    const f = await company();
    await f.waitForUpdate();
    const said = (await (await mcp(f.app, TOKEN)).callTool({ name: 'message_employee', arguments: { employee: f.bruno.id, text: 'Report on the checkout, please.' } })) as Result;
    expect(said.isError).toBeFalsy();
    expect(said.content[0]!.text).toBe('Sent to Bruno. Its machine waits for an update, so the turn starts after it.');
    const [turn] = await f.db.select().from(jobs).where(and(eq(jobs.agentId, f.bruno.id), inArray(jobs.status, ['queued', 'running'])));
    expect(turn!.status).toBe('queued');
  });

  it('tells the sender of no wait when the words went into the turn that still runs there', async () => {
    const f = await company();
    await f.db.insert(jobs).values({ companyId: f.acme.id, subscriptionId: f.sub.id, agentId: f.bruno.id, kind: 'conversation', prompt: 'Go on', timeoutMs: 900000, status: 'running', startedAt: new Date() });
    await f.waitForUpdate();
    const sending = (await mcp(f.app, TOKEN)).callTool({ name: 'message_employee', arguments: { employee: f.bruno.id, text: 'Report on the checkout, please.' } }) as Promise<Result>;
    const typed = await f.builtin.next();
    if (typed.type !== 'agent.say') throw new Error(`Expected agent.say, got ${typed.type}`);
    f.builtin.send({ type: 'agent.said', ref: typed.ref as string, ok: true });
    expect((await sending).content[0]!.text).toBe('Sent to Bruno.');
  });

  it('tells the sender as before when the machine does not wait', async () => {
    const f = await company();
    const said = (await (await mcp(f.app, TOKEN)).callTool({ name: 'message_employee', arguments: { employee: f.bruno.id, text: 'Report on the checkout, please.' } })) as Result;
    expect(said.content[0]!.text).toBe('Sent to Bruno.');
  });

  it('still tells the sender a message did not go out when the plan is at its limit, which is no wait for an update', async () => {
    const f = await company();
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    await f.db.update(subscriptions).set({ limits: { status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt }] }, limitsUpdatedAt: new Date() }).where(eq(subscriptions.id, f.sub.id));
    const said = (await (await mcp(f.app, TOKEN)).callTool({ name: 'message_employee', arguments: { employee: f.bruno.id, text: 'Report on the checkout, please.' } })) as Result;
    expect(said.isError).toBe(true);
    expect(said.content[0]!.text).toContain('did not reach');
  });

  it('raises no alarm on a turn that waits in line for the machine', async () => {
    const f = await company();
    await f.waitForUpdate();
    const [turn] = await f.db.insert(jobs).values({ companyId: f.acme.id, subscriptionId: f.sub.id, agentId: f.bruno.id, kind: 'conversation', prompt: 'Go on', timeoutMs: 900000, status: 'queued' }).returning();
    await checkSilentTurns(f.app.ctx, new Date(Date.now() + 2 * SILENT_TURN_MS));
    const alarms = await f.db.select().from(agentEvents).where(sql`${agentEvents.data}->>'silentJob' = ${turn!.id}`);
    expect(alarms).toEqual([]);
  });

  it.each([['does not wait', false], ['waits for an update', true]])('still raises the alarm on a turn that really hangs on a machine that %s', async (_name, waits) => {
    const f = await company();
    const startedAt = new Date(Date.now() - 2 * SILENT_TURN_MS);
    const [turn] = await f.db.insert(jobs).values({ companyId: f.acme.id, subscriptionId: f.sub.id, agentId: f.bruno.id, kind: 'conversation', prompt: 'Go on', timeoutMs: 7_200_000, status: 'running', startedAt }).returning();
    if (waits) await f.waitForUpdate();
    await checkSilentTurns(f.app.ctx);
    /* Seen first at twice the quiet that raises it, the call is the one of the first doubling. */
    const alarms = await f.db.select().from(agentEvents).where(sql`${agentEvents.data}->>'silentJob' = ${`${turn!.id}:quiet:1`}`);
    expect(alarms.map(a => a.agentId)).toEqual([f.odin.id]);
    expect(alarms[0]!.data).toMatchObject({ silentReason: 'node_silent' });
  });

  it('takes a restart for the update for a wait, and the same machine gone for no such reason for a lost one', async () => {
    const f = await company();
    await f.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, f.round.id));
    expect((await f.waitForUpdate()).drain.state).toBe('restarting');
    f.builtin.close();
    await until(() => !f.app.ctx.hub.isOnline(BUILTIN));
    expect(await agentState(f.app.ctx, f.bruno.id)).toMatchObject({ ready: true, reason: null, machineDrain: { state: 'restarting' } });
  });

  it('reports a machine that goes away for no update as offline', async () => {
    const f = await company();
    f.builtin.close();
    await until(() => !f.app.ctx.hub.isOnline(BUILTIN));
    expect(await agentState(f.app.ctx, f.bruno.id)).toMatchObject({ ready: false, reason: 'machine_offline', machineDrain: null });
  });
});
