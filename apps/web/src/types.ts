import type { EchelonFindingsView } from '@hornhoof/protocol/echelons';
import type { EchelonsSnapshot } from '@hornhoof/protocol/echelons';
import type { ApprovalChannel, ApprovalMode, ApprovalRule as ChannelRule } from '@hornhoof/protocol/approval-policy';
import type { ExternalWait } from '@hornhoof/protocol/waits';
import type { Notification } from '@hornhoof/protocol';
import type { ConnectionEnd, FailureKind, Limits, MachineDrain, MaterialManifest, ModelOption, NodeWait, NodeDisconnectCause, NodeLoad, NodeReconnect, ProgramInfo, ProviderId, TemplateKey } from '@hornhoof/protocol';
import type { RoleEffort } from '@hornhoof/protocol/efforts';
import type { RiskClass, WorkKind } from '@hornhoof/protocol/pipeline-report';
import type { ProgramRetry, TurnAlarm, TurnProgram, TurnRetry, WorkLine } from '@hornhoof/protocol/map';

export type { MaterialManifest, MaterialView } from '@hornhoof/protocol';
export type { FailureKind, Limits, ModelOption, ProgramRetry, ProviderId, TemplateKey, TurnAlarm, TurnRetry, WorkLine };

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
  /* The CEO's delegate takes the CEO's decisions; only the CEO sets it. An older server sends none. */
  isCeoDelegate?: boolean;
};

export type Company = { id: string; name: string };

/* canDecideCompany: this person takes the decisions only the CEO takes, the orchestrator's cards among them. */
export type Me = { person: Person; company: Company; canDecideCompany?: boolean };

export type PersonView = {
  id: string;
  name: string;
  email: string;
  title: string;
  status: Person['status'];
  isOwner: boolean;
  isCeoDelegate?: boolean;
  access: AccessView;
  /* On the map: how many decisions wait for this person among those the viewer sees; null when the viewer cannot see them. */
  pendingDecisions?: number | null;
};

/* What a person reaches: the whole company, or departments and teams, in the order of the map. */
export type AccessView = { whole: boolean; departments: { id: string; name: string }[]; teams: { id: string; name: string; departmentId: string }[] };

/* What the People screen sends for a person's access. */
export type AccessInput = { whole: true } | { departments: string[]; teams: string[] };

/* A plan's state on one machine: waiting for the login there, for the first setup of its program, or ready. */
export type PlanStatus = 'needs_login' | 'needs_setup' | 'ready';

export type SubView = {
  id: string;
  provider: ProviderId;
  kind: 'personal' | 'api_key';
  label: string;
  status: 'waiting_machine' | 'needs_login' | 'needs_setup' | 'ready';
  online: boolean;
  last4: string | null;
  owner: { id: string; name: string };
  place: { kind: 'company' | 'department' | 'listed'; id: string | null; name: string };
  /* The machines the plan runs on, oldest first, with its state on each. */
  machines: { id: string; hostname: string; status: PlanStatus; online: boolean }[];
  limits: Limits | null;
  /* When the last snapshot arrived. Undefined on an older server, null when an old row never recorded it. */
  limitsUpdatedAt?: string | null;
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

/* turnkey: each member does a task alone from start to finish, with no stages and nobody else of the department. */
export type Team = { id: string; name: string; about: string; stage: number; gate: boolean; turnkey: boolean };

export type AgentState = 'working' | 'sleeping' | 'needs_subscription';

/* What an employee does now. queued: it holds a task whose turn has not started; handed: what it holds is with gates or
   with the tasks it gave out; waiting: it waits for people; off: it has no subscription. */
export type EmployeeStatus = 'working' | 'queued' | 'handed' | 'waiting' | 'idle' | 'off';

/* The task an employee is about, for people who reach its department. */
export type EmployeeTask = { echelons: EchelonsSnapshot; id: string; number: number; title: string };

export type ProgramView = TurnProgram;

/* The latest failed turn of an agent, as /api/org and /api/agents/:id give it; at is Unix epoch milliseconds. */
export type TurnFailure = { kind: FailureKind; text: string; at: number; tail?: string };
export type TurnObsolete = { at: number };

/* An employee as the map lists it: the head first, then members in the order they were hired. */
export type Employee = {
  id: string;
  name: string;
  roleId: string | null;
  teamId?: string | null;
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
  /* What the program of its running turn does, as its node said; null while it runs none. */
  program: ProgramView | null;
  /* The server's alarm about its running turn, or null. */
  alarm: TurnAlarm | null;
  /* The oldest turn its plan holds, and why. */
  held?: { reason: 'limit' | 'budget'; since: string; until: string } | null;
  /* Hornhoof's waiting retry after a failed turn, or null. */
  retry: TurnRetry | null;
  /* Its latest failed turn, or null. */
  failure: TurnFailure | null;
  obsolete?: TurnObsolete | null;
};

/* A role a department's employees hold, in its template's order; gate: where it stands among the default gates. */
export type DeptRole = { id: string; title: Lang; description: Lang; kind: 'head' | 'member'; gate: number | null; schema?: 'before_work' | 'final_check' | 'observer' | null };

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
  /* The person who takes its approvals; none means the CEO. */
  ownerPersonId?: string | null;
};

