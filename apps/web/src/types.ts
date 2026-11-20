import type { ApiProtocol, TaskPriority } from '@hornhoof/protocol';
import type { EchelonFindingsView, EchelonStage } from '@hornhoof/protocol/echelons';
import type { EchelonsSnapshot } from '@hornhoof/protocol/echelons';
import type { ApprovalChannel, ApprovalMode, ApprovalRule as ChannelRule } from '@hornhoof/protocol/approval-policy';
import type { ExternalWait, TaskWaitFact, WaitSourceKind } from '@hornhoof/protocol/waits';
import type { SigninStep } from '@hornhoof/protocol/signin';
import type { Notification } from '@hornhoof/protocol';
import type { ConnectionEnd, DepartmentTurnProgress, DiskReport, FailureKind, Limits, MachineDrain, MachineReplicas, MaterialManifest, ModelOption, NodeWait, NodeDisconnectCause, NodeLoad, NodeReconnect, ProgramInfo, ProviderId, TemplateKey } from '@hornhoof/protocol';
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
  /* None for an assistant, which never signs in. */
  email: string | null;
  title: string;
  status: Person['status'];
  isOwner: boolean;
  isCeoDelegate?: boolean;
  access: AccessView;
  /* Who they are in Telegram, for the heads' bots: a username, the account's number, or both once a bot met them. */
  telegram?: { username: string | null; id: number | null } | null;
  /* On the map: how many decisions wait for this person among those the viewer sees; null when the viewer cannot see them. */
  pendingDecisions?: number | null;
  /* When this is an agent that acts for another person: whom for, its program, where it is woken and when its key was made. */
  assistant?: AssistantView | null;
};

export const ASSISTANT_PROGRAMS = ['avaclone', 'openclaw', 'hermes', 'other'] as const;
export type AssistantProgram = (typeof ASSISTANT_PROGRAMS)[number];
/* skillsUrl: where the assistant's own agent asks the program for its skills. agent: the agent that thinks for the assistant,
   and the plan it thinks on; null until its owner picks a plan. */
export type AssistantView = {
  owner: { id: string; name: string };
  program: AssistantProgram;
  eventsUrl: string | null;
  skillsUrl: string | null;
  key: { createdAt: string } | null;
  agent: { id: string; plan: string | null } | null;
};

/* What a person reaches: the whole company, or departments and teams, in the order of the map. */
export type AccessView = { whole: boolean; departments: { id: string; name: string }[]; teams: { id: string; name: string; departmentId: string }[] };

/* What the People screen sends for a person's access. */
export type AccessInput = { whole: true } | { departments: string[]; teams: string[] };

/* A plan's state on one machine: waiting for the login there, for the first setup of its program, or ready. */
export type PlanStatus = 'needs_login' | 'needs_setup' | 'ready';

/* A plan's connection after its sign-in code, as its node says it, for its owner: the step it is at, since when and until
   when it may take, and why it failed. */
export type Connecting = {
  nodeId: string;
  hostname: string;
  state: 'connecting' | 'failed' | 'too_long';
  step: SigninStep;
  since: string;
  until: string;
  error: string | null;
  code: number | null;
  line: string | null;
};

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
  /* The plans its employees go on to at its limit, in order, each with the model to run there or null for their role's;
     empty for any plan of the company with room. None from an older server. */
  fallbacks?: PlanFallback[];
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
  /* Where an API connection's program sends its calls and in which protocol; none for a plan or on an older server. */
  api?: { baseUrl: string; protocol: 'anthropic' | 'openai' } | null;
  /* The models it runs: an API connection's own, or the ones its node reported. */
  models?: ModelOption[];
  /* The place an API connection was given; none for a plan. */
  target?: { kind: 'orchestrator' | 'department' | 'team' | 'any'; id: string | null } | null;
  /* What its turns used, in the list alone, with today counted in UTC: an open card asks for its own day. */
  tokens?: TokenPeriods;
  /* Its connection after the sign-in code, for its owner; none when there is none. */
  connecting?: Connecting | null;
  /* In the list alone: this person changes and removes this API connection, as one of the whole company or as one who runs
     the department it serves. */
  canChange?: boolean;
};

