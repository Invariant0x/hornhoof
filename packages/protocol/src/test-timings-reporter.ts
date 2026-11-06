import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { Reporter, TestCase, TestModule, Vitest } from 'vitest/node';
import { SLOWEST_TESTS, timingLine, type TestFileTiming, type TestPackageTiming } from './pipeline-report.js';

/* What a test says it spent on its database and app and on clearing them away, in its task's meta. */
type TestMeta = { setupMs?: number; teardownMs?: number };

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

export function repositoryOf(folder: string): string {
  for (let at = folder; ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) return at;
    if (dirname(at) === at) return folder;
  }
}

export function median(sorted: number[]): number {
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

const metaOf = (test: TestCase): TestMeta => test.meta() as TestMeta;
const fullTime = (test: TestCase): number => test.diagnostic()?.duration ?? 0;
/* A test's own time, without what it says went to its database and app. */
const ownTime = (test: TestCase): number => Math.max(0, fullTime(test) - (metaOf(test).setupMs ?? 0) - (metaOf(test).teardownMs ?? 0));

export function fileTiming(module: TestModule, name: string): TestFileTiming {
  const tests = [...module.children.allTests()];
  const d = module.diagnostic();
  const inTests = sum(tests.map(fullTime));
  /* The hooks of a file have no time of their own: what they took is what the file took outside its tests. */
  const beforeTests = d.environmentSetupDuration + d.prepareDuration + d.collectDuration + d.setupDuration + Math.max(0, d.duration - inTests);
  const setupMs = Math.round(beforeTests + sum(tests.map(t => metaOf(t).setupMs ?? 0)));
  const teardownMs = Math.round(sum(tests.map(t => metaOf(t).teardownMs ?? 0)));
  const testsMs = Math.round(sum(tests.map(ownTime)));
  const slowest = [...tests].sort((a, b) => ownTime(b) - ownTime(a)).slice(0, SLOWEST_TESTS).map(t => ({ name: t.fullName.slice(0, 500), ms: Math.round(ownTime(t)) }));
  return { package: name, file: module.relativeModuleId.slice(0, 500), totalMs: setupMs + testsMs + teardownMs, setupMs, testsMs, teardownMs, slowest };
}

export function packageTiming(modules: readonly TestModule[], name: string): TestPackageTiming {
  const times = modules.flatMap(m => [...m.children.allTests()].map(ownTime)).sort((a, b) => a - b);
  const middle = median(times);
  return { package: name, tests: times.length, medianTestMs: Math.round(middle), slowerThanMedian: times.filter(t => t > middle).length };
}

/* How a file went, for the report a part of a run asks for. A file that ran no test failed nothing. */
const fileOutcome = (module: TestModule) => ({ file: module.moduleId, status: ['passed', 'skipped'].includes(module.state()) ? 'passed' : 'failed', ms: Math.round(module.diagnostic().duration) });

/* In a part of a run, each test file's time goes into the log for the pipeline report, ahead of the runner's own summary:
   the last lines of a log are what the agent reads of a failed part. */
export default class TestTimings implements Reporter {
  private name = '.';

  onInit(vitest: Vitest): void {
    const { root } = vitest.config;
    this.name = relative(repositoryOf(root), root) || '.';
  }

  onTestRunEnd(modules: readonly TestModule[]): void {
    if (process.env.HH_TEST_REPORT) writeFileSync(process.env.HH_TEST_REPORT, JSON.stringify({ files: modules.map(fileOutcome) }));
    if (!process.env.HH_TEST_PART) return;
    const lines = [...modules.map(m => timingLine({ kind: 'file', ...fileTiming(m, this.name) })), timingLine({ kind: 'package', ...packageTiming(modules, this.name) })];
    process.stdout.write(`${lines.join('\n')}\n`);
  }
}
