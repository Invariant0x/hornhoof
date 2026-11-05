import { describe, expect, it } from 'vitest';
import { parseTimingLines, timingLine, TIMING_LINE } from '../src/pipeline-report.js';

const file = { package: 'apps/server', file: 'test/a.test.ts', totalMs: 12, setupMs: 1, testsMs: 10, teardownMs: 1, slowest: [{ name: 'slow', ms: 9 }] };
const pkg = { package: 'apps/server', tests: 3, medianTestMs: 4, slowerThanMedian: 1 };

describe('timing lines in a log', () => {
  it('reads back what a runner printed, among everything else', () => {
    const log = ['$ npm test', timingLine({ kind: 'file', ...file }), ' ✓ test/a.test.ts (3 tests) 12ms', timingLine({ kind: 'package', ...pkg }), 'Done.'].join('\n');
    expect(parseTimingLines(log)).toEqual({ files: [file], packages: [pkg] });
  });

  it('finds a line behind what the shell put before it', () => {
    expect(parseTimingLines(`stdout | ${timingLine({ kind: 'package', ...pkg })}`).packages).toEqual([pkg]);
  });

  it('has nothing in a log without lines', () => {
    expect(parseTimingLines('')).toEqual({ files: [], packages: [] });
  });

  it.each([
    ['not json', `${TIMING_LINE}{oops`],
    ['the wrong shape', `${TIMING_LINE}${JSON.stringify({ kind: 'file', file: 'x' })}`],
    ['a kind it does not know', `${TIMING_LINE}${JSON.stringify({ ...file, kind: 'other' })}`],
    ['a negative time', `${TIMING_LINE}${JSON.stringify({ kind: 'file', ...file, totalMs: -1 })}`],
    ['a name too long to be one', `${TIMING_LINE}${JSON.stringify({ kind: 'file', ...file, file: 'x'.repeat(501) })}`],
    ['more slow tests than a line has', `${TIMING_LINE}${JSON.stringify({ kind: 'file', ...file, slowest: Array(6).fill({ name: 'a', ms: 1 }) })}`],
  ])('believes no line with %s, as a branch writes its own log', (_why, line) => {
    expect(parseTimingLines(`${line}\n${timingLine({ kind: 'package', ...pkg })}`)).toEqual({ files: [], packages: [pkg] });
  });
});
