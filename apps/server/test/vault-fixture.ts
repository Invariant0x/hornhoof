import { eq } from 'drizzle-orm';
import { agents, companies, departments, jobs, people, sessions, subscriptions } from '../src/db/schema.js';
import { hashToken } from '../src/crypto/tokens.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { as, invitePerson, listen, setUpCompany, testApp } from './helpers.js';

/* A company with two departments, an employee in each, an assistant, a person of each department and a person of another
   company, for the vault's people API and its tools. */
export async function vaultCompany(logger?: Parameters<typeof testApp>[1]) {
  const { app, db, config } = await testApp({}, logger);
  /* The tools are reached over MCP, which needs the server listening. */
  await listen(app);
  const ceoSession = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people).where(eq(people.isOwner, true));
  const [sub] = await db.select().from(subscriptions);
  const [mkt, sales] = await db
    .insert(departments)
    .values([
      { companyId, templateKey: 'marketing', roleCode: 'MKT', position: 1 },
      { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
    ])
    .returning();
  const [nora, sammy, aide] = await db
    .insert(agents)
    .values([
      { companyId, kind: 'worker', name: 'Nora', roleKey: 'MKT-SEO', departmentId: mkt!.id, model: '', subscriptionId: sub!.id },
      { companyId, kind: 'worker', name: 'Sammy', roleKey: 'SAL-AE', departmentId: sales!.id, model: '', subscriptionId: sub!.id },
      { companyId, kind: 'assistant', name: 'Aide', model: '', subscriptionId: sub!.id },
    ])
    .returning();
  const claraSession = await invitePerson(app, ceoSession, { name: 'Clara', email: 'clara@acme.test', access: { departments: [mkt!.id] } });
  const samSession = await invitePerson(app, ceoSession, { name: 'Sam', email: 'sam@acme.test', access: { departments: [sales!.id] } });
  const [clara] = await db.select().from(people).where(eq(people.email, 'clara@acme.test'));

  const [other] = await db.insert(companies).values({ name: 'Other company', singleton: false }).returning();
  const [olaf] = await db.insert(people).values({ companyId: other!.id, name: 'Olaf', email: 'olaf@other.test', status: 'active', scopeKind: 'company', isOwner: false }).returning();
  const olafSession = 'olaf-session-token-0123456789abcdef';
  await db.insert(sessions).values({ tokenHash: hashToken(olafSession), personId: olaf!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  const [otherAgent] = await db.insert(agents).values({ companyId: other!.id, kind: 'worker', name: 'Otto', roleKey: 'OPS-X', model: '' }).returning();

  const task = (
    await createTask(app.ctx, { agentId: nora!.id }, { title: 'Sign in to the partner site', brief: 'Sign in', body: 'Sign in with the vault.', departmentId: mkt!.id, assigneeAgentId: nora!.id, executor: true })
  ).task;

  let seq = 0;
  const startTurn = async (agentId: string, taskId: string | null = null) => {
    const token = `vault-tool-token-${++seq}-0123456789abcdef`;
    const [job] = await db
      .insert(jobs)
      .values({ companyId, subscriptionId: sub!.id, agentId, kind: 'conversation', prompt: 'sign in', timeoutMs: 900_000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token), taskId })
      .returning();
    return { token, job: job! };
  };

  const add = async (session: string, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/vault', payload: { scope: { kind: 'company' }, ...body }, ...as(session) });

  return { app, db, config, companyId, ceo: ceo!, ceoSession, clara: clara!, claraSession, samSession, olaf: olaf!, olafSession, other: other!, otherAgent: otherAgent!, mkt: mkt!, sales: sales!, nora: nora!, sammy: sammy!, aide: aide!, task, startTurn, add };
}
