import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, jobs, subscriptions, toolCalls } from '../src/db/schema.js';
import { writeKeeperState, type Mode } from '../src/modules/keeper/state.js';
import { callName, CUT_OFF, READ_TOOLS } from '../src/modules/tools/read-tools.js';
import { listen, setUpCompany, testApp, TUNNEL, until } from './helpers.js';

type Said = { isError?: boolean; content: { type: string; text: string }[] };
const TOKEN = 'tool-token-of-the-orchestrator-0123456789abcdef';

/* A company whose app runs behind a keeper the test speaks for, with a turn of the orchestrator running and its tools
   as that turn reaches them. It leads while it is set up, and the test says what it does after. */
async function stand() {
  const dir = mkdtempSync(join(tmpdir(), 'hh-control-'));
  const { app, db } = await testApp({ HORNHOOF_KEEPER: 'on', HORNHOOF_CONTROL_DIR: dir, TUNNEL_HOST: TUNNEL });
  const modeNow = async () => (await app.inject({ url: '/api/health' })).json().mode;
  const say = async (mode: Mode, more: { internet?: boolean } = {}) => {
    writeKeeperState(dir, { mode, at: new Date().toISOString(), link: null, ...more });
    await until(async () => (await modeNow()) === mode);
  };
  await say('lead');
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [job] = await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: orchestrator!.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900_000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(TOKEN) }).returning();
  await listen(app);
  const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
  /* The tools as the turn's program reaches them; headers: what front and the keeper would add to a call. */
  const tools = async (headers: Record<string, string> = {}) => {
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}`, ...headers } } }));
    onTestFinished(() => client.close());
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Said;
  return { app, db, dir, say, tools, call, job: job! };
}

describe('the tools of an agent on a machine that only reads', () => {
  it('lists the same tools in every mode, and answers the ones that read', async () => {
    const s = await stand();
    const leading = (await (await s.tools()).listTools()).tools.map(tool => tool.name).sort();
    await s.say('read');
    const reading = await s.tools();
    expect((await reading.listTools()).tools.map(tool => tool.name).sort()).toEqual(leading);
    /* The orchestrator's own read tools are among them; the employees' ones come with an employee's turn. */
    for (const name of ['company', 'staffing_options', 'tasks', 'task', 'turns', 'improvements', 'database', 'view', 'pool']) {
      expect(leading, name).toContain(name);
      expect(READ_TOOLS.has(name), name).toBe(true);
    }
    expect(READ_TOOLS.has('computer_result')).toBe(false);
    const tasks = await s.call(reading, 'tasks');
    expect(tasks.isError).toBeFalsy();
    expect(JSON.parse(tasks.content[0]!.text)).toEqual([]);
    const company = await s.call(reading, 'company');
    expect(company.isError).toBeFalsy();
    expect(company.content[0]!.text).toContain('Acme');
    const pool = await s.call(reading, 'pool');
    expect(pool.isError).toBeFalsy();
  });

  it('tells an agent on a machine that is cut off to wrap up, and asks one whose machine still has the internet to wait', async () => {
    const s = await stand();
    await s.say('read', { internet: false });
    const cut = await s.tools();
    const refused = await s.call(cut, 'remember', { text: 'A note.' });
    expect(refused).toEqual({ isError: true, content: [{ type: 'text', text: CUT_OFF }] });
    /* A tool that reads still answers there. */
    expect((await s.call(cut, 'tasks')).isError).toBeFalsy();
    /* With the internet the machine waits for the leader or for the CEO: the call is refused before any tool runs, so
       front tries it again. */
    await s.say('read', { internet: true });
    const waiting = await s.tools();
    await expect(s.call(waiting, 'remember', { text: 'A note.' })).rejects.toThrow(/503|only reads/);
    const raw = await s.app.inject({
      method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'remember', arguments: { text: 'A note.' } } },
    });
    expect([raw.statusCode, raw.json().error.reason]).toEqual([503, 'read_only']);
    expect((await s.call(waiting, 'tasks')).isError).toBeFalsy();
    /* Several calls in one request are not taken on a machine that only reads, and a token the machine does not know
       is one to try again, not one that is wrong: a copy may not hold yet that the turn runs. */
    const batch = await s.app.inject({
      method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json, text/event-stream' },
      payload: [{ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'remember', arguments: { text: 'A note.' } } }],
    });
    expect(batch.statusCode).toBe(400);
    const unknown = await s.app.inject({ method: 'POST', url: '/mcp', headers: { authorization: 'Bearer some-token-this-machine-does-not-know-0123456789' }, payload: { jsonrpc: '2.0', id: 9, method: 'tools/list' } });
    expect([unknown.statusCode, unknown.json().error.reason]).toEqual([503, 'read_only']);
    /* The tools that only read, though they are no part of the first list, answer too. */
    for (const name of ['backlog', 'machines']) expect((await s.call(waiting, name)).content[0]!.text, name).not.toContain('did not run');
  });

  it('writes nothing in read, with or without the id of a call', async () => {
    const s = await stand();
    await s.say('read', { internet: false });
    const before = (await s.db.select().from(jobs).where(eq(jobs.id, s.job.id)))[0];
    const stamped = await s.tools({ 'x-hornhoof-invocation': randomUUID(), 'x-hornhoof-via': 'keeper' });
    expect((await s.call(stamped, 'tasks')).isError).toBeFalsy();
    expect((await s.call(stamped, 'remember', { text: 'A note.' })).isError).toBe(true);
    expect(await s.db.select().from(toolCalls)).toEqual([]);
    expect((await s.db.select().from(jobs).where(eq(jobs.id, s.job.id)))[0]).toEqual(before);
  });

  it('lets the orchestrator read the database, and nothing more', async () => {
    const s = await stand();
    await s.say('read', { internet: false });
    const tools = await s.tools();
    const read = await s.call(tools, 'database', { sql: 'SELECT count(*) AS n FROM companies' });
    expect(read.isError).toBeFalsy();
    expect(read.content[0]!.text).toContain('1');
    const write = await s.call(tools, 'database', { sql: "UPDATE companies SET name = 'Other'" });
    expect(write.isError).toBe(true);
    expect((await s.db.select().from(companies))[0]!.name).not.toBe('Other');
  });

  it('keeps maintenance shut', async () => {
    const s = await stand();
    await s.say('maintenance');
    const refused = await s.app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${TOKEN}` }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect([refused.statusCode, refused.json().error.reason]).toEqual([503, 'maintenance']);
  });

  it("reads the call's name", () => {
    expect(callName({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_task', arguments: {} } })).toBe('update_task');
    expect(callName({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'use_tool', arguments: { name: 'tasks', arguments: {} } } })).toBe('tasks');
    expect(callName({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'use_tool', arguments: {} } })).toBe('use_tool');
    for (const body of [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, [{ method: 'tools/call', params: { name: 'x' } }], 'tools/call', null, { method: 'tools/call' }, { method: 'tools/call', params: { name: 7 } }]) {
      expect(callName(body), JSON.stringify(body)).toBeNull();
    }
  });
});
