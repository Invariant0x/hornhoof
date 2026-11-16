import type { Entry } from './store.js';

/* An agent that uses the vault: an employee or an assistant, its company and department, and the turn it runs. */
export type VaultAgent = { id: string; companyId: string; departmentId: string | null; jobId: string | null };

/* Every agent of the company uses an entry, unless a person kept it for one department or one agent. Another company's
   entry is never this agent's. */
export function mayUse(entry: Entry, agent: VaultAgent): boolean {
  if (entry.companyId !== agent.companyId) return false;
  if (entry.scopeKind === 'department') return entry.scopeDepartmentId !== null && entry.scopeDepartmentId === agent.departmentId;
  if (entry.scopeKind === 'agent') return entry.scopeAgentId === agent.id;
  return true;
}
