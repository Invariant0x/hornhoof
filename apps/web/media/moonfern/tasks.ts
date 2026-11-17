import { emptyEchelonFindings } from '@hornhoof/protocol/echelons';
import type { AgentRef, Decisions, GoalView, PersonRef, Pipeline, TaskDepartments, TaskDetail, TaskLine, TaskLogLine, TaskStatus, TurnView, WaitingRequest } from '../../src/types';
import { PLACEMENTS } from './agents';
import { BASE_ISO, isoMinutes } from './clock';
import { LEO_VIEW, MAYA_VIEW, SAM_VIEW } from './people';
import { routeAt } from './route';

const refOf = (agentId: string): AgentRef => {
  const p = PLACEMENTS.find(x => x.employee.id === agentId)!;
  return {
    id: p.employee.id,
    name: p.employee.name,
    kind: p.employee.kind,
    role: p.employee.title,
  };
};

const PLACES = {
  dev: { id: 'dept-dev', name: 'Development' },
  dsn: { id: 'dept-dsn', name: 'Design' },
  mkt: { id: 'dept-mkt', name: 'Marketing' },
  ops: { id: 'dept-ops', name: 'Operations' },
  biz: { id: 'dept-biz', name: 'Business development' },
};

type TaskSeed = [
  number: number,
  title: string,
  brief: string,
  dept: keyof typeof PLACES,
  agentId: string,
  status: TaskStatus,
  stage?: number,
  waitsFor?: number[],
  bounces?: number,
];

