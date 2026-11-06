import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { WorkspaceJobAuthority, WorkspaceRepositoryIdentity } from '../src/db/workspace-store.js';
import { agents, companies, departments, externalOperations, externalRecoveryCases, jobs, people, subscriptions, tasks, workspaceRepositories } from '../src/db/schema.js';
import * as external from '../src/modules/failures/external.js';
import { BUILTIN, NodeHub, type NodeIdentity, type NodeTransport } from '../src/modules/nodes/hub.js';
import type { Tx } from '../src/modules/tasks/engine.js';
import { createTestDb } from './helpers-db.js';

type Caller = { authority: WorkspaceJobAuthority; identity: NodeIdentity; transport: NodeTransport };
type Binding = WorkspaceRepositoryIdentity & { companyId: string; jobId: string; agentId: string; taskId: string; assignmentEpoch: number; workspaceBinding: string; producerLinkId: string };
type Context = { hub: NodeHub };
type Issue = (tx: Tx, ctx: Context, caller: Caller) => Promise<Binding>;
type Read = (tx: Tx, ctx: Context, caller: Caller, expected: { repositoryId: string; workspaceBinding: string }) => Promise<Binding>;

function issue(...args: Parameters<Issue>): ReturnType<Issue> {
  const fn = Reflect.get(external, 'issueGitJobBinding') as Issue | undefined;
  expect(fn, 'Missing real current-job Git binding producer').toBeTypeOf('function');
  return fn!(...args);
}

function read(...args: Parameters<Read>): ReturnType<Read> {
  const fn = Reflect.get(external, 'readGitJobBinding') as Read | undefined;
  expect(fn, 'Missing real current-job Git binding consumer').toBeTypeOf('function');
  return fn!(...args);
}

async function fixture() {
  const db = await createTestDb();
  const [company] = await db.insert(companies).values({ name: 'Git source company' }).returning();
  const [person] = await db.insert(people).values({ companyId: company!.id, name: 'Owner', email: 'owner@example.test', status: 'active', scopeKind: 'company' }).returning();
  const [subscription] = await db.insert(subscriptions).values({ companyId: company!.id, provider: 'codex', kind: 'api_key', label: 'Plan', ownerPersonId: person!.id, status: 'ready' }).returning();
  const [department] = await db.insert(departments).values({ companyId: company!.id, roleCode: 'DEV', repoUrl: 'https://git.example/team/project.git', repoTokenEnc: 'private-test-ciphertext', repoTokenRevision: 4 }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company!.id, kind: 'worker', name: 'Author', departmentId: department!.id, model: '' }).returning();
  const [task] = await db.insert(tasks).values({ companyId: company!.id, departmentId: department!.id, number: 1, title: 'Work', status: 'working', assigneeAgentId: agent!.id, executorAgentId: agent!.id, assignmentEpoch: 3 }).returning();
  const [job] = await db.insert(jobs).values({ companyId: company!.id, subscriptionId: subscription!.id, agentId: agent!.id, taskId: task!.id, kind: 'conversation', status: 'running', assignmentEpoch: 3, prompt: 'Work', timeoutMs: 60000 }).returning();
  const links: string[] = [];
  const hub = new NodeHub({ pingMs: 60000, onMessage: async () => {}, onClose: async () => {}, onConnected: async (_id, link) => { links.push(link); } });
  onTestFinished(() => hub.stop());
  const attach = () => hub.attach(BUILTIN, Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} }) as unknown as WebSocket);
  attach();
  const ctx = { hub };
  const caller: Caller = { authority: { companyId: company!.id, jobId: job!.id, agentId: agent!.id, node: BUILTIN, assignmentEpoch: 3 }, identity: BUILTIN, transport: { linkId: links[0]! } };
  const make = (who = caller) => db.transaction(tx => issue(tx, ctx, who));
  const check = (value: Binding, who = caller) => db.transaction(tx => read(tx, ctx, who, value));
  return { db, company: company!, department: department!, task: task!, job: job!, agent: agent!, hub, ctx, caller, links, attach, make, check };
}

describe('server-issued Git job binding', () => {
  it('uses the real private registry and credential revision without creating an operation or episode', async () => {
    const c = await fixture(), value = await c.make();
    expect(value).toMatchObject({ companyId: c.company.id, taskId: c.task.id, jobId: c.job.id, agentId: c.agent.id, assignmentEpoch: 3, canonicalUrl: 'https://git.example/team/project', credentialScopeId: c.department.id, credentialRevision: 4, producerLinkId: c.links[0] });
    expect(value.workspaceBinding).toMatch(/^[a-f0-9]{64}$/);
    expect((await c.db.select().from(workspaceRepositories)).map(row => row.id)).toEqual([value.repositoryId]);
    expect(await c.make()).toEqual(value);
    expect(await c.check(value)).toEqual(value);
    expect(await c.db.select().from(externalOperations)).toEqual([]);
    expect(await c.db.select().from(externalRecoveryCases)).toEqual([]);
    expect(JSON.stringify(value)).not.toContain('private-test-ciphertext');
  });

  it('rejects an old link and preserves the assignment binding on a genuine replacement link', async () => {
    const c = await fixture(), value = await c.make();
    c.attach();
    await expect(c.check(value)).rejects.toMatchObject({ status: 409 });
    const caller = { ...c.caller, transport: { linkId: c.links[1]! } };
    const current = await c.make(caller);
    expect(current.workspaceBinding).toBe(value.workspaceBinding);
    expect(current.producerLinkId).toBe(c.links[1]);
  });

  it('rechecks a real hub replacement after the registry await and rolls registration back', async () => {
    const c = await fixture(), current = c.hub.isCurrentLink.bind(c.hub);
    let replaced = false;
    vi.spyOn(c.hub, 'isCurrentLink').mockImplementation((id, link) => {
      const result = current(id, link);
      if (!replaced) { replaced = true; queueMicrotask(c.attach); }
      return result;
    });
    await expect(c.make()).rejects.toMatchObject({ status: 409 });
    expect(await c.db.select().from(workspaceRepositories)).toEqual([]);
  });

  it.each(['credential', 'epoch', 'owner', 'ended'] as const)('refuses a stale %s source instead of granting execution', async change => {
    const c = await fixture(), value = await c.make();
    if (change === 'credential') await c.db.update(departments).set({ repoTokenRevision: 5 }).where(eq(departments.id, c.department.id));
    if (change === 'epoch') await c.db.update(tasks).set({ assignmentEpoch: 4 }).where(eq(tasks.id, c.task.id));
    if (change === 'owner') await c.db.update(tasks).set({ executorAgentId: null }).where(eq(tasks.id, c.task.id));
    if (change === 'ended') await c.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, c.job.id));
    await expect(c.check(value)).rejects.toMatchObject({ status: 409 });
    expect(await c.db.select().from(externalOperations)).toEqual([]);
  });

  it('refuses forged repository and workspace selectors and a different producer node', async () => {
    const c = await fixture(), value = await c.make();
    await expect(c.check({ ...value, repositoryId: randomUUID() })).rejects.toMatchObject({ status: 409 });
    await expect(c.check({ ...value, workspaceBinding: 'a'.repeat(64) })).rejects.toMatchObject({ status: 409 });
    await expect(c.make({ ...c.caller, identity: { kind: 'node', nodeId: randomUUID(), keyHash: 'b'.repeat(64) } })).rejects.toMatchObject({ status: 409 });
  });
});
