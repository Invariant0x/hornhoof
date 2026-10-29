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
  scope: { kind: ScopeKind; id: string | null; name: string };
};

export type SubView = {
  id: string;
  provider: 'claude' | 'codex' | 'kimi' | 'anthropic_api' | 'openai_api';
  kind: 'personal' | 'api_key';
  label: string;
  status: 'active' | 'waiting_machine';
  last4: string | null;
  owner: { id: string; name: string };
  target: { kind: 'chief' | 'department' | 'team' | 'any'; id: string | null; name: string };
};

export type Team = { id: string; name: string; about: string; stage: number; gate: boolean };

export type Department = { id: string; name: string; roleCode: string; teams: Team[] };

export type Org = {
  company: Company;
  chief: { name: string; model: string; subscription: SubView | null } | null;
  agents: { total: number; working: number };
  people: PersonView[];
  departments: Department[];
};
