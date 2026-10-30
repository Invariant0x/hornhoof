import type { Limits, ModelOption, ProviderId, TemplateKey } from '@hornhoof/protocol';

export type { Limits, ModelOption, ProviderId, TemplateKey };

/* Template text that comes in both languages. */
export type Lang = { en: string; ru: string };

/* company: the whole company; listed: the departments and teams ticked for the person. */
export type ScopeKind = 'company' | 'listed';

export type Person = {
  id: string;
  companyId: string;
  name: string;
  email: string;
  title: string;
  status: 'active' | 'invited' | 'disabled';
  scopeKind: ScopeKind;
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
  access: AccessView;
};

/* What a person reaches: the whole company, or departments and teams, in the order of the map. */
export type AccessView = { whole: boolean; departments: { id: string; name: string }[]; teams: { id: string; name: string; departmentId: string }[] };

/* What the People screen sends for a person's access. */
export type AccessInput = { whole: true } | { departments: string[]; teams: string[] };

export type SubView = {
  id: string;
  provider: ProviderId;
  kind: 'personal' | 'api_key';
  label: string;
  status: 'waiting_machine' | 'needs_login' | 'ready';
  online: boolean;
  last4: string | null;
  owner: { id: string; name: string };
  place: { kind: 'company' | 'department' | 'listed'; id: string | null; name: string };
  machine: { id: string; hostname: string } | null;
  limits: Limits | null;
  isOrchestrator: boolean;
};

export type Team = { id: string; name: string; about: string; stage: number; gate: boolean };

export type AgentState = 'working' | 'sleeping' | 'needs_subscription';

/* What an employee does now. queued: it holds a task whose turn has not started; handed: what it holds is with gates or
   with the tasks it gave out; waiting: it waits for people; off: it has no subscription. */
export type EmployeeStatus = 'working' | 'queued' | 'handed' | 'waiting' | 'idle' | 'off';

/* The task an employee is about, for people who reach its department. */
export type EmployeeTask = { id: string; number: number; title: string; stage: number; gateCount: number; bounces: number };

/* An employee as the map lists it: the head first, then members in the order they were hired. */
export type Employee = {
  id: string;
  name: string;
  roleId: string | null;
  title: Lang | null;
  kind: 'head' | 'worker';
  model: string;
  modelName: string | null;
  provider: ProviderId | null;
  state: AgentState;
  status: EmployeeStatus;
  task: EmployeeTask | null;
};

/* A role a department's employees hold, in its template's order; gate: where it stands among the default gates. */
export type DeptRole = { id: string; title: Lang; description: Lang; kind: 'head' | 'member'; gate: number | null };

/* A template department without a typed name shows its template's name in the person's language. people: those who reach
   only this department. */
export type Department = {
  id: string;
  name: string | null;
  templateKey: TemplateKey | null;
  roleCode: string;
  about: string;
  agents: { total: number; working: number };
  products: { id: string; name: string; repository?: Repository | null }[];
  teams: Team[];
  people: PersonView[];
  employees: Employee[];
  roles: DeptRole[];
  /* What it works on now, for people who reach it. */
  current?: { id: string; number: number; title: string } | null;
  repository?: Repository | null;
};

/* The git repository a department's or product's agents clone; the token never comes back, only its last four. */
export type Repository = { url: string; branch: string; tokenLast4: string | null; author?: { name: string; email: string } | null };

export type Org = {
  company: Company;
  orchestrator: { id: string; name: string; model: string; subscription: SubView | null } | null;
  agents: { total: number; working: number };
  /* Next to the CEO: people who see the whole company, and deputies whose departments span more than one. */
  people: (PersonView & { deputy?: boolean })[];
  departments: Department[];
  turn?: { id: string; number: number; goal: string } | null;
};

/* Whether the orchestrator can take a turn now, and what he is doing. */
export type OrchestratorState = {
  ready: boolean;
  reason: 'no_subscription' | 'waiting_machine' | 'needs_login' | 'node_outdated' | 'machine_offline' | null;
  busy: boolean;
  runningJobId: string | null;
  queued: number;
  /* Its node shows the agent's live terminal; older nodes do not. */
  terminal?: boolean;
};

/* One part of an agent's instructions: who it is (written by Hornhoof), its role, or a skill between markers. */
export type Part = { kind: 'header' | 'base' | 'skill'; id: string | null; title: Lang | null; text: string; overridden: boolean; templateChanged: boolean };

export type CardSkill = { id: string; title: Lang; description: Lang; on: boolean; locked: boolean; overridden: boolean; templateChanged: boolean };