/* 40 tasks in Turn 6 ("Launch the iOS beta"): 24 done (60%), 16 active across waiting, review, working and blocked. */
const TURN_6_SEEDS: TaskSeed[] = [
  /* Active / waiting / in review / in progress (16) */
  [230, 'Onboarding plant card layout', 'Design three layout variants for the first-plant card on iPhone.', 'dsn', 'dsn-1', 'waiting', 0],
  [225, 'Import plants from CSV and Apple Notes', 'Parse exported plant lists and map species names to care profiles.', 'dev', 'dev-5', 'waiting', 0],
  [218, 'Merge watering reminder engine to main', 'Approve exact release commit for local notification scheduling.', 'dev', 'dev-head', 'waiting', 0],
  [214, 'Run iOS beta smoke suite on TestFlight build', 'Verify camera capture, offline journal sync and reminder delivery.', 'dev', 'dev-test', 'review', 3],
  [215, 'Audit signed photo upload URLs', 'Ensure presigned S3 upload policies expire in 5 minutes and scope to user.', 'dev', 'dev-sec', 'review', 2],
  [216, 'Offline care schedule conflict resolver', 'Merge edits when a plant is marked watered on two devices offline.', 'dev', 'dev-2', 'review', 1],
  [217, 'Latin and common name fuzzy search tokenizer', 'Match nicknames like Swiss cheese plant to Monstera deliciosa.', 'dev', 'dev-3', 'review', 1],
  [219, 'Sync schema for offline watering logs', 'Define compact delta frames for watering, misting and fertilizing.', 'dev', 'dev-arch', 'working', 0],
  [220, 'Profile cold start and CoreML leaf model memory', 'Keep launch under 420 ms and peak model footprint below 95 MB.', 'dev', 'dev-perf', 'working', 0],
  [221, 'Plant identification camera flow', 'Frame guide, indoor white-balance normalization and top-3 species cards.', 'dev', 'dev-1', 'working', 0],
  [222, 'Local push reminders for watering schedules', 'Group morning reminders into one quiet notification at the user hour.', 'dev', 'dev-2', 'working', 0],
  [223, 'Soil moisture chart and care streak card', 'Render 30-day moisture curve and gentle streak recovery.', 'dev', 'dev-3', 'working', 0, [], 1],
  [224, 'Sunlight meter calibration on iPhone', 'Map rear camera exposure readings to low, medium and bright indirect light.', 'dev', 'dev-4', 'working', 0],
  [226, 'Batch photo upload compression', 'Encode journal photos to WebP on background threads before sync.', 'dev', 'dev-6', 'working', 0],
  [227, 'Shareable plant care card for friends', 'Generate plant-sitter link with watering instructions while away.', 'dev', 'dev-7', 'blocked', 0, [221]],
  [231, 'App Store 6.9-inch beta screenshots', 'Compose five light-mode iPhone screenshots with real botanical copy.', 'dsn', 'dsn-2', 'working', 0],

  /* Done in Turn 6 (24 of 40 = 60%) */
  [194, 'Set up TestFlight internal and external beta groups', 'Configure App Store Connect beta groups and build metadata.', 'ops', 'ops-head', 'done'],
  [195, 'CoreML leaf classifier quantized weights bundle', 'Ship int8 classifier weights under 18 MB inside app bundle.', 'dev', 'dev-1', 'done'],
  [196, 'Room grouping and window orientation picker', 'Let users group plants by room and window direction.', 'dev', 'dev-4', 'done'],
  [197, 'Seasonal watering interval adjustments', 'Lengthen watering intervals automatically during winter daylight hours.', 'dev', 'dev-2', 'done'],
  [198, 'Toxic-to-pets warning badge on species sheet', 'Highlight cats and dogs toxicity from verified botanical reference.', 'dev', 'dev-6', 'done'],
  [199, 'Crash reporting symbol upload pipeline', 'Upload dSYM bundles automatically on each tagged beta build.', 'ops', 'ops-fix', 'done'],
  [200, 'Onboarding three-step room and light quiz', 'Keep sign-up optional and save first plant locally right away.', 'dev', 'dev-3', 'done'],
  [202, 'Watering snooze actions on lock screen', 'Support Watered now and Remind tomorrow from iOS notification.', 'dev', 'dev-2', 'done'],
  [203, 'Custom pot drainage and soil mix selector', 'Adjust moisture decay for terracotta, ceramic and nursery pots.', 'dev', 'dev-5', 'done'],
  [204, 'Leaf progress photo timeline scrubber', 'Compare growth photos month over month with swipe slider.', 'dev', 'dev-1', 'done'],
  [205, 'App icon light and tinted iOS 18 variants', 'Export crisp fern emblem in standard, dark and tinted layers.', 'dsn', 'dsn-3', 'done'],
  [206, 'Empty shelf illustration and first-plant prompt', 'Warm botanical line art before any plant is added.', 'dsn', 'dsn-1', 'done'],
  [207, 'Typography scale and Dynamic Type audit', 'Ensure every care card scales cleanly up to AX3.', 'dsn', 'dsn-3', 'done'],
  [208, 'Beta waitlist landing page at moonfern.app/beta', 'Fast static page with TestFlight signup and privacy promise.', 'mkt', 'mkt-write', 'done'],
  [209, 'Top 30 houseplant care reference slugs', 'Structured care guides for pothos, monstera, snake plant and ZZ.', 'mkt', 'mkt-seo', 'done'],
  [210, 'TestFlight welcome email and feedback reply address', 'Plain-text note from Maya, Leo and Sam with one-tap bug link.', 'mkt', 'mkt-write', 'done'],
  [211, 'Neighborhood plant shop QR tent card', 'Printable counter card for five partner shops in Portland and Seattle.', 'biz', 'biz-head', 'done'],
  [212, 'Nursery partner beta cohort list', 'Confirm 12 independent plant shops testing care cards with buyers.', 'biz', 'biz-analyst', 'done'],
  [213, 'SQLite WAL migration check on iOS upgrade', 'Test zero-data-loss migration from prototype schema v2 to v6.', 'dev', 'dev-arch', 'done'],
  [228, 'APNs token rotation and sandbox fallback', 'Route TestFlight builds to production push gateway cleanly.', 'ops', 'ops-head', 'done'],
  [229, 'Color contrast pass on sunlight and moisture chips', 'Pass WCAG AA contrast on all status pills in daylight.', 'dsn', 'dsn-head', 'done'],
  [232, 'Watering badge icons and leaf palette tokens', 'Ship shared SVG icon tokens to iOS asset catalog.', 'dsn', 'dsn-3', 'done'],
  [233, 'Alert on crash-free session dip below 99.5%', 'Page Operations if beta crash-free rate drops on a new build.', 'ops', 'ops-fix', 'done'],
  [234, 'Privacy nutrition labels verification', 'Confirm zero third-party trackers and accurate photo usage strings.', 'ops', 'ops-watch', 'done'],
];

