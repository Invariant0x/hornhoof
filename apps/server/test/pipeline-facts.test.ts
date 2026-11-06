import { describe, expect, it } from 'vitest';
import { laterBugsOf, pipelineFacts, type FactsEvent, type FactsInput, type FactsRun, type FactsTask } from '../src/modules/tasks/pipeline-facts.js';
import type { AgentTime } from '../src/modules/tasks/tree.js';

const T0 = Date.parse('2026-11-04T14:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const min = (n: number) => n * 60;

function task(number: number, over: Partial<FactsTask> = {}): FactsTask {
  return { id: `t${number}`, number, parentId: null, executorAgentId: 'bruno', status: 'done', after: [], gates: 0, bounces: 0, workKind: null, firstLine: '', createdAt: at(0), closedAt: at(30), ...over };
}
const event = (taskNumber: number, kind: FactsEvent['kind'], minutes: number, data: Record<string, unknown> = {}): FactsEvent => ({ taskId: `t${taskNumber}`, kind, data, createdAt: at(minutes) });
/* A task handed in, passed and merged at these minutes. */
const passed = (n: number, submit: number, pass: number, merge: number): FactsEvent[] => [event(n, 'submitted', submit), event(n, 'verdict', pass, { pass: true }), event(n, 'submitted', merge, { merged: true })];

function input(over: Partial<FactsInput> = {}): FactsInput {
  return { openedAt: at(0), until: at(120), tasks: [], events: [], requests: [], runs: [], jobs: [], agentTime: [], timings: [], ...over };
}
const run = (over: Partial<FactsRun> = {}): FactsRun => ({ id: 'r1', taskId: 't1', kind: 'tests', createdAt: at(0), finishedAt: at(20), parts: [{ queuedAt: at(0), startedAt: at(5), finishedAt: at(20) }], ...over });

describe('the time from giving a task out to accepting it', () => {
  it('counts from when the task was given out, not from when it was made to wait', () => {
    const facts = pipelineFacts(input({
      tasks: [task(1), task(2, { after: ['t1'], closedAt: at(60) })],
      events: [...passed(1, 10, 20, 30), event(2, 'started', 30), ...passed(2, 50, 55, 60)],
    }));
    expect(facts.toFirstSubmit).toEqual({ count: 2, median: min(15), worst: min(20) });
    expect(facts.toAcceptance).toEqual({ count: 2, median: min(30), worst: min(30) });
  });

  it('counts a planned task from when the turn opened', () => {
    const facts = pipelineFacts(input({ openedAt: at(10), tasks: [task(1, { createdAt: at(0) })], events: passed(1, 20, 25, 30) }));
    expect(facts.toFirstSubmit.median).toBe(min(10));
    expect(facts.toAcceptance.median).toBe(min(20));
  });

  it('counts from the assignment of a task that waited for its turn to start', () => {
    const facts = pipelineFacts(input({ tasks: [task(1)], events: [event(1, 'assigned', 5), ...passed(1, 15, 20, 30)] }));
    expect(facts.toFirstSubmit.median).toBe(min(10));
  });

  it('leaves out a task still open from acceptance, and a cancelled one from both, but counts them as tasks', () => {
    const facts = pipelineFacts(input({
      tasks: [task(1), task(2, { status: 'working', closedAt: null }), task(3, { status: 'cancelled', closedAt: at(5) })],
      events: [...passed(1, 10, 20, 30), event(2, 'submitted', 40), event(3, 'submitted', 2)],
    }));
    expect(facts.tasks).toEqual({ total: 3, done: 1, cancelled: 1, open: 1 });
    expect(facts.toAcceptance).toEqual({ count: 1, median: min(30), worst: min(30) });
    expect(facts.toFirstSubmit).toEqual({ count: 2, median: min(25), worst: min(40) });
  });

  it('has no number where no task got that far', () => {
    expect(pipelineFacts(input()).toAcceptance).toEqual({ count: 0, median: null, worst: null });
  });

  it("leaves out tasks with no executor and the review of a turn", () => {
    const facts = pipelineFacts(input({
      tasks: [task(1, { executorAgentId: null }), task(2, { closedAt: at(90) })],
      events: [event(2, 'created', 0, { turnReview: true, covers: [] })],
    }));
    expect(facts.toAcceptance.count).toBe(0);
    expect(facts.tasks.total).toBe(2);
  });
});

describe('the stages of a task', () => {
  it('splits a task that passed at once into work, review and merge', () => {
    const facts = pipelineFacts(input({ tasks: [task(1, { gates: 1 })], events: passed(1, 10, 25, 30) }));
    expect(facts.stages).toEqual({ work: min(10), review: min(15), fixes: 0, merge: min(5), turnReview: 0 });
  });

  it('counts the way back as fixes and each look as review', () => {
    const facts = pipelineFacts(input({
      tasks: [task(1, { gates: 1, bounces: 1, closedAt: at(50) })],
      events: [event(1, 'submitted', 10), event(1, 'verdict', 20, { pass: false }), event(1, 'submitted', 35), event(1, 'verdict', 40, { pass: true }), event(1, 'submitted', 50, { merged: true })],
    }));
    expect(facts.stages).toEqual({ work: min(10), review: min(15), fixes: min(15), merge: min(10), turnReview: 0 });
  });

  it('takes the last verdict of a panel as the end of its look', () => {
    const facts = pipelineFacts(input({
      tasks: [task(1, { gates: 1 })],
      events: [event(1, 'submitted', 10), event(1, 'verdict', 12, { pass: true }), event(1, 'verdict', 20, { pass: true }), event(1, 'submitted', 30, { merged: true })],
    }));
    expect(facts.stages).toMatchObject({ review: min(10), merge: min(10) });
  });

  it('counts a task without gates as merging from its hand-in', () => {
    const facts = pipelineFacts(input({ tasks: [task(1)], events: [event(1, 'submitted', 10), event(1, 'submitted', 30, { merged: true })] }));
    expect(facts.stages).toMatchObject({ work: min(10), review: 0, merge: min(20) });
  });

  it('counts an open task up to now in the stage it is in', () => {
    const open = { status: 'working' as const, closedAt: null };
    const stages = (t: FactsTask, events: FactsEvent[]) => pipelineFacts(input({ until: at(100), tasks: [t], events })).stages;
    expect(stages(task(1, open), [])).toMatchObject({ work: min(100) });
    expect(stages(task(1, { ...open, gates: 1 }), [event(1, 'submitted', 10)])).toMatchObject({ work: min(10), review: min(90) });
    expect(stages(task(1, { ...open, gates: 1 }), [event(1, 'submitted', 10), event(1, 'verdict', 30, { pass: false })])).toMatchObject({ review: min(20), fixes: min(70) });
    expect(stages(task(1, { ...open, gates: 1 }), [event(1, 'submitted', 10), event(1, 'verdict', 30, { pass: true })])).toMatchObject({ review: min(20), merge: min(70) });
  });

  it('counts the review of a turn on its own', () => {
    const facts = pipelineFacts(input({ tasks: [task(1, { createdAt: at(40), closedAt: at(90) })], events: [event(1, 'created', 40, { turnReview: true, covers: [] })] }));
    expect(facts.stages).toEqual({ work: 0, review: 0, fixes: 0, merge: 0, turnReview: min(50) });
  });
});

describe('the critical path of a turn', () => {
  it('is the longest chain of tasks, apart from the sum of agents', () => {
    const facts = pipelineFacts(input({
      tasks: [task(1), task(2, { after: ['t1'], closedAt: at(60) }), task(3, { closedAt: at(40) })],
      events: [event(2, 'started', 30)],
      agentTime: [{ agent: { id: 'bruno', name: 'Bruno' }, work: min(500), after: 0, person: 0, stall: 0, lost: 0, alarm: 0, queued: 0, unknown: 0 }],
    }));
    expect(facts.criticalPath).toEqual({ seconds: min(60), tasks: [1, 2] });
    expect(facts.agents.work).toBe(min(500));
    expect(facts.wholeTurn).toBe(min(120));
  });

  it('runs from a review of a turn back through the work under what it covers', () => {
    const facts = pipelineFacts(input({
      tasks: [task(1, { executorAgentId: null, closedAt: at(100) }), task(2, { parentId: 't1', closedAt: at(30) }), task(3, { parentId: 't1', closedAt: at(50) }), task(4, { createdAt: at(50), closedAt: at(80) })],
      events: [event(4, 'created', 50, { turnReview: true, covers: ['t1'] })],
    }));
    expect(facts.criticalPath).toEqual({ seconds: min(80), tasks: [3, 4] });
  });

  it('leaves out cancelled tasks, and survives a circle in old data', () => {
    const facts = pipelineFacts(input({
      tasks: [task(1, { after: ['t2'], closedAt: at(10) }), task(2, { after: ['t1'], closedAt: at(20) }), task(3, { status: 'cancelled', closedAt: at(100) })],
    }));
    expect(facts.criticalPath.seconds).toBeGreaterThanOrEqual(min(20));
    expect(facts.criticalPath.tasks).not.toContain(3);
  });
});

describe('waits', () => {
  it('counts test runs and their parts, and work runs apart', () => {
    const facts = pipelineFacts(input({
      tasks: [task(1)],
      runs: [
        run(),
        run({ id: 'r2', createdAt: at(30), finishedAt: at(90), parts: [{ queuedAt: at(30), startedAt: at(40), finishedAt: at(80) }, { queuedAt: at(30), startedAt: at(35), finishedAt: at(90) }] }),
        run({ id: 'r3', kind: 'work', createdAt: at(0), finishedAt: at(3), parts: [{ queuedAt: at(0), startedAt: at(1), finishedAt: at(3) }] }),
      ],
    }));
    expect(facts.waits.testRuns).toEqual({ count: 2, seconds: min(80), worst: min(60), parts: 3, partQueueSeconds: min(20), partRunSeconds: min(110) });
    expect(facts.waits.workRuns).toEqual({ count: 1, seconds: min(3), worst: min(3), parts: 1, partQueueSeconds: min(1), partRunSeconds: min(2) });
  });

  it('counts a run or part still going up to now, and a part that never started as waiting', () => {
    const facts = pipelineFacts(input({ until: at(50), tasks: [task(1)], runs: [run({ finishedAt: null, parts: [{ queuedAt: at(0), startedAt: at(10), finishedAt: null }, { queuedAt: at(0), startedAt: null, finishedAt: null }] })] }));
    expect(facts.waits.testRuns).toMatchObject({ seconds: min(50), partQueueSeconds: min(60), partRunSeconds: min(40) });
  });

  it('counts each kind of external wait apart', () => {
    const wait = (since: number, on?: object) => ({ externalWait: { reason: 'x', since: at(since).toISOString(), until: at(since + 100).toISOString(), ...(on ? { on } : {}) } });
    const facts = pipelineFacts(input({
      tasks: [task(1)],
      events: [
        event(1, 'updated', 0, wait(0, { kind: 'employee', employee: 'e' })), event(1, 'updated', 5, { externalWait: null }),
        event(1, 'updated', 10, wait(10, { kind: 'external', event: 'ceo' })), event(1, 'comment', 30, { externalWait: null }),
        event(1, 'updated', 40, wait(40, { kind: 'external', event: 'machine' })), event(1, 'updated', 41, { externalWait: null }),
        event(1, 'updated', 50, wait(50, { kind: 'external', event: 'time' })), event(1, 'updated', 53, { externalWait: null }),
        event(1, 'updated', 60, wait(60)), event(1, 'updated', 64, { externalWait: null }),
      ],
    }));
    expect(facts.waits.external).toEqual({
      employee: { count: 1, seconds: min(5) }, ceo: { count: 1, seconds: min(20) }, machine: { count: 1, seconds: min(1) }, time: { count: 1, seconds: min(3) }, other: { count: 1, seconds: min(4) },
    });
  });

  it('ends a wait with any move of the task, but not with a note in its log', () => {
    const wait = { externalWait: { reason: 'x', since: at(0).toISOString(), until: at(100).toISOString() } };
    const after = (kind: FactsEvent['kind']) => pipelineFacts(input({ tasks: [task(1)], events: [event(1, 'updated', 0, wait), event(1, 'interrupted', 5), event(1, 'comment', 6), event(1, kind, 10)] })).waits.external.other.seconds;
    expect(after('submitted')).toBe(min(10));
    expect(after('verdict')).toBe(min(10));
    expect(after('blocked')).toBe(min(10));
  });

  it('counts a wait still going up to now', () => {
    const wait = { externalWait: { reason: 'x', since: at(0).toISOString(), until: at(100).toISOString() } };
    const facts = pipelineFacts(input({ until: at(30), tasks: [task(1, { status: 'working', closedAt: null })], events: [event(1, 'updated', 0, wait)] }));
    expect(facts.waits.external.other).toEqual({ count: 1, seconds: min(30) });
  });

  it('keeps a wait for a test run as a run: only what is left after the run is an external wait', () => {
    const wait = { externalWait: { reason: 'Test run 93', since: at(0).toISOString(), until: at(100).toISOString() } };
    const facts = pipelineFacts(input({
      tasks: [task(1)],
      events: [event(1, 'updated', 0, wait), event(1, 'updated', 60, { externalWait: null })],
      runs: [run({ createdAt: at(0), finishedAt: at(10) })],
    }));
    expect(facts.waits.testRuns.seconds).toBe(min(10));
    expect(facts.waits.external.other).toEqual({ count: 1, seconds: min(50) });
  });

  it('counts no external wait that a run covers whole, nor a run of another task', () => {
    const wait = { externalWait: { reason: 'x', since: at(5).toISOString(), until: at(100).toISOString() } };
    const events = [event(1, 'updated', 5, wait), event(1, 'updated', 15, { externalWait: null })];
    expect(pipelineFacts(input({ tasks: [task(1)], events, runs: [run()] })).waits.external.other).toEqual({ count: 0, seconds: 0 });
    expect(pipelineFacts(input({ tasks: [task(1)], events, runs: [run({ taskId: 't9' })] })).waits.external.other).toEqual({ count: 1, seconds: min(10) });
  });

  it('counts people, other tasks and the queue', () => {
    const facts = pipelineFacts(input({
      until: at(100),
      tasks: [task(1, { createdAt: at(10) })],
      events: [event(1, 'started', 25)],
      requests: [{ taskId: 't1', createdAt: at(0), answeredAt: at(30) }, { taskId: 't1', createdAt: at(90), answeredAt: null }],
      jobs: [{ taskId: 't1', status: 'done', error: null, interrupted: false, createdAt: at(0), startedAt: at(4), finishedAt: at(10) }],
    }));
    expect(facts.waits.person).toEqual({ count: 2, seconds: min(40) });
    expect(facts.waits.tasks).toEqual({ count: 1, seconds: min(15) });
    expect(facts.waits.queue).toEqual({ count: 1, seconds: min(4) });
  });
});

describe('returns, failures and interrupted turns', () => {
  it('counts returns and the rounds of fixes, without the merge', () => {
    const facts = pipelineFacts(input({
      tasks: [task(1, { bounces: 2 }), task(2)],
      events: [event(1, 'submitted', 1), event(1, 'submitted', 2), event(1, 'submitted', 3), event(1, 'submitted', 4, { merged: true }), event(2, 'submitted', 5)],
    }));
    expect(facts.returns).toBe(2);
    expect(facts.fixRounds).toBe(2);
    expect(facts.submitsPerTask).toBe(2);
  });

  it('counts failed turns without those a restart cut off or Hornhoof ended itself', () => {
    const job = (status: 'done' | 'failed', error: string | null, interrupted = false) => ({ taskId: 't1', status, error, interrupted, createdAt: at(0), startedAt: at(0), finishedAt: at(1) });
    const facts = pipelineFacts(input({ tasks: [task(1)], jobs: [job('failed', 'agent_failed'), job('failed', null), job('failed', 'handed_on'), job('failed', 'waiting'), job('failed', 'machine_restarted', true), job('done', null)] }));
    expect(facts.failures).toBe(2);
    expect(facts.interrupted).toBe(1);
  });

  it('says it has no number for test selection misses while no full run could find any', () => {
    expect(pipelineFacts(input()).selectionMisses).toBeNull();
    const cached = { mode: 'cached' as const, turn: 1, fingerprints: [], reused: 3, preparationReused: false, wouldSkip: [], mismatches: [] };
    expect(pipelineFacts(input({ runs: [run({ fileCache: cached })] })).selectionMisses).toBeNull();
  });

  it('counts what the full runs of a turn found that the kept results called green', () => {
    const full = (files: string[]) => ({ mode: 'full' as const, turn: 5, fingerprints: [], reused: 0, preparationReused: false, wouldSkip: [], mismatches: files.map(file => ({ suiteId: 'unit', file })) });
    expect(pipelineFacts(input({ runs: [run({ fileCache: full([]) })] })).selectionMisses).toBe(0);
    expect(pipelineFacts(input({ runs: [run({ fileCache: full(['a.ts', 'b.ts']) }), run({ fileCache: full(['c.ts']) })] })).selectionMisses).toBe(3);
  });
});

describe('numbers by kind of task', () => {
  it('counts by the field, then by the first line of the body, and the rest apart', () => {
    const facts = pipelineFacts(input({
      tasks: [
        task(1, { workKind: 'bug', bounces: 1 }), task(2, { workKind: 'bug', closedAt: at(50) }),
        task(3, { firstLine: 'Вид: старый код. Класс риска: нет.' }),
        task(4, { firstLine: 'Plain text' }),
      ],
      events: [event(1, 'submitted', 5), event(1, 'submitted', 6)],
    }));
    expect(facts.kinds).toEqual({
      bug: { tasks: 2, toAcceptance: min(40), returns: 1, fixRounds: 1 },
      legacy_code: { tasks: 1, toAcceptance: min(30), returns: 0, fixRounds: 0 },
      unset: { tasks: 1, toAcceptance: min(30), returns: 0, fixRounds: 0 },
    });
    expect(facts.done.map(d => [d.number, d.kind])).toEqual([[1, 'bug'], [2, 'bug'], [3, 'legacy_code'], [4, 'unset']]);
  });
});

describe('bugs found later', () => {
  const done = [{ number: 5, kind: 'bug' as const, closedAt: at(10).toISOString() }, { number: 6, kind: 'unset' as const, closedAt: at(20).toISOString() }];

  it('counts a bug made after a done task closed that names it, by the kind of that task', () => {
    expect(laterBugsOf(done, [{ number: 9, createdAt: at(30), text: 'Broke in #5 and in #6.' }])).toEqual({ total: 1, byKind: { bug: 1, unset: 1 } });
  });

  it('counts each bug once for a kind, and none that came first or name something else', () => {
    expect(laterBugsOf(done, [
      { number: 9, createdAt: at(15), text: 'Before #6 closed; after #5 closed.' },
      { number: 10, createdAt: at(30), text: 'See #5 and #5 again.' },
      { number: 11, createdAt: at(30), text: 'See #50 and #7.' },
    ])).toEqual({ total: 2, byKind: { bug: 2 } });
  });
});

describe('agent time', () => {
  it('sums every agent into what the speed panel shows', () => {
    const one: AgentTime = { agent: { id: 'a', name: 'A' }, work: 10, after: 1, person: 2, stall: 3, lost: 4, alarm: 5, queued: 6, unknown: 7 };
    expect(pipelineFacts(input({ agentTime: [one, { ...one, agent: { id: 'b', name: 'B' } }] })).agents).toEqual({ work: 20, waiting: 6, idle: 6, lost: 18, queued: 12, unknown: 14 });
  });
});

describe('test times', () => {
  const file = (name: string, total: number, phases: [number, number, number] | null = null, slowest: { name: string; ms: number }[] = [], pkg = 'apps/server') => ({
    package: pkg, file: name, totalMs: total, setupMs: phases?.[0] ?? null, testsMs: phases?.[1] ?? null, teardownMs: phases?.[2] ?? null, slowest,
  });

  it('takes the median of each file over its parts and sums it in packages and in the suite', () => {
    const { tests } = pipelineFacts(input({
      timings: [
        { runId: 'r1', files: [file('a.test.ts', 100, [10, 80, 10]), file('b.test.ts', 300, [100, 150, 50])], packages: [] },
        { runId: 'r2', files: [file('a.test.ts', 200, [20, 170, 10])], packages: [] },
        { runId: 'r3', files: [file('a.test.ts', 300, [30, 260, 10]), file('c.test.ts', 50, [5, 40, 5], [], 'apps/web')], packages: [] },
      ],
    }));
    expect(tests).toMatchObject({ files: 3, totalMs: 550, setupMs: 125, testsMs: 360, teardownMs: 65 });
    expect(tests.packages).toEqual([
      { package: 'apps/server', files: 2, totalMs: 500, setupMs: 120, testsMs: 320, teardownMs: 60, medianFileMs: 250, tests: null, medianTestMs: null, slowerThanMedian: null },
      { package: 'apps/web', files: 1, totalMs: 50, setupMs: 5, testsMs: 40, teardownMs: 5, medianFileMs: 50, tests: null, medianTestMs: null, slowerThanMedian: null },
    ]);
    expect(tests.slowestFiles.map(f => [f.file, f.totalMs, f.parts])).toEqual([['b.test.ts', 300, 1], ['a.test.ts', 200, 3], ['c.test.ts', 50, 1]]);
  });

  it('has no phases where a log told only the total', () => {
    const { tests } = pipelineFacts(input({ timings: [{ runId: 'r1', files: [file('a.test.ts', 100), file('b.test.ts', 300)], packages: [] }] }));
    expect(tests).toMatchObject({ totalMs: 400, setupMs: null, testsMs: null, teardownMs: null });
  });

  it('names the slowest tests and adds up a package split over the parts of a run', () => {
    const { tests } = pipelineFacts(input({
      timings: [
        { runId: 'r1', files: [file('a.test.ts', 100, null, [{ name: 'slow', ms: 90 }, { name: 'quick', ms: 2 }])], packages: [{ package: 'apps/server', tests: 10, medianTestMs: 5, slowerThanMedian: 4 }] },
        { runId: 'r1', files: [file('b.test.ts', 100, null, [{ name: 'slower', ms: 95 }])], packages: [{ package: 'apps/server', tests: 20, medianTestMs: 7, slowerThanMedian: 9 }] },
        { runId: 'r2', files: [file('a.test.ts', 100, null, [{ name: 'slow', ms: 70 }])], packages: [{ package: 'apps/server', tests: 12, medianTestMs: 6, slowerThanMedian: 5 }] },
      ],
    }));
    expect(tests.slowestTests.map(t => [t.name, t.ms])).toEqual([['slower', 95], ['slow', 90], ['quick', 2]]);
    expect(tests.packages[0]).toMatchObject({ tests: 30, medianTestMs: 6, slowerThanMedian: 13 });
  });
});