/* An agent's card: what it is, where it runs and the text it runs with. The orchestrator has no role and no skills. */
export type AgentCardView = {
  id: string;
  kind: 'orchestrator' | 'head' | 'worker';
  name: string;
  role: { id: string; title: Lang; description: Lang } | null;
  department: { id: string; name: string } | null;
  product: { id: string; name: string } | null;
  model: string;
  subscription: SubView | null;
  state: AgentState;
  skills: CardSkill[];
  parts: Part[];
  raw: string;
  runsOn: { subscription: SubView; models: ModelOption[] }[];
  changes: { field: string; personName: string | null; at: string }[];
  /* The whole company or the agent's department may change it; only the whole company removes it. */
  canEdit: boolean;
};

/* A subscription or key that may serve a department, with the models it runs. */
export type Serving = { id: string; provider: ProviderId; kind: 'personal' | 'api_key'; label: string; owner: string; models: ModelOption[] };

/* A role of a department's template; subscription: the first one serving the department that runs the role's tier. */
export type RoleOption = { id: string; title: Lang; kind: 'head' | 'member'; tier: 'deep' | 'standard' | 'fast'; perProduct: boolean; skills: string[]; subscription: string | null };

/* A line of a staff card. Left out: the name is the role's title, the subscription the role's first, the model Default. */
export type StaffLine = { role: string; name?: string; product?: string | null; model?: string; subscription?: string | null; skills?: { on?: string[]; off?: string[] } | string[]; checked?: boolean };

/* The default roster of a department and what its card can pick from. */
export type Roster = { people: StaffLine[]; roles: RoleOption[]; products: { id: string; name: string }[]; subscriptions: Serving[] };

/* An item of the orchestrator's card: a department to create from a template, or a change to one that exists. */
export type NewItem = { template: TemplateKey; name?: string; checked: boolean; note: string; products?: string[] };
export type ChangeItem = { department: string; checked: boolean; note: string; products?: string[]; remove?: boolean };
export type StructureItem = NewItem | ChangeItem;

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
  | { type: 'pulse'; from: Endpoint; to: Endpoint }
  | { type: 'task'; id: string }
  | { type: 'requests' };

export type TaskStatus = 'planned' | 'open' | 'working' | 'review' | 'waiting' | 'blocked' | 'done' | 'cancelled';
export type AgentRef = { id: string; name: string; kind: 'orchestrator' | 'head' | 'worker'; role: Lang | null };
export type TaskPlace = { id: string; name: string } | null;

/* A task as lists show it. stage 0 is with its executor; 1 and up is the gate it waits at. */
export type TaskLine = {
  id: string;
  number: number;
  title: string;
  brief: string;
  status: TaskStatus;
  department: TaskPlace;
  product: TaskPlace;
  assignee: AgentRef | null;
  stage: number;
  gateCount: number;
  bounces: number;
  turn: number | null;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskLogLine = { kind: string; text: string; data: unknown; by: { kind: 'person' | 'agent'; id: string; name: string } | null; at: string };
export type TaskRequest = { id: string; kind: 'question' | 'approval' | 'stuck'; text: string; commit: string | null; status: string; answer: string | null; agent: AgentRef | null; at: string };

export type TaskDetail = TaskLine & {
  body: string;
  parent: { id: string; number: number; title: string } | null;
  executor: AgentRef | null;
  gates: (AgentRef & { state: 'passed' | 'current' | 'next' })[];
  createdBy: { kind: 'person' | 'agent'; id: string; name: string } | null;
  subtasks: TaskLine[];
  log: TaskLogLine[];
  requests: TaskRequest[];
};

/* What an agent asks of people, under "Waiting for you". */
export type WaitingRequest = {
  id: string;
  kind: 'question' | 'approval' | 'stuck';
  text: string;
  commit: string | null;
  at: string;
  agent: { id: string; name: string };
  task: { id: string; number: number; title: string; department: TaskPlace };
};

/* A turn as the orchestrator laid it out: a short title, its main point, and the people's own words it came from (only for
   people who see the whole company). Planned turns wait in number order. */
export type TurnView = {
  id: string;
  number: number;
  title: string;
  goal: string;
  status: 'planned' | 'open' | 'closed';
  messages: { by: string; text: string; at: string }[];
  taskId: string | null;
  startedAt: string;
  openedAt: string | null;
  closedAt: string | null;
  tasks: { total: number; done: number };
};

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

/* A published build of Hornhoof, from the registry. */
export type Build = { tag: string; version: string; commit: string; created: string; title: string; migrations: number };
export type UpdateStep = 'backup' | 'pull' | 'install' | 'health' | 'rollback' | 'finished';
export type UpdaterStatus = { id: string; version: string; state: 'running' | 'done' | 'failed' | 'rolled_back'; step: UpdateStep; log: string; at: string };
export type UpdatesView = {
  current: { version: string; commit: string; migrations: number };
  available: boolean;
  checkedAt: string | null;
  latest: Build | null;
  versions: Build[];
  error: string | null;
  updater: { present: boolean; status: UpdaterStatus | null; waiting: { version: string } | null };
};