if (TURN_6_SEEDS.length !== 40 || TURN_6_SEEDS.filter(s => s[5] === 'done').length !== 24) {
  throw new Error('Moonfern Turn 6 must have 40 tasks with 24 done.');
}

/* Work after Turn 6 nobody has started yet, and the three parts of the camera flow, #221. */
const LATER_SEEDS: TaskSeed[] = [
  [241, 'Background sync retry backoff on cellular', 'Back off sync retries on weak cellular so the battery lasts the day.', 'dev', 'dev-6', 'open'],
  [242, 'Widget refresh budget on iOS 18', 'Refresh the watering widget at most four times an hour.', 'dev', 'dev-8', 'open'],
  [243, 'Low-light exposure hint banner', 'Tell the grower to move closer to a window when the photo is too dark.', 'dev', 'dev-1', 'open'],
  [237, 'Care guide pages for 30 common houseplants', 'One page per plant: light, water, soil, pets and the usual mistake.', 'mkt', 'mkt-seo', 'working'],
];
const CAMERA_PARTS: TaskSeed[] = [
  [244, 'Frame guide overlay for the leaf', 'Show where to hold the leaf so the classifier sees it whole.', 'dev', 'dev-1', 'done'],
  [245, 'White balance for indoor light', 'Correct warm lamp light before the photo reaches the classifier.', 'dev', 'dev-1', 'working'],
  [246, 'Top three species cards', 'Show the three likeliest species with their care in one line each.', 'dev', 'dev-1', 'open'],
];

export const MAYA: PersonRef = { id: MAYA_VIEW.id, name: MAYA_VIEW.name };
export const LEO: PersonRef = { id: LEO_VIEW.id, name: LEO_VIEW.name };
export const SAM: PersonRef = { id: SAM_VIEW.id, name: SAM_VIEW.name };

/* What the company aims at: 500 testers, and under it what Development, Design and Marketing each answer for. */
const goal = (id: string, number: number, title: string, over: Partial<GoalView>): GoalView => ({
  id, number, title, why: '', department: null, parentId: 'g-1', responsible: MAYA, target: null, current: null, unit: '', dueAt: null,
  status: 'active', progress: null, done: 0, total: 0, version: 1, mayEdit: true, ...over,
});
const GOAL_SEEDS: GoalView[] = [
  goal('g-1', 1, '500 TestFlight testers by December', { why: 'Real growers show us what to fix before the App Store launch.', parentId: null, target: 500, current: 312, unit: 'testers', dueAt: '2026-12-01T00:00:00.000Z' }),
  goal('g-2', 2, 'A beta build testers can trust', { why: 'Camera ID, reminders and sync must just work on the first day.', department: PLACES.dev, responsible: SAM, dueAt: '2026-11-28T00:00:00.000Z' }),
  goal('g-5', 5, 'Works offline', { why: 'Plants live in rooms with bad Wi-Fi.', department: PLACES.dev, parentId: 'g-2', responsible: SAM }),
  goal('g-3', 3, 'A store page that wins installs', { why: 'Most testers find us through the store page.', department: PLACES.dsn, responsible: LEO }),
  goal('g-4', 4, 'Waitlist to 1,000 sign-ups', { why: 'Every sign-up is a tester we can invite.', department: PLACES.mkt, responsible: LEO, target: 1000, current: 640, unit: 'sign-ups' }),
];
const OFFLINE = new Set([213, 216, 219, 226, 241]);
const goalOf = (number: number, dept: keyof typeof PLACES): string => {
  if (dept === 'dev') return OFFLINE.has(number) ? 'g-5' : 'g-2';
  if (dept === 'dsn') return 'g-3';
  if (dept === 'mkt') return 'g-4';
  return 'g-1';
};
const RESPONSIBLE: Record<keyof typeof PLACES, PersonRef> = { dev: SAM, dsn: LEO, mkt: LEO, ops: MAYA, biz: MAYA };
const WHY: Partial<Record<number, string>> = {
  218: 'Testers get reminders the day the beta opens.',
  221: 'Naming a plant from a photo is why people install Moonfern.',
  225: 'Growers bring the plants they already keep in lists.',
  227: 'Someone can water the plants while the grower is away.',
  230: 'The first card decides whether a tester adds a second plant.',
};

