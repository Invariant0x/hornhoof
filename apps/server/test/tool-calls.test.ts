import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { Ctx } from '../src/app.js';
import { hashToken } from '../src/crypto/tokens.js';
import type { Db } from '../src/db/client.js';
import { NotConfirmed } from '../src/db/confirm.js';
import { agents, companies, jobs, notebookNotes, people, subscriptions, toolCalls } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { listed, outsideSources } from '../src/db/sources.js';
import { READ_ONLY_MESSAGE } from '../src/modules/keeper/app-mode.js';
import { ALREADY_RAN, ANSWER_MAX, currentInvocation, guardTools, ID_TAKEN, INVOCATION, MAY_HAVE_RUN, PENDING, STARTS_FIRST, TOO_LARGE } from '../src/modules/tools/calls.js';
import { listen, ownDatabases, setLease, setUpCompany, testApp } from './helpers.js';

/* One test ends the lease, which emptying the tables does not undo. */
ownDatabases();

const TOKEN = 'tool-token-0123456789abcdef0123456789';

type Answer = { content: { type: string; text: string }[]; isError?: boolean };
const say = (text: string, isError = false): Answer => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });
const rowsOf = <T>(answer: unknown): T[] => (answer as { rows: T[] }).rows;

/* The app believes the invocation id only from the keeper's address, which the test's own requests come from here. */
async function company(env: NodeJS.ProcessEnv = { TUNNEL_HOST: 'localhost' }) {
  const { app, db } = await testApp(env);
  await listen(app);
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [sub] = await db.select().from(subscriptions);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  /* The orchestrator's turn is the CEO's, who started it without a message, so every tool works in it. */
  const aJob = async (token = TOKEN) =>
    (await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: orchestrator!.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(token), answersCeo: true, createdBy: owner!.id }).returning())[0]!;
  const job = await aJob();
  /* A call as front sends it: every try of one call carries the call's id. */
  const call = async (name: string, args: Record<string, unknown>, invocation?: string, token = TOKEN): Promise<Answer> => {
    const client = await mcp(app, token, invocation);
    return (await client.callTool({ name, arguments: args })) as Answer;
  };
  const notes = () => db.select().from(notebookNotes);
  const calls = () => db.select().from(toolCalls);
  return { app, db, job, aJob, call, notes, calls };
}

async function mcp(app: FastifyInstance, token: string, invocation?: string): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
  const headers = { Authorization: `Bearer ${token}`, ...(invocation ? { [INVOCATION]: invocation } : {}) };
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  onTestFinished(() => client.close());
  return client;
}

/* A server of the test's own with one guarded tool, called as the SDK calls a tool without arguments. */
function guarded(ctx: Pick<Ctx, 'db'>, jobId: string, name: string, handler: () => Promise<Answer>) {
  return (invocation: string | null): Promise<Answer> => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    let registered!: (extra: unknown) => Promise<Answer>;
    server.registerTool = ((_name: string, _config: unknown, cb: (extra: unknown) => Promise<Answer>) => void (registered = cb)) as never;
    guardTools(server, ctx as Ctx, { id: jobId }, invocation);
    (server.registerTool as unknown as (name: string, config: object, cb: () => Promise<Answer>) => void)(name, {}, handler);
    return registered({});
  };
}

