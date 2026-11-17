import type {
  AgentTime,
  Department,
  DepartmentTree,
  IdleStretch,
  Org,
  TreeActivity,
  TreeAgent,
  TreeLine,
  TreeSegment,
} from '../../src/types';
import { emptyEchelonFindings } from '@hornhoof/protocol/echelons';
import { MOONFERN_DEPARTMENTS, MOONFERN_ORG } from './agents';
import { employeeTask, routeAt } from './route';
import { clockIso, secondsBetweenIso } from './tree-clock';

/* A turn review as the tree once drew it. The tree has no review rows now; the reviewers' time still counts. */
type TreeReview = {
  taskId: string;
  number: number;
  openedAt: string;
  closedAt: string | null;
  head: TreeAgent;
  reviewers: { agent: TreeAgent; verdict: { at: string; pass: boolean; findings: number } | null; segments: TreeSegment[]; lastActionAt: string; live: boolean }[];
};

export type TreeSnapshot = {
  now: string;
  tree: DepartmentTree;
  org: Org;
};

const ACTORS: TreeAgent[] = [
  { id: 'dev-head', name: 'Dana' },
  { id: 'dev-arch', name: 'Victor' },
  { id: 'dev-1', name: 'Iris' },
  { id: 'dev-8', name: 'Tessa' },
  { id: 'dev-5', name: 'Priya' },
  { id: 'dev-7', name: 'Owen' },
  { id: 'dev-6', name: 'Liam' },
  { id: 'dev-2', name: 'Theo' },
  { id: 'dev-3', name: 'Jules' },
  { id: 'dev-4', name: 'Soren' },
  { id: 'rev-claude', name: 'Vera' },
  { id: 'rev-codex', name: 'Marcus' },
  { id: 'rev-kimi', name: 'Hana' },
  { id: 'rev-google', name: 'Kiran' },
];

const actor = (id: string): TreeAgent => {
  const found = ACTORS.find(a => a.id === id);
  if (!found) throw new Error(`Unknown tree actor ${id}`);
  return found;
};

const seg = (kind: TreeSegment['kind'], from: string, to: string | null): TreeSegment => ({
  kind,
  from: clockIso(from),
  to: to ? clockIso(to) : null,
});

function taskLine(
  number: number,
  title: string,
  agentId: string,
  cut: string,
  merged: string | null,
  segments: TreeSegment[],
  live: boolean,
  waitsFor: number[] = [],
  moves: TreeLine['moves'] = [],
): TreeLine {
  const cutAt = clockIso(cut);
  const mergedAt = merged ? clockIso(merged) : null;
  return {
    echelons: routeAt(0),
    echelonFindings: emptyEchelonFindings(),
    ownerSince: cutAt,
    taskId: `t-${number}`,
    number,
    title,
    agent: actor(agentId),
    part: { id: 't-201', number: 201, title: 'Launch the iOS beta' },
    branch: `task-${number}`,
    createdAt: cutAt,
    cutAt,
    mergedAt,
    doneAt: mergedAt,
    waitsFor,
    segments,
    moves,
    lastActionAt: mergedAt ?? segments.at(-1)?.from ?? cutAt,
    live,
  };
}

/* Four progressive snapshots of Turn 6 in Development:
   0 (14:20): Tessa is idle (7 min), Owen waits for #221, Priya waits on a person, 6 devs working.
   1 (14:24): Tessa picks up #235 (idle -> working), Liam merges #226 into turn-6 and starts #241.
   2 (14:28): Iris merges #221 into turn-6, Owen unblocks on #227 (waiting -> working), review #242 opens across 4 makers.
   3 (14:32): Vera (Claude) and Marcus (Codex) post verdicts on review #242 while Hana (Kimi) and Kiran (Google) continue. */
export function buildDevelopmentTreeSnapshots(): TreeSnapshot[] {
  const clocks = ['14:20', '14:24', '14:28', '14:32'] as const;
  return clocks.map((hhmm, step) => buildStep(hhmm, step));
}

