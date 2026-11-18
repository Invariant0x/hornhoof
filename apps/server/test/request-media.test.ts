import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, approvalPolicies, attachments, companies, departments, jobs, people, subscriptions, taskEvents } from '../src/db/schema.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { as, invitePerson, listen, setUpCompany, testApp } from './helpers.js';

/* The smallest bytes each format starts with, padded out like a picture. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const COMMIT = 'a'.repeat(40);

async function company() {
  const { app, db } = await testApp();
  await listen(app);
  const ceoSession = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [dev, sales] = await db
    .insert(departments)
    .values([
      { companyId, templateKey: 'development', roleCode: 'DEV', position: 1, repoUrl: 'https://github.com/acme/app.git', repoBranch: 'main' },
      { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
    ])
    .returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const fran = await hire('Fran', 'worker', 'DEV-FE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  const parent = (await createTask(app.ctx, { personId: ceo!.id }, { title: 'Icons', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: head.id })).task;
  const task = (await createTask(app.ctx, { agentId: head.id }, { title: 'Provider icons', brief: '', body: '', departmentId: dev!.id, parentId: parent.id, assigneeAgentId: fran.id, executor: true, reviewerAgentId: rita.id })).task;
  let n = 0;
  /* A running turn of the agent: its token, for uploads and for Hornhoof's tools. */
  const turn = async (agent: { id: string }) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: agent.id, kind: 'conversation', prompt: 'go', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return { token, tools: await mcp(app, token) };
  };
  const upload = (token: string | null, body: Buffer) =>
    app.inject({ method: 'POST', url: '/api/attachments', payload: body, headers: { 'content-type': 'application/octet-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  return { app, db, companyId, ceoSession, ceo: ceo!, dev: dev!, sales: sales!, head, fran, task, turn, upload };
}

async function mcp(app: FastifyInstance, token: string): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  onTestFinished(() => client.close());
  return client;
}

type Res = { content: { text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as Res;

describe('pictures, links and choices in requests', () => {
  it('takes a picture from a running turn and refuses anything else', async () => {
    const { upload, turn, fran } = await company();
    const { token } = await turn(fran);
    const ok = await upload(token, PNG);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await upload(token, JPEG)).statusCode).toBe(201);
    expect((await upload(token, Buffer.from('<svg onload="alert(1)"></svg>'))).json().error.reason).toBe('attachment_invalid');
    expect((await upload(token, Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]))).statusCode).toBe(413);
    expect((await upload(null, PNG)).statusCode).toBe(401);
    expect((await upload('tool-token-not-a-turn-0123456789abcdef', PNG)).statusCode).toBe(401);
  });

  it('refuses a picture a person sent the agent: it stays in that conversation', async () => {
    const { app, db, ceoSession, turn, fran, task } = await company();
    const { tools } = await turn(fran);
    const sent = await app.inject({ method: 'POST', url: `/api/agents/${fran.id}/pictures?name=screen.png`, payload: PNG, headers: { 'content-type': 'application/octet-stream' }, ...as(ceoSession) });
    expect(sent.statusCode).toBe(201);
    const shown = await call(tools, 'ask_person', { task: task.number, question: 'Look?', images: [sent.json().id] });
    expect(shown.isError).toBe(true);
    expect(shown.content[0]!.text).toContain('hh-attach');
    expect((await db.select().from(attachments).where(eq(attachments.id, sent.json().id)))[0]!.requestId).toBeNull();
  });

  it('shows the pictures of a question to the people who reach its task, and to nobody else', async () => {
    const { app, upload, turn, fran, task, ceoSession, sales } = await company();
    const { token, tools } = await turn(fran);
    const shot = (await upload(token, PNG)).json().id as string;
    const loose = (await upload(token, JPEG)).json().id as string;
    const asked = await call(tools, 'ask_person', { task: task.number, question: 'Do the icons read well?', images: [shot] });
    expect(asked.isError).toBeFalsy();

    const waiting = (await app.inject({ method: 'GET', url: '/api/requests', ...as(ceoSession) })).json().requests;
    expect(waiting).toMatchObject([{ kind: 'question', images: [shot], options: [], link: null }]);
    const picture = await app.inject({ method: 'GET', url: `/api/attachments/${shot}`, ...as(ceoSession) });
    expect(picture.statusCode).toBe(200);
    expect(picture.headers['content-type']).toBe('image/png');
    expect(picture.headers['x-content-type-options']).toBe('nosniff');
    expect(picture.rawPayload.equals(PNG)).toBe(true);

    /* A picture no request shows yet, a stranger and someone from another department see nothing. */
    expect((await app.inject({ method: 'GET', url: `/api/attachments/${loose}`, ...as(ceoSession) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/attachments/${shot}` })).statusCode).toBe(401);
    const seller = await invitePerson(app, ceoSession, { name: 'Sara', email: 'sara@acme.com', access: { departments: [sales.id] } });
    expect((await app.inject({ method: 'GET', url: `/api/attachments/${shot}`, ...as(seller) })).statusCode).toBe(404);
  });

  it("refuses another agent's picture and one already shown", async () => {
    const { upload, turn, fran, head, task } = await company();
    const theirs = (await upload((await turn(head)).token, PNG)).json().id as string;
    const { token, tools } = await turn(fran);
    const mine = (await upload(token, PNG)).json().id as string;
    const foreign = await call(tools, 'ask_person', { task: task.number, question: 'Look?', images: [theirs] });
    expect(foreign.isError).toBe(true);
    expect(foreign.content[0]!.text).toContain('hh-attach');
    expect((await call(tools, 'ask_person', { task: task.number, question: 'Look?', images: [mine] })).isError).toBeFalsy();
    expect((await call(tools, 'ask_person', { task: task.number, question: 'Again?', images: [mine] })).isError).toBe(true);
  });

  it('never shows a file put on a task as a picture', async () => {
    const { app, turn, fran, task } = await company();
    const { token, tools } = await turn(fran);
    const put = await app.inject({ method: 'POST', url: `/api/attachments?task=${task.number}&name=shot.png`, payload: PNG, headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` } });
    const shown = await call(tools, 'ask_person', { task: task.number, question: 'Look?', images: [put.json().id] });
    expect(shown.isError).toBe(true);
    expect(shown.content[0]!.text).toContain('is a file on a task, not a picture');
  });

  it('lets a person pick one of a few ways, and wakes the agent with the pick', async () => {
    const { app, db, upload, turn, fran, task, ceoSession } = await company();
    const { token, tools } = await turn(fran);
    const round = (await upload(token, PNG)).json().id as string;
    const square = (await upload(token, PNG)).json().id as string;
    const asked = await call(tools, 'ask_person', {
      task: task.number,
      question: 'Which icons?',
      options: [
        { label: 'Round', image: round },
        { label: 'Square', image: square },
      ],
    });
    expect(asked.isError).toBeFalsy();
    const [waiting] = (await app.inject({ method: 'GET', url: '/api/requests', ...as(ceoSession) })).json().requests;
    expect(waiting).toMatchObject({ kind: 'choice', options: [{ label: 'Round', image: round }, { label: 'Square', image: square }] });
    expect((await app.inject({ method: 'GET', url: `/api/attachments/${square}`, ...as(ceoSession) })).statusCode).toBe(200);

    expect((await app.inject({ method: 'POST', url: `/api/requests/${waiting.id}`, payload: { pick: 2 }, ...as(ceoSession) })).json().error.reason).toBe('task_invalid');
    expect((await app.inject({ method: 'POST', url: `/api/requests/${waiting.id}`, payload: { pick: 2, answer: 'Round' }, ...as(ceoSession) })).json().error.reason).toBe('task_invalid');
    const picked = await app.inject({ method: 'POST', url: `/api/requests/${waiting.id}`, payload: { pick: 1, answer: 'A bit smaller.' }, ...as(ceoSession) });
    expect(picked.json()).toMatchObject({ request: { status: 'answered' } });
    const said = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
    expect(said.find(e => e.kind === 'answered')!.text).toBe('Picked 2: Square. A bit smaller.');
    const detail = (await app.inject({ method: 'GET', url: `/api/tasks/${task.id}`, ...as(ceoSession) })).json().task;
    expect(detail.requests).toMatchObject([{ kind: 'choice', picked: 1, status: 'answered' }]);
  });

  it('refuses a choice with one way, or with a commit', async () => {
    const { turn, fran, task } = await company();
    const { tools } = await turn(fran);
    expect((await call(tools, 'ask_person', { task: task.number, question: 'Which?', options: [{ label: 'Only' }] })).isError).toBe(true);
    const both = await call(tools, 'ask_person', { task: task.number, question: 'Which?', commit: COMMIT, options: [{ label: 'A' }, { label: 'B' }] });
    expect(both.isError).toBe(true);
  });

  it('links an approval to its commit on GitHub, and keeps a link the agent gives', async () => {
    const { app, db, turn, fran, task, ceoSession } = await company();
    await db.insert(approvalPolicies).values({ companyId: task.companyId, departmentId: task.departmentId!, channel: 'commit', mode: 'every' });
    const { tools } = await turn(fran);
    await call(tools, 'ask_person', { task: task.number, question: 'Release the icons?', commit: COMMIT, link: 'https://github.com/acme/app/compare/main...task-4-icons' });
    const [waiting] = (await app.inject({ method: 'GET', url: '/api/requests', ...as(ceoSession) })).json().requests;
    expect(waiting).toMatchObject({
      kind: 'approval',
      commitUrl: `https://github.com/acme/app/commit/${COMMIT}`,
      link: 'https://github.com/acme/app/compare/main...task-4-icons',
    });
    expect((await call(tools, 'ask_person', { task: task.number, question: 'Look?', link: 'javascript:alert(1)' })).isError).toBe(true);
  });
});
