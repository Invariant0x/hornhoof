import type { Limits, ModelOption, NodeLoad, ProviderId, TemplateKey } from '@hornhoof/protocol';
import type { RoleEffort } from '@hornhoof/protocol/efforts';
import type { WorkLine } from '@hornhoof/protocol/map';

export type { Limits, ModelOption, ProviderId, TemplateKey, WorkLine };

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
  /* On the map: how many decisions wait for this person among those the viewer sees; null when the viewer cannot see them. */
  pendingDecisions?: number | null;
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
  /* The machines the plan runs on, oldest first, with its state on each. */
  machines: { id: string; hostname: string; status: 'needs_login' | 'ready'; online: boolean }[];
  limits: Limits | null;
  /* The share of each limit window, in percent, that task turns may use; null: the whole limit. */
  budget: number | null;
  isOrchestrator: boolean;
  /* The account each signed-in machine of the plan is on; the address only for its owner and people who see the whole
     company. tier: the one all of them say; accountsDiffer: they are on different accounts or tiers. */
  accounts: PlanAccount[];
  tier: string | null;
  accountsDiffer: boolean;
  /* The owner signed the plan in once in Hornhoof, so it runs on any of their machines. */
  signedInOnce: boolean;
  /* The machine a Codex plan signed in once runs on now, one at a time. */
  leaseMachine: string | null;
  /* Included by the subscriptions list only. Other views of a plan omit its agents. */
  agents?: RunningAgent[];
};

export type PlanAccount = { nodeId: string; hostname: string; tier: string | null; email?: string | null };

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
  /* The level its model thinks at, when Hornhoof knows it. */
  effort: string | null;
  state: AgentState;
  status: EmployeeStatus;
  /* Off for now: it takes no work until a person switches it on. */
  on: boolean;
  /* How often it wakes on its timer, in minutes; null without one. */
  timer: number | null;
  task: EmployeeTask | null;
  /* How full its context was when its machine last said, from 0 to 1; null before it said. */
  context: number | null;
};

/* A role a department's employees hold, in its template's order; gate: where it stands among the default gates. */
export type DeptRole = { id: string; title: Lang; description: Lang; kind: 'head' | 'member'; gate: number | null };

/* A template department without a typed name shows its template's name in the person's language. people: those who reach
   only this department. */
