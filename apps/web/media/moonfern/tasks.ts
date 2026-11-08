import type { AgentRef, Decisions, TaskDetail, TaskLine, TaskStatus, TurnView, WaitingRequest } from '../../src/types';
import { PLACEMENTS } from './agents';
import { isoMinutes } from './clock';
import { LEO_VIEW, MAYA_VIEW } from './people';

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

export const MOONFERN_TASKS: TaskLine[] = TURN_6_SEEDS.map((s, idx) => {
  const [number, title, brief, dept, agentId, status, stage = 0, waitsFor = [], bounces = 0] = s;
  const gateCount = dept === 'dev' ? 3 : 0;
  return {
    id: `t-${number}`,
    number,
    title,
    brief,
    status,
    department: PLACES[dept],
    product: null,
    assignee: refOf(agentId),
    stage,
    gateCount,
    merging: false,
    bounces,
    turn: 6,
    parentId: null,
    waitsFor,
    createdAt: isoMinutes(-300 + idx * 4),
    updatedAt: isoMinutes(-45 + (idx % 30)),
  };
});

export const MOONFERN_TURNS: TurnView[] = [
  {
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
  },
  {
    id: 'turn-7',
    number: 7,
    title: 'Nursery partner directory and Android waitlist',
    goal: 'Add local nursery care tags and open the Android beta signup.',
    status: 'planned',
    messages: [],
    taskId: null,
    startedAt: isoMinutes(-120),
    openedAt: null,
    closedAt: null,
    tasks: { total: 14, done: 0 },
  },
  {
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
  },
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
    computerAccess: null,
    counts: {
      byPerson,
      byAgent,
      total: requests.length,
    },
  };
}

export function moonfernTaskDetail(taskId: string): TaskDetail | null {
  const line = MOONFERN_TASKS.find(t => t.id === taskId);
  if (!line) return null;
  const devGates = line.department?.id === 'dept-dev' && line.gateCount > 0
    ? [
        { ...refOf('rev-codex'), state: (line.stage > 1 ? 'passed' : line.stage === 1 ? 'current' : 'next') as 'passed' | 'current' | 'next' },
        { ...refOf('dev-sec'), state: (line.stage > 2 ? 'passed' : line.stage === 2 ? 'current' : 'next') as 'passed' | 'current' | 'next' },
        { ...refOf('dev-test'), state: (line.stage >= 3 ? 'current' : 'next') as 'current' | 'next' },
      ]
    : [];
  return {
    ...line,
    body: `${line.brief}\n\n### Acceptance criteria\n- Works offline without blocking the main thread.\n- Covered by unit tests on the Turn 6 branch.\n- Verified in light and dark appearance on iPhone.`,
    parent: { id: 't-201', number: 201, title: 'Launch the iOS beta' },
    after: line.waitsFor.map(num => {
      const dep = MOONFERN_TASKS.find(x => x.number === num);
      return { id: dep?.id ?? `t-${num}`, number: num, title: dep?.title ?? `Task #${num}`, status: dep?.status ?? 'working' };
    }),
    executor: line.assignee,
    gates: devGates,
    createdBy: { kind: 'agent', id: 'dev-head', name: 'Dana' },
    subtasks: [],
    log: [
      { kind: 'created', text: '', data: null, by: { kind: 'agent', id: 'dev-head', name: 'Dana' }, at: line.createdAt },
      { kind: 'assigned', text: '', data: null, by: { kind: 'agent', id: 'dev-head', name: 'Dana' }, at: line.createdAt },
    ],
    requests: [],
  };
}