export type { ApprovalChannel, ApprovalMode };
/* How a department's approvals go on one channel: every one, only new kinds, or none up to a limit. */
export type ApprovalRule = { channel: ApprovalChannel } & ChannelRule;
/* A department's owner and rules as this person may see them; no owner means the CEO. */
export type ApprovalPolicyView = {
  departmentId: string;
  owner: { id: string; name: string } | null;
  canSetOwner: boolean;
  canChangePolicy: boolean;
  /* Who the CEO may name: active people with access to the department. */
  candidates: { id: string; name: string; title: string }[];
  rules: ApprovalRule[];
};

/* The git repository a department's or product's agents clone; the token never comes back, only its last four. */
export type Repository = { url: string; branch: string; tokenLast4: string | null; author?: { name: string; email: string } | null; testMemoryGb?: number; fullTestCommand?: string | null };

/* What a department or a product keeps for its agents: its way of working and its repositories. connected: the one its
   agents get cloned, as its repository settings name it. */
export type BriefingRepository = { url: string; branch: string; rules: string; author: { name: string; email: string } | null };
export type Briefing = {
  text: string;
  repositories: BriefingRepository[];
  connected: { url: string; branch: string; author: { name: string; email: string } | null } | null;
  updatedAt: string | null;
  by: { name: string | null; byOrchestrator: boolean } | null;
};

export type Org = {
  company: Company;
  /* limitUntil: his plan is at its limit until then, and he waits for the reset. */
  orchestrator: { id: string; name: string; model: string; effort: string | null; subscription: SubView | null; machine?: Machine | null; context: number | null; limitUntil?: string | null; held?: { reason: 'limit' | 'budget'; since: string; until: string } | null; program: ProgramView | null; alarm: TurnAlarm | null; retry: TurnRetry | null; failure: TurnFailure | null } | null;
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
  /* The plan used the share set for tasks until then; workers' task turns wait, people's messages still go. */
  budgetUntil?: string | null;
  /* The oldest turn its plan holds, and why. */
  held?: { reason: 'limit' | 'budget'; since: string; until: string } | null;
  /* Its machine gets ready for an update; new turns wait for it, and people may still write. */
  machineDrain?: MachineDrain | null;
  /* Its machine is short of free memory for its program to start; its turns wait and go on by themselves after. */
  memoryWait?: boolean;
  reason: 'no_subscription' | 'waiting_machine' | 'needs_login' | 'needs_setup' | 'node_outdated' | 'machine_offline' | null;
  browserError?: string | null;
  busy: boolean;
  runningJobId: string | null;
  queued: number;
  /* Its node shows the agent's live terminal; older nodes do not. */
  terminal?: boolean;
  /* This person types into that terminal, as the owner of the agent's plan. The agent's own window gets it. */
  canType?: boolean;
  /* Why the last prompt its program took has no turn, until a new turn begins; older servers do not say. */
  turnRefused?: TurnRefusal | null;
};