export type Department = {
  id: string;
  /* The lines from its head to each employee: who works on the head's task now, and who just gave a result back. */
  workLines?: WorkLine[];
  /* Last completed return from a gate to the executor, on the server's clock. */
  reworkAt?: string | null;
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
export type Repository = { url: string; branch: string; tokenLast4: string | null; author?: { name: string; email: string } | null; testMemoryGb?: number };

export type Org = {
  company: Company;
  /* limitUntil: his plan is at its limit until then, and he waits for the reset. */
  orchestrator: { id: string; name: string; model: string; effort: string | null; subscription: SubView | null; machine?: Machine | null; context: number | null; limitUntil?: string | null } | null;
  agents: { total: number; working: number };
  /* People who see the whole company, and deputies whose reach spans more than one top-level department. */
  people: (PersonView & { deputy?: boolean; departments?: string[] })[];
  departments: Department[];
  turn?: { id: string; number: number; goal: string } | null;
  /* The server's clock when it read the lines, which times how long a yellow line burns. */
  serverNow?: string;
  /* The lines from the orchestrator to each department's head, as the server keeps them. */
  workLines?: WorkLine[];
};

/* Whether the orchestrator can take a turn now, and what he is doing. */
export type OrchestratorState = {
  ready: boolean;
  /* The plan is at its limit until then; its turns wait, and people may still write. */
  limitUntil?: string | null;
  /* The plan used the share set for tasks until then; task turns wait, people's messages still go. */
  budgetUntil?: string | null;
  reason: 'no_subscription' | 'waiting_machine' | 'needs_login' | 'node_outdated' | 'machine_offline' | null;
  busy: boolean;
  runningJobId: string | null;
  queued: number;
  /* Its node shows the agent's live terminal; older nodes do not. */
  terminal?: boolean;
};

/* One part of an agent's instructions: who it is (written by Hornhoof), its role, or a skill between markers. */
export type Part = { kind: 'header' | 'base' | 'skill' | 'notebook'; id: string | null; title: Lang | null; text: string; overridden: boolean; templateChanged: boolean };

export type CardSkill = { id: string; title: Lang; description: Lang; on: boolean; locked: boolean; overridden: boolean; templateChanged: boolean };

/* An agent's card: what it is, where it runs and the text it runs with. The orchestrator has no role and no skills. */
/* Why a node restarted, as far as Hornhoof could tell. */
export type RestartCause = 'update' | 'machine' | 'container' | 'program' | 'connection' | 'unknown';

export type AgentCardView = {
  id: string;
  kind: 'orchestrator' | 'head' | 'worker';
  name: string;
  role: { id: string; title: Lang; description: Lang; effort?: RoleEffort } | null;
  department: { id: string; name: string } | null;
  product: { id: string; name: string } | null;
  model: string;
  /* The level a person picked, or null for the Default. */
  effort: string | null;
  subscription: SubView | null;
  /* The machine its program runs on; none before its first turn, or on a key. */
  machine: Machine | null;
  state: AgentState;
  skills: CardSkill[];
  parts: Part[];
  raw: string;
  /* How long the text every turn sends is, and the most it may be. */
  instructions: { length: number; max: number };
  runsOn: { subscription: SubView; models: ModelOption[] }[];
  changes: { field: string; personName: string | null; byOrchestrator: boolean; at: string }[];
  /* Its latest turns a node restart cut off, the latest first; node: none for the built-in node. */
  interrupted: { job: string; at: string; cause: RestartCause; node: string | null; task: { id: string; number: number } | null; retry: boolean }[];
  /* The whole company or the agent's department may change it; only the whole company removes it. */
  canEdit: boolean;
  /* Wakes every so many minutes, outside any task, to do its order; lastAt: the last round, or when it was set. */
  /* forWork: it skips a round while no task is open and nothing failed since the last one. */
  timer: { minutes: number; order: string; forWork: boolean; lastAt: string | null } | null;
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
export type Endpoint = { kind: 'person'; id: string } | { kind: 'orchestrator' } | { kind: 'department'; id: string } | { kind: 'agent'; id: string; departmentId: string };

export type AgentEventKind = 'message' | 'text' | 'tool' | 'tool_result' | 'todo' | 'proposal' | 'applied' | 'stopped' | 'failed' | 'computer' | 'typed';

/* Who wrote or got a message: a person (id null: the company's people at large), an agent, or Hornhoof itself. */
export type MessageParty = {
  kind: 'person' | 'agent' | 'hornhoof';
  id: string | null;
  name: string;
  role: Lang | null;
  department: { id: string; name: Lang } | null;
  agentKind?: 'orchestrator' | 'head' | 'worker';
};

/* One line of an agent's conversation, as the server keeps it. message: who a message came from and went to, and whether
   it came to this agent or went out of it; older events have none. */
export type EventView = {
  seq: number;
  kind: AgentEventKind;
  data: unknown;
  jobId: string | null;
  person: { id: string; name: string } | null;
  at: string;
  message?: { direction: 'in' | 'out'; from: MessageParty; to: MessageParty };
};

/* What the browser hears live from /api/stream. */
export type StreamMessage =
  | { type: 'agent_event'; agentId: string; event: EventView }
  | { type: 'working'; working: number }
  | { type: 'org' }
  | { type: 'notebook'; spot: { departmentId: string | null } }
  | { type: 'pulse'; from: Endpoint; to: Endpoint }
  | { type: 'task'; id: string; spot: { departmentId: string | null; parentId?: string | null } }
  | { type: 'requests' }
  /* The orchestrator's request for the computer changed; only the CEO's screen hears it. */
  | { type: 'computer' }
  | { type: 'improvements' }
  | { type: 'context'; agentId: string; used: number }
  /* A plan's owner finished or gave up a sign-in on one of its machines; only the owner hears it. */
  | { type: 'subscription.signin'; subscriptionId: string; nodeId: string; ok: boolean; error: string | null; owner: string };

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
  /* Every gate passed it and its executor puts the work together with the rest of the turn. */
  merging: boolean;
  bounces: number;
  turn: number | null;
  parentId: string | null;
  /* The numbers of the tasks it comes after that are not done yet: until they are, it waits. */
  waitsFor: number[];
  createdAt: string;
  updatedAt: string;
};

export type TaskLogLine = { kind: string; text: string; data: unknown; by: { kind: 'person' | 'agent'; id: string; name: string } | null; at: string };
export type TaskRequest = { id: string; kind: 'question' | 'approval' | 'stuck'; text: string; commit: string | null; status: string; answer: string | null; agent: AgentRef | null; at: string };

export type TaskDetail = TaskLine & {
  body: string;
  parent: { id: string; number: number; title: string } | null;
  /* The tasks of its turn it comes after, and where each stands. */
  after: { id: string; number: number; title: string; status: TaskStatus }[];
  executor: AgentRef | null;
  /* returned: a reviewer in the review of a turn who found what blocks; skipped: one who did not check it. */
  gates: (AgentRef & { state: 'passed' | 'current' | 'next' | 'returned' | 'skipped' })[];
  /* The review of a department's turn: every reviewer checks at once, and the head who gets the verdicts did no work. */
  turnReview?: boolean;
  createdBy: { kind: 'person' | 'agent'; id: string; name: string } | null;
  subtasks: TaskLine[];
  log: TaskLogLine[];
  requests: TaskRequest[];
};

/* What an agent asks of people, under "Waiting for you". */
/* An improvement as a short case: what is wrong, the facts with where each comes from, the guesses kept apart, why it
   matters, the change and what it gives. */
export type ImprovementParts = {
  problem: string | null;
  facts: { text: string; source: string }[];
  guesses: string[];
  why: string | null;
  change: string;
  gain: string | null;
};

/* Something an employee found to improve in how the company works. open waits for the CEO, taken is with the
   orchestrator, done is done, dismissed was set aside. result: the orchestrator's word on what came of it. */
export type Improvement = {
  id: string;
  title: string;
  text: string;
  seen: number;
  status: 'open' | 'taken' | 'done' | 'dismissed';
  result: string | null;
  at: string;
  updatedAt: string;
  agent: { id: string; name: string };
  department: { id: string; name: string } | null;
  decidedBy: string | null;
  tasks?: { id: string; number: number; title: string }[];
  /* null for one filed as one text; an older server sends none. */
  parts?: ImprovementParts | null;
};

export type WaitingRequest = {
  id: string;
  kind: 'question' | 'choice' | 'approval' | 'stuck';
  text: string;
  commit: string | null;
  /* The commit on GitHub, when the repository is there. */
  commitUrl: string | null;
  /* Pictures the agent shows, by id; a choice's ways may carry their own. */
  images: string[];
  options: { label: string; image: string | null }[];
  /* Where to see the work. */
  link: string | null;
  /* The orchestrator's words for people: what is needed from them, why, and the ways to go; null until it writes them. */
  explained: string | null;
  /* The orchestrator was asked to, in a turn that waits or runs now. */
  explaining: boolean;
  at: string;
  agent: { id: string; name: string };
  task: { id: string; number: number; title: string; department: TaskPlace };
  /* The person whose decision it is: whose card counts it and whose filter shows it. Who may answer stays as before. */
  ownerPersonId: string;
  /* Whether this person may answer it here; an approval is for people who see the whole company. */
  canAnswer: boolean;
};

/* A card of the orchestrator that waits for people: a structure to build, or people to hire into a department. */
export type ProposalDecision = {
  id: string;
  agent: { id: string; name: string };
  department: { id: string; name: string } | null;
  brief: string;
  at: string;
  ownerPersonId: string;
  canAnswer: boolean;
} & ({ kind: 'structure'; items: StructureItem[] } | { kind: 'staff'; items: StaffLine[] });

/* The orchestrator's request for the computer the server runs on, which only the CEO sees and answers. */
export type ComputerAccessDecision = { kind: 'computer_access'; id: 'server'; agent: { id: string; name: string }; ownerPersonId: string; canAnswer: true; at: string; view: ComputerView };

/* Everything that waits for people as /api/requests shows it to this person, and the counts of all of it: per owner, per
   asking agent and in total. */
export type Decisions = {
  requests: WaitingRequest[];
  proposals: ProposalDecision[];
  computerAccess: ComputerAccessDecision | null;
  counts: { byPerson: Record<string, number>; byAgent: Record<string, number>; total: number };
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

export type Machine = { id: string; hostname: string };

export type MachineView = {
  id: string;
  hostname: string;
  os: string;
  arch: string;
  owner: { id: string; name: string };
  online: boolean;
  lastSeenAt: string | null;
  /* The plans that run on it, with their state there; none: it only lends itself to test runs. */
  plans: { id: string; provider: ProviderId; status: 'needs_login' | 'ready'; online: boolean }[];
  /* What its nodes said last about how busy it is; none while no node of it is connected. */
  load: NodeLoad | null;
  /* Takes the company's test runs when it is the freest machine. */
  lendsTests: boolean;
  running: Running;
};

/* What runs on a machine now: the employees whose program is there, busy while a turn of theirs runs, and the parts of
   runs it takes, of tests or of other work. */
export type RunningAgent = {
  id: string;
  name: string;
  busy: boolean;
  title: Lang | null;
  department: { id: string; name: string } | null;
  provider: ProviderId;
  since: string | null;
  task: { number: number; title: string } | null;
  withCeo: boolean;
};

export type Running = {
  agents: RunningAgent[];
  parts: { run: number; kind: 'tests' | 'work'; task: number | null; part: number; parts: number; agent: string | null; startedAt: string | null }[];
};

/* A machine command the orchestrator asked Hornhoof for, which only the CEO's screen gets: to connect a machine alone,
   to connect plans, or to add a plan to a machine. */
/* Access to the computer the server runs on: whether Hornhoof reaches it, until when it is open, what the orchestrator asked it for. */
/* machine: the hostname of the machine the server runs on, when that computer joined as a machine. */
export type ComputerView = { available: boolean; until: string | null; asked: { reason: string; at: string } | null; machine?: string | null };
export type ShownCommand = { id: string; kind: 'machine' | 'plans' | 'add'; plans: string[]; machine: string | null; command: string; expiresAt: string };

/* The node that comes with the server, for those who see the whole company. */
/* machine: the company's machine it runs on, when the server is on one; the pool counts that computer once. */
export type BuiltinView = { online: boolean; load: NodeLoad | null; running: Running; machine?: Machine | null };

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

/* A note of the company notebook or a department's, and who wrote it last: a person, the orchestrator or the head. */
export type NoteView = { number: number; text: string; by: { kind: 'orchestrator' } | { kind: 'person' | 'agent'; id: string; name: string } | null; updatedAt: string };

export type SegmentKind = 'work' | 'after' | 'person' | 'stall';
export type TreeSegment = { kind: SegmentKind; from: string; to: string | null };
export type TreeMove = { kind: string; at: string; text: string };
export type TreeAgent = { id: string; name: string };
export type TreeLine = {
  taskId: string;
  number: number;
  title: string;
  agent: TreeAgent;
  part: { id: string; number: number; title: string } | null;
  branch: string | null;
  createdAt: string;
  cutAt: string | null;
  mergedAt: string | null;
  doneAt: string | null;
  waitsFor: number[];
  segments: TreeSegment[];
  moves: TreeMove[];
  lastActionAt: string | null;
  live: boolean;
};
export type TreeVerdict = { at: string; pass: boolean; findings: number | null };
export type TreeReviewer = { agent: TreeAgent; verdict: TreeVerdict | null; segments: TreeSegment[]; lastActionAt: string | null; live: boolean };
export type TreeReview = { taskId: string; number: number; openedAt: string; closedAt: string | null; head: TreeAgent; reviewers: TreeReviewer[] };
export type AgentTime = { agent: TreeAgent; work: number; after: number; person: number; stall: number };
export type IdleStretch = { agent: TreeAgent; taskId: string; number: number; title: string; kind: Exclude<SegmentKind, 'work'>; from: string; to: string | null; waitsFor: number[]; question: string | null };
export type DepartmentTree = {
  now: string;
  turn: { id: string; number: number; branch: string; startedAt: string } | null;
  repository: boolean;
  stage: 'work' | 'review';
  lines: TreeLine[];
  review: TreeReview | null;
  time: AgentTime[];
  idle: IdleStretch[];
};
