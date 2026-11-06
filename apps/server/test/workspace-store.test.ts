import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, jobs, machines, nodes, people, subscriptions, tasks, taskWorkspaces, workspaceRepositories } from '../src/db/schema.js';
import { readJobWorkspaceRepository, registerJobWorkspaceRepository, type WorkspaceJobAuthority, type WorkspaceRepositoryIdentity } from '../src/db/workspace-store.js';
import { createTestDb } from './helpers-db.js';

async function fixture() {
  const db = await createTestDb();
  const [company] = await db.insert(companies).values({ name: 'Workspace company' }).returning();
  const companyId = company!.id;
  const [owner] = await db.insert(people).values({ companyId, name: 'Repository owner', email: 'owner@example.test', status: 'active', scopeKind: 'company' }).returning();
  const [subscription] = await db.insert(subscriptions).values({ companyId, provider: 'claude', kind: 'personal', label: 'Plan', ownerPersonId: owner!.id, status: 'ready' }).returning();
  const [department] = await db.insert(departments).values({ companyId, roleCode: 'DEV', repoUrl: 'https://git.example/team/project.git', repoTokenEnc: 'encrypted-test-value', repoTokenRevision: 7 }).returning();
  const [agent] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Author', model: '', departmentId: department!.id }).returning();
  const [task] = await db.insert(tasks).values({ companyId, number: 1, title: 'Current task', status: 'working', departmentId: department!.id, assigneeAgentId: agent!.id, executorAgentId: agent!.id, assignmentEpoch: 3 }).returning();
  const [job] = await db.insert(jobs).values({ companyId, subscriptionId: subscription!.id, agentId: agent!.id, taskId: task!.id, kind: 'conversation', status: 'running', assignmentEpoch: 3, prompt: 'Current work', timeoutMs: 1000 }).returning();
  const authority: WorkspaceJobAuthority = { companyId, jobId: job!.id, agentId: agent!.id, node: { kind: 'builtin' }, assignmentEpoch: 3 };
  const register = (who = authority) => db.transaction(tx => registerJobWorkspaceRepository(tx, who));
  const read = (id: string, who = authority) => db.transaction(tx => readJobWorkspaceRepository(tx, who, id));
  return { db, companyId, owner: owner!, department: department!, agent: agent!, task: task!, job: job!, authority, register, read };
}

async function registered(c: Awaited<ReturnType<typeof fixture>>): Promise<WorkspaceRepositoryIdentity> {
  const found = await c.register();
  expect(found).toHaveProperty('repositoryId');
  if ('code' in found) throw new Error(found.code);
  return found;
}

