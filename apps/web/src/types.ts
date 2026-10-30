import type { Limits, ProviderId, TemplateKey } from '@hornhoof/protocol';

export type { Limits, ProviderId, TemplateKey };

export type ScopeKind = 'company' | 'department' | 'team';

export type Person = {
  id: string;
  companyId: string;
  name: string;
  email: string;
  title: string;
  status: 'active' | 'invited' | 'disabled';
  scopeKind: ScopeKind;
  scopeId: string | null;
  isOwner: boolean;
};

export type Company = { id: string; name: string };

export type Me = { person: Person; company: Company };

export type PersonView = {
  id: string;
  name: string;
  email: string;
  title: string;
  status: Person['status'];
  isOwner: boolean;
  scope: { kind: ScopeKind; id: string | null; name: string };
};

export type SubView = {
  id: string;
  provider: ProviderId;
  kind: 'personal' | 'api_key';
  label: string;
  status: 'waiting_machine' | 'needs_login' | 'ready';
  online: boolean;
  last4: string | null;
  owner: { id: string; name: string };
  place: { kind: 'company' | 'department'; id: string | null; name: string };
  machine: { id: string; hostname: string } | null;
  limits: Limits | null;
  isOrchestrator: boolean;
};

export type Team = { id: string; name: string; about: string; stage: number; gate: boolean };

/* A template department without a typed name shows its template's name in the person's language. */
export type Department = { id: string; name: string | null; templateKey: TemplateKey | null; roleCode: string; about: string; products: { id: string; name: string }[]; teams: Team[] };

export type Org = {
  company: Company;
  orchestrator: { name: string; model: string; subscription: SubView | null } | null;
  agents: { total: number; working: number };
  people: PersonView[];
  departments: Department[];
};

/* Who a pulse on the map runs between. */
export type Endpoint = { kind: 'person'; id: string } | { kind: 'orchestrator' } | { kind: 'department'; id: string };

export type AgentEventKind = 'message' | 'text' | 'tool' | 'tool_result' | 'todo' | 'proposal' | 'applied' | 'stopped' | 'failed';

/* One line of an agent's conversation, as the server keeps it. */
export type EventView = { seq: number; kind: AgentEventKind; data: unknown; jobId: string | null; person: { id: string; name: string } | null; at: string };

/* What the browser hears live from /api/stream. */
export type StreamMessage =
  | { type: 'agent_event'; agentId: string; event: EventView }
  | { type: 'working'; working: number }
  | { type: 'org' }
  | { type: 'pulse'; from: Endpoint; to: Endpoint };

export type MachineView = {
  id: string;
  hostname: string;
  os: string;
  arch: string;
  owner: { id: string; name: string };
  online: boolean;
  lastSeenAt: string | null;
  subscriptions: number;
};

export type JobView = {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  result: string | null;
  tail: string;
  error: string | null;
  machine: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};
