import type { NodeRef, WorkspaceProblem } from '@hornhoof/protocol';
import type { Db } from './client.js';

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

/* Identity only: neither a staging plan nor permission to prepare or start a workspace. */
export async function registerJobWorkspaceRepository(_tx: Tx, _authority: WorkspaceJobAuthority): Promise<WorkspaceRepositoryIdentity | WorkspaceProblem> {
  throw new Error('Workspace repository authority is not implemented.');
}

export async function readJobWorkspaceRepository(_tx: Tx, _authority: WorkspaceJobAuthority, _repositoryId: string): Promise<WorkspaceRepositoryIdentity | WorkspaceProblem> {
  throw new Error('Workspace repository authority is not implemented.');
}