describe('job-bound private repository registry', () => {
  it('registers the configured canonical identity once without storing or returning credentials', async () => {
    const c = await fixture(), first = await registered(c);
    expect(first).toEqual({ repositoryId: expect.any(String), canonicalUrl: 'https://git.example/team/project', credentialScopeId: c.department.id, credentialRevision: 7 });
    expect(await c.register()).toEqual(first);
    const rows = await c.db.select().from(workspaceRepositories);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify({ rows, first })).not.toContain('encrypted-test-value');
    expect(await c.db.select().from(taskWorkspaces)).toEqual([]);
  });

  it('uses the product repository first, sharing identity across aliases but keeping its actual credential scope', async () => {
    const c = await fixture(), first = await registered(c);
    const [product] = await c.db.insert(departments).values({ companyId: c.companyId, parentId: c.department.id, roleCode: 'PRODUCT', repoUrl: 'https://GIT.example/team/project/', repoTokenRevision: 11 }).returning();
    await c.db.update(tasks).set({ productId: product!.id }).where(eq(tasks.id, c.task.id));
    expect(await c.register()).toEqual({ ...first, credentialScopeId: product!.id, credentialRevision: 11 });
    expect(await c.db.select().from(workspaceRepositories)).toHaveLength(1);
  });

  it('falls back to the department only when the product has no repository', async () => {
    const c = await fixture(), first = await registered(c);
    const [product] = await c.db.insert(departments).values({ companyId: c.companyId, parentId: c.department.id, roleCode: 'PRODUCT' }).returning();
    await c.db.update(tasks).set({ productId: product!.id }).where(eq(tasks.id, c.task.id));
    expect(await c.register()).toEqual(first);
  });

  it('refuses an invalid configured product URL instead of falling back to another repository', async () => {
    const c = await fixture();
    const [product] = await c.db.insert(departments).values({ companyId: c.companyId, parentId: c.department.id, roleCode: 'PRODUCT', repoUrl: 'ssh://git.example/team/project' }).returning();
    await c.db.update(tasks).set({ productId: product!.id }).where(eq(tasks.id, c.task.id));
    expect(await c.register()).toEqual({ code: 'wrong_repository', retryable: false });
    expect(await c.db.select().from(workspaceRepositories)).toEqual([]);
  });

  it('keeps different remotes with the same basename separate and rejects an old mapping', async () => {
    const c = await fixture(), first = await registered(c);
    await c.db.update(departments).set({ repoUrl: 'https://other.example/team/project.git' }).where(eq(departments.id, c.department.id));
    expect(await c.read(first.repositoryId)).toEqual({ code: 'wrong_repository', retryable: false });
    const next = await registered(c);
    expect(next.repositoryId).not.toBe(first.repositoryId);
    expect((await c.db.select().from(workspaceRepositories)).map(row => row.canonicalUrl).sort()).toEqual(['https://git.example/team/project', 'https://other.example/team/project']);
  });

  it('reads only an already registered current identity and captures the server credential revision again', async () => {
    const c = await fixture();
    expect(await c.read(randomUUID())).toEqual({ code: 'wrong_repository', retryable: false });
    expect(await c.db.select().from(workspaceRepositories)).toEqual([]);
    const first = await registered(c);
    await c.db.update(departments).set({ repoTokenRevision: 8, repoTokenEnc: null }).where(eq(departments.id, c.department.id));
    expect(await c.read(first.repositoryId)).toEqual({ ...first, credentialRevision: 8 });
  });

  it.each(['company', 'agent', 'epoch', 'node', 'job'] as const)('refuses forged or stale %s context without registering anything', async field => {
    const c = await fixture();
    const changes: Partial<WorkspaceJobAuthority> = field === 'company' ? { companyId: randomUUID() }
      : field === 'agent' ? { agentId: randomUUID() }
      : field === 'epoch' ? { assignmentEpoch: 2 }
      : field === 'node' ? { node: { kind: 'node', nodeId: randomUUID() } } : { jobId: randomUUID() };
    expect(await c.register({ ...c.authority, ...changes })).toEqual({ code: 'binding_stale', retryable: false });
    expect(await c.db.select().from(workspaceRepositories)).toEqual([]);
  });

  it.each(['queued', 'done', 'failed', 'obsolete'] as const)('does not turn a %s job into current repository authority', async status => {
    const c = await fixture();
    await c.db.update(jobs).set({ status }).where(eq(jobs.id, c.job.id));
    expect(await c.register()).toEqual({ code: 'binding_stale', retryable: false });
    expect(await c.db.select().from(workspaceRepositories)).toEqual([]);
  });

  it.each(['task epoch', 'job epoch', 'task owner', 'executor', 'removed author', 'closed task'] as const)('rejects changed %s even with the original authenticated job context', async field => {
    const c = await fixture();
    if (field === 'task epoch') await c.db.update(tasks).set({ assignmentEpoch: 4 }).where(eq(tasks.id, c.task.id));
    if (field === 'job epoch') await c.db.update(jobs).set({ assignmentEpoch: 4 }).where(eq(jobs.id, c.job.id));
    if (field === 'task owner') await c.db.update(tasks).set({ assigneeAgentId: null }).where(eq(tasks.id, c.task.id));
    if (field === 'executor') await c.db.update(tasks).set({ executorAgentId: null }).where(eq(tasks.id, c.task.id));
    if (field === 'removed author') await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.agent.id));
    if (field === 'closed task') await c.db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.id, c.task.id));
    expect(await c.register()).toEqual({ code: 'binding_stale', retryable: false });
    expect(await c.db.select().from(workspaceRepositories)).toEqual([]);
  });

  it('accepts its actual assigned remote node and refuses an unbound builtin claim', async () => {
    const c = await fixture();
    const [machine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.owner.id, machineKey: 'fixture-machine' }).returning();
    const [node] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: machine!.id, subscriptionId: c.job.subscriptionId, status: 'ready', keyHash: 'fixture-key-hash' }).returning();
    await c.db.update(jobs).set({ nodeId: node!.id }).where(eq(jobs.id, c.job.id));
    expect(await c.register()).toEqual({ code: 'binding_stale', retryable: false });
    expect(await c.register({ ...c.authority, node: { kind: 'node', nodeId: node!.id } })).toMatchObject({ canonicalUrl: 'https://git.example/team/project' });
  });

  it('never resolves a foreign company product through a valid local task', async () => {
    const c = await fixture();
    const [other] = await c.db.insert(companies).values({ name: 'Foreign company', singleton: false }).returning();
    const [product] = await c.db.insert(departments).values({ companyId: other!.id, roleCode: 'PRODUCT', repoUrl: 'https://git.example/team/private.git' }).returning();
    await c.db.update(tasks).set({ productId: product!.id }).where(eq(tasks.id, c.task.id));
    expect(await c.register()).toEqual({ code: 'wrong_repository', retryable: false });
    expect(await c.db.select().from(workspaceRepositories)).toEqual([]);
  });

  it('fails closed when the configured repository is removed', async () => {
    const c = await fixture(), first = await registered(c);
    await c.db.update(departments).set({ repoUrl: null }).where(eq(departments.id, c.department.id));
    expect(await c.read(first.repositoryId)).toEqual({ code: 'wrong_repository', retryable: false });
    expect(await c.register()).toEqual({ code: 'wrong_repository', retryable: false });
  });

  it('rolls registry creation back with its enclosing authority transaction', async () => {
    const c = await fixture();
    await expect(c.db.transaction(async tx => {
      const found = await registerJobWorkspaceRepository(tx, c.authority);
      expect(found).toHaveProperty('repositoryId');
      throw new Error('Abort admission');
    })).rejects.toThrow('Abort admission');
    expect(await c.db.select().from(workspaceRepositories)).toEqual([]);
  });
});