/* The way every Development change goes: built, reviewed by another maker, checked for security and smoke-tested on
   TestFlight. */
export const MOONFERN_PIPELINE: Pipeline = {
  id: 'pl-beta', department: PLACES.dev, name: 'Beta build way', archived: false, version: 1, mayEdit: true,
  why: 'Every change is built, reviewed by another maker, checked for security and smoke-tested on TestFlight.',
  stages: [
    { id: 's-build', parentId: null, name: 'Build', ownerRole: null, owner: null, position: 0 },
    { id: 's-review', parentId: 's-build', name: 'Review', ownerRole: null, owner: { id: 'rev-codex', name: 'Marcus' }, position: 0 },
    { id: 's-security', parentId: 's-review', name: 'Security', ownerRole: null, owner: { id: 'dev-sec', name: 'Petra' }, position: 0 },
    { id: 's-smoke', parentId: 's-security', name: 'TestFlight smoke test', ownerRole: null, owner: { id: 'dev-test', name: 'Gideon' }, position: 0 },
  ],
};
const STAGE_IDS = ['s-build', 's-review', 's-security', 's-smoke'];

function line(s: TaskSeed, idx: number, turn: number | null, parentId: string | null = null): TaskLine {
  const [number, title, brief, dept, agentId, status, stage = 0, waitsFor = []] = s;
  const gateCount = dept === 'dev' ? 3 : 0;
  const updatedAt = isoMinutes(-45 + (idx % 30));
  const since = status === 'waiting' ? isoMinutes(-(40 + (idx % 5) * 9)) : isoMinutes(-(25 + (idx % 7) * 23));
  const waiting = status === 'waiting' ? [{ who: { kind: 'person' as const, ...(dept === 'dsn' ? LEO : MAYA) }, since }] : [];
  const onWay = dept === 'dev' && gateCount > 0;
  return {
    echelons: routeAt(stage, gateCount),
    id: `t-${number}`,
    number,
    title,
    brief,
    status,
    department: PLACES[dept],
    product: null,
    assignee: refOf(agentId),
    turn,
    parentId,
    waitsFor,
    goal: (() => { const g = GOAL_SEEDS.find(x => x.id === goalOf(number, dept))!; return { id: g.id, number: g.number, title: g.title }; })(),
    responsible: RESPONSIBLE[dept],
    why: WHY[number] ?? '',
    dueAt: number === 218 || number === 221 ? '2026-11-20T00:00:00.000Z' : number === 230 ? '2026-11-19T00:00:00.000Z' : null,
    time: { inStatusSince: status === 'done' ? updatedAt : since, workSeconds: 600 + ((number * 977) % 9000), waitsOn: waiting },
    pipelineId: onWay ? MOONFERN_PIPELINE.id : null,
    pipelineStageId: onWay && status !== 'open' ? STAGE_IDS[Math.min(stage, 3)]! : null,
    createdAt: isoMinutes(-300 + idx * 4),
    updatedAt,
  };
}