/* What a subscription's turns used in a period: turns counts them all, noData those whose program told no tokens. */
export type TokenSum = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; turns: number; noData: number };
export type TokenPeriods = { today: TokenSum; week: TokenSum; month: TokenSum; all: TokenSum };
/* What one model's turns used of a connection in 30 days; model null for the turns that told none. */
export type ModelTokens = { model: string | null; total: number };

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
  turnkey?: boolean;
  title: Lang | null;
  kind: 'head' | 'worker';
  model: string;
  modelName: string | null;
  provider: ProviderId | null;
  apiProtocol?: ApiProtocol;
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
  /* Whether this person opens its window and card. Everyone sees every employee of the company and its work; its own
     window is for the people of its department. */
  opens?: boolean;
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
  /* Whether it or one of its products keeps a repository, for everyone, even where repository is out of reach: work without
     one goes in as documents. None said: an older server, read as code. */
  keepsRepository?: boolean;
  /* The GitHub key its repositories are created with, for the people who set them; none when no key is saved. */
  repoHost?: RepoHost | null;
  /* The person who takes its approvals and runs it as the CEO does; none means the CEO. */
  ownerPersonId?: string | null;
  /* The results accepted into its open turn, the next release, as far as this person sees them; none while it runs no turn
     or out of reach. */
  turnProgress?: DepartmentTurnProgress | null;
  pipelines?: DepartmentPipeline[];
  /* Its one-shot calls that wait or run now; startedAt: none while one waits for its turn on the machine. */
  calls?: CallMark[];
};

export type DepartmentPipeline = Omit<Pipeline, 'stages'> & { stages: DepartmentStage[] };
export type DepartmentStage = PipelineStage & {
  echelon?: EchelonStage;
  oneShot?: { fanOut: number; judge: boolean };
  ownerTitle?: Lang;
  handoffs?: Pick<Department, 'id' | 'name' | 'templateKey'>[];
};
export type CallMark = { id: string; number: number; judge: boolean; task: number; by: string; pipelineId?: string | null; stage: string | null; startedAt: string | null };

export type { ApprovalChannel, ApprovalMode };
/* How a department's approvals go on one channel: every one, only new kinds, or none up to a limit. */
export type ApprovalRule = { channel: ApprovalChannel } & ChannelRule;
/* A department's owner and rules as this person may see them; no owner means the CEO. */
export type AutonomousReleaseEntry = {
  id: string;
  departmentId?: string | null;
  taskId: string | null;
  taskNumber: number;
  agentId: string | null;
  agentName: string;
  commitSha: string;
  baseCommitSha?: string;
  testRunId: string | null;
  testRunNumber: number;
  reviewerAgentId: string | null;
  reviewerName: string;
  verdictStage: string;
  createdAt: string;
};

export type ApprovalPolicyView = {
  departmentId: string;
  owner: { id: string; name: string } | null;
  canSetOwner: boolean;
  canChangePolicy: boolean;
  autonomousRelease?: boolean;
  canSetAutonomousRelease?: boolean;
  hasAutonomousReleases?: boolean;
  /* Who the CEO may name: active people with access to the department. */
  candidates: { id: string; name: string; title: string }[];
  rules: ApprovalRule[];
};

/* The git repository a department's or product's agents clone; the token never comes back, only its last four. */
export type Repository = { url: string; branch: string; tokenLast4: string | null; author?: { name: string; email: string } | null; testMemoryGb?: number; fullTestCommand?: string | null };

/* A GitHub key Hornhoof creates repositories with: the user or organization they go to, and only the key's last four. */
export type RepoKey = { provider: 'github'; owner: string; tokenLast4: string };
/* The key a department's repositories are created with: its own, else the company's. */
export type RepoHost = RepoKey & { own: boolean };
export type GoogleSheetsConfig = { kind: 'service_account' | 'oauth'; account: string; shareEmail: string | null; keyLast4: string };

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
  orchestrator: { id: string; name: string; model: string; effort: string | null; subscription: SubView | null; machine?: Machine | null; context: number | null; limitUntil?: string | null; held?: { reason: 'limit' | 'budget'; since: string; until: string } | null; program: ProgramView | null; alarm: TurnAlarm | null; retry: TurnRetry | null; failure: TurnFailure | null; opens?: boolean; planned?: boolean } | null;
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

export type PlanFallback = { subscription: string; model: string | null };

