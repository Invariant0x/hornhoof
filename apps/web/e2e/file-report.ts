import { writeFileSync } from 'node:fs';
import type { Reporter, Suite, TestCase } from '@playwright/test/reporter';

/* Playwright also calls a test skipped when it never got to run, and that one has no result. A test that only passed on a second
   try says nothing good of its file either. */
const wentWell = (test: TestCase): boolean => test.outcome() === 'expected' || (test.outcome() === 'skipped' && test.results.length > 0);

/* How each spec file went, for the report a part of a test run asks for in HH_TEST_REPORT. */
export default class FileReport implements Reporter {
  private suite: Suite | undefined;

  printsToStdio(): boolean {
    return false;
  }

  onBegin(_config: unknown, suite: Suite): void {
    this.suite = suite;
  }

  onEnd(): void {
    const files = new Map<string, { file: string; status: 'passed' | 'failed'; ms: number }>();
    for (const test of this.suite?.allTests() ?? []) {
      const file = files.get(test.location.file) ?? { file: test.location.file, status: 'passed', ms: 0 };
      if (!wentWell(test)) file.status = 'failed';
      file.ms += test.results.reduce((sum, result) => sum + result.duration, 0);
      files.set(file.file, file);
    }
    writeFileSync(process.env.HH_TEST_REPORT!, JSON.stringify({ files: [...files.values()] }));
  }
}
