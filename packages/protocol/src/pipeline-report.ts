import { z } from 'zod';

/* What kind of work a task is, and what a mistake in it would cost. A head or the orchestrator names them as it gives the
   task out: the pipeline report counts by kind, and the risk class says who else looks at it. */
export const WORK_KINDS = ['bug', 'known_behavior', 'unknown_path', 'legacy_code'] as const;
export type WorkKind = (typeof WORK_KINDS)[number];
export const RISK_CLASSES = ['money', 'access', 'security', 'data', 'none'] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/* What a test runner prints for the report, one line each, wherever it stands in a part's log. */
export const TIMING_LINE = '::hh-test-timing::';
/* The slowest tests of a file a line names: a log has room for the slow ones, and a package's median covers the rest. */
export const SLOWEST_TESTS = 5;
/* The testing policy's time budget: the report names each file and test over it, as a defect to fix. */
export const FILE_BUDGET_MS = 30_000;
export const TEST_BUDGET_MS = 1_000;

const Ms = z.number().finite().min(0).max(1e10);
const Name = z.string().min(1).max(500);
const Count = z.number().int().min(0).max(1e7);

const SlowTestTiming = z.object({ name: Name, ms: Ms });
type SlowTestTiming = z.infer<typeof SlowTestTiming>;
/* One test file on one part of a run. Setup is what came before its tests (the runner, the database, the app), teardown what
   came after them. A log from before these lines tells only a file's total, so its phases are null. */
export const TestFileTiming = z.object({
  package: Name,
  file: Name,
  totalMs: Ms,
  setupMs: Ms.nullable(),
  testsMs: Ms.nullable(),
  teardownMs: Ms.nullable(),
  slowest: z.array(SlowTestTiming).max(SLOWEST_TESTS),
});
export type TestFileTiming = z.infer<typeof TestFileTiming>;
/* One package on one part of a run: how many tests it has, their median, and how many are slower than it. */
export const TestPackageTiming = z.object({ package: Name, tests: Count, medianTestMs: Ms, slowerThanMedian: Count });
export type TestPackageTiming = z.infer<typeof TestPackageTiming>;

const TimingLine = z.discriminatedUnion('kind', [TestFileTiming.extend({ kind: z.literal('file') }), TestPackageTiming.extend({ kind: z.literal('package') })]);
type TimingLine = z.infer<typeof TimingLine>;
export type PartTimings = { files: TestFileTiming[]; packages: TestPackageTiming[] };

/* No part prints more files than this; a log that does is not believed past it. */
const MOST_TIMING_LINES = 20_000;

export const timingLine = (line: TimingLine): string => `${TIMING_LINE}${JSON.stringify(line)}`;

