import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, asc, eq } from 'drizzle-orm';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, people, subscriptions } from '../src/db/schema.js';
import { appendEvent } from '../src/modules/events/store.js';
import { listen, mcp, setUpCompany, testApp } from './helpers.js';

/* A company with Development, Sales and Design, their heads and one developer, and the orchestrator's tools, for the tests of turns. */
export async function company() {
  const { app, db } = await testApp();
  await listen(app);
  const ceoToken = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [dev, sales, design] = await db
    .insert(departments)
    .values([
      { companyId, templateKey: 'development', roleCode: 'DEV', position: 1 },
      { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
      { companyId, templateKey: 'design', roleCode: 'DSN', position: 3 },
    ])
    .returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD', dev!.id);
  const sara = await hire('Sara', 'head', 'SAL-HEAD', sales!.id);
  const bruno = await hire('Bruno', 'worker', 'DEV-BE', dev!.id);
  let n = 0;
  /* Hornhoof's tools as a running turn of this agent sees them. */
  const tools = async (agent: { id: string }) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: agent.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };
  /* What a person wrote to the orchestrator, as the window or his terminal stores it. A turn tells its words apart by their
     order, not by their time. */
  const say = async (text: string, personId = ceo!.id) => {
    await appendEvent(app.ctx, { companyId, agentId: orchestrator!.id, kind: 'message', data: { text }, personId });
  };
  /* A person's message to the orchestrator with the turn it makes: queued, or running with his tools. */
  const message = async (text: string, status: 'running' | 'queued' = 'running') => {
    const [job] = await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: orchestrator!.id, kind: 'conversation', prompt: `Ivan (CEO): ${text}`, timeoutMs: 900000, status: 'queued', createdBy: ceo!.id }).returning();
    await appendEvent(app.ctx, { companyId, agentId: orchestrator!.id, jobId: job!.id, kind: 'message', data: { text }, personId: ceo!.id });
    const run = async () => {
      const token = `tool-token-${++n}-0123456789abcdef0123456789`;
      await db.update(jobs).set({ status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) }).where(eq(jobs.id, job!.id));
      return mcp(app, token);
    };
    return { run, tools: status === 'running' ? await run() : null };
  };
  /* Turns queued for an agent, oldest first. */
  const queued = async (agentId: string) => db.select({ prompt: jobs.prompt, taskId: jobs.taskId }).from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.status, 'queued'))).orderBy(asc(jobs.createdAt));
  const get = (token: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie: `hh_session=${token}` } });
  return { app, db, ctx: app.ctx, companyId, ceo: ceo!, ceoToken, orchestrator: orchestrator!, dev: dev!, sales: sales!, design: design!, hana, sara, bruno, tools, say, message, queued, get };
}

export type Res = { content: { text: string }[]; isError?: boolean };
export const call = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as Res;
export const text = (r: Res) => r.content[0]!.text;
export const work = (department: string, title: string) => ({ department, title, brief: `${title}, in a line.`, body: `${title}: what to build.` });
