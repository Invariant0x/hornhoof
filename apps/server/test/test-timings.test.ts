import { timingLine } from '@hornhoof/protocol';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, TestRunner, vi } from 'vitest';
import { agents, attachments, companies, departments, jobs, subscriptions, tasks, testPartTimings, testParts, testRuns, turnSnapshots, turns } from '../src/db/schema.js';
import { createRoute } from '../src/modules/tasks/echelons-store.js';
import { developmentStages } from './templates-once.js';
import { pipelineReport } from '../src/modules/tasks/pipeline-report.js';
import { keepTimings, timingsOfLog } from '../src/modules/testruns/timings.js';
import { setUpCompany, testApp } from './helpers.js';
import { looseFiles, stored } from './files-fixture.js';

const OLD_LOG = `$ git clone --branch task-299 https://github.com/acme/shop
At a490ff989e491ca255a8aa6f64de9c16754ead7f.

 RUN  v5.0.5 /data/tests/98b375b2-bf9a-4dcb-b6d8-8e35ad9ee467/repo/apps/server

 ✓ test/nodes.test.ts (27 tests) 33531ms
   ✓ POST /api/nodes/join (8)
     ✓ gives every subscription a node 2204ms
     ✓ answers plain lines 1207ms
 ❯ test/turns.test.ts (3 tests | 1 failed) 4100ms
   × closes it 900ms
 ↓ test/skipped.test.ts (1 test | 1 skipped)

 Test Files  2 passed (2)
      Tests  53 passed (53)

 RUN  v5.0.5 /data/tests/98b375b2-bf9a-4dcb-b6d8-8e35ad9ee467/repo/apps/node

 ✓ test/run.test.ts (5 tests) 1.5s
 ✓ test/quick.test.ts (1 test) 3ms
`;

describe('what a log says of its test files', () => {
  it('reads the lines a runner printed for this, and nothing else from such a log', () => {
    const file = { package: 'apps/server', file: 'test/a.test.ts', totalMs: 12, setupMs: 1, testsMs: 10, teardownMs: 1, slowest: [] };
    const log = `${OLD_LOG}\n${timingLine({ kind: 'file', ...file })}\n${timingLine({ kind: 'package', package: 'apps/server', tests: 2, medianTestMs: 1, slowerThanMedian: 0 })}`;
    const read = timingsOfLog(log);
    expect(read.files).toEqual([file]);
    expect(read.packages).toHaveLength(1);
  });

  it('reads the total of each file from an older log, with its package and its slow tests', () => {
    expect(timingsOfLog(OLD_LOG)).toEqual({
      files: [
        { package: 'apps/server', file: 'test/nodes.test.ts', totalMs: 33531, setupMs: null, testsMs: null, teardownMs: null, slowest: [{ name: 'gives every subscription a node', ms: 2204 }, { name: 'answers plain lines', ms: 1207 }] },
        { package: 'apps/server', file: 'test/turns.test.ts', totalMs: 4100, setupMs: null, testsMs: null, teardownMs: null, slowest: [{ name: 'closes it', ms: 900 }] },
        { package: 'apps/node', file: 'test/run.test.ts', totalMs: 1500, setupMs: null, testsMs: null, teardownMs: null, slowest: [] },
        { package: 'apps/node', file: 'test/quick.test.ts', totalMs: 3, setupMs: null, testsMs: null, teardownMs: null, slowest: [] },
      ],
      packages: [],
    });
  });

  it('names no package before a runner said where it runs', () => {
    expect(timingsOfLog(' ✓ test/a.test.ts (1 test) 5ms').files[0]!.package).toBe('.');
  });

  it('keeps to the most slow tests a line has', () => {
    const lines = Array.from({ length: 8 }, (_, i) => `   ✓ test ${i} ${i + 1}ms`).join('\n');
    expect(timingsOfLog(` ✓ test/a.test.ts (8 tests) 50ms\n${lines}`).files[0]!.slowest.map(t => t.ms)).toEqual([8, 7, 6, 5, 4]);
  });

  it('has nothing in a log of something else', () => {
    expect(timingsOfLog('cargo test\nok 1 passed')).toEqual({ files: [], packages: [] });
  });
});

async function runOf() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [sub] = await db.select().from(subscriptions);
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
  const [bruno] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning();
  const from = new Date('2026-11-04T14:00:00.000Z');
  const [turn] = await db.insert(turns).values({ companyId, number: 7, goal: 'Go', status: 'closed', openedAt: from, closedAt: new Date(from.getTime() + 3_600_000) }).returning();
  const [task] = await db.insert(tasks).values({ companyId, number: 1, turnId: turn!.id, title: 'One', departmentId: dev!.id, executorAgentId: bruno!.id, status: 'done', closedAt: from, updatedAt: from }).returning();
  await db.transaction(tx => createRoute(tx, task!, {}, developmentStages()));
  const [job] = await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: bruno!.id, taskId: task!.id, kind: 'conversation', prompt: 'hi', timeoutMs: 1000 }).returning();
  const run = async (number: number, kind: 'tests' | 'work', log: string | null, status: 'passed' | 'running' = 'passed') => {
    const [row] = await db.insert(testRuns).values({ companyId, number, taskId: task!.id, agentId: bruno!.id, jobId: job!.id, kind, command: 'npm test', timeoutMs: 1000, status }).returning();
    const [part] = await db.insert(testParts).values({ companyId, runId: row!.id, part: 1, status }).returning();
    if (log !== null) {
      const bytes = Buffer.from(log);
      await db.insert(attachments).values({ companyId, jobId: job!.id, agentId: bruno!.id, taskId: task!.id, name: `${kind}-${number}-1.log`, mediaType: 'text/plain', sha256: await stored(db, bytes), size: bytes.length });
    }
    return part!;
  };
  return { db, companyId, taskId: task!.id, run };
}

