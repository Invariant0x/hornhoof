import { eq } from 'drizzle-orm';
import { agents, companies, departments, jobs, people, sessions, subscriptions } from '../src/db/schema.js';
import { hashToken } from '../src/crypto/tokens.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { appFixture, as, invitePerson, listen, setUpCompany, testApp } from './helpers.js';

/* A company with an employee, an assistant, the orchestrator, a person who sees one department only and a person and an
   agent of another company, for the vault's people API and its tools. */
export async function vaultCompany() {
  const { app, db, config } = await testApp();
  await listen(app);
  const ready = await appFixture(app, 'vaultCompany', async () => {
    const ceoSession = await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    const companyId = acme!.id;
    const [ceo] = await db.select().from(people).where(eq(people.isOwner, true));
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const [sub] = await db.select().from(subscriptions);
    const [sales] = await db.insert(departments).values({ companyId, templateKey: 'sales', roleCode: 'SAL', position: 1 }).returning();
    const [nora, aide] = await db
      .insert(agents)
      .values([
        { companyId, kind: 'worker', name: 'Nora', roleKey: 'SAL-AE', departmentId: sales!.id, model: '', subscriptionId: sub!.id },
        { companyId, kind: 'assistant', name: 'Aide', model: '', subscriptionId: sub!.id },
      ])
      .returning();
    const samSession = await invitePerson(app, ceoSession, { name: 'Sam', email: 'sam@acme.test', access: { departments: [sales!.id] } });
    const [sam] = await db.select().from(people).where(eq(people.email, 'sam@acme.test'));

    const [other] = await db.insert(companies).values({ name: 'Other company', singleton: false }).returning();
    const [olaf] = await db.insert(people).values({ companyId: other!.id, name: 'Olaf', email: 'olaf@other.test', status: 'active', scopeKind: 'company', isOwner: false }).returning();
    const olafSession = 'olaf-session-token-0123456789abcdef';
    await db.insert(sessions).values({ tokenHash: hashToken(olafSession), personId: olaf!.id, expiresAt: new Date(Date.now() + 3_600_000) });
    const [otto] = await db.insert(agents).values({ companyId: other!.id, kind: 'worker', name: 'Otto', roleKey: 'OPS-X', model: '', subscriptionId: sub!.id }).returning();

    const task = (
      await createTask(app.ctx, { agentId: nora!.id }, { title: 'Sign in to the partner site', brief: 'Sign in', body: 'Sign in with the vault.', departmentId: sales!.id, assigneeAgentId: nora!.id, executor: true })
    ).task;
    return { companyId, ceo: ceo!, ceoSession, sam: sam!, samSession, olaf: olaf!, olafSession, other: other!, otto: otto!, orchestrator: orchestrator!, nora: nora!, aide: aide!, task, sub: sub! };
  });
  const { sub } = ready;

  let seq = 0;
  /* A running turn of the agent and the token its program calls the tools with. */
  const startTurn = async (agentId: string, taskId: string | null = null) => {
    const token = `vault-tool-token-${++seq}-0123456789abcdef`;
    const [{ companyId: of }] = (await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId))) as [{ companyId: string }];
    const [job] = await db
      .insert(jobs)
      .values({ companyId: of, subscriptionId: sub!.id, agentId, kind: 'conversation', prompt: 'sign in', timeoutMs: 900_000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token), taskId })
      .returning();
    return { token, job: job! };
  };

  const add = async (session: string, body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/vault', payload: body, ...as(session) });

  return { app, db, config, ...ready, startTurn, add };
}
