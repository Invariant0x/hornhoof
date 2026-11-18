/* The company of the tests of the map's lines, with Development, its head and employees, and the built-in node online. */
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { lineState, type WorkLine } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, subscriptions } from '../src/db/schema.js';
import { workStarts } from '../src/modules/org/map-state.js';
import { createTask, startWork } from '../src/modules/tasks/engine.js';
import { agentState } from '../src/modules/conversation/queue.js';
import { as, connectNode, listen, setUpCompany, testApp, until, echelonsTurn } from './helpers.js';
import { HEAD } from './development-echelons-fixture.js';

export type Org = { serverNow: string; workLines: WorkLine[]; departments: { id: string; workLines: WorkLine[]; reworkAt: string | null }[] };

/* Development with Hana at its head, Bruno and Felix who build, and Rita who reviews; the orchestrator gives Hana the
   department's work. Everyone is on the company key. */
export async function company(env: NodeJS.ProcessEnv = {}) {
  const { app, db, config } = await testApp(env);
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV', position: 0 }).returning();
  const [sales] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'sales', roleCode: 'SAL', position: 1 }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId = dev!.id, extra: Partial<typeof agents.$inferInsert> = {}) =>
    (await db.insert(agents).values({ companyId: acme!.id, kind, name, roleKey, departmentId, model: 'claude-opus-5-5', subscriptionId: sub!.id, skills: app.ctx.templates.roles.get(roleKey)?.skills.filter(s => s.on).map(s => s.id) ?? [], ...extra }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const felix = await hire('Felix', 'worker', 'DEV-FE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  const ctx = app.ctx;
  await db.update(departments).set({ repoUrl: 'https://github.com/acme/shop.git' }).where(eq(departments.id, dev!.id));
  let commit = HEAD;
  const atCommit = (sha: string) => { commit = sha; };
  ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: commit });
  ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
  await echelonsTurn(db, acme!.id);
  const top = (await createTask(ctx, { agentId: orchestrator!.id }, { title: 'Payments', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: hana.id })).task;
  const member = async (title: string, agentId: string, reviewerAgentId = rita.id) =>
    (await createTask(ctx, { agentId: hana.id }, { title, brief: '', body: '', departmentId: dev!.id, parentId: top.id, assigneeAgentId: agentId, executor: true, small: true, paths: ['logic/totals.ts'], reviewerAgentId })).task;
  /* A turn of the agent on the task goes out, as the queue takes it: running, with the new cycle of its lines in the same
     write, and then its task at work. */
  const run = async (agentId: string, taskId: string | null, at = new Date()) => {
    const job = await db.transaction(async tx => {
      const [row] = await tx
        .insert(jobs)
        .values({ companyId: acme!.id, subscriptionId: sub!.id, agentId, taskId, kind: 'conversation', prompt: 'go', status: 'running', startedAt: at, timeoutMs: 900000 })
        .returning();
      await workStarts(tx, { id: row!.id, companyId: acme!.id, agentId, taskIds: [taskId] });
      return row!;
    });
    await startWork(ctx, job.id);
    return job;
  };
  const end = (jobId: string, status: 'done' | 'failed' = 'done') => db.update(jobs).set({ status, finishedAt: new Date() }).where(eq(jobs.id, jobId));
  const org = async (token = ceo, on: FastifyInstance = app): Promise<Org> => (await on.inject({ url: '/api/org', ...as(token) })).json();
  return { app, db, config, ctx, ceo, acme: acme!, sub: sub!, orchestrator: orchestrator!, dev: dev!, sales: sales!, hire, hana, bruno, felix, rita, top, member, run, end, org, atCommit };
}

export const allLines = (org: Org) => [...org.workLines, ...org.departments.flatMap(d => d.workLines)];
export const lineOf = (org: Org, up: string, down: string) => allLines(org).find(l => l.upstreamAgentId === up && l.downstreamAgentId === down);

/* What the browser draws for the line at the time the server gave. */
export function stateOf(org: Org, up: { id: string }, down: { id: string }): string {
  const line = lineOf(org, up.id, down.id);
  if (!line) return 'none';
  return lineState({ working: line.working, workEpoch: line.workEpoch, returnedEpoch: line.returnedEpoch, returnedAt: line.returnedAt ? Date.parse(line.returnedAt) : null }, Date.parse(org.serverNow));
}

export const NODE_KEY = 'k'.repeat(40);

/* The company with the built-in node online, so its agents can run, and a tool client for one agent's running turn. */
export async function online() {
  const c = await company({ NODE_KEY });
  const url = await listen(c.app);
  const builtin = await connectNode(url, NODE_KEY);
  onTestFinished(() => builtin.close());
  builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [] });
  await until(async () => (await agentState(c.app.ctx, c.hana.id)).ready);
  const tools = async (agentId: string, taskId: string | null = null) => {
    const token = `tool-token-${agentId}`;
    const job = await c.db.transaction(async tx => {
      const [row] = await tx
        .insert(jobs)
        .values({ companyId: c.acme.id, subscriptionId: c.sub.id, agentId, taskId, kind: 'conversation', prompt: 'go', status: 'running', startedAt: new Date(), timeoutMs: 900000, toolTokenHash: hashToken(token) })
        .returning();
      await workStarts(tx, { id: row!.id, companyId: c.acme.id, agentId, taskIds: [taskId] });
      return row!;
    });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(c.app.server.address() as AddressInfo).port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    onTestFinished(() => client.close());
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { job, call };
  };
  return { ...c, tools, builtin };
}