const appliedAt = async (db: Db, source: string): Promise<number> =>
  rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from net.journal where tbl = 'applied' and key->>'source' = ${source}`))[0]!.n;

describe('a tool call with an invocation id', () => {
  it('answers a retried call from what it kept, and runs it once', async () => {
    const c = await company();
    const id = randomUUID();
    const first = await c.call('remember', { text: 'Commits are made by Ivan only.' }, id);
    const second = await c.call('remember', { text: 'Commits are made by Ivan only.' }, id.toUpperCase());
    expect(first.isError).toBeUndefined();
    expect(second).toEqual(first);
    expect(await c.notes()).toHaveLength(1);
    expect(await c.calls()).toMatchObject([{ id, jobId: c.job.id, answer: first }]);
    expect(await listed(c.db, `tool:${id}`)).toMatchObject({ first: `tool:${id}:0` });
  });

  it('runs two calls with two ids, and a call without an id as before', async () => {
    const c = await company();
    await c.call('remember', { text: 'One.' }, randomUUID());
    await c.call('remember', { text: 'One.' }, randomUUID());
    expect(await c.notes()).toHaveLength(2);
    expect(await c.calls()).toHaveLength(2);
    await c.call('remember', { text: 'One.' });
    expect(await c.notes()).toHaveLength(3);
    expect(await c.calls()).toHaveLength(2);
    expect(rowsOf(await c.db.execute(sql`select 1 from applied where base not like 'tool:%'`))).toEqual([]);
  });

  it('tells a retry that the answer was lost, and does not run it again', async () => {
    const c = await company();
    const id = randomUUID();
    await c.call('remember', { text: 'Once.' }, id);
    await c.db.delete(toolCalls);
    const before = await appliedAt(c.db, `tool:${id}:0`);
    const again = await c.call('remember', { text: 'Once.' }, id);
    expect(again).toEqual(say(ALREADY_RAN, true));
    expect(await c.notes()).toHaveLength(1);
    expect(await appliedAt(c.db, `tool:${id}:0`)).toBe(before + 1);
  });

  it('keeps answers with their job', async () => {
    const c = await company();
    const id = randomUUID();
    const other = await c.aJob('another-token-0123456789abcdef0123456789');
    await c.db.insert(toolCalls).values({ id, jobId: other.id, answer: say('Theirs.') });
    expect(await c.call('remember', { text: 'Mine.' }, id)).toEqual(say(ID_TAKEN, true));
    expect(await c.notes()).toHaveLength(0);
  });

  it('takes an invocation id from the keeper alone', async () => {
    for (const env of [{ TUNNEL_HOST: 'keeper.invalid' }, {}]) {
      const c = await company(env);
      const id = randomUUID();
      await c.call('remember', { text: 'Twice.' }, id);
      await c.call('remember', { text: 'Twice.' }, id);
      expect(await c.notes()).toHaveLength(2);
      expect(await c.calls()).toHaveLength(0);
      expect(await listed(c.db, `tool:${id}`)).toBeNull();
    }
  });

  it('takes no id that is not a uuid', async () => {
    const c = await company();
    await c.call('remember', { text: 'Twice.' }, 'again');
    await c.call('remember', { text: 'Twice.' }, 'again');
    expect(await c.notes()).toHaveLength(2);
    expect(await c.calls()).toHaveLength(0);
  });

  it('knows every tool that starts first', async () => {
    const c = await company();
    const [head] = await c.db.insert(agents).values({ companyId: c.job.companyId, kind: 'head', name: 'Hana', model: '', roleKey: 'OPS-HEAD' }).returning();
    const [sub] = await c.db.select().from(subscriptions);
    await c.db.insert(jobs).values({ companyId: c.job.companyId, subscriptionId: sub!.id, agentId: head!.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken('head-token-0123456789abcdef0123456789abc') });
    const names = new Set<string>();
    for (const token of [TOKEN, 'head-token-0123456789abcdef0123456789abc']) for (const tool of (await (await mcp(c.app, token)).listTools()).tools) names.add(tool.name);
    expect([...STARTS_FIRST].filter(name => !names.has(name))).toEqual([]);
  });
});

describe('a guarded tool', () => {
  async function standing() {
    const c = await company();
    return { ...c, ctx: { db: c.db } };
  }

  it('commits a started row before it acts, tells a retry to wait, and then gives the retry its answer', async () => {
    const c = await standing();
    const id = randomUUID();
    let finish!: (answer: Answer) => void;
    const working = new Promise<Answer>(done => (finish = done));
    let seen: unknown;
    const run = guarded(c.ctx, c.job.id, 'run_tests', async () => {
      seen = await c.calls();
      expect(currentInvocation()).toBe(id);
      return working;
    });
    const first = run(id);
    await expect.poll(() => seen).toMatchObject([{ id, jobId: c.job.id, answer: null }]);
    const startedAt = (await c.calls())[0]!.at;
    const retry = await run(id);
    expect(retry).toEqual(say(PENDING(startedAt), true));
    expect(retry.content[0]!.text).toMatch(/^This call started at \d\d:\d\d UTC and its result is not in yet\./);
    finish(say('The run is r1.'));
    expect(await first).toEqual(say('The run is r1.'));
    expect(await run(id)).toEqual(say('The run is r1.'));
  });

  it('keeps a may-have-run on a started row only', async () => {
    const c = await standing();
    const started = guarded(c.ctx, c.job.id, 'run_tests', async () => {
      throw new NotConfirmed(new Error('the connection ended'));
    });
    const id = randomUUID();
    expect(await started(id)).toEqual(say(MAY_HAVE_RUN, true));
    expect(await started(id)).toEqual(say(MAY_HAVE_RUN, true));
    expect(await c.calls()).toMatchObject([{ id, answer: say(MAY_HAVE_RUN, true) }]);

    let tries = 0;
    const plain = guarded(c.ctx, c.job.id, 'remember', async () => {
      if (tries++ === 0) throw new NotConfirmed(new Error('the connection ended'));
      return say('Noted.');
    });
    const other = randomUUID();
    expect(await plain(other)).toEqual(say(MAY_HAVE_RUN, true));
    expect(await plain(other)).toEqual(say('Noted.'));
    expect(tries).toBe(2);
  });

  it('answers a refused lease in its own words, and leaves any other failure as it was', async () => {
    const c = await standing();
    const refused = guarded(c.ctx, c.job.id, 'remember', async () => {
      throw Object.assign(new Error('This machine holds no lease now, so nothing was changed.'), { code: 'HHF01' });
    });
    expect(await refused(randomUUID())).toEqual(say(READ_ONLY_MESSAGE, true));
    const broken = guarded(c.ctx, c.job.id, 'remember', async () => {
      throw new Error('a bug');
    });
    await expect(broken(randomUUID())).rejects.toThrow('a bug');
  });

  /* The tool did its work. Telling the agent it failed would make the agent do it again, under a new id. */
  it('gives the agent the answer of a call that ran, even when the answer could not be kept', async () => {
    const c = await standing();
    const run = guarded(c.ctx, c.job.id, 'run_tests', async () => {
      await outsideSources(() => setLease(c.db, { until: '-infinity' }));
      return say('The run is r1.');
    });
    const id = randomUUID();
    expect(await run(id)).toEqual(say('The run is r1.'));
    await setLease(c.db, { until: 'infinity' });
    /* The row that said it started is still there, so the same call sent again does not run again. */
    expect((await run(id)).isError).toBe(true);
  });

  it('keeps a large answer as too large, after giving it whole the first time', async () => {
    const c = await standing();
    const large = say('x'.repeat(ANSWER_MAX + 1024));
    const run = guarded(c.ctx, c.job.id, 'view', async () => large);
    const id = randomUUID();
    expect(await run(id)).toEqual(large);
    expect(await run(id)).toEqual(say(TOO_LARGE, true));
  });

  it('runs as before without an id', async () => {
    const c = await standing();
    let runs = 0;
    const run = guarded(c.ctx, c.job.id, 'run_tests', async () => say(`Run ${++runs}.`));
    expect(await run(null)).toEqual(say('Run 1.'));
    expect(await run(null)).toEqual(say('Run 2.'));
    expect(await c.calls()).toEqual([]);
  });
});

describe('the database tool with an invocation id', () => {
  it("keeps its answer in the change's own commit, and answers a retry from it", async () => {
    const c = await company();
    const id = randomUUID();
    await c.db.insert(agents).values({ companyId: c.job.companyId, kind: 'worker', name: 'Bruno', model: '' });
    const change = { sql: `UPDATE agents SET name = name || '!' WHERE name LIKE 'Bruno%'` };
    const first = await c.call('database', change, id);
    const names = async () => (await c.db.select(only(agents, 'name')).from(agents).where(sql`${agents.name} like 'Bruno%'`)).map(row => row.name);
    expect(JSON.parse(first.content[0]!.text)).toEqual([{ rows: [], changed: 1 }]);
    expect(await c.call('database', change, id)).toEqual(first);
    expect(await names()).toEqual(['Bruno!']);
    expect(await c.calls()).toMatchObject([{ id, jobId: c.job.id, answer: first }]);
    /* The transaction that wrote each kind of row: the call's record went in with the change itself. */
    const xact = (table: string, op: string) => c.db.execute(sql`select xact from net.journal where tbl = ${table} and op = ${op} order by at`).then(answer => rowsOf<{ xact: string }>(answer).map(row => row.xact));
    expect(await xact('tool_calls', 'insert')).toEqual((await xact('agents', 'update')).slice(-1));
    expect(await listed(c.db, `tool:${id}`)).toMatchObject({ steps: 1, first: `tool:${id}:0` });
  });
});