/* One instruction part: identity and notebook are read-only; assignment and skill bodies can be edited. */
export type Part = { kind: 'header' | 'base' | 'assignment' | 'skill' | 'notebook'; id: string | null; title: Lang | null; text: string; overridden: boolean; templateChanged: boolean };

export type CardSkill = { id: string; title: Lang; description: Lang; on: boolean; locked: boolean; overridden: boolean; templateChanged: boolean };

/* An agent's card: what it is, where it runs and the text it runs with. The orchestrator has no role and no skills. */
/* Why a node restarted, as far as Hornhoof could tell. */
export type RestartCause = 'server' | 'update' | 'machine' | 'container' | 'program' | 'connection' | 'unknown';

export type AgentCardView = {
  id: string;
  currentTask: { id: string; number: number; title: string } | null;
  kind: 'orchestrator' | 'head' | 'worker';
  name: string;
  role: { id: string; title: Lang; description: Lang; effort?: RoleEffort } | null;
  department: { id: string; name: string } | null;
  product: { id: string; name: string } | null;
  team?: { id: string; name: string } | null;
  teams?: { id: string; name: string }[];
  model: string;
  /* The level a person picked, or null for the Default. */
  effort: string | null;
  subscription: SubView | null;
  /* The machine its program runs on; none before its first turn, or on a key. */
  machine: Machine | null;
  state: AgentState;
  program?: ProgramView | null;
  alarm?: TurnAlarm | null;
  held?: { reason: 'limit' | 'budget'; since: string; until: string } | null;
  retry: TurnRetry | null;
  failure: TurnFailure | null;
  obsolete?: TurnObsolete | null;
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
  /* forWork: it skips a round while every open task waits on purpose and nothing failed since the last one. */
  timer: { minutes: number; order: string; forWork: boolean; lastAt: string | null } | null;
};

/* A subscription or key that may serve a department, with the models it runs. */
export type Serving = { id: string; provider: ProviderId; kind: 'personal' | 'api_key'; label: string; owner: string; models: ModelOption[] };

/* A role of a department's template; subscription: the first one serving the department that runs the role's tier;
   required: Operations must always have it; holder: who is in that required role now. */
export type RoleOption = { id: string; title: Lang; kind: 'head' | 'member'; tier: 'top' | 'deep' | 'standard' | 'fast'; perProduct: boolean; skills: string[]; subscription: string | null; required: boolean; holder: string | null };

/* A line of a staff card. Left out: the name is the role's title, the subscription the role's first, the model Default. */
export type StaffLine = { role: string; name?: string; product?: string | null; model?: string; subscription?: string | null; skills?: { on?: string[]; off?: string[] } | string[]; checked?: boolean };

/* The default roster of a department and what its card can pick from. */
export type Roster = { people: StaffLine[]; roles: RoleOption[]; products: { id: string; name: string }[]; subscriptions: Serving[] };

/* An item of the orchestrator's card: a department to create from a template, or a change to one that exists. */
/* staff: the department comes with the people of its template. */
export type NewItem = { template: TemplateKey; name?: string; checked: boolean; note: string; products?: string[]; staff?: boolean };
export type ChangeItem = { department: string; checked: boolean; note: string; products?: string[]; remove?: boolean };
export type StructureItem = NewItem | ChangeItem;

/* Who a pulse on the map runs between. */
export type Endpoint = { kind: 'person'; id: string } | { kind: 'orchestrator' } | { kind: 'department'; id: string } | { kind: 'agent'; id: string; departmentId: string };

export type AgentEventKind = 'program' | 'message' | 'text' | 'tool' | 'tool_result' | 'todo' | 'proposal' | 'applied' | 'stopped' | 'failed' | 'computer' | 'typed' | 'turn_refused' | 'input_left';
export type TurnRefusal = 'busy' | 'unknown_words';

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
  message?: { direction: 'in' | 'out'; from: MessageParty; to: MessageParty; notification?: Notification; senders?: MessageParty[]; revision?: number; originSeq?: number };
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
  /* A department's list of work kept for later turns changed. */
  | { type: 'backlog'; spot: { departmentId: string | null } }
  | { type: 'context'; agentId: string; used: number }
  /* A plan's owner finished or gave up a sign-in on one of its machines; only the owner hears it. */
  | { type: 'subscription.signin'; subscriptionId: string; nodeId: string; ok: boolean; error: string | null; owner: string };