function parsedLine(text: string): TimingLine | null {
  const at = text.indexOf(TIMING_LINE);
  if (at < 0) return null;
  try {
    const parsed = TimingLine.safeParse(JSON.parse(text.slice(at + TIMING_LINE.length)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/* A log is written by whatever the branch runs, so a line that does not parse is left out and nothing past the checks gets in. */
export function parseTimingLines(log: string): PartTimings {
  const out: PartTimings = { files: [], packages: [] };
  const lines = log.split('\n').map(parsedLine).filter(line => line !== null).slice(0, MOST_TIMING_LINES);
  for (const { kind, ...line } of lines) {
    if (kind === 'file') out.files.push(line as TestFileTiming);
    else out.packages.push(line as TestPackageTiming);
  }
  return out;
}

/* All times below are seconds, unless a name says Ms. */
export type Spread = { count: number; median: number | null; worst: number | null };
export type Waited = { count: number; seconds: number };
export type RunWaits = Waited & { worst: number; parts: number; partQueueSeconds: number; partRunSeconds: number };

export const EXTERNAL_WAITS = ['employee', 'time', 'ceo', 'machine', 'other'] as const;
export type ExternalWaitKind = (typeof EXTERNAL_WAITS)[number];
export const PIPELINE_STAGES = ['work', 'review', 'fixes', 'merge', 'turnReview'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export const AGENT_TIMES = ['work', 'waiting', 'idle', 'lost', 'queued', 'unknown'] as const;
export type AgentTimeKind = (typeof AGENT_TIMES)[number];
/* Tasks nobody named a kind for have their own line, so no task drops out of the counts. */
export const KIND_LINES = [...WORK_KINDS, 'unset'] as const;
export type KindLine = (typeof KIND_LINES)[number];

/* Agent turns of a turn: all of them, those of the orchestrator, the heads and Operations, how many a task took and the
   share that went to coordination. */
export type TurnsFacts = { total: number; coordination: number; perTask: number | null; coordinationShare: number | null };
export type KindFacts = { tasks: number; toAcceptance: number | null; returns: number; fixRounds: number };
/* A done task, as a later bug that names it counts against it. */
export type DoneTask = { number: number; kind: KindLine; closedAt: string };

export type FileTime = { package: string; file: string; totalMs: number; setupMs: number | null; testsMs: number | null; teardownMs: number | null; parts: number };
export type SlowTest = SlowTestTiming & { package: string; file: string };
export type PackageTime = {
  package: string;
  files: number;
  totalMs: number;
  setupMs: number | null;
  testsMs: number | null;
  teardownMs: number | null;
  medianFileMs: number;
  tests: number | null;
  medianTestMs: number | null;
  slowerThanMedian: number | null;
};
export type TestsFacts = {
  files: number;
  totalMs: number;
  setupMs: number | null;
  testsMs: number | null;
  teardownMs: number | null;
  packages: PackageTime[];
  slowestFiles: FileTime[];
  slowestTests: SlowTest[];
  /* Older snapshots have no such lists. */
  overBudgetFiles?: FileTime[];
  overBudgetTests?: SlowTest[];
};

export type PipelineFacts = {
  tasks: { total: number; done: number; cancelled: number; open: number };
  /* Closed small tasks, from creation to closing. Older snapshots have no such line. */
  small?: Spread;
  toAcceptance: Spread;
  toFirstSubmit: Spread;
  wholeTurn: number;
  criticalPath: { seconds: number; tasks: number[] };
  agents: Record<AgentTimeKind, number>;
  /* Older snapshots have no such line. */
  turns?: TurnsFacts;
  stages: Record<PipelineStage, number>;
  waits: {
    testRuns: RunWaits;
    workRuns: RunWaits;
    external: Record<ExternalWaitKind, Waited>;
    person: Waited;
    tasks: Waited;
    queue: Waited;
  };
  returns: number;
  fixRounds: number;
  submitsPerTask: number | null;
  failures: number;
  interrupted: number;
  /* No source yet: test selection records what it chose, and until then the report says there is no number. */
  selectionMisses: number | null;
  kinds: Partial<Record<KindLine, KindFacts>>;
  done: DoneTask[];
  tests: TestsFacts;
};
export type DepartmentFacts = PipelineFacts & { department: { id: string; name: string } };
/* A turn's facts as a snapshot keeps them. */
export type TurnFacts = { version: 1; whole: PipelineFacts; departments: DepartmentFacts[] };

export const PIPELINE_SECTIONS = ['tasks', 'time', 'stages', 'agents', 'turns', 'waits', 'problems', 'quality', 'kinds', 'tests'] as const;
export type PipelineSection = (typeof PIPELINE_SECTIONS)[number];
export type PipelineUnit = 'seconds' | 'count' | 'ratio';
/* One number with the same number of the previous and the baseline turn, and the change to each in percent. */
export type PipelineRow = {
  section: PipelineSection;
  key: string;
  unit: PipelineUnit;
  value: number | null;
  previous: number | null;
  baseline: number | null;
  vsPrevious: number | null;
  vsBaseline: number | null;
};
export type PipelineTurn = { number: number; title: string; status: 'open' | 'closed'; openedAt: string; closedAt: string | null; source: 'live' | 'closed' | 'rebuilt' };
export type DepartmentReport = {
  department: { id: string; name: string };
  /* Whether the department has a description to take its own numbers from. */
  described: boolean;
  criticalPath: number[];
  rows: PipelineRow[];
  tests: Required<Pick<TestsFacts, 'packages' | 'slowestFiles' | 'slowestTests' | 'overBudgetFiles' | 'overBudgetTests'>>;
};
export type PipelineHead = { turn: PipelineTurn; previous: PipelineTurn | null; baseline: PipelineTurn | null; turns: number[] };
export type PipelineReport = PipelineHead & { whole: PipelineRow[]; departments: DepartmentReport[] };
/* What one department's screen reads. No department: it had no tasks in that turn. */
export type DepartmentPipeline = PipelineHead & { department: DepartmentReport | null };
