import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ServerMessage } from '@hornhoof/protocol';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, companies, departments, jobs, subscriptions, taskEvents, tasks } from '../src/db/schema.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { agentState } from '../src/modules/conversation/queue.js';
import { connectNode, listen, mcp, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);
const LOOK = 'Final look check of the checkout screen';

type Result = { content: { text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;

/* Development with Hana at its head and Bruno, who holds a screen task; Design with Dana at its head, who checks the final
   look of screens; Marketing with Mona at its head, who has nothing to do with it. Each of them runs a turn with its tools. */
async function company() {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  onTestFinished(() => builtin.close());
  builtin.ws.on('message', data => {
    const message = JSON.parse(String(data)) as ServerMessage;
    if (message.type === 'agent.say') builtin.send({ type: 'agent.said', ref: message.ref, ok: true });
  });
  builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [], terminals: true });
  const [acme] = await db.select().from(companies);
  const [sub] = await db.select().from(subscriptions);
  const [dev, design, marketing] = await db.insert(departments).values([
    { companyId: acme!.id, templateKey: 'development', roleCode: 'DEV', position: 1 },
    { companyId: acme!.id, templateKey: 'design', roleCode: 'DES', position: 2 },
    { companyId: acme!.id, templateKey: 'marketing', roleCode: 'MKT', position: 3 },
  ]).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId: string) =>
    (await db.insert(agents).values({ companyId: acme!.id, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD', dev!.id);
  const bruno = await hire('Bruno', 'worker', 'DEV-FE', dev!.id);
  const dana = await hire('Dana', 'head', 'DES-HEAD', design!.id);
  const mona = await hire('Mona', 'head', 'MKT-HEAD', marketing!.id);
  await until(async () => (await agentState(app.ctx, dana.id)).ready);
  let n = 0;
  /* A running turn of the agent, and its tools. */
  const turn = async (agent: { id: string }) => {
    const token = `tool-token-look-${++n}-0123456789abcdef0123`;
    await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: agent.id, kind: 'conversation', prompt: 'go', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return { token, client: await mcp(app, token) };
  };
  const task = (await createTask(app.ctx, { agentId: hana.id }, { title: 'Checkout screen', brief: '', body: 'The checkout screen on the design system.', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true })).task;
  const asBruno = await turn(bruno);
  const asDana = await turn(dana);
  const asMona = await turn(mona);
  const attach = (token: string, name: string, body: string) =>
    app.inject({ method: 'POST', url: `/api/attachments?task=${task.number}&name=${name}`, payload: Buffer.from(body), headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` } });
  const fetchFile = (token: string, name: string) => app.inject({ method: 'GET', url: `/api/attachments/file?task=${task.number}&file=${name}`, headers: { authorization: `Bearer ${token}` } });
  /* Bruno asks Dana for the look check by naming her on the work he tracks. */
  const askLook = (employee = dana.id) => call(asBruno.client, 'track_work', { task: task.number, work: LOOK, nextCheck: new Date(Date.now() + 3_600_000).toISOString(), employee });
  const state = async () => (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!;
  return { app, db, dev: dev!, hana, bruno, dana, mona, task, asBruno, asDana, asMona, attach, fetchFile, askLook, state };
}

const unknown = (number: number) => `There is no task ${number} you can see. Call tasks for yours.`;

describe('a head of another department named to check the look of a task', () => {
  it('reads the task and its file, and gives the verdict as a comment that wakes its holder', async () => {
    const c = await company();
    expect((await c.attach(c.asBruno.token, 'checkout-100.png', 'screenshot')).statusCode).toBe(201);
    expect((await c.askLook()).isError).toBeFalsy();
    const read = await call(c.asDana.client, 'task', { task: c.task.number });
    expect(read.isError).toBeFalsy();
    const detail = JSON.parse(read.content[0]!.text) as { number: number; body: string; files: { name: string }[] };
    expect(detail.number).toBe(c.task.number);
    expect(detail.body).toBe('The checkout screen on the design system.');
    expect(detail.files.map(f => f.name)).toContain('checkout-100.png');
    const file = await c.fetchFile(c.asDana.token, 'checkout-100.png');
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe('screenshot');
    const verdict = await call(c.asDana.client, 'comment', { task: c.task.number, text: 'Look check: passed at 100% and zoomed in.' });
    expect(verdict.content[0]!.text).toBe(`Noted on #${c.task.number}. It is open again, and its executor goes on with your answer.`);
    const said = await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.task.id), eq(taskEvents.kind, 'comment')));
    expect(said.map(e => [e.text, e.agentId])).toEqual([['Look check: passed at 100% and zoomed in.', c.dana.id]]);
    expect((await c.state()).externalWait).toBeNull();
  });

  it('reads it with no credential and no private path in its words, as a company watchdog does', async () => {
    const c = await company();
    const token = 'ghp_' + 'syntheticLookToken00'.repeat(3);
    const home = '/home/fixture805/private-project/.env';
    await c.db.update(tasks).set({ body: `Built with ${token} from ${home} today.` }).where(eq(tasks.id, c.task.id));
    await c.askLook();
    const read = await call(c.asDana.client, 'task', { task: c.task.number });
    const words = (value: unknown): string[] => (typeof value === 'string' ? [value] : value !== null && typeof value === 'object' ? Object.values(value).flatMap(words) : []);
    const said = words(JSON.parse(read.content[0]!.text));
    for (const one of said) for (const secret of [token, home, 'fixture805']) expect(one).not.toContain(secret);
    expect((JSON.parse(read.content[0]!.text) as { body: string }).body).toBe('Built with [hidden] from [hidden] today.');
  });

  it('cannot change, move, pause or close the task', async () => {
    const c = await company();
    await c.askLook();
    const before = await c.state();
    const tries: [string, Record<string, unknown>][] = [
      ['update_task', { task: c.task.number, body: 'Rewritten by Design.' }],
      ['cancel_task', { task: c.task.number, why: 'Design does not like it.' }],
      ['pause_task', { task: c.task.number, why: 'Wait for Design.' }],
      ['report', { task: c.task.number, done: true, summary: 'Looks fine.' }],
      ['blocked', { task: c.task.number, why: 'Design blocks it.' }],
      ['track_work', { task: c.task.number, work: 'Redraw', nextCheck: new Date(Date.now() + 3_600_000).toISOString() }],
    ];
    for (const [name, args] of tries) {
      const refused = await call(c.asDana.client, name, args);
      expect(refused.isError, name).toBe(true);
    }
    const after = await c.state();
    expect({ status: after.status, body: after.body, paused: after.paused, assignee: after.assigneeAgentId, version: after.version })
      .toEqual({ status: before.status, body: before.body, paused: before.paused, assignee: before.assigneeAgentId, version: before.version });
  });

  it('is the only head outside the department that reads it, and only while the check is asked', async () => {
    const c = await company();
    expect((await call(c.asDana.client, 'task', { task: c.task.number })).content[0]!.text).toBe(unknown(c.task.number));
    expect((await call(c.asDana.client, 'comment', { task: c.task.number, text: 'Unasked.' })).isError).toBe(true);
    await c.askLook();
    expect((await call(c.asMona.client, 'task', { task: c.task.number })).content[0]!.text).toBe(unknown(c.task.number));
    expect((await call(c.asMona.client, 'comment', { task: c.task.number, text: 'Me too.' })).isError).toBe(true);
    /* The verdict ends the asked check, and with it the sight of the task. */
    await call(c.asDana.client, 'comment', { task: c.task.number, text: 'Passed.' });
    expect((await call(c.asDana.client, 'task', { task: c.task.number })).content[0]!.text).toBe(unknown(c.task.number));
  });

  it("is not opened on a closed task, nor on one a person's own assistant is part of", async () => {
    const c = await company();
    await c.askLook();
    const wait = (await c.state()).externalWait;
    await c.db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.id, c.task.id));
    expect((await call(c.asDana.client, 'task', { task: c.task.number })).content[0]!.text).toBe(unknown(c.task.number));
    expect((await call(c.asDana.client, 'comment', { task: c.task.number, text: 'Late verdict.' })).isError).toBe(true);
    const [ava] = await c.db.insert(agents).values({ companyId: c.dana.companyId, kind: 'assistant', name: 'Ava', model: '' }).returning();
    await c.db.update(tasks).set({ status: 'working', closedAt: null, externalWait: wait, createdByAgentId: ava!.id }).where(eq(tasks.id, c.task.id));
    expect((await call(c.asDana.client, 'task', { task: c.task.number })).content[0]!.text).toBe(unknown(c.task.number));
    expect((await call(c.asDana.client, 'comment', { task: c.task.number, text: 'Private.' })).isError).toBe(true);
    expect((await call(c.asBruno.client, 'message_employee', { employee: c.dana.id, task: c.task.number, text: 'Look?' })).content[0]!.text).toContain('other_department');
  });

  it('is not opened to a worker of another department named on the work', async () => {
    const c = await company();
    const [design] = await c.db.select().from(departments).where(eq(departments.templateKey, 'design'));
    const [devon] = await c.db.insert(agents).values({ companyId: c.dana.companyId, kind: 'worker', name: 'Devon', roleKey: 'DES-UI', departmentId: design!.id, model: '', subscriptionId: c.dana.subscriptionId }).returning();
    await until(async () => (await agentState(c.app.ctx, devon!.id)).ready);
    expect((await c.askLook(devon!.id)).isError).toBeFalsy();
    const token = 'tool-token-look-devon-0123456789abcdef';
    await c.db.insert(jobs).values({ companyId: c.dana.companyId, subscriptionId: c.dana.subscriptionId!, agentId: devon!.id, kind: 'conversation', prompt: 'go', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    expect((await call(await mcp(c.app, token), 'task', { task: c.task.number })).content[0]!.text).toBe(unknown(c.task.number));
  });

  it('gets the holder\'s message about that task, though it works in another department', async () => {
    const c = await company();
    await c.askLook();
    const sent = await call(c.asBruno.client, 'message_employee', { employee: c.dana.id, task: c.task.number, text: 'The screenshots are on the task: checkout-100.png.' });
    expect(sent.content[0]!.text).not.toContain('other_department');
    expect(sent.isError).toBeFalsy();
    const got = await c.db.select({ text: sql<string>`${agentEvents.data}->>'text'` }).from(agentEvents)
      .where(and(eq(agentEvents.agentId, c.dana.id), eq(agentEvents.kind, 'message'), sql`${agentEvents.data}->>'by' = ${c.bruno.id}`));
    expect(got.map(g => g.text)).toEqual(['The screenshots are on the task: checkout-100.png.']);
    /* Only about the task she checks, and only her: a word without the task, or to another head, stays refused. */
    expect((await call(c.asBruno.client, 'message_employee', { employee: c.dana.id, text: 'Lunch?' })).content[0]!.text).toContain('other_department');
    expect((await call(c.asBruno.client, 'message_employee', { employee: c.mona.id, task: c.task.number, text: 'Look too?' })).content[0]!.text).toContain('other_department');
  });
});
