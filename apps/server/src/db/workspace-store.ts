import { NodeRef, type WorkspaceProblem } from '@hornhoof/protocol';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './client.js';
import { agents, departments, jobs, tasks, workspaceRepositories } from './schema.js';
import { canonicalWorkspaceRepositoryUrl } from './workspace-repository-url.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/* Server-internal context from the authenticated running job, never a request-body assertion. */
export interface WorkspaceJobAuthority {
  companyId: string;
  jobId: string;
  agentId: string;
  node: NodeRef;
  assignmentEpoch: number;
}

export interface WorkspaceRepositoryIdentity {
  repositoryId: string;
  canonicalUrl: string;
  credentialScopeId: string;
  credentialRevision: number;
}

const Authority = z.strictObject({ companyId: z.uuid(), jobId: z.uuid(), agentId: z.uuid(), node: NodeRef, assignmentEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
const stale = (): WorkspaceProblem => ({ code: 'binding_stale', retryable: false });
const wrongRepository = (): WorkspaceProblem => ({ code: 'wrong_repository', retryable: false });
type Task = typeof tasks.$inferSelect;
type Configuration = { canonicalUrl: string; credentialScopeId: string; credentialRevision: number };

/* Match the actual running job after locking its task, then the job. Never widen a stale tool into system authority. */
async function currentTask(tx: Tx, authority: WorkspaceJobAuthority): Promise<Task | null> {
  if (!Authority.safeParse(authority).success) return null;
  const jobKey = and(eq(jobs.id, authority.jobId), eq(jobs.companyId, authority.companyId));
  const [hint] = await tx.select({ taskId: jobs.taskId }).from(jobs).where(jobKey);
  if (!hint?.taskId) return null;
  const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, hint.taskId), eq(tasks.companyId, authority.companyId))).for('update');
  const [job] = await tx.select().from(jobs).where(jobKey).for('update');
  if (!task || !job || job.taskId !== task.id || job.status !== 'running' || job.agentId !== authority.agentId) return null;
  if (task.assigneeAgentId !== authority.agentId || task.executorAgentId !== authority.agentId || task.closedAt || ['done', 'cancelled'].includes(task.status)) return null;
  if (job.assignmentEpoch !== authority.assignmentEpoch || task.assignmentEpoch !== authority.assignmentEpoch) return null;
  if (job.nodeId !== (authority.node.kind === 'node' ? authority.node.nodeId : null)) return null;
  const [agent] = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, authority.agentId), eq(agents.companyId, authority.companyId), isNull(agents.removedAt)));
  return agent ? task : null;
}

/* Product first, then department, as the existing repository selector does. A bad or foreign first mapping never falls back. */
async function configuration(tx: Tx, task: Task): Promise<Configuration | null> {
  for (const id of [task.productId, task.departmentId]) {
    if (!id) continue;
    const [row] = await tx.select({ id: departments.id, url: departments.repoUrl, revision: departments.repoTokenRevision }).from(departments)
      .where(and(eq(departments.id, id), eq(departments.companyId, task.companyId))).for('share');
    if (!row) return null;
    if (!row.url) continue;
    const canonicalUrl = canonicalWorkspaceRepositoryUrl(row.url);
    return canonicalUrl ? { canonicalUrl, credentialScopeId: row.id, credentialRevision: row.revision } : null;
  }
  return null;
}

async function currentRepository(tx: Tx, authority: WorkspaceJobAuthority): Promise<Configuration | WorkspaceProblem> {
  const task = await currentTask(tx, authority);
  if (!task) return stale();
  return (await configuration(tx, task)) ?? wrongRepository();
}

const identity = (repositoryId: string, config: Configuration): WorkspaceRepositoryIdentity => ({ repositoryId, ...config });

/* Identity only: neither a staging plan nor permission to prepare or start a workspace. The caller owns this transaction;
   the canonical registry guard stays locked until it commits, and no Git or network work belongs inside it. */
export async function registerJobWorkspaceRepository(tx: Tx, authority: WorkspaceJobAuthority): Promise<WorkspaceRepositoryIdentity | WorkspaceProblem> {
  const config = await currentRepository(tx, authority);
  if ('code' in config) return config;
  const key = and(eq(workspaceRepositories.companyId, authority.companyId), eq(workspaceRepositories.canonicalUrl, config.canonicalUrl));
  await tx.insert(workspaceRepositories).values({ companyId: authority.companyId, canonicalUrl: config.canonicalUrl })
    .onConflictDoNothing({ target: [workspaceRepositories.companyId, workspaceRepositories.canonicalUrl] });
  const [row] = await tx.select({ id: workspaceRepositories.id }).from(workspaceRepositories).where(key).for('update');
  if (!row) throw new Error('The repository identity was not stored.');
  return identity(row.id, config);
}

export async function readJobWorkspaceRepository(tx: Tx, authority: WorkspaceJobAuthority, repositoryId: string): Promise<WorkspaceRepositoryIdentity | WorkspaceProblem> {
  const config = await currentRepository(tx, authority);
  if ('code' in config) return config;
  if (!z.uuid().safeParse(repositoryId).success) return wrongRepository();
  const [row] = await tx.select({ id: workspaceRepositories.id }).from(workspaceRepositories).where(and(
    eq(workspaceRepositories.id, repositoryId), eq(workspaceRepositories.companyId, authority.companyId), eq(workspaceRepositories.canonicalUrl, config.canonicalUrl),
  )).for('update');
  return row ? identity(row.id, config) : wrongRepository();
}