export type TaskStatus = 'planned' | 'open' | 'working' | 'review' | 'waiting' | 'blocked' | 'done' | 'cancelled';
export type AgentRef = { id: string; name: string; kind: 'orchestrator' | 'head' | 'worker'; role: Lang | null };
export type TaskPlace = { id: string; name: string } | null;

/* A task as lists show it, with its required current route. */
export type TaskLine = {
  echelons: EchelonsSnapshot;
  id: string;
  number: number;
  title: string;
  brief: string;
  status: TaskStatus;
  externalWait?: ExternalWait | null;
  /* Paused work wakes nobody until it is resumed; root is the task the pause was placed on. */
  paused?: { at: string; reason: string; root: string } | null;
  /* What kind of work it is and what a mistake in it would cost, when someone said so. An older server sends neither. */
  workKind?: WorkKind | null;
  riskClass?: RiskClass | null;
  department: TaskPlace;
  product: TaskPlace;
  assignee: AgentRef | null;
  turn: number | null;
  parentId: string | null;
  /* The numbers of the tasks it comes after that are not done yet: until they are, it waits. */
  waitsFor: number[];
  independentPart?: ({ title: string; brief: string; body: string; executor: AgentRef; task: { id: string; number: number; title: string; status: TaskStatus } } | { reason: string }) | null;
  createdAt: string;
  updatedAt: string;
};

/* by.for: the person the orchestrator acted for. */
export type TaskLogLine = { kind: string; text: string; data: unknown; by: { kind: 'person' | 'agent'; id: string; name: string; for?: { id: string; name: string } } | null; at: string };
export type TaskRequest = { id: string; kind: 'question' | 'choice' | 'approval' | 'stuck'; text: string; commit: string | null; status: string; answer: string | null; agent: AgentRef | null; at: string };
export type TaskFile = { id: string; name: string; size: number; by: { id: string; name: string } | null; at: string };