export const MOONFERN_TASKS: TaskLine[] = [
  ...TURN_6_SEEDS.map((s, idx) => line(s, idx, 6)),
  ...LATER_SEEDS.map((s, idx) => line(s, 40 + idx, null)),
  ...CAMERA_PARTS.map((s, idx) => line(s, 44 + idx, 6, 't-221')),
];

/* Each goal's tasks done of all of them, cancelled aside, counted over its smaller goals too; a number to reach wins. */
export const MOONFERN_GOALS: GoalView[] = GOAL_SEEDS.map(g => {
  const under = (id: string): string[] => [id, ...GOAL_SEEDS.filter(x => x.parentId === id).flatMap(x => under(x.id))];
  const ids = new Set(under(g.id));
  const mine = MOONFERN_TASKS.filter(t => t.goal && ids.has(t.goal.id) && t.status !== 'cancelled');
  const done = mine.filter(t => t.status === 'done').length;
  const progress = g.target ? Math.min(1, (g.current ?? 0) / g.target) : mine.length ? done / mine.length : null;
  return { ...g, done, total: mine.length, progress };
});

export const MOONFERN_TASK_DEPARTMENTS: TaskDepartments = {
  whole: true,
  mayPlanCompany: true,
  departments: [
    { ...PLACES.dev, templateKey: null, mine: true, mayPlan: true, responsible: SAM },
    { ...PLACES.dsn, templateKey: null, mine: true, mayPlan: true, responsible: LEO },
    { ...PLACES.mkt, templateKey: null, mine: true, mayPlan: true, responsible: LEO },
    { ...PLACES.ops, templateKey: null, mine: true, mayPlan: true, responsible: MAYA },
    { ...PLACES.biz, templateKey: null, mine: true, mayPlan: true, responsible: MAYA },
  ],
};

const turn = (over: Pick<TurnView, 'id' | 'number' | 'title' | 'goal' | 'status' | 'messages' | 'taskId' | 'startedAt' | 'openedAt' | 'closedAt' | 'tasks'>): TurnView => ({
  version: over.status === 'closed' ? `v0.${over.number}.0` : null, commit: null, baseVersion: over.status === 'closed' ? null : 'v0.5.0',
  departmentId: PLACES.dev.id, releases: true, ...over,
});

export const MOONFERN_TURNS: TurnView[] = [
  turn({
    id: 'turn-6',
    number: 6,
    title: 'Launch the iOS beta',
    goal: 'Ship the TestFlight iOS beta with camera plant ID, local watering reminders, App Store screenshots and beta landing page.',
    status: 'open',
    messages: [
      {
        by: 'Maya Chen',
        text: 'Let us get Turn 6 ready for our first 500 TestFlight testers: finish the camera plant ID flow, local watering reminders, App Store screenshots and the beta landing page.',
        at: isoMinutes(-320),
      },
    ],
    taskId: 't-201',
    startedAt: isoMinutes(-320),
    openedAt: isoMinutes(-318),
    closedAt: null,
    tasks: { total: 40, done: 24 },
  }),
  turn({
    id: 'turn-5',
    number: 5,
    title: 'Offline plant journal and watering engine',
    goal: 'Build local-first SQLite plant storage and seasonal watering schedules.',
    status: 'closed',
    messages: [],
    taskId: null,
    startedAt: isoMinutes(-1800),
    openedAt: isoMinutes(-1795),
    closedAt: isoMinutes(-400),
    tasks: { total: 32, done: 32 },
  }),
];