function buildStep(hhmm: string, step: number): TreeSnapshot {
  const now = clockIso(hhmm);
  const turnStart = clockIso('13:00');

  /* Earlier completed lines in Turn 6 so every lane shows history and merges into turn-6. */
  const early: TreeLine[] = [
    taskLine(213, 'SQLite WAL migration check', 'dev-arch', '13:02', '13:34', [seg('work', '13:02', '13:34')], false),
    taskLine(195, 'CoreML quantized weights bundle', 'dev-1', '13:03', '13:38', [seg('work', '13:03', '13:38')], false),
    taskLine(197, 'Seasonal watering intervals', 'dev-2', '13:04', '13:42', [seg('work', '13:04', '13:42')], false),
    taskLine(200, 'Room and light onboarding quiz', 'dev-3', '13:05', '13:46', [seg('work', '13:05', '13:46')], false),
    taskLine(196, 'Window orientation picker', 'dev-4', '13:06', '13:44', [seg('work', '13:06', '13:44')], false),
    taskLine(203, 'Pot drainage and soil mix selector', 'dev-5', '13:07', '13:49', [seg('work', '13:07', '13:49')], false),
    taskLine(198, 'Toxic-to-pets warning badge', 'dev-6', '13:08', '13:40', [seg('work', '13:08', '13:40')], false),
    taskLine(204, 'Growth photo timeline scrubber', 'dev-8', '13:09', '14:12', [
      seg('work', '13:09', '13:36'),
      seg('after', '13:36', '13:44'),
      seg('work', '13:44', '14:12'),
    ], false),
  ];

  /* Active lanes across the 4 steps. */
  const active: TreeLine[] = [
    taskLine(219, 'Sync schema for offline watering logs', 'dev-arch', '13:38', null, [seg('work', '13:38', null)], true),
    taskLine(
      221,
      'Plant identification camera flow',
      'dev-1',
      '13:42',
      step >= 2 ? '14:26' : null,
      [seg('work', '13:42', step >= 2 ? '14:26' : null)],
      step < 2,
      [],
      step >= 2 ? [{ kind: 'report', at: clockIso('14:26'), text: 'Camera framing and 14 species classifier tests green.' }] : [],
    ),
    ...(step >= 2
      ? [taskLine(243, 'Low-light exposure hint banner', 'dev-1', '14:27', null, [seg('work', '14:27', null)], true)]
      : []),
    taskLine(222, 'Local push reminders for watering schedules', 'dev-2', '13:46', null, [seg('work', '13:46', null)], true),
    taskLine(223, 'Soil moisture chart and care streak card', 'dev-3', '13:50', null, [
      seg('work', '13:50', '14:04'),
      seg('stall', '14:04', '14:08'),
      seg('work', '14:08', null),
    ], true),
    taskLine(224, 'Sunlight meter calibration on iPhone', 'dev-4', '13:48', null, [seg('work', '13:48', null)], true),
    taskLine(
      225,
      'Import plants from CSV and Apple Notes',
      'dev-5',
      '13:52',
      null,
      [seg('work', '13:52', '14:04'), seg('person', '14:04', null)],
      false,
      [],
      [{ kind: 'asked', at: clockIso('14:04'), text: 'Attach genus care schedule automatically for unknown cultivars?' }],
    ),
    taskLine(
      226,
      'Batch photo upload compression',
      'dev-6',
      '13:44',
      step >= 1 ? '14:22' : null,
      [seg('work', '13:44', step >= 1 ? '14:22' : null)],
      step < 1,
    ),
    ...(step >= 1
      ? [taskLine(241, 'Background sync retry backoff on cellular', 'dev-6', '14:23', null, [seg('work', '14:23', null)], true)]
      : []),
    taskLine(
      227,
      'Shareable plant care card for friends',
      'dev-7',
      '13:54',
      null,
      step >= 2
        ? [seg('work', '13:54', '14:02'), seg('after', '14:02', '14:26'), seg('work', '14:26', null)]
        : [seg('work', '13:54', '14:02'), seg('after', '14:02', null)],
      step >= 2,
      step >= 2 ? [] : [221],
      step >= 2 ? [{ kind: 'started', at: clockIso('14:26'), text: '#221 merged, starting share card preview.' }] : [],
    ),
    ...(step >= 1
      ? [taskLine(235, 'Widget refresh budget on iOS 18', 'dev-8', '14:21', null, [seg('work', '14:21', null)], true)]
      : []),
  ];

  /* Mid-turn review (#214, closed) + live review (#242, opens at step 2) across all 4 makers. */
  const review1: TreeReview = {
    taskId: 'r-214',
    number: 214,
    openedAt: clockIso('13:48'),
    closedAt: clockIso('14:05'),
    head: actor('dev-head'),
    reviewers: [
      { agent: actor('rev-claude'), verdict: { at: clockIso('14:02'), pass: true, findings: 0 }, segments: [seg('work', '13:48', '14:02')], lastActionAt: clockIso('14:02'), live: false },
      { agent: actor('rev-codex'), verdict: { at: clockIso('14:04'), pass: false, findings: 1 }, segments: [seg('work', '13:48', '14:04')], lastActionAt: clockIso('14:04'), live: false },
      { agent: actor('rev-kimi'), verdict: { at: clockIso('14:03'), pass: true, findings: 0 }, segments: [seg('work', '13:48', '14:03')], lastActionAt: clockIso('14:03'), live: false },
      { agent: actor('rev-google'), verdict: { at: clockIso('14:05'), pass: true, findings: 0 }, segments: [seg('work', '13:48', '14:05')], lastActionAt: clockIso('14:05'), live: false },
    ],
  };

  const review2: TreeReview | null = step >= 2
    ? {
        taskId: 'r-242',
        number: 242,
        openedAt: clockIso('14:26'),
        closedAt: null,
        head: actor('dev-head'),
        reviewers: [
          {
            agent: actor('rev-claude'),
            verdict: step >= 3 ? { at: clockIso('14:31'), pass: true, findings: 0 } : null,
            segments: [seg('work', '14:26', step >= 3 ? '14:31' : null)],
            lastActionAt: clockIso(step >= 3 ? '14:31' : hhmm),
            live: step < 3,
          },
          {
            agent: actor('rev-codex'),
            verdict: step >= 3 ? { at: clockIso('14:31'), pass: true, findings: 0 } : null,
            segments: [seg('work', '14:26', step >= 3 ? '14:31' : null)],
            lastActionAt: clockIso(step >= 3 ? '14:31' : hhmm),
            live: step < 3,
          },
          {
            agent: actor('rev-kimi'),
            verdict: null,
            segments: [seg('work', '14:26', null)],
            lastActionAt: now,
            live: true,
          },
          {
            agent: actor('rev-google'),
            verdict: null,
            segments: [seg('work', '14:26', null)],
            lastActionAt: now,
            live: true,
          },
        ],
      }
    : null;

  const reviews = review2 ? [review1, review2] : [review1];
  const lines = [...early, ...active];

  /* Head coordination activity & brief queued message so SpeedPanel shows realistic Working/Waiting/Idle/Interrupted/Queued columns. */
  const activity: TreeActivity[] = [
    {
      jobId: 'job-dana-1',
      agent: actor('dev-head'),
      task: { id: 't-201', number: 201, title: 'Coordinate Turn 6 iOS beta' },
      segments: [
        seg('work', '13:00', '13:32'),
        seg('queued', '13:32', '13:36'),
        seg('work', '13:36', '14:08'),
        seg('lost', '14:08', '14:11'),
        seg('work', '14:11', null),
      ],
    },
  ];

  const waiting: DepartmentTree['waiting'] = step === 0
    ? [
        {
          agent: actor('dev-8'),
          waitsForAgent: actor('dev-head'),
          from: clockIso('14:12'),
          kind: 'stall',
          taskId: 't-204',
          number: 204,
          title: 'Waiting for next task assignment',
        },
      ]
    : [];

  /* Idle stretches: open waits first, then ended waits from earlier in Turn 6. */
  const idle: IdleStretch[] = [
    {
      agent: actor('dev-5'),
      taskId: 't-225',
      number: 225,
      title: 'Import plants from CSV and Apple Notes',
      kind: 'person',
      from: clockIso('14:04'),
      to: null,
      waitsFor: [],
      question: 'Attach genus care schedule automatically for unknown cultivars?',
    },
    ...(step < 2
      ? [
          {
            agent: actor('dev-7'),
            taskId: 't-227',
            number: 227,
            title: 'Shareable plant care card for friends',
            kind: 'after' as const,
            from: clockIso('14:02'),
            to: null,
            waitsFor: [221],
            question: null,
          },
        ]
      : []),
    ...(step === 0
      ? [
          {
            agent: actor('dev-8'),
            taskId: 't-204',
            number: 204,
            title: 'Growth photo timeline scrubber',
            kind: 'stall' as const,
            from: clockIso('14:12'),
            to: null,
            waitsFor: [],
            waitsForAgent: actor('dev-head'),
            question: null,
          },
        ]
      : []),
    /* Ended waits */
    ...(step >= 2
      ? [
          {
            agent: actor('dev-7'),
            taskId: 't-227',
            number: 227,
            title: 'Shareable plant care card for friends',
            kind: 'after' as const,
            from: clockIso('14:02'),
            to: clockIso('14:26'),
            waitsFor: [221],
            question: null,
          },
        ]
      : []),
    ...(step >= 1
      ? [
          {
            agent: actor('dev-8'),
            taskId: 't-204',
            number: 204,
            title: 'Growth photo timeline scrubber',
            kind: 'stall' as const,
            from: clockIso('14:12'),
            to: clockIso('14:21'),
            waitsFor: [],
            waitsForAgent: actor('dev-head'),
            question: null,
          },
        ]
      : []),
    {
      agent: actor('dev-3'),
      taskId: 't-223',
      number: 223,
      title: 'Soil moisture chart and care streak card',
      kind: 'stall',
      from: clockIso('14:04'),
      to: clockIso('14:08'),
      waitsFor: [],
      question: null,
    },
    {
      agent: actor('dev-8'),
      taskId: 't-204',
      number: 204,
      title: 'Growth photo timeline scrubber',
      kind: 'after',
      from: clockIso('13:36'),
      to: clockIso('13:44'),
      waitsFor: [213],
      question: null,
    },
    {
      agent: actor('dev-head'),
      taskId: 't-201',
      number: 201,
      title: 'Coordinate Turn 6 iOS beta',
      kind: 'lost',
      from: clockIso('14:08'),
      to: clockIso('14:11'),
      waitsFor: [],
      question: null,
    },
  ];

  const time: AgentTime[] = ACTORS.map(ag => {
    const segs: TreeSegment[] = [
      ...lines.filter(l => l.agent.id === ag.id).flatMap(l => l.segments),
      ...reviews.flatMap(r => r.reviewers.filter(rv => rv.agent.id === ag.id).flatMap(rv => rv.segments)),
      ...activity.filter(a => a.agent.id === ag.id).flatMap(a => a.segments),
      ...idle.filter(i => i.agent.id === ag.id && i.waitsForAgent).map(i => ({ kind: i.kind, from: i.from, to: i.to })),
    ];
    const sum = (kind: TreeSegment['kind']) =>
      segs.filter(s => s.kind === kind).reduce((acc, s) => acc + secondsBetweenIso(s.from, s.to ?? now), 0);
    return {
      agent: ag,
      work: sum('work'),
      after: sum('after'),
      person: sum('person'),
      stall: sum('stall'),
      lost: sum('lost'),
      alarm: sum('alarm'),
      queued: sum('queued'),
      unknown: 0,
    };
  });

  const tree: DepartmentTree = {
    now,
    turn: {
      id: 'turn-6',
      number: 6,
      branch: 'turn-6',
      startedAt: turnStart,
    },
    repository: true,
    lines,
    waiting,
    activity,
    time,
    idle,
  };

  /* Sync Development employee statuses with the current tree snapshot so plates and chips match. */
  const devDept = MOONFERN_DEPARTMENTS.find(d => d.id === 'dept-dev')!;
  const nowMs = Date.parse(now);
  const activeProgram = (tool: string | null, sinceIso: string): NonNullable<Employee['program']> => ({
    state: tool ? 'tool' : 'thinking',
    since: Date.parse(sinceIso),
    tool,
    screenAt: nowMs - 10_000,
    signAt: nowMs - 6_000,
    retry: null,
    reportedAt: nowMs - 3_000,
  });
  const updatedEmployees = devDept.employees.map(emp => {
    const freshProgram = emp.program
      ? { ...emp.program, screenAt: nowMs - 10_000, signAt: nowMs - 6_000, reportedAt: nowMs - 3_000 }
      : null;
    if (emp.id === 'dev-8') {
      const working = step >= 1;
      return {
        ...emp,
        program: working ? activeProgram('Edit', clockIso('14:22')) : null,
        state: (working ? 'working' : 'sleeping') as Employee['state'],
        status: (working ? 'working' : 'idle') as Employee['status'],
        task: working ? employeeTask('t-235', 235, 'Widget refresh budget on iOS 18', 0, 3) : null,
      };
    }
    if (emp.id === 'dev-6' && step >= 1) {
      return {
        ...emp,
        program: freshProgram,
        task: employeeTask('t-241', 241, 'Background sync retry backoff on cellular', 0, 3),
      };
    }
    if (emp.id === 'dev-1' && step >= 2) {
      return {
        ...emp,
        program: freshProgram,
        task: employeeTask('t-243', 243, 'Low-light exposure hint banner', 0, 3),
      };
    }
    if (emp.id === 'dev-7' && step >= 2) {
      return {
        ...emp,
        program: activeProgram('Bash', clockIso('14:26')),
        state: 'working' as const,
        status: 'working' as const,
      };
    }
    return { ...emp, program: freshProgram };
  });
  const devWorking = updatedEmployees.filter(e => e.status === 'working').length;
  const updatedDev: Department = {
    ...devDept,
    employees: updatedEmployees,
    agents: { total: updatedEmployees.length, working: devWorking },
  };
  const departments = MOONFERN_ORG.departments.map(d => (d.id === 'dept-dev' ? updatedDev : d));
  const org: Org = {
    ...MOONFERN_ORG,
    serverNow: now,
    departments,
    agents: {
      total: departments.reduce((s, d) => s + d.agents.total, 0),
      working: departments.reduce((s, d) => s + d.agents.working, 0),
    },
  };

  return { now, tree, org };
}

type Employee = Department['employees'][number];