export type AgentCardView = {
  id: string;
  currentTask: { id: string; number: number; title: string } | null;
  kind: 'orchestrator' | 'head' | 'worker' | 'assistant';
  name: string;
  role: { id: string; title: Lang; description: Lang; effort?: RoleEffort } | null;
  department: { id: string; name: string } | null;
  product: { id: string; name: string } | null;
  team?: { id: string; name: string } | null;
  teams?: { id: string; name: string }[];
  turnkey?: boolean;
  model: string;
  /* The level a person picked, or null for the Default. */
  effort: string | null;
  subscription: SubView | null;
  /* Hornhoof put it on its subscription for a while, as its own plan is at its limit: that plan, and until when as far as it
     is known; it goes back between turns after that. None from an older server. */
  fallback?: { home: SubView; until: string | null } | null;
  /* The machine its plan was heard from last while none of the plan's machines is online, and when; none while it can run. */
  offline?: OfflineMachine | null;
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
  runsOn: { subscription: SubView; models: ModelOption[] }[];
  changes: { field: string; personName: string | null; actingAgent: { id: string; name: string } | null; byOrchestrator: boolean; at: string }[];
  /* Its latest turns a node restart cut off, the latest first; node: none for the built-in node. */
  interrupted: { job: string; at: string; cause: RestartCause; node: string | null; task: { id: string; number: number } | null; retry: boolean }[];
  /* The whole company or the agent's department may change it; only the whole company removes it. */
  canEdit: boolean;
  /* The whole company or the owner of its department removes it. */
  canRemove: boolean;
  /* How many of its letters wait unread in its inbox; a card that does not say counts none. */
  inboxUnread?: number;
  /* Wakes every so many minutes, outside any task, to do its order; lastAt: the last round, or when it was set. */
  /* forWork: it skips a round while every open task waits on purpose and nothing failed since the last one. */
  timer: { minutes: number; order: string; forWork: boolean; lastAt: string | null } | null;
  /* The Telegram bot people write to it through, by its name; only heads and the orchestrator have one. */
  telegram?: { username: string } | null;
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
export type TurnRefusal = 'busy' | 'unknown_words' | 'machine_updating';

/* Who wrote or got a message: a person (id null: the company's people at large), an agent, or Hornhoof itself. */
export type MessageParty = {
  kind: 'person' | 'agent' | 'hornhoof';
  id: string | null;
  name: string;
  role: Lang | null;
  department: { id: string; name: Lang } | null;
  agentKind?: 'orchestrator' | 'head' | 'worker' | 'assistant';
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
  message?: { direction: 'in' | 'out'; from: MessageParty; to: MessageParty; notification?: Notification; senders?: MessageParty[]; revision?: number; originSeq?: number; channel?: 'telegram' | 'assistant'; assistant?: { id: string; name: string } };
};

/* An employee's inbox as its window shows it. A letter the employee dealt with is read to a person. */
export type InboxMode = 'inbox' | 'direct';
export type LetterKind = 'message' | 'report' | 'comment' | 'assignment' | 'notification';
export type InboxLetter = { id: string; sender: MessageParty; kind: LetterKind; source: string | null; task: { id: string | null; number: number; title: string | null } | null; receivedAt: string; text: string; unread: boolean };
/* mode: the employee's own choice, or null for its department's rule (the company's for one with none). */
export type InboxView = { unreadCount: number; total: number; letters: InboxLetter[]; more: boolean; mode: InboxMode | null; inheritedMode: InboxMode; effectiveMode: InboxMode; canChangeMode: boolean; canMarkRead: boolean };

/* What the browser hears live from /api/stream. */
export type StreamMessage =
  | { type: 'agent_event'; agentId: string; event: EventView }
  /* An employee's inbox changed; its window reads it again. */
  | { type: 'inbox'; agentId: string }
  | { type: 'working'; working: number }
  | { type: 'org' }
  | { type: 'notebook'; spot: { departmentId: string | null } }
  | { type: 'pulse'; from: Endpoint; to: Endpoint }
  | { type: 'task'; id: string; spot: { departmentId: string | null; parentId?: string | null } }
  /* A goal or a pipeline changed. */
  | { type: 'tracker' }
  | { type: 'requests' }
  /* The orchestrator's request for the computer changed; only the CEO's screen hears it. */
  | { type: 'computer' }
  | { type: 'improvements' }
  /* The feedback inbox of Hornhoof's own installation changed. */
  | { type: 'feedback' }
  /* A department's list of work kept for later turns changed. */
  | { type: 'backlog'; spot: { departmentId: string | null } }
  | { type: 'context'; agentId: string; used: number }
  /* A plan's owner finished or gave up a sign-in on one of its machines; only the owner hears it. */
  | { type: 'subscription.signin'; subscriptionId: string; nodeId: string; ok: boolean; error: string | null; code?: number | null; line?: string | null; owner: string }
  /* Where a plan's connection is after its sign-in code, or none once it ended; only the owner hears it. */
  | { type: 'subscription.connecting'; subscriptionId: string; connecting: Connecting | null; owner: string };

export type TaskStatus = 'open' | 'working' | 'review' | 'waiting' | 'blocked' | 'done' | 'cancelled';
export type AgentRef = { id: string; name: string; kind: 'orchestrator' | 'head' | 'worker' | 'assistant'; role: Lang | null };
export type TaskPlace = { id: string; name: string } | null;
export type PersonRef = { id: string; name: string };
/* What a task's time says, worked out on the server: since when it is in its status, how long its turns ran, and whom it
   waits for since when. */
export type TimeFacts = { inStatusSince: string; workSeconds: number; waitsOn: TaskWaitFact[] };
/* A task another one comes after, or that comes after it, and where it stands. */
export type TaskLink = { id: string; number: number; title: string; status: TaskStatus };

/* A task as lists show it, with its required current route. */
export type TaskLine = {
  echelons: EchelonsSnapshot;
  id: string;
  number: number;
  title: string;
  brief: string;
  status: TaskStatus;
  priority?: TaskPriority;
  externalWait?: ExternalWait | null;
  /* Paused work wakes nobody until it is resumed; root is the task the pause was placed on. */
  paused?: { at: string; reason: string; root: string } | null;
  /* What kind of work it is and what a mistake in it would cost, when someone said so. An older server sends neither. */
  workKind?: WorkKind | null;
  riskClass?: RiskClass | null;
  /* Said by the CEO or the owner of its department, never read from its words; the work under it is as urgent. */
  urgent?: boolean;
  department: TaskPlace;
  product: TaskPlace;
  assignee: AgentRef | null;
  /* The employee who writes it, when one does; the assignee holds it now, a reviewer at a gate among them. */
  executor?: AgentRef | null;
  turn: number | null;
  parentId: string | null;
  /* The numbers of the tasks it comes after that are not done yet: until they are, it waits. */
  waitsFor: number[];
  independentPart?: ({ title: string; brief: string; body: string; executor: AgentRef; task: { id: string; number: number; title: string; status: TaskStatus } } | { reason: string }) | null;
  /* What the tracker keeps: the goal it serves (a subtask, that of the task at the top of its work), who answers for it, why
     it exists, by when, its time, and the pipeline and stage it stands on. An older server sends none. */
  goal?: { id: string; number: number; title: string } | null;
  responsible?: PersonRef | null;
  why?: string;
  dueAt?: string | null;
  time?: TimeFacts;
  pipelineId?: string | null;
  pipelineStageId?: string | null;
  createdAt: string;
  updatedAt: string;
};

/* by.for: the person the orchestrator acted for. */
export type TaskLogLine = { kind: string; text: string; data: unknown; by: { kind: 'person' | 'agent'; id: string; name: string; for?: { id: string; name: string }; byOrchestrator?: true } | null; at: string };
export type TaskRequest = { id: string; kind: 'question' | 'choice' | 'approval' | 'stuck'; text: string; commit: string | null; status: string; answer: string | null; byOrchestrator?: boolean; agent: AgentRef | null; at: string };
/* big: over 50 MB, it lives 30 days on one machine and is lost if that machine goes. */
export type TaskFile = { id: string; name: string; size: number; by: { id: string; name: string } | null; at: string; big?: true };

export type TaskDetail = TaskLine & {
  echelonFindings: EchelonFindingsView;
  /* The person reading it may pause and resume it. */
  mayPause?: boolean;
  mayHideSecret?: boolean;
  body: string;
  parent: { id: string; number: number; title: string } | null;
  /* The tasks of its turn it comes after, and where each stands. */
  after: TaskLink[];
  /* The tasks that wait for this one, of those the reader sees. */
  neededFor?: TaskLink[];
  /* The person reading it acts on its work and may change what the tracker keeps of it; version and revision: what such a
     change names, the version of its work and the revision of what the tracker keeps. */
  mayEdit?: boolean;
  version?: number;
  revision?: number;
  executor: AgentRef | null;
  createdBy: { kind: 'person' | 'agent'; id: string; name: string } | null;
  subtasks: TaskLine[];
  log: TaskLogLine[];
  requests: TaskRequest[];
  files?: TaskFile[];
  /* The machine the holder's plan was heard from last while none of its machines is online. */
  assigneeOffline?: OfflineMachine | null;
};

/* A machine of a plan that is offline, and when it last spoke: none if it never did. */
export type OfflineMachine = { hostname: string; since: string | null };

/* An accepted or handed-in task of a department whose branch is not in main yet; merged null: the repository cannot tell. */
export type DepartmentBranch = { task: number; title: string; status: 'done' | 'review'; branch: string; commit: string; merged: false | null };
export type DepartmentBranches = { branches: DepartmentBranch[]; problem: string | null };

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

/* Something an employee found to improve. open waits for the CEO, taken is with the orchestrator, done is done, dismissed
   was set aside, sent went to Hornhoof's developers. scope: company for how the company works, platform for Hornhoof
   itself, with the error code Hornhoof gave if any. result: the orchestrator's word on what came of it. */
export type Improvement = {
  id: string;
  title: string;
  text: string;
  seen: number;
  status: 'open' | 'taken' | 'done' | 'dismissed' | 'sent';
  scope: 'company' | 'platform';
  code: string | null;
  result: string | null;
  at: string;
  updatedAt: string;
  agent: { id: string; name: string };
  department: { id: string; name: string } | null;
  decidedBy: string | null;
  tasks?: { id: string; number: number; title: string }[];
  /* null for one filed as one text; an older server sends none. */
  parts?: ImprovementParts | null;
  /* What became of one sent to Hornhoof's developers, null for any other; an older server sends none. */
  sent?: SentFate | null;
};

/* When it went, its number in the inbox of Hornhoof's developers once it gave one, its issue there, the version that fixed
   it once this Hornhoof runs it, and how many more rounds found it since they last heard of it. */
export type SentFate = { at: string; number: number | null; issue: { number: number; url: string } | null; fixedIn: string | null; repeats: number };

export type FeedbackKind = 'bug' | 'improvement' | 'idea';
/* What goes to Hornhoof's developers, as the server cleaned it, with the technical data beside it, how much it hid of each
   kind and the digest that ties a press of Send to exactly this. */
export type FeedbackShown = {
  report: { kind: FeedbackKind; title: string; text: string; facts: { version: string; platform: string[]; errorCode: string | null } };
  hidden: { secret: number; email: number; address: number; path: number };
  digest: string;
};
/* A card of the inbox on Hornhoof's own installation: one report and its repeats, from how many installations. */
export type InboxCard = {
  id: string;
  /* What an installation calls the report by. */
  number: number;
  kind: FeedbackKind;
  title: string;
  text: string;
  errorCode: string | null;
  versions: string[];
  platforms: string[];
  signals: number;
  installations: number;
  priority: 'high' | 'normal' | 'low';
  firstAt: string;
  lastAt: string;
  issue: { number: number; url: string } | null;
};

export type MaterialStampView = {
  materialRevision?: MaterialManifest['materialRevision'] | null;
  materialDigest?: MaterialManifest['materialDigest'] | null;
  hasMaterials?: boolean;
};

/* What a release brings that no check covers, one item each, as Hornhoof wrote it on the approval card of the release: the
   commits between main and the release it could not all read, work whose checker or holder is off, work with no checked
   version, and commits or merges no checked work brought. */
export type UncheckedItem =
  | { kind: 'unread'; base: string; commit: string }
  | { kind: 'holder_off' | 'no_candidate' | 'task_unread' | 'unpinned' | 'unstarted'; task: number }
  | { kind: 'checker'; task: number; commit: string }
  | { kind: 'merge' | 'commit'; commit: string };

export type WaitingRequest = MaterialStampView & {
  id: string;
  kind: 'question' | 'choice' | 'approval' | 'stuck';
  text: string;
  commit: string | null;
  /* On the approval of a release, what it brings that no check covers, apart from the words above; shown next to Approve. An
     older server sends none. */
  unchecked?: UncheckedItem[] | null;
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
export type DecidedBy = { kind: 'ceo_and_delegate' | 'department_and_ceo' | 'owner_and_ceo' | 'machine_owner' | 'named_person'; department: { id: string; name: string } | null };

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

/* The orchestrator's request for a machine of the company, which its owner answers; id is the machine's. */

/* A card Hornhoof kept for this person until they say they saw it: a wait past its date that came up to them, a goal at
   risk, a turn that is over, or a version marked in the code that released nothing of its turn. Seeing it decides nothing.
   turn: the turn a summary or a tag is of, with the version it came out as; tag: what that version is named and why it
   released nothing. */
export type WaitCard = {
  id: string;
  about: 'late' | 'final_review' | 'goal_risk' | 'turn_summary' | 'release_tag';
  taskId: string | null;
  number: number | null;
  kind: WaitSourceKind | null;
  level: number | null;
  at: string;
  turn: { number: number; version: string | null } | null;
  tag: { version: string; why: 'unrecorded' | 'stale' } | null;
};

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

/* A machine short of disk space, whose node takes no new checks or builds since: for its owner and the CEO, gone by itself
   once the node has room again or is off the line. */
export type MachineLowCard = {
  id: string;
  hostname: string;
  owner: { id: string; name: string } | null;
  since: string;
  disk: DiskReport;
  /* The names of the company's employees whose work the machine keeps, by its folder. A server from before sends none. */
  names?: Record<string, string>;
};

/* Everything that waits for people as /api/requests shows it to this person, and the counts of all of it: per owner, per
   asking agent and in total. */
export type Decisions = {
  requests: WaitingRequest[];
  proposals: ProposalDecision[];
  machineAccess?: never[];
  /* The orchestrator's requests for machines. A server from before machines had access of their own sends none. */
  /* What merges left for the CEO alone. A server from before merges sends none. */
  merges?: MergeDecision[];
  machinesAway?: MachineAwayCard[];
  /* A server from before nodes said how full their disk is sends none. */
  machinesLow?: MachineLowCard[];
  counts: { byPerson: Record<string, number>; byAgent: Record<string, number>; total: number };
};

/* A turn is a release of its department: the open one takes in each result as it is accepted into its branch, and the tag of
   its release closes it with that version and commit. The people's own words it came from show only to people who see the
   whole company. */
export type TurnView = {
  id: string;
  number: number;
  title: string;
  goal: string;
  status: 'open' | 'closed';
  /* The version and commit its release was tagged with, and the release it went on from; none while it is open or before. */
  version: string | null;
  commit: string | null;
  baseVersion: string | null;
  /* The department whose turn it is; none only for a closed turn of a department that was removed. */
  departmentId: string | null;
  /* Whether that department keeps a repository, so the turn comes out as a release; the work of one without stays outside
     releases. */
  releases: boolean;
  messages: { by: string; text: string; at: string }[];
  taskId: string | null;
  startedAt: string;
  openedAt: string | null;
  closedAt: string | null;
  tasks: { total: number; done: number };
};

/* The departments whose tasks a person reads, and whether they have the whole company. mine: a department of the person's
   own, whose work and list for later turns they change. mayPlan: the person gives the department work and sets its goals
   and pipelines; mayPlanCompany: the company's goals. The server decides both; none said is no. */
export type TaskDepartments = { whole: boolean; mayPlanCompany?: boolean; departments: { id: string; name: string | null; templateKey: TemplateKey | null; mine: boolean; mayPlan?: boolean; responsible?: PersonRef | null }[] };

/* A goal: of the company with no department, or of one; it may be part of a bigger one. progress from 0 to 1: the number
   target when there is one, else the share of its tasks done; none while there is nothing to count. */
export type GoalStatus = 'active' | 'reached' | 'dropped';
export type GoalView = {
  id: string;
  number: number;
  title: string;
  why: string;
  department: PersonRef | null;
  parentId: string | null;
  responsible: PersonRef;
  target: number | null;
  current: number | null;
  unit: string;
  dueAt: string | null;
  status: GoalStatus;
  progress: number | null;
  done: number;
  total: number;
  version: number;
  /* The reader may change it, reach it or drop it, as the server decides; none said is no. */
  mayEdit?: boolean;
};

/* A department's pipeline: who hands work to whom, as a tree of stages in tree order. A stage's owner is a role of the
   department, or one of its employees. */
export type PipelineStage = { id: string; parentId: string | null; name: string; stockName?: string; ownerRole: string | null; owner: PersonRef | null; position: number };
/* mayEdit: the reader may change it, as the server decides; none said is no. */
export type Pipeline = { id: string; department: PersonRef; name: string; why: string; catalogKey?: string | null; isDefault?: boolean; stockName?: string; stockWhy?: string; archived: boolean; version: number; mayEdit?: boolean; stages: PipelineStage[] };

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

/* A restore of the company from a backup, as its keeper and its updater say it. */
export type RestoreStep = 'fetch' | 'check' | 'open' | 'load' | 'swap' | 'start';
export type RestoreStatus = { attempt: string; id: string; state: 'running' | 'done' | 'failed'; step: RestoreStep; line: string; at: string; kept: string | null };
/* A backup of the company. recovery: whether the recovery file saved now opens it, an older one does, or none.
   restorable with why null: it can be restored as it is; with needs_recovery_file: once that file is added. */
export type BackupBundle = {
  id: string;
  dumpedAt: string;
  reason: 'timer' | 'update' | 'fork';
  size: number;
  recovery: 'none' | 'current' | 'older';
  where: { machine: string | null; name: string; online: boolean }[];
  restorable: boolean;
  why: 'newer_build' | 'not_held' | 'needs_recovery_file' | null;
};
export type KeptMerge = { id: string; status: 'pending' | 'applied' | 'merged' | 'removing' | 'done'; added: number; conflicts: number; error: string | null };

/* A merge that left the CEO something to settle. after: the time of the backup a restore went back to, when the merge
   is of the database that restore set aside. */
export type MergeDecision = { id: string; label: string; after: string | null; open: number; ownerPersonId: string };
export type MergeTopic = 'people' | 'access' | 'plans' | 'machines' | 'protected' | 'work';
/* What a merge could not prove of one row, with both values in plain words; a secret is never among them. */
export type MergeConflict = {
  id: string; merge: string; label: string; table: string; topic: MergeTopic; what: string; kind: string; cols: string[];
  here: Record<string, string> | null; there: Record<string, string> | null; at: string | null;
  task: { id: string; number: number; title: string } | null; whose: 'orchestrator' | 'ceo'; picked: 'here' | 'there' | 'value' | null;
};
export type MergePicked = { settled: number; here: number; there: number; refused: { id: string; why: string }[]; tasks: { id: string; number: number }[] };

export type BackupsView = {
  last: string | null;
  recovery: { madeAt: string; madeBy: string } | null;
  recoveryNeeded: boolean;
  linkChanged: boolean;
  restore: RestoreStatus | null;
  /* The databases restores replaced and kept on the server, each with how far the bringing back of what it holds got. */
  kept: { name: string; at: string; merge?: KeptMerge | null }[];
  bundles: BackupBundle[];
};
/* What a restore to a backup's time undoes. */
export type RestoreWarning = { machines: { name: string; owner: string }[]; people: string[] };
/* A server set up anew that was given a recovery file: the backups sent to it so far. */
export type RecoveryView = { company: string; link: string | null; bundles: { id: string; dumpedAt: string; reason: string; size: number; from: string }[]; restore: RestoreStatus | null };

/* The CEO's request to move the server to another machine, and how far it is. machine: the machine asked to take it;
   leader: the name of the machine that led when it was asked; progress: how far that machine's copy is, while it is
   not up to date. */
export type MoveView = {
  machine: string;
  state: 'preparing' | 'switching' | 'failed';
  reason: 'no_answer' | 'not_ready' | 'behind' | 'no_link' | 'expired' | 'left' | null;
  leader: string;
  progress: number | null;
};

export type MachineView = {
  id: string;
  hostname: string;
  /* The machine the company was installed on, while the server runs on another: no computer someone joined. */
  serverInstall?: boolean;
  os: string;
  arch: string;
  owner: { id: string; name: string };
  online: boolean;
  lastSeenAt: string | null;
  /* The plans that run on it, with their state there; none: it only lends itself to test runs. */
  plans: { id: string; provider: ProviderId; status: PlanStatus; online: boolean }[];
  /* What its nodes said last about how busy it is; none while no node of it is connected. */
  load: NodeLoad | null;
  /* The copies of company databases it holds, inside Docker's volumes: none while unmeasured. Older servers omit it. */
  replicas?: MachineReplicas | null;
  /* The employees' working folders of each of its nodes, by the plan the node serves (none for the machine's own node), the
     biggest first: none of a node that says nothing of its disk. Older servers omit it. */
  folders?: { plan: string | null; bytes: number }[];
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
  checkError?: string | null;
  /* Older servers omit it; null while no update waits on the machine. */
  drain?: MachineDrain | null;
  /* The company's core on it: where the company opens on that machine, and how the machine reaches the server; null
     without the core. Older servers omit it. */
  core?: { webPort: number | null; path: 'direct' | 'relay' | null } | null;
  /* Its owner may put the company's core on it: it joined before machines had one, and its nodes are about. */
  needsCore?: boolean;
  /* Its computer access as this person sees it; null without the core, or when it is not theirs to see. */
  access?: ComputerAccessView | null;
  /* Whether its owner lets it keep the company's backups, and how many it holds; null without the core. Older servers
     omit them. */
  keepsBackups?: boolean | null;
  heldBackups?: number | null;
  /* Its part in holding the company's data, for those who see the whole company. Older servers omit it. */
  data?: DataView | null;
};

/* Why a machine holds no copy of the company's data. */
export type Unfit =
  | { why: 'phone' | 'no_core' | 'no_link' }
  | { why: 'scope'; person: string; departments?: number };

/* How a machine's copy of the company's data does. */
export type CopyLine =
  | { line: 'making' | 'remaking'; progress: number }
  | { line: 'ready' | 'catching_up' | 'saving' }
  | { line: 'behind'; minutes: number }
  | { line: 'asleep'; since: string | null }
  | { line: 'stopped'; why: 'disk_full' | 'setup' | null };

/* A machine's place in the order of who holds the company's data, why it holds no copy, how its copy does, when it
   stopped holding the data, and, for the machine the server last moved from, until when it ran the server, once its
   copy is up to date again. Older servers omit that last one. */
export type DataView = {
  number: number | null; why: string | null; pin: 'none' | number | null; unfit: Unfit | null; copy: CopyLine | null; leftAt: string | null; led?: { until: string } | null;
};

/* The question a machine that keeps a copy puts to the CEO when the machine that led stopped answering and the copies
   may lack changes. leader.heard: when it was last heard. copies: each copy that is up, with how far its changes
   reach. waiting: until when the CEO chose to wait. */
export type Question = {
  since: string;
  leader: { networkId: string; host: string; heard: string | null };
  copies: { networkId: string; host: string; number: number | null; reach: string | null; self: boolean }[];
  waiting: string | null;
};
export type QuestionView = { question: Question | null; canAnswer: boolean };

/* What the keeper of the machine the page came from says of where the company's server is going. self: that machine.
   from, to: the machine the server moves from and to; while cut, from is the server this machine's copy cannot reach.
   All are machine ids. */
export type SwitchWord = { self: string | null; moving: boolean; from: string | null; to: string | null; since: string | null; cut: boolean; question: boolean };

/* The newest move of the server, for a day after it: its machines by their names, when the machine that led was last
   heard, and how far the changes of the one that took the server reached. */
export type Switched = { id: string; kind: 'planned' | 'takeover' | 'ceo'; reason: string | null; from: string; to: string; heard: string | null; reach: string | null; at: string };

/* Who holds the company: the machine that leads, those that keep a copy, the one commits wait for marked, and since
   when only the leader holds the changes. */
export type CopiesView = { leader: string; copies: { hostname: string; sync: boolean }[]; onlySince: string | null };

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
/* A machine of the company that has its core. hostname: the name its computer told, or none. data: it keeps the company's
   data. */
export type AccessMachine = { id: string; networkId: string; name: string; hostname: string; personId: string; role: 'data' | 'worker' | null; os: 'linux' | 'darwin' | null; data: boolean };
/* Computer access to a connected machine, including the owner's switch and the orchestrator's employee grants. */
export type ComputerAccessView = {
  machine: AccessMachine;
  reachable: boolean;
  open: boolean;
  canOpen: boolean;
  canClose: boolean;
  scope: 'orchestrator' | 'all_agents' | null;
  employees: { employeeId: string; taskId: string }[];
};
export type ShownCommand = { id: string; kind: 'machine' | 'plans' | 'add' | 'core'; plans: string[]; subscriptionIds?: string[]; dismissedSubscriptionIds?: string[]; machineId?: string | null; machine: string | null; command: string; expiresAt: string };

/* The node that comes with the server, for those who see the whole company. */
/* machine: the company's machine it runs on, when the server is on one; the pool counts that computer once. */
/* webPort: where the company opens on the server's own machine. refusedBy: the machines on the server's network whose
   connections it did not take. Older servers omit both. */
export type BuiltinView = { online: boolean; load: NodeLoad | null; replicas?: MachineReplicas | null; running: Running; machine?: Machine | null; programs?: ProgramInfo[] | null; browserError?: string | null; checkError?: string | null; drain?: MachineDrain | null; webPort?: number | null; refusedBy?: string[]; access?: ComputerAccessView | null };

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
export type UpdateStep = 'backup' | 'pull' | 'promise' | 'install' | 'health' | 'rollback' | 'finished';
export type UpdaterStatus = { id: string; version: string; commit?: string; state: 'running' | 'done' | 'failed' | 'rolled_back'; step: UpdateStep; log: string; at: string };
/* A running turn by its agent's name and its task's number. */
export type NamedTurn = { agent: string; task: number | null };
/* An update that waits for the agents: until is when it is called off unless they finished. lost: the turns it does not
   wait for, as their node said nothing of their program for ten minutes. */
export type UpdateWaiting = { version: string; commit?: string; since: string; until: string; turns: NamedTurn[]; lost: NamedTurn[] };
/* An update that went to nobody, with the turns that still ran and until when it waited. deadline: the agents had not
   finished by then. cancelled: a person or the orchestrator called it off. failed: Hornhoof could not pass it to the
   updater, error says why. */
export type UpdateCalledOff = { version: string; commit?: string; at: string; until: string; reason: 'deadline' | 'cancelled' | 'failed'; turns: NamedTurn[]; error?: string };

export type UpdatesView = {
  current: { version: string; commit: string; migrations: number };
  available: boolean;
  checkedAt: string | null;
  latest: Build | null;
  versions: Build[];
  error: string | null;
  updater: { present: boolean; status: UpdaterStatus | null; waiting: UpdateWaiting | null; calledOff: UpdateCalledOff | null };
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