export const INITIAL_MOONFERN_REQUESTS: WaitingRequest[] = [
  {
    id: 'req-choice-card',
    kind: 'choice',
    text: 'Which layout should we use for the first-plant card at the end of onboarding?',
    commit: null,
    commitUrl: null,
    images: [],
    options: [
      { label: 'Botanical field card', image: 'choice-botanical' },
      { label: 'Moisture & light dial', image: 'choice-dial' },
      { label: 'Compact shelf list', image: 'choice-list' },
    ],
    link: null,
    explained: 'Pick the default card style testers see right after identifying their first houseplant.',
    explaining: false,
    at: isoMinutes(-18),
    agent: { id: 'dsn-1', name: 'Nadia' },
    task: { id: 't-230', number: 230, title: 'Onboarding plant card layout', department: PLACES.dsn },
    ownerPersonId: LEO_VIEW.id,
    canAnswer: true,
    decidedBy: { kind: 'department_and_ceo', department: PLACES.dsn },
  },
  {
    id: 'req-commit-approve',
    kind: 'approval',
    text: 'All four reviewers, security and the TestFlight smoke suite passed. Approve merging the watering reminder engine into main?',
    commit: '8f4c2d1e9a7b3054c18d62f0a91e4b77c3d2091a',
    commitUrl: 'https://github.com/moonfern-app/moonfern/commit/8f4c2d1e9a7b3054c18d62f0a91e4b77c3d2091a',
    images: [],
    options: [],
    link: null,
    explained: null,
    explaining: false,
    at: isoMinutes(-11),
    agent: { id: 'dev-head', name: 'Dana' },
    task: { id: 't-218', number: 218, title: 'Merge watering reminder engine to main', department: PLACES.dev },
    ownerPersonId: MAYA_VIEW.id,
    canAnswer: true,
    decidedBy: { kind: 'ceo_and_delegate', department: PLACES.dev },
  },
  {
    id: 'req-csv-question',
    kind: 'question',
    text: 'When a CSV import has an unrecognized cultivar (like "Monstera Thai Constellation"), should we attach the genus care schedule automatically or ask the user to confirm?',
    commit: null,
    commitUrl: null,
    images: [],
    options: [],
    link: null,
    explained: null,
    explaining: false,
    at: isoMinutes(-16),
    agent: { id: 'dev-5', name: 'Priya' },
    task: { id: 't-225', number: 225, title: 'Import plants from CSV and Apple Notes', department: PLACES.dev },
    ownerPersonId: MAYA_VIEW.id,
    canAnswer: true,
    decidedBy: { kind: 'department_and_ceo', department: PLACES.dev },
  },
];

export function buildDecisions(requests: WaitingRequest[]): Decisions {
  const byPerson: Record<string, number> = {};
  const byAgent: Record<string, number> = {};
  for (const r of requests) {
    byPerson[r.ownerPersonId] = (byPerson[r.ownerPersonId] ?? 0) + 1;
    byAgent[r.agent.id] = (byAgent[r.agent.id] ?? 0) + 1;
  }
  return {
    requests,
    proposals: [],
    counts: {
      byPerson,
      byAgent,
      total: requests.length,
    },
  };
}

/* The thirty plants Jonah's one-shot calls each wrote a care page for, and the brief they shared. */
export const CARE_PLANTS = [
  'Pothos', 'Monstera', 'Snake plant', 'ZZ plant', 'Peace lily', 'Spider plant', 'Rubber plant', 'Fiddle leaf fig', 'Calathea', 'Philodendron',
  'Aloe vera', 'Jade plant', 'Boston fern', 'Chinese evergreen', 'Dracaena', 'English ivy', 'Bird of paradise', 'Prayer plant', 'String of pearls', 'Ponytail palm',
  'Parlor palm', 'Hoya', 'Peperomia', 'Begonia', 'Anthurium', 'Croton', 'Areca palm', 'Cast iron plant', 'Haworthia', 'Orchid',
] as const;
const CARE_BRIEF = 'Write one care page for the plant in your input, in the format of moonfern.app/care/pothos: light, water, soil, pets, and the one mistake new growers make. Return Markdown only.';

const call = (number: number, input: string | null, startMin: number, minutes: number, result: string, over: Record<string, unknown> = {}): TaskLogLine => ({
  kind: 'call',
  text: '',
  data: { batch: 'b1d2c3e4-0000-4000-8000-000000000237', number, judge: false, brief: CARE_BRIEF, input, stage: null, status: 'done', error: null, verdict: null, result,
    startedAt: isoMinutes(startMin), finishedAt: isoMinutes(startMin + minutes), ...over },
  by: { kind: 'agent', id: 'mkt-seo', name: 'Jonah' },
  at: isoMinutes(startMin + minutes),
});

