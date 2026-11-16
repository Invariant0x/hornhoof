import { eq } from 'drizzle-orm';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, people, subscriptions } from '../src/db/schema.js';
import { idOnly } from '../src/db/selections.js';
import { createTask } from '../src/modules/tasks/engine.js';
import type { Deps } from '../src/app.js';
import { appFixture, as, invitePerson, listen, mcp, setUpCompany, testApp } from './helpers.js';

/* A company with Development and Sales, each with a worker on a task, and Dana listed for Development, Sam for Sales and Tia
   for a team of Development only, made once in a file. */
export async function company(env: NodeJS.ProcessEnv = {}, logger?: Deps['logger']) {
  const { app, db } = await testApp(env, logger);
  await listen(app);
  const made = await appFixture(app, 'department-owner company', async () => {
    const ceoToken = await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    const companyId = acme!.id;
    const [sub] = await db.select().from(subscriptions);
    const [ceoRow] = await db.select().from(people);
    const [devDept, salesDept] = await db.insert(departments).values([{ companyId, templateKey: 'development', roleCode: 'DEV', position: 1 }, { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 }]).returning();
    const [product] = await db.insert(departments).values({ companyId, name: 'Shop', roleCode: 'DEV', parentId: devDept!.id, position: 3 }).returning();
    const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId: string) =>
      (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
    const head = await hire('Hana', 'head', 'DEV-HEAD', devDept!.id);
    const worker = await hire('Bruno', 'worker', 'DEV-BE', devDept!.id);
    const seller = await hire('Sid', 'worker', 'SAL-AE', salesDept!.id);
    const salesHead = await hire('Sue', 'head', 'SAL-HEAD', salesDept!.id);
    const danaToken = await invitePerson(app, ceoToken, { name: 'Dana', email: 'dana@acme.com', access: { departments: [devDept!.id] } });
    const samToken = await invitePerson(app, ceoToken, { name: 'Sam', email: 'sam@acme.com', access: { departments: [salesDept!.id] } });
    const wholeToken = await invitePerson(app, ceoToken, { name: 'Wes', email: 'wes@acme.com', access: { whole: true } });
    const idOf = async (email: string) => (await db.select(idOnly(people)).from(people).where(eq(people.email, email)))[0]!.id;
    const task = (await createTask(app.ctx, { agentId: head.id }, { title: 'Checkout', brief: '', body: '', departmentId: devDept!.id, assigneeAgentId: worker.id, executor: true, resultKind: 'code' })).task;
    const salesTask = (await createTask(app.ctx, { agentId: salesHead.id }, { title: 'Deal', brief: '', body: '', departmentId: salesDept!.id, assigneeAgentId: seller.id, executor: true })).task;
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    return {
      companyId, subId: sub!.id, ceoToken, danaToken, samToken, wholeToken, head, worker, seller, salesHead, orchestrator: orchestrator!, task, salesTask,
      dev: devDept!, sales: salesDept!, product: product!,
      ids: { ceo: ceoRow!.id, dana: await idOf('dana@acme.com'), sam: await idOf('sam@acme.com'), wes: await idOf('wes@acme.com') },
    };
  });
  const { companyId, subId, ...rows } = made;
  const setOwner = (token: string, departmentId: string, personId: string | null) => app.inject({ method: 'PUT', url: `/api/departments/${departmentId}/owner`, payload: { personId }, ...as(token) });
  const setRule = (token: string, departmentId: string, channel: string, rule: object) => app.inject({ method: 'PUT', url: `/api/departments/${departmentId}/approval-policy/${channel}`, payload: rule, ...as(token) });
  const policy = (token: string, departmentId: string) => app.inject({ method: 'GET', url: `/api/departments/${departmentId}/approval-policy`, ...as(token) });
  let n = 0;
  /* Hornhoof's tools as a running turn of this agent sees them. createdBy: the person the turn answers. */
  const tools = async (agent: { id: string }, createdBy: string | null = null) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    await db.insert(jobs).values({ companyId, subscriptionId: subId, agentId: agent.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token), createdBy, answersCeo: createdBy !== null });
    return mcp(app, token);
  };
  return { app, db, companyId, ...rows, setOwner, setRule, policy, tools };
}