describe('keeping what the logs of a turn said', () => {
  const file = (name: string, ms: number) => timingLine({ kind: 'file', package: 'apps/server', file: name, totalMs: ms, setupMs: ms / 4, testsMs: ms / 2, teardownMs: ms / 4, slowest: [{ name: `slow in ${name}`, ms: ms / 2 }] });

  it('reads each ended part of tests once, also when its log said nothing', async () => {
    const { db, companyId, taskId, run } = await runOf();
    const told = await run(1, 'tests', file('test/a.test.ts', 100));
    const silent = await run(2, 'tests', 'cargo test');
    await keepTimings(db, companyId, [taskId], looseFiles());
    const [kept] = await db.select().from(testPartTimings).where(eq(testPartTimings.partId, told.id));
    expect(kept!.files.map(f => f.file)).toEqual(['test/a.test.ts']);
    expect((await db.select().from(testPartTimings).where(eq(testPartTimings.partId, silent.id)))[0]!.files).toEqual([]);

    await db.update(attachments).set({ sha256: await stored(db, file('test/changed.test.ts', 1)) });
    await keepTimings(db, companyId, [taskId], looseFiles());
    expect((await db.select().from(testPartTimings).where(eq(testPartTimings.partId, told.id)))[0]!.files.map(f => f.file)).toEqual(['test/a.test.ts']);
  });

  it('leaves work runs, parts still running and parts with no log yet for later', async () => {
    const { db, companyId, taskId, run } = await runOf();
    await run(1, 'work', file('test/a.test.ts', 100));
    await run(2, 'tests', file('test/b.test.ts', 100), 'running');
    await run(3, 'tests', null);
    await keepTimings(db, companyId, [taskId], looseFiles());
    expect(await db.select().from(testPartTimings)).toEqual([]);
  });

  it('shows the turn its test times, by package and file, slowest first', async () => {
    const { db, companyId, run } = await runOf();
    await run(1, 'tests', [file('test/a.test.ts', 100), file('test/b.test.ts', 300), timingLine({ kind: 'package', package: 'apps/server', tests: 40, medianTestMs: 2, slowerThanMedian: 19 })].join('\n'));
    const report = await pipelineReport(db, companyId, 7, undefined, looseFiles());
    const dev = report.departments[0]!;
    const value = (key: string) => dev.rows.find(r => r.key === key)?.value;
    expect(value('tests.total')).toBe(0.4);
    expect(value('tests.setup')).toBe(0.1);
    expect(value('tests.run')).toBe(0.2);
    expect(value('tests.teardown')).toBe(0.1);
    expect(value('tests.files')).toBe(2);
    expect(value('tests.package.apps/server')).toBe(0.4);
    expect(dev.tests.slowestFiles.map(f => f.file)).toEqual(['test/b.test.ts', 'test/a.test.ts']);
    expect(dev.tests.slowestTests[0]).toEqual({ package: 'apps/server', file: 'test/b.test.ts', name: 'slow in test/b.test.ts', ms: 150 });
    expect(dev.tests.packages[0]).toMatchObject({ tests: 40, medianTestMs: 2, slowerThanMedian: 19, medianFileMs: 200 });
    expect(await db.select({ n: sql<number>`count(*)::int` }).from(testPartTimings)).toEqual([{ n: 1 }]);
  });

  it('names the files over 30 s and the tests over 1 s, also for a turn kept before such lists', async () => {
    const { db, companyId, run } = await runOf();
    await run(1, 'tests', [file('test/a.test.ts', 100), file('test/b.test.ts', 40_000)].join('\n'));
    const dev = (await pipelineReport(db, companyId, 7, undefined, looseFiles())).departments[0]!;
    expect(dev.tests.overBudgetFiles.map(f => [f.file, f.totalMs])).toEqual([['test/b.test.ts', 40_000]]);
    expect(dev.tests.overBudgetTests).toEqual([{ package: 'apps/server', file: 'test/b.test.ts', name: 'slow in test/b.test.ts', ms: 20_000 }]);

    const [kept] = await db.select().from(turnSnapshots);
    for (const d of kept!.facts.departments) {
      delete d.tests.overBudgetFiles;
      delete d.tests.overBudgetTests;
    }
    await db.update(turnSnapshots).set({ facts: kept!.facts });
    const older = (await pipelineReport(db, companyId, 7, undefined, looseFiles())).departments[0]!;
    expect(older.tests.overBudgetFiles.map(f => f.file)).toEqual(['test/b.test.ts']);
    expect(older.tests.overBudgetTests.map(t => t.name)).toEqual(['slow in test/b.test.ts']);
  });
});

describe('what a test spends on its database and app', () => {
  it('counts as setup for the report of test times', async () => {
    /* A clock that moves a millisecond each time it is read, so what the setup took is known without the real one. */
    let ms = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => ++ms);
    try {
      await testApp();
    } finally {
      clock.mockRestore();
    }
    expect((TestRunner.getCurrentTest()!.meta as { setupMs?: number }).setupMs).toBeGreaterThan(0);
  });
});