/* What the history of #237 keeps: the task given, then the calls that answered and the judge that read them all. */
const CARE_LOG: TaskLogLine[] = [
  { kind: 'created', text: '', data: null, by: { kind: 'agent', id: 'mkt-head', name: 'Robin' }, at: isoMinutes(-70) },
  { kind: 'assigned', text: '', data: null, by: { kind: 'agent', id: 'mkt-head', name: 'Robin' }, at: isoMinutes(-70) },
  call(1, 'Pothos', -24, 3, '## Pothos\nBright, indirect light. Water when the top 2 cm are dry. Toxic to cats and dogs.'),
  call(2, 'Monstera', -24, 4, '## Monstera\nBright, indirect light, a moss pole as it climbs. Water every 1 to 2 weeks.'),
  call(3, 'Snake plant', -24, 2, '## Snake plant\nAny light. Water once a month in winter: the usual mistake is too much water.'),
  call(30, 'Orchid', -21, 3, '## Orchid\nEast window, water by soaking for 10 minutes, let it drain fully.'),
  {
    ...call(31, null, -17, 2, 'All 30 pages follow the format and give the pet warning. Calls 7 and 19 named the same mistake for different plants; both are fixed.', {
      judge: true, brief: 'Read the 30 pages. Check the format, the pet warning and that no two pages repeat each other. Fix what you find.', verdict: { pass: true, reason: 'All 30 pages are ready to publish.' },
    }),
  },
];

export function moonfernTaskDetail(taskId: string): TaskDetail | null {
  const found = MOONFERN_TASKS.find(t => t.id === taskId);
  if (!found) return null;
  const head = found.department?.id === 'dept-dev' ? 'dev-head' : found.department?.id === 'dept-mkt' ? 'mkt-head' : 'dsn-head';
  const headName = PLACEMENTS.find(p => p.employee.id === head)?.employee.name ?? 'Dana';
  const by = { kind: 'agent' as const, id: head, name: headName };
  const subtasks = MOONFERN_TASKS.filter(t => t.parentId === found.id);
  const log: TaskLogLine[] = found.id === 't-237' ? CARE_LOG : [
    { kind: 'created', text: '', data: null, by, at: found.createdAt },
    { kind: 'assigned', text: '', data: null, by, at: found.createdAt },
    ...(found.status === 'open' ? [] : [{ kind: 'status', text: '', data: { fromStatus: 'open', toStatus: 'working' }, by, at: isoMinutes(minutesAgoOf(found.createdAt) > 60 ? -60 : -20) }]),
  ];
  return {
    ...found,
    echelonFindings: emptyEchelonFindings(),
    body: `${found.brief}\n\n### Done when\n- It works offline and never blocks the main thread.\n- Its tests pass on the Turn 6 branch.\n- It reads well in light and dark on iPhone.`,
    parent: found.parentId ? { id: found.parentId, number: Number(found.parentId.slice(2)), title: MOONFERN_TASKS.find(t => t.id === found.parentId)?.title ?? '' } : null,
    after: found.waitsFor.map(num => {
      const dep = MOONFERN_TASKS.find(x => x.number === num);
      return { id: dep?.id ?? `t-${num}`, number: num, title: dep?.title ?? `Task #${num}`, status: dep?.status ?? 'working' };
    }),
    neededFor: MOONFERN_TASKS.filter(x => x.waitsFor.includes(found.number)).map(x => ({ id: x.id, number: x.number, title: x.title, status: x.status })),
    mayEdit: true,
    version: 1,
    revision: 1,
    executor: found.assignee,
    createdBy: by,
    subtasks,
    log,
    requests: [],
    files: [],
  };
}

const minutesAgoOf = (iso: string) => Math.round((Date.parse(BASE_ISO) - Date.parse(iso)) / 60_000);