export type TaskDetail = TaskLine & {
  echelonFindings: EchelonFindingsView;
  /* The person reading it may pause and resume it. */
  mayPause?: boolean;
  body: string;
  parent: { id: string; number: number; title: string } | null;
  /* The tasks of its turn it comes after, and where each stands. */
  after: { id: string; number: number; title: string; status: TaskStatus }[];
  executor: AgentRef | null;
  createdBy: { kind: 'person' | 'agent'; id: string; name: string } | null;
  subtasks: TaskLine[];
  log: TaskLogLine[];
  requests: TaskRequest[];
  files?: TaskFile[];
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

export type MaterialStampView = {
  materialRevision?: MaterialManifest['materialRevision'] | null;
  materialDigest?: MaterialManifest['materialDigest'] | null;
  hasMaterials?: boolean;
};

export type WaitingRequest = MaterialStampView & {
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
  /* The person whose decision it is: whose card counts it and whose filter shows it. */
  ownerPersonId: string;
  /* Whether this person may take it; the server checks it again. Who takes it; an older server sends none. */
  canAnswer: boolean;
  decidedBy?: DecidedBy;
};

/* Who takes a decision: the CEO and the CEO delegate, and also the people of its department or its owner. */
export type DecidedBy = { kind: 'ceo_and_delegate' | 'department_and_ceo' | 'owner_and_ceo'; department: { id: string; name: string } | null };

/* A card of the orchestrator that waits for people: a structure to build, or people to hire into a department. */
export type ProposalDecision = MaterialStampView & {
  id: string;
  agent: { id: string; name: string };
  department: { id: string; name: string } | null;
  brief: string;
  at: string;
  ownerPersonId: string;
  canAnswer: boolean;
  decidedBy?: DecidedBy;
} & ({ kind: 'structure'; items: StructureItem[] } | { kind: 'staff'; items: StaffLine[] });

/* The orchestrator's request for the computer the server runs on, which people of the whole company see and the CEO and
   the delegate answer. */
export type ComputerAccessDecision = { kind: 'computer_access'; id: 'server'; agent: { id: string; name: string }; ownerPersonId: string; canAnswer: boolean; decidedBy?: DecidedBy; at: string; view: ComputerView };

/* A machine with agents on it that went away: for its owner and the CEO, closed by itself once back is set. */
export type MachineAwayCard = {
  id: string;
  hostname: string;
  owner: { id: string; name: string } | null;
  since: string;
  back: string | null;
  agents: number;
  important: { name: string; kind: 'orchestrator' | 'head' }[];
};

/* Everything that waits for people as /api/requests shows it to this person, and the counts of all of it: per owner, per
   asking agent and in total. */
export type Decisions = {
  requests: WaitingRequest[];
  proposals: ProposalDecision[];
  computerAccess: ComputerAccessDecision | null;
  machinesAway?: MachineAwayCard[];
  counts: { byPerson: Record<string, number>; byAgent: Record<string, number>; total: number };
};

/* A turn as the orchestrator laid it out: a short title, its main point, and the people's own words it came from (only for
   people who see the whole company). Planned turns wait in number order. */
export type TurnMode = 'echelons' | 'turnkey';

export type TurnView = {
  id: string;
  number: number;
  title: string;
  goal: string;
  status: 'planned' | 'open' | 'closed';
  /* How the turn runs, fixed once it starts: through the stages, or by one employee of a turnkey team alone. */
  mode: TurnMode;
  messages: { by: string; text: string; at: string }[];
  taskId: string | null;
  startedAt: string;
  openedAt: string | null;
  closedAt: string | null;
  tasks: { total: number; done: number };
};

/* The departments whose tasks a person reads, and whether they have the whole company. */
export type TaskDepartments = { whole: boolean; departments: { id: string; name: string | null; templateKey: TemplateKey | null }[] };

/* What people of a department keep for a later turn: not work yet, until it goes into a turn. */
export type BacklogItem = { id: string; departmentId: string; title: string; text: string; by: { id: string; name: string }; at: string };

export type Machine = { id: string; hostname: string };

export type { MachineDrain, NodeWait };
/* Why a machine dropped: as the server saw it, or as the machine did when the server saw only its new connection. */
export type DropCause = ConnectionEnd | NodeDisconnectCause;

/* One connection of a machine that broke; report: what the machine said of it when back, none from a node from before. */
export type NodeDropView = {
  nodeId: string;
  subscriptionId: string | null;
  at: string;
  back: string | null;
  offlineMs: number | null;
  cause: ConnectionEnd;
  closeCode: number | null;
  closeReason: string | null;
  error: string | null;
  report: NodeReconnect | null;
};

/* The connections of a machine that broke together; back and offlineMs are none while one of them is away. */
export type MachineDrop = { at: string; back: string | null; offlineMs: number | null; cause: DropCause; drops: NodeDropView[] };

/* What GET /api/machines/:id/connections answers: the last day in short, and the latest drops, newest first. */
export type ConnectionHistory = { summary: { drops: number; averageMs: number | null; cause: DropCause | null }; events: MachineDrop[] };

export type MachineView = {
  id: string;
  hostname: string;
  os: string;
  arch: string;
  owner: { id: string; name: string };
  online: boolean;
  lastSeenAt: string | null;
  /* The plans that run on it, with their state there; none: it only lends itself to test runs. */
  plans: { id: string; provider: ProviderId; status: PlanStatus; online: boolean }[];
  /* What its nodes said last about how busy it is; none while no node of it is connected. */
  load: NodeLoad | null;
  /* Takes the company's test runs when it is the freest machine. */
  lendsTests: boolean;
  running: Running;
  /* Older servers omit program snapshots. */
  programs?: ProgramInfo[] | null;
  /* The node builds of its nodes online that are not the server's own node build, null for one that says none; null
     while all are, or while the server tells none apart. */
  otherBuild?: { server: string; nodes: (string | null)[] } | null;
  /* Why Playwright's browser failed to start on the machine, or null when it is ready. */
  browserError?: string | null;
  /* Older servers omit it; null while no update waits on the machine. */
  drain?: MachineDrain | null;
};

/* What runs on a machine now: the employees whose program is there, busy while a turn of theirs runs, and the parts of
   runs it takes, of tests or of other work. */
export type RunningAgent = {
  id: string;
  canOpen: boolean;
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
/* canAnswer: this person opens, closes or declines it; an older server sends none, as only the CEO saw it. */
export type ComputerView = { available: boolean; until: string | null; asked: { reason: string; at: string } | null; machine?: string | null; canAnswer?: boolean };
export type ShownCommand = { id: string; kind: 'machine' | 'plans' | 'add'; plans: string[]; subscriptionIds?: string[]; dismissedSubscriptionIds?: string[]; machineId?: string | null; machine: string | null; command: string; expiresAt: string };

/* The node that comes with the server, for those who see the whole company. */
/* machine: the company's machine it runs on, when the server is on one; the pool counts that computer once. */
export type BuiltinView = { online: boolean; load: NodeLoad | null; running: Running; machine?: Machine | null; programs?: ProgramInfo[] | null; browserError?: string | null; drain?: MachineDrain | null };

export type JobView = {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'obsolete';
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
export type UpdaterStatus = { id: string; version: string; commit?: string; state: 'running' | 'done' | 'failed' | 'rolled_back'; step: UpdateStep; log: string; at: string };
export type UpdatesView = {
  current: { version: string; commit: string; migrations: number };
  available: boolean;
  checkedAt: string | null;
  latest: Build | null;
  versions: Build[];
  error: string | null;
  updater: { present: boolean; status: UpdaterStatus | null; waiting: { version: string; commit?: string } | null };
  /* What each node waits for before it is replaced. A server from before this says nothing. */
  nodeWaits?: NodeWait[];
};

/* A note of the company notebook or a department's, and who wrote it last: a person, the orchestrator or the head. */
export type NoteView = { number: number; text: string; by: { kind: 'orchestrator' } | { kind: 'person' | 'agent'; id: string; name: string } | null; updatedAt: string };

export type SegmentKind = 'work' | 'after' | 'person' | 'stall' | 'lost' | 'alarm' | 'queued' | 'unknown';
export type { ExternalWait } from '@hornhoof/protocol/waits';
export type TreeSegment = { kind: SegmentKind; from: string; to: string | null; program?: Pick<TurnProgram, 'state' | 'since' | 'tool'>; alarm?: TurnAlarm; waitsForAgent?: TreeAgent; externalWait?: ExternalWait };
export type TreeMove = { kind: string; at: string; text: string };
export type TreeAgent = { id: string; name: string };
export type TreeLine = {
  echelons: EchelonsSnapshot;
  echelonFindings: EchelonFindingsView;
  ownerSince: string;
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
  externalWait?: ExternalWait | null;
};
export type AgentTime = { agent: TreeAgent; work: number; after: number; person: number; stall: number; lost?: number; alarm?: number; queued?: number; unknown?: number };
export type IdleStretch = { agent: TreeAgent; taskId: string; number: number; title: string; kind: Exclude<SegmentKind, 'work'>; from: string; to: string | null; waitsFor: number[]; question: string | null; program?: TreeSegment['program']; alarm?: TurnAlarm; waitsForAgent?: TreeAgent; externalWait?: ExternalWait };
export type TreeActivity = { jobId: string; agent: TreeAgent; task: { id: string; number: number; title: string } | null; segments: TreeSegment[] };
export type DepartmentTree = {
  now: string;
  turn: { id: string; number: number; branch: string; startedAt: string } | null;
  repository: boolean;
  lines: TreeLine[];
  activity?: TreeActivity[];
  waiting?: { agent: TreeAgent; waitsForAgent: TreeAgent; from: string; kind: 'stall' | 'after'; taskId: string; number: number; title: string }[];
  time: AgentTime[];
  idle: IdleStretch[];
};

/* Where the public link's encryption ends, as GET /api/link says: the tunnel's mode, whether the company's machine holds
   the link's own certificate, when it ends, and when the last try to get one failed. */
export type TlsView = { mode: 'http' | 'https'; certificate: boolean; expiresAt: string | null; failedAt: string | null };
