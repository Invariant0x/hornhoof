import { eq } from 'drizzle-orm';
import { agents, companies, departments, jobs, people, personAccess, sessions, subscriptions } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { hashToken } from '../src/crypto/tokens.js';
import { encryptSecret } from '../src/crypto/secrets.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { appFixture, as, listen, testApp } from './helpers.js';
import { prepareSharedDatabase } from './helpers-db.js';

await prepareSharedDatabase();

/* A company with an employee, an assistant, the orchestrator, a person who sees one department only and a person and an
   agent of another company, for the vault's people API and its tools. */
export async function vaultCompany() {
  const { app, db, config } = await testApp();
  await listen(app);
  const ready = await appFixture(app, 'vaultCompany', async () => {
    /* These tests exercise Vault, not onboarding or invitations. Seed the same access and session records directly;
       their real API flows are checked in setup/people tests and cost hundreds of unrelated queries on a cold VM. */
    const [acme] = await db.insert(companies).values({ name: 'Acme', inboxMode: 'direct' }).returning();
    const companyId = acme!.id;
    const [ceo, sam] = await db.insert(people).values([
      { companyId, name: 'Ivan', email: 'ivan@acme.test', status: 'active', scopeKind: 'company', isOwner: true },
      { companyId, name: 'Sam', email: 'sam@acme.test', status: 'active', scopeKind: 'listed' },
    ]).returning();
    const [sub] = await db.insert(subscriptions).values({ companyId, provider: 'anthropic_api', kind: 'api_key', label: 'Test plan', ownerPersonId: ceo!.id, status: 'ready', targetKind: 'company', secretEnc: encryptSecret('sk-test-vault-fixture', config.secret) }).returning();
    const [orchestrator] = await db.insert(agents).values({ companyId, kind: 'orchestrator', name: 'Orchestrator', model: '', subscriptionId: sub!.id }).returning();
    const [sales] = await db.insert(departments).values({ companyId, templateKey: 'sales', roleCode: 'SAL', position: 1 }).returning();
    const [nora, aide] = await db
      .insert(agents)
      .values([
        { companyId, kind: 'worker', name: 'Nora', roleKey: 'SAL-AE', departmentId: sales!.id, model: '', subscriptionId: sub!.id },
        { companyId, kind: 'assistant', name: 'Aide', model: '', subscriptionId: sub!.id },
      ])
      .returning();
    await db.insert(personAccess).values({ companyId, personId: sam!.id, departmentId: sales!.id });
    const ceoSession = 'vault-ceo-session-0123456789abcdef', samSession = 'vault-sam-session-0123456789abcdef';
    await db.insert(sessions).values([
      { tokenHash: hashToken(ceoSession), personId: ceo!.id, expiresAt: new Date(Date.now() + 3_600_000) },
      { tokenHash: hashToken(samSession), personId: sam!.id, expiresAt: new Date(Date.now() + 3_600_000) },
    ]);

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
    const [{ companyId: of }] = (await db.select(only(agents, 'companyId')).from(agents).where(eq(agents.id, agentId))) as [{ companyId: string }];
    const [job] = await db
      .insert(jobs)
      .values({ companyId: of, subscriptionId: sub!.id, agentId, kind: 'conversation', prompt: 'sign in', timeoutMs: 900_000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token), taskId })
      .returning();
    return { token, job: job! };
  };

  const add = async (session: string, body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/vault', payload: body, ...as(session) });

  return { app, db, config, ...ready, startTurn, add };
}
